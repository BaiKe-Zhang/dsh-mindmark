// dsh-mindmark — durable store for user annotations.
//
// The document lives outside every workspace, under the Harness home, because
// annotations belong to a conversation rather than to one project:
//
//   {
//     "version": 2,
//     "sessions": {
//       "<sessionId>": {
//         "mode": "brief" | "full",            // optional; injection view mode
//         "annotations": [Annotation],
//         "messages": { "<messageKey>": { "text": "...", "turn": 3 } }
//       }
//     }
//   }
//
// Writes are atomic (temp + rename with retry) and a copy of the previous good
// document is retained as `state.backup.json`. Loading never throws: a corrupt
// file is moved aside and treated as empty. Saving never throws either — a
// failed save is reported through the optional logger and the in-memory state
// stays usable, so the HTTP boundary can never emit an unhandled rejection.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const STATE_VERSION = 2
export const MAX_ANNOTATIONS_PER_SESSION = 300
export const MAX_ID_LENGTH = 80
export const MAX_QUOTE_LENGTH = 2000
export const MAX_NOTE_LENGTH = 2000
export const MAX_CONTEXT_LENGTH = 80
export const MAX_ROOT_SELECTOR_LENGTH = 300
export const MAX_SESSION_ID_LENGTH = 200
export const MAX_MESSAGE_KEY_LENGTH = 200
export const MAX_MESSAGE_TEXT_LENGTH = 20000
export const ANNOTATION_STYLES = ['highlight', 'underline', 'strike', 'comment', 'rewrite', 'move', 'reference']
/** Styles whose meaning needs the user's own words. */
export const NOTE_STYLES = ['comment', 'rewrite']
/** Material attached to a `reference` annotation. */
export const MATERIAL_KINDS = ['text', 'url', 'file']
export const MAX_MATERIAL_CHARS = 200000
export const MAX_MATERIAL_TITLE = 120
export const MAX_MATERIAL_URL = 2000
export const MATERIAL_EXCERPT_CHARS = 600
/** Materials up to this size are sent whole; longer ones are read through the tool. */
export const MATERIAL_INLINE_CHARS = 2000
export const MATERIAL_CHUNK_CHARS = 8000
export const ANNOTATION_STATUSES = ['pending', 'resolved']
export const INJECTION_MODES = ['brief', 'full']
export const DEFAULT_MODE = 'brief'

/** Error carrying a stable, user-facing code for the HTTP boundary / tool. */
export class AnnotateInputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AnnotateInputError'
    this.code = code
  }
}

/** Resolve `$DSH_HOME/annotations/state.json` (or `%USERPROFILE%\.dsh/...`). */
export function resolveStatePath(env = process.env) {
  const home =
    typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
      ? env.DSH_HOME
      : path.join(os.homedir(), '.dsh')
  return path.join(home, 'annotations', 'state.json')
}

/** Empty-but-valid document. */
export function emptyState() {
  return { version: STATE_VERSION, sessions: {} }
}

function truncate(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** Server-side id for a record whose client omitted `id`. */
export function generateAnnotationId() {
  return `ann_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Validate a session id coming from the wire or from an Agent. Returns the id
 * unchanged (session ids are opaque) and throws a user-facing InputError
 * otherwise.
 */
export function validateSessionId(sessionId) {
  if (
    typeof sessionId !== 'string' ||
    sessionId.trim() === '' ||
    sessionId.length > MAX_SESSION_ID_LENGTH
  ) {
    throw new AnnotateInputError('invalid-session-id', '会话 ID 无效。')
  }
  return sessionId
}

/** Validate an injection mode from the wire or the tool. */
export function validateMode(mode) {
  if (!INJECTION_MODES.includes(mode)) {
    throw new AnnotateInputError('invalid-mode', '模式必须是 brief（精简）或 full（完整）。')
  }
  return mode
}

function contextString(value, max) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new AnnotateInputError('invalid-annotation-context', '标注上下文格式不正确。')
  }
  return truncate(value, max)
}

function optionalInteger(value) {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(number) || number < 0) return undefined
  return number
}

function hostOf(url) {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, MAX_MATERIAL_TITLE)
  }
}

/**
 * Validate the material of a `reference` annotation (wire format). Returns
 * `{ meta, content }`: `meta` is what the annotation record keeps, `content`
 * goes to its own file under `annotations/materials/`.
 */
export function validateMaterialInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AnnotateInputError('missing-material', '依据需要附上参考材料（粘贴文本、链接或文件）。')
  }
  if (!MATERIAL_KINDS.includes(raw.kind)) {
    throw new AnnotateInputError('invalid-material-kind', '材料类型必须是 text、url 或 file。')
  }
  const content = typeof raw.content === 'string' ? raw.content.trim() : ''
  if (content === '') {
    throw new AnnotateInputError('missing-material', '参考材料不能为空。')
  }
  let title = typeof raw.title === 'string' ? raw.title.trim().replace(/\s+/g, ' ').slice(0, MAX_MATERIAL_TITLE) : ''
  if (raw.kind === 'url') {
    if (content.length > MAX_MATERIAL_URL || !/^https?:\/\/\S+$/i.test(content)) {
      throw new AnnotateInputError('invalid-material-url', '链接必须是以 http:// 或 https:// 开头的网址。')
    }
    if (title === '') title = hostOf(content)
    return { meta: { kind: 'url', title, url: content, length: 0, excerpt: '' }, content }
  }
  if (content.length > MAX_MATERIAL_CHARS) {
    throw new AnnotateInputError(
      'material-too-long',
      `材料太长：最多 ${MAX_MATERIAL_CHARS} 字，请只保留和这一段相关的部分。`,
    )
  }
  if (title === '') title = raw.kind === 'file' ? '文件' : '粘贴的材料'
  return {
    meta: { kind: raw.kind, title, length: content.length, excerpt: content.slice(0, MATERIAL_EXCERPT_CHARS) },
    content,
  }
}

function normalizeStoredMaterial(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!MATERIAL_KINDS.includes(raw.kind)) return null
  const title = truncate(typeof raw.title === 'string' ? raw.title : '', MAX_MATERIAL_TITLE)
  if (raw.kind === 'url') {
    const url = truncate(raw.url, MAX_MATERIAL_URL)
    if (!/^https?:\/\//i.test(url)) return null
    return { kind: 'url', title, url, length: 0, excerpt: '' }
  }
  return {
    kind: raw.kind,
    title,
    length: optionalInteger(raw.length) ?? 0,
    excerpt: truncate(raw.excerpt, MATERIAL_EXCERPT_CHARS),
  }
}

/**
 * Where a `move` annotation goes, inside the same message. Either an insertion
 * point (the caret: the passage goes right after `targetPrefix`), or, when the
 * user selected text as the target, that text (`targetQuote`), which the moved
 * passage replaces. `targetPrefix` / `targetSuffix` are the text right before
 * and after the point or the replaced text; `targetOffset` (and `targetEnd`
 * for a replacement) are offsets in the captured message when the source
 * passage is anchored there.
 */
function moveTargetOf(raw, anchor) {
  const targetPrefix = contextString(raw.targetPrefix, MAX_CONTEXT_LENGTH)
  const targetSuffix = contextString(raw.targetSuffix, MAX_CONTEXT_LENGTH)
  let targetQuote = ''
  if (raw.targetQuote !== undefined && raw.targetQuote !== null && raw.targetQuote !== '') {
    if (typeof raw.targetQuote !== 'string' || raw.targetQuote.length > MAX_QUOTE_LENGTH) {
      throw new AnnotateInputError('invalid-move-target', `被替换的文字必须是 1–${MAX_QUOTE_LENGTH} 个字符。`)
    }
    targetQuote = raw.targetQuote.trim() === '' ? '' : raw.targetQuote
  }
  if (targetPrefix === '' && targetSuffix === '' && targetQuote === '') {
    throw new AnnotateInputError('missing-move-target', '移动需要指定目标位置。')
  }
  const target = { targetPrefix, targetSuffix }
  if (targetQuote !== '') target.targetQuote = targetQuote
  const offset = optionalInteger(raw.targetOffset)
  if (anchor !== undefined && offset !== undefined) {
    if (targetQuote === '') {
      if (offset >= anchor.start && offset <= anchor.end) {
        throw new AnnotateInputError('invalid-move-target', '目标位置不能在被移动的文字里面，也不能是原处。')
      }
    } else {
      const end = optionalInteger(raw.targetEnd) ?? offset + targetQuote.length
      if (offset < anchor.end && end > anchor.start) {
        throw new AnnotateInputError('invalid-move-target', '被替换的文字不能和被移动的文字重叠。')
      }
      target.targetEnd = end
    }
    target.targetOffset = offset
  }
  return target
}

/** Drop the style-specific fields a record of another style must not carry. */
function stripForeignFields(record) {
  if (record.style !== 'move') {
    delete record.targetPrefix
    delete record.targetSuffix
    delete record.targetOffset
    delete record.targetEnd
    delete record.targetQuote
  }
  if (record.style !== 'reference') delete record.material
  return record
}

/**
 * Normalize one incoming Annotation (wire format, client -> Host). Missing
 * optional fields are filled in; anything shaped wrongly is rejected with a
 * Chinese message so the route can answer 400.
 */
export function validateAnnotationInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AnnotateInputError('invalid-annotation', '标注格式不正确。')
  }
  if (!ANNOTATION_STYLES.includes(raw.style)) {
    throw new AnnotateInputError(
      'invalid-annotation-style',
      `标注类型必须是 ${ANNOTATION_STYLES.join('、')} 之一。`,
    )
  }
  if (
    typeof raw.quote !== 'string' ||
    raw.quote.trim().length < 1 ||
    raw.quote.trim().length > MAX_QUOTE_LENGTH
  ) {
    throw new AnnotateInputError(
      'invalid-annotation-quote',
      `标注文本必须是 1–${MAX_QUOTE_LENGTH} 个字符的字符串。`,
    )
  }

  let note = ''
  if (raw.note !== undefined && raw.note !== null) {
    if (typeof raw.note !== 'string') {
      throw new AnnotateInputError('invalid-annotation-note', '批注内容必须是字符串。')
    }
    note = raw.note.trim().slice(0, MAX_NOTE_LENGTH)
  }
  if (NOTE_STYLES.includes(raw.style) && note === '') {
    throw new AnnotateInputError(
      'missing-annotation-note',
      raw.style === 'rewrite' ? '改写需要给出替换后的文字。' : '批注需要填写内容。',
    )
  }

  let id
  if (raw.id === undefined || raw.id === null || raw.id === '') {
    id = generateAnnotationId()
  } else if (typeof raw.id === 'string') {
    id = raw.id.trim().slice(0, MAX_ID_LENGTH)
    if (id === '') id = generateAnnotationId()
  } else {
    throw new AnnotateInputError('invalid-annotation-id', '标注 ID 必须是字符串。')
  }

  let createdAt
  if (raw.createdAt === undefined || raw.createdAt === null) {
    createdAt = new Date().toISOString()
  } else if (typeof raw.createdAt === 'string' && raw.createdAt.trim() !== '') {
    createdAt = raw.createdAt
  } else {
    throw new AnnotateInputError('invalid-annotation-created-at', '标注时间格式不正确。')
  }

  const messageKey = contextString(raw.messageKey, MAX_MESSAGE_KEY_LENGTH)
  const messageStart = optionalInteger(raw.messageStart)
  const messageEnd = optionalInteger(raw.messageEnd)
  const anchored =
    messageKey !== '' &&
    messageStart !== undefined &&
    messageEnd !== undefined &&
    messageEnd > messageStart

  // Keep harmless unknown fields from newer/older clients; the known fields win.
  const record = {
    ...raw,
    id,
    style: raw.style,
    quote: raw.quote,
    note,
    prefix: contextString(raw.prefix, MAX_CONTEXT_LENGTH),
    suffix: contextString(raw.suffix, MAX_CONTEXT_LENGTH),
    rootSelector: contextString(raw.rootSelector, MAX_ROOT_SELECTOR_LENGTH),
    messageKey: anchored ? messageKey : '',
    createdAt,
    status: 'pending',
    injections: 0,
  }
  stripForeignFields(record)
  delete record.targetOffset
  delete record.targetEnd
  delete record.targetQuote
  if (record.style === 'move') {
    Object.assign(record, moveTargetOf(raw, anchored ? { start: messageStart, end: messageEnd } : undefined))
  }
  if (record.style === 'reference') record.material = validateMaterialInput(raw.material).meta
  return withAnchor(record, anchored ? messageStart : undefined, anchored ? messageEnd : undefined, optionalInteger(raw.turn))
}

/** Set or drop the optional anchor fields so a record never carries `undefined` keys. */
function withAnchor(record, messageStart, messageEnd, turn) {
  if (messageStart === undefined || messageEnd === undefined) {
    delete record.messageStart
    delete record.messageEnd
  } else {
    record.messageStart = messageStart
    record.messageEnd = messageEnd
  }
  if (turn === undefined) delete record.turn
  else record.turn = turn
  return record
}

/**
 * Normalize one incoming message capture `{ key, text, turn }` (the full text
 * of the message an annotation belongs to). Returns null when it is unusable;
 * a bad capture never fails the annotation itself.
 */
export function validateMessageInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const key = typeof raw.key === 'string' ? raw.key.trim().slice(0, MAX_MESSAGE_KEY_LENGTH) : ''
  if (key === '') return null
  if (typeof raw.text !== 'string' || raw.text.length === 0 || raw.text.length > MAX_MESSAGE_TEXT_LENGTH) {
    return null
  }
  const turn = optionalInteger(raw.turn)
  return turn === undefined ? { key, text: raw.text } : { key, text: raw.text, turn }
}

/** Normalize one stored record. Returns null for a malformed entry. */
function normalizeStoredAnnotation(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  if (!ANNOTATION_STYLES.includes(raw.style)) return null
  if (typeof raw.quote !== 'string') return null
  const quoteLength = raw.quote.trim().length
  if (quoteLength < 1 || quoteLength > MAX_QUOTE_LENGTH) return null
  if (typeof raw.createdAt !== 'string' || raw.createdAt.trim() === '') return null
  const messageKey = truncate(raw.messageKey, MAX_MESSAGE_KEY_LENGTH)
  const messageStart = optionalInteger(raw.messageStart)
  const messageEnd = optionalInteger(raw.messageEnd)
  const anchored =
    messageKey !== '' && messageStart !== undefined && messageEnd !== undefined && messageEnd > messageStart
  const injections = optionalInteger(raw.injections) ?? 0
  const status = ANNOTATION_STATUSES.includes(raw.status) ? raw.status : 'pending'
  const record = withAnchor({
    ...raw,
    id: truncate(raw.id.trim(), MAX_ID_LENGTH),
    style: raw.style,
    quote: raw.quote,
    note: truncate(typeof raw.note === 'string' ? raw.note.trim() : '', MAX_NOTE_LENGTH),
    prefix: truncate(raw.prefix, MAX_CONTEXT_LENGTH),
    suffix: truncate(raw.suffix, MAX_CONTEXT_LENGTH),
    rootSelector: truncate(raw.rootSelector, MAX_ROOT_SELECTOR_LENGTH),
    messageKey: anchored ? messageKey : '',
    createdAt: raw.createdAt,
    status,
    injections,
  }, anchored ? messageStart : undefined, anchored ? messageEnd : undefined, optionalInteger(raw.turn))
  if (status === 'resolved') {
    record.resolvedAt = typeof raw.resolvedAt === 'string' ? raw.resolvedAt : raw.createdAt
    record.resolvedBy = typeof raw.resolvedBy === 'string' ? raw.resolvedBy.slice(0, 20) : 'user'
  } else {
    delete record.resolvedAt
    delete record.resolvedBy
  }
  if (record.lastInjectedTurn !== undefined && optionalInteger(record.lastInjectedTurn) === undefined) {
    delete record.lastInjectedTurn
  }
  stripForeignFields(record)
  if (record.style === 'move') {
    record.targetPrefix = truncate(raw.targetPrefix, MAX_CONTEXT_LENGTH)
    record.targetSuffix = truncate(raw.targetSuffix, MAX_CONTEXT_LENGTH)
    const targetQuote = typeof raw.targetQuote === 'string' && raw.targetQuote.trim() !== '' ? truncate(raw.targetQuote, MAX_QUOTE_LENGTH) : ''
    if (targetQuote === '') delete record.targetQuote
    else record.targetQuote = targetQuote
    if (record.targetPrefix === '' && record.targetSuffix === '' && targetQuote === '') return null
    const offset = optionalInteger(raw.targetOffset)
    if (offset === undefined || !anchored) delete record.targetOffset
    else record.targetOffset = offset
    const end = optionalInteger(raw.targetEnd)
    if (targetQuote === '' || record.targetOffset === undefined || end === undefined || end <= offset) delete record.targetEnd
    else record.targetEnd = end
  }
  if (record.style === 'reference') {
    const material = normalizeStoredMaterial(raw.material)
    if (material === null) return null
    record.material = material
  }
  return record
}

function normalizeStoredMessages(raw, annotations) {
  const messages = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return messages
  const referenced = new Set(annotations.map(item => item.messageKey).filter(key => key !== ''))
  for (const [key, value] of Object.entries(raw)) {
    if (!referenced.has(key)) continue
    const message = validateMessageInput({ ...(value ?? {}), key })
    if (message !== null) messages[key] = { text: message.text, ...(message.turn === undefined ? {} : { turn: message.turn }) }
  }
  return messages
}

/** Normalize one stored session. Returns null when it carries nothing worth keeping. */
function normalizeStoredSession(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const annotations = []
  if (Array.isArray(raw.annotations)) {
    for (const item of raw.annotations) {
      const annotation = normalizeStoredAnnotation(item)
      if (annotation !== null) annotations.push(annotation)
    }
  }
  const mode = INJECTION_MODES.includes(raw.mode) && raw.mode !== DEFAULT_MODE ? raw.mode : undefined
  if (annotations.length === 0 && mode === undefined) return null
  const capped =
    annotations.length > MAX_ANNOTATIONS_PER_SESSION
      ? annotations.slice(-MAX_ANNOTATIONS_PER_SESSION)
      : annotations
  const session = { annotations: capped, messages: normalizeStoredMessages(raw.messages, capped) }
  if (mode !== undefined) session.mode = mode
  return session
}

/**
 * Coerce an arbitrary parsed document into the safe in-memory shape. Never
 * throws: garbage sections and malformed records are dropped, empty session
 * keys are removed, and the per-session cap is re-applied.
 */
export function normalizeState(raw) {
  const state = emptyState()
  try {
    const sessions =
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.sessions !== null &&
      typeof raw.sessions === 'object' &&
      !Array.isArray(raw.sessions)
        ? raw.sessions
        : {}
    for (const [sessionId, sessionRaw] of Object.entries(sessions)) {
      if (
        typeof sessionId !== 'string' ||
        sessionId.trim() === '' ||
        sessionId.length > MAX_SESSION_ID_LENGTH
      ) {
        continue
      }
      const session = normalizeStoredSession(sessionRaw)
      if (session !== null) state.sessions[sessionId] = session
    }
  } catch {
    // `normalizeState` never throws; a partially normalized document is fine.
  }
  return state
}

/** Drop session keys that carry nothing (no annotations and the default mode). */
function pruneEmptySessions(state) {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return state
  if (state.sessions === null || typeof state.sessions !== 'object' || Array.isArray(state.sessions)) {
    state.sessions = {}
    return state
  }
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const empty =
      session === null ||
      typeof session !== 'object' ||
      !Array.isArray(session.annotations) ||
      session.annotations.length === 0
    const defaultMode = session?.mode === undefined || session?.mode === DEFAULT_MODE
    if (empty && defaultMode) {
      delete state.sessions[sessionId]
    } else if (empty) {
      session.annotations = []
      session.messages = {}
    }
  }
  return state
}

function ensureDirectory(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

/**
 * Load a document. A missing file means an empty document; a corrupt file is
 * copied aside (`state.json.corrupt-<ts>`) instead of being silently
 * overwritten. Never throws.
 */
export function loadStateFile(filePath, { logger } = {}) {
  try {
    ensureDirectory(filePath)
  } catch (error) {
    logger?.warn?.(`dsh-mindmark: cannot create the annotation directory: ${String(error)}`)
    return emptyState()
  }
  let raw
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`dsh-mindmark: cannot read ${filePath}: ${String(error)}`)
    }
    return emptyState()
  }
  try {
    return normalizeState(JSON.parse(raw))
  } catch (error) {
    const backup = `${filePath}.corrupt-${Date.now()}`
    try {
      fs.copyFileSync(filePath, backup)
    } catch {
      // Best effort: the unreadable original remains in place.
    }
    logger?.warn?.(
      `dsh-mindmark: annotation state was unreadable (${String(error)}); backup at ${backup}`,
    )
    return emptyState()
  }
}

/** `state.json` -> `state.backup.json` (contract's name). */
export function backupPathFor(filePath) {
  const base = path.basename(filePath)
  const stem = base.toLowerCase().endsWith('.json') ? base.slice(0, -'.json'.length) : base
  return path.join(path.dirname(filePath), `${stem}.backup.json`)
}

/** Windows can briefly lock the destination after an antivirus scan. */
function replaceWithRetry(temp, filePath) {
  let lastError
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.renameSync(temp, filePath)
      return
    } catch (error) {
      lastError = error
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') {
        throw error
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (attempt + 1))
    }
  }
  // A non-atomic copy is still preferable to losing the user's annotations.
  fs.copyFileSync(temp, filePath)
  fs.unlinkSync(temp)
  if (!fs.existsSync(filePath)) throw lastError
}

/** Atomically replace the document, keeping one previous good copy. */
export function saveStateFile(filePath, state) {
  ensureDirectory(filePath)
  const document = pruneEmptySessions(
    state !== null && typeof state === 'object' && !Array.isArray(state) ? state : emptyState(),
  )
  const json = `${JSON.stringify(document, null, 2)}\n`
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temp, json, { encoding: 'utf8', mode: 0o600 })
  try {
    if (fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, backupPathFor(filePath))
      } catch {
        // The next successful write can try the backup again.
      }
    }
    replaceWithRetry(temp, filePath)
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp)
    } catch {
      // Leftover temp files are harmless.
    }
  }
}

function cleanIds(ids) {
  return new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id.trim() !== ''))
}

/**
 * Small synchronous store; the document is tiny and mutations are serialized.
 * Save failures are logged but never thrown, so the HTTP handler and the tool
 * keep working with the in-memory document.
 */
export class AnnotationStore {
  constructor(filePath, { logger, defaultMode } = {}) {
    this.filePath = filePath ?? resolveStatePath()
    this.logger = logger
    this.defaultMode = INJECTION_MODES.includes(defaultMode) ? defaultMode : DEFAULT_MODE
    this.materialsDir = path.join(path.dirname(this.filePath), 'materials')
    this.state = loadStateFile(this.filePath, { logger })
    this.lastSaveError = null
    // Canonicalize what was loaded (and create the file early, best effort).
    this.persist()
    this.sweepMaterials()
  }

  // ------------------------------------------------------------ materials

  materialPath(id) {
    return path.join(this.materialsDir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.txt`)
  }

  writeMaterial(id, content) {
    fs.mkdirSync(this.materialsDir, { recursive: true })
    fs.writeFileSync(this.materialPath(id), content, { encoding: 'utf8', mode: 0o600 })
  }

  readMaterialFile(id) {
    try {
      return fs.readFileSync(this.materialPath(id), 'utf8')
    } catch {
      return undefined
    }
  }

  deleteMaterials(records) {
    for (const record of records) {
      if (record?.style !== 'reference') continue
      try {
        fs.rmSync(this.materialPath(record.id), { force: true })
      } catch (error) {
        this.logger?.warn?.(`dsh-mindmark: cannot delete material ${record.id}: ${String(error)}`)
      }
    }
  }

  /** Remove material files no annotation refers to any more (best effort). */
  sweepMaterials() {
    let names
    try {
      names = fs.readdirSync(this.materialsDir)
    } catch {
      return
    }
    const keep = new Set()
    for (const session of Object.values(this.state.sessions)) {
      for (const item of session?.annotations ?? []) {
        if (item.style === 'reference') keep.add(path.basename(this.materialPath(item.id)))
      }
    }
    for (const name of names) {
      if (!name.endsWith('.txt') || keep.has(name)) continue
      try {
        fs.rmSync(path.join(this.materialsDir, name), { force: true })
      } catch {
        // Harmless leftover.
      }
    }
  }

  /**
   * Read one chunk of the material of a `reference` annotation. Returns
   * undefined when the annotation or its material is gone.
   */
  material(sessionId, id, { offset = 0, limit = MATERIAL_CHUNK_CHARS } = {}) {
    const record = this.sessionFor(sessionId)?.annotations.find(item => item.id === id)
    if (record === undefined || record.style !== 'reference') return undefined
    const meta = record.material
    if (meta.kind === 'url') {
      return { id, kind: 'url', title: meta.title, url: meta.url, total: 0, offset: 0, content: '', nextOffset: -1 }
    }
    const content = this.readMaterialFile(id)
    if (content === undefined) return undefined
    const start = Math.max(0, Math.min(Number.isInteger(offset) ? offset : 0, content.length))
    const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MATERIAL_CHUNK_CHARS) : MATERIAL_CHUNK_CHARS
    const end = Math.min(content.length, start + size)
    return {
      id,
      kind: meta.kind,
      title: meta.title,
      total: content.length,
      offset: start,
      content: content.slice(start, end),
      nextOffset: end < content.length ? end : -1,
    }
  }

  /** Session id -> safe session object, or undefined. */
  sessionFor(sessionId) {
    if (typeof sessionId !== 'string') return undefined
    const session = this.state.sessions[sessionId]
    if (
      session === null ||
      typeof session !== 'object' ||
      !Array.isArray(session.annotations)
    ) {
      return undefined
    }
    if (session.messages === null || typeof session.messages !== 'object' || Array.isArray(session.messages)) {
      session.messages = {}
    }
    return session
  }

  ensureSession(sessionId) {
    const key = validateSessionId(sessionId)
    let session = this.sessionFor(key)
    if (session === undefined) {
      session = { annotations: [], messages: {} }
      this.state.sessions[key] = session
    }
    return session
  }

  /** Oldest first, always a fresh array. */
  list(sessionId) {
    const session = this.sessionFor(sessionId)
    if (session === undefined) return []
    return session.annotations.map(annotation => ({ ...annotation }))
  }

  /** Annotations still waiting for the model, oldest first. */
  pending(sessionId) {
    return this.list(sessionId).filter(annotation => annotation.status !== 'resolved')
  }

  /** The injection mode for one session (the configured default when unset). */
  getMode(sessionId) {
    const session = this.sessionFor(sessionId)
    const mode = session?.mode
    return INJECTION_MODES.includes(mode) ? mode : this.defaultMode
  }

  /** Record the injection mode for one session. */
  setMode(sessionId, mode) {
    const next = validateMode(mode)
    const session = this.ensureSession(sessionId)
    if (next === this.defaultMode) delete session.mode
    else session.mode = next
    this.persist()
    return next
  }

  /** The captured full text of one message, or undefined. */
  messageOf(sessionId, messageKey) {
    const session = this.sessionFor(sessionId)
    if (session === undefined || typeof messageKey !== 'string' || messageKey === '') return undefined
    const message = session.messages[messageKey]
    if (message === null || typeof message !== 'object' || typeof message.text !== 'string') return undefined
    return { ...message }
  }

  /** Everything the injection builder needs for one session. */
  snapshot(sessionId) {
    const session = this.sessionFor(sessionId)
    const annotations = this.list(sessionId)
    // Short materials travel whole; longer ones are read through the tool.
    const materials = {}
    for (const item of annotations) {
      if (item.style !== 'reference' || item.material.kind === 'url') continue
      if (item.material.length > MATERIAL_INLINE_CHARS) continue
      const content = this.readMaterialFile(item.id)
      if (content !== undefined) materials[item.id] = content
    }
    return {
      mode: this.getMode(sessionId),
      annotations,
      messages:
        session === undefined
          ? {}
          : Object.fromEntries(Object.entries(session.messages).map(([key, value]) => [key, { ...value }])),
      materials,
    }
  }

  /**
   * Append one annotation. An identical `(style, quote, prefix, suffix, note)`
   * marks the same passage again: its `createdAt` is refreshed, it becomes
   * pending again and moves to the end instead of being duplicated. The
   * per-session cap drops the oldest. `message` optionally captures the full
   * text of the message the annotation belongs to.
   */
  add(sessionId, annotation, message) {
    const record = validateAnnotationInput(annotation)
    const session = this.ensureSession(sessionId)
    const capture = validateMessageInput(message)
    if (capture !== null && record.messageKey === capture.key) {
      session.messages[capture.key] = {
        text: capture.text,
        ...(capture.turn === undefined ? {} : { turn: capture.turn }),
      }
      if (record.turn === undefined && capture.turn !== undefined) record.turn = capture.turn
    } else if (record.messageKey !== '' && session.messages[record.messageKey] === undefined) {
      // Anchored to a message we never captured: keep the offsets harmless.
      record.messageKey = ''
      delete record.messageStart
      delete record.messageEnd
      delete record.targetOffset
      delete record.targetEnd
    }
    const material = record.style === 'reference' ? validateMaterialInput(annotation.material) : null
    const index = session.annotations.findIndex(
      item =>
        item.style === record.style &&
        item.quote === record.quote &&
        item.prefix === record.prefix &&
        item.suffix === record.suffix &&
        item.note === record.note &&
        (item.style !== 'move' ||
          (item.targetPrefix === record.targetPrefix &&
            item.targetSuffix === record.targetSuffix &&
            (item.targetQuote ?? '') === (record.targetQuote ?? ''))),
    )
    let result
    let stored
    if (index >= 0) {
      const existing = session.annotations[index]
      const anchorSource = record.messageKey !== '' ? record : existing
      const refreshed = withAnchor({
        ...existing,
        createdAt: record.createdAt,
        status: 'pending',
        injections: 0,
        messageKey: anchorSource.messageKey ?? '',
      }, anchorSource.messageStart, anchorSource.messageEnd, record.turn ?? existing.turn)
      delete refreshed.resolvedAt
      delete refreshed.resolvedBy
      delete refreshed.lastInjectedTurn
      // A re-marked reference takes the newly attached material.
      if (material !== null) refreshed.material = material.meta
      if (record.style === 'move') {
        if (record.targetOffset !== undefined) refreshed.targetOffset = record.targetOffset
        else if (refreshed.messageStart === undefined) delete refreshed.targetOffset
        if (record.targetEnd !== undefined) refreshed.targetEnd = record.targetEnd
        else if (refreshed.targetOffset === undefined) delete refreshed.targetEnd
      }
      session.annotations.splice(index, 1)
      session.annotations.push(refreshed)
      stored = refreshed
      result = { annotation: { ...refreshed }, deduped: true }
    } else {
      session.annotations.push({ ...record })
      if (session.annotations.length > MAX_ANNOTATIONS_PER_SESSION) {
        const dropped = session.annotations.splice(0, session.annotations.length - MAX_ANNOTATIONS_PER_SESSION)
        this.deleteMaterials(dropped)
      }
      stored = record
      result = { annotation: { ...record }, deduped: false }
    }
    if (material !== null) {
      try {
        this.writeMaterial(stored.id, material.content)
      } catch (error) {
        // Without its material a new reference is meaningless: undo it.
        if (!result.deduped) session.annotations = session.annotations.filter(item => item.id !== stored.id)
        this.logger?.warn?.(`dsh-mindmark: cannot save material: ${String(error)}`)
        throw new AnnotateInputError('material-save-failed', '参考材料保存失败。')
      }
    }
    this.pruneMessages(session)
    this.persist()
    return result
  }

  /** Drop captured messages no annotation references any more. */
  pruneMessages(session) {
    const referenced = new Set(session.annotations.map(item => item.messageKey).filter(key => key !== ''))
    for (const key of Object.keys(session.messages)) {
      if (!referenced.has(key)) delete session.messages[key]
    }
  }

  /** Remove annotations by id. Returns how many were removed. */
  remove(sessionId, ids) {
    const session = this.sessionFor(sessionId)
    if (session === undefined) return 0
    const wanted = cleanIds(ids)
    if (wanted.size === 0) return 0
    const dropped = session.annotations.filter(item => wanted.has(item.id))
    session.annotations = session.annotations.filter(item => !wanted.has(item.id))
    const removed = dropped.length
    if (removed > 0) {
      this.pruneMessages(session)
      this.persist()
      this.deleteMaterials(dropped)
    }
    return removed
  }

  /** Remove every annotation of one session (the mode is kept). Returns how many were removed. */
  clear(sessionId) {
    const session = this.sessionFor(sessionId)
    if (session === undefined) return 0
    const dropped = session.annotations
    const removed = dropped.length
    session.annotations = []
    session.messages = {}
    if (removed > 0) {
      this.persist()
      this.deleteMaterials(dropped)
    }
    return removed
  }

  /**
   * Mark annotations as handled. `ids` undefined/empty means every pending
   * annotation. `by` records who settled them: `model`, `user` or `cap`.
   * Returns the ids that changed.
   */
  resolve(sessionId, ids, { by = 'user', at } = {}) {
    const session = this.sessionFor(sessionId)
    if (session === undefined) return []
    const wanted = cleanIds(ids)
    const stamp = typeof at === 'string' ? at : new Date().toISOString()
    const changed = []
    for (const item of session.annotations) {
      if (item.status === 'resolved') continue
      if (wanted.size > 0 && !wanted.has(item.id)) continue
      item.status = 'resolved'
      item.resolvedAt = stamp
      item.resolvedBy = by
      changed.push(item.id)
    }
    if (changed.length > 0) this.persist()
    return changed
  }

  /**
   * Put annotations back in front of the model. `ids` undefined/empty means
   * every annotation. The injection counter restarts. Returns the ids that changed.
   */
  reopen(sessionId, ids) {
    const session = this.sessionFor(sessionId)
    if (session === undefined) return []
    const wanted = cleanIds(ids)
    const changed = []
    for (const item of session.annotations) {
      if (wanted.size > 0 && !wanted.has(item.id)) continue
      if (item.status === 'pending' && item.injections === 0) continue
      item.status = 'pending'
      item.injections = 0
      delete item.resolvedAt
      delete item.resolvedBy
      delete item.lastInjectedTurn
      changed.push(item.id)
    }
    if (changed.length > 0) this.persist()
    return changed
  }

  /**
   * Count one injection for the given pending annotations and settle those
   * that reached `cap` before this turn (`resolvedBy: 'cap'`).
   * Returns `{ injected: ids, capped: ids }`; only `injected` were included.
   */
  markInjected(sessionId, ids, { turn, cap } = {}) {
    const session = this.sessionFor(sessionId)
    if (session === undefined) return { injected: [], capped: [] }
    const wanted = cleanIds(ids)
    const injected = []
    const capped = []
    const limit = Number.isInteger(cap) && cap > 0 ? cap : undefined
    for (const item of session.annotations) {
      if (item.status === 'resolved' || !wanted.has(item.id)) continue
      if (limit !== undefined && item.injections >= limit) {
        item.status = 'resolved'
        item.resolvedAt = new Date().toISOString()
        item.resolvedBy = 'cap'
        capped.push(item.id)
        continue
      }
      item.injections += 1
      if (Number.isInteger(turn)) item.lastInjectedTurn = turn
      injected.push(item.id)
    }
    if (injected.length > 0 || capped.length > 0) this.persist()
    return { injected, capped }
  }

  /** Pending annotations that may still be injected under `cap`. */
  injectable(sessionId, cap) {
    const limit = Number.isInteger(cap) && cap > 0 ? cap : undefined
    return this.pending(sessionId).filter(item => limit === undefined || item.injections < limit)
  }

  /** Save the document; failures are logged and recorded, never thrown. */
  persist() {
    try {
      saveStateFile(this.filePath, this.state)
      this.lastSaveError = null
      return true
    } catch (error) {
      this.lastSaveError = error
      this.logger?.warn?.(`dsh-mindmark: cannot save ${this.filePath}: ${String(error)}`)
      return false
    }
  }
}
