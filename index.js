// dsh-annotate — Host half.
//
// Registers:
//   • the read/write HTTP API the Web client uses to store annotations and the
//     per-session injection mode (`/plugins/dsh-annotate/annotations`);
//   • `annotations`, the model-facing tool that lists / resolves / reopens /
//     deletes the annotations of the current conversation;
//   • an `agent/pre-step` listener that, at the start of each turn, enters one
//     user-role context message carrying the pending annotations (so the model
//     sees "the answer as the user marked it up"), logged like every other
//     model-visible input;
//   • a short protocol section in the system prompt while annotations are pending.
//
// No DSH package is imported on purpose: the plugin must boot from a linked
// profile directory whose loader can resolve only Node builtins.

import {
  AnnotationStore,
  AnnotateInputError,
  ANNOTATION_STYLES,
  INJECTION_MODES,
  resolveStatePath,
  validateMode,
  validateSessionId,
} from './src/store.js'
import {
  buildInjection,
  buildProtocolSection,
  SOURCE_KIND,
  STYLE_META,
  TOOL_NAME,
} from './src/inject.js'

export const name = 'annotate'
export const inject = ['tools', 'systemPrompt', 'webServer']

export const ROUTE = '/plugins/dsh-annotate/annotations'
export { TOOL_NAME }
export const SECTION_NAME = 'tool:annotations'
export const SECTION_ORDER = 9100
/** How many turns one annotation is re-injected before it settles on its own. */
export const DEFAULT_MAX_INJECTIONS = 3

const MAX_BODY_BYTES = 64 * 1024
// Plain-browser loopback origins and the Desktop shell's own boundary. The
// Desktop shell proxies the page's request without an Origin header, so an
// absent Origin is accepted here exactly like the shipped routes do.
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i

function styleLabel(style) {
  return STYLE_META[style]?.label ?? '标注'
}

// ------------------------------------------------------------------- HTTP

function corsHeaders(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string') return {}
  if (origin === 'null' || LOOPBACK_ORIGIN_RE.test(origin)) {
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'Origin',
    }
  }
  return {}
}

function originAllowed(req) {
  const origin = req?.headers?.origin
  if (typeof origin !== 'string' || origin === '') return true
  if (origin === 'null' || origin === 'dsh-app://app') return true
  if (LOOPBACK_ORIGIN_RE.test(origin)) return true
  const host = req?.headers?.host
  if (typeof host === 'string' && (origin === `http://${host}` || origin === `https://${host}`)) {
    return true
  }
  return false
}

function sendJson(req, res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    'x-content-type-options': 'nosniff',
    ...corsHeaders(req),
  })
  res.end(payload)
}

function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { ok: false, error: { code, message } })
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request-too-large')
      error.code = 'request-too-large'
      throw error
    }
    chunks.push(buffer)
  }
  if (size === 0) {
    const error = new Error('empty-body')
    error.code = 'invalid-json'
    throw error
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const error = new Error('invalid-json')
    error.code = 'invalid-json'
    throw error
  }
}

function sessionIdFromUrl(req) {
  try {
    const url = new URL(typeof req?.url === 'string' ? req.url : '', 'http://127.0.0.1')
    return url.searchParams.get('sessionId') ?? undefined
  } catch {
    return undefined
  }
}

function sessionPayload(store, sessionId, extra = {}) {
  return { ok: true, annotations: store.list(sessionId), mode: store.getMode(sessionId), ...extra }
}

function stringIds(ids, code, message) {
  if (ids === undefined || ids === null) return []
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) {
    throw new AnnotateInputError(code, message)
  }
  return ids
}

/**
 * Build the annotations HTTP handler. Exported for tests; `apply` registers it
 * as-is. `deps = { store, logger }`.
 */
export function createAnnotationsHandler(deps) {
  const store = deps?.store
  const logger = deps?.logger
  if (!store || typeof store.list !== 'function') {
    throw new TypeError('createAnnotationsHandler requires deps.store')
  }

  return async function annotationsHandler(req, res) {
    try {
      if (req?.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req))
        res.end()
        return
      }
      if (!originAllowed(req)) {
        sendError(req, res, 403, 'forbidden', '请求来源不被允许。')
        return
      }

      if (req?.method === 'GET') {
        const sessionId = sessionIdFromUrl(req)
        let key
        try {
          key = validateSessionId(sessionId)
        } catch {
          sendError(req, res, 400, 'invalid-session-id', '会话 ID 无效。')
          return
        }
        sendJson(req, res, 200, sessionPayload(store, key))
        return
      }

      if (req?.method !== 'POST') {
        sendError(req, res, 405, 'method-not-allowed', '只支持 GET 和 POST。')
        return
      }

      const contentType = req.headers?.['content-type']
      if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith('application/json')) {
        sendError(req, res, 415, 'unsupported-media-type', '请使用 application/json。')
        return
      }

      let body
      try {
        body = await readJsonBody(req)
      } catch (error) {
        const tooLarge = error?.code === 'request-too-large'
        if (tooLarge) {
          sendError(req, res, 413, 'request-too-large', '请求过大。')
        } else {
          sendError(req, res, 400, 'invalid-json', '请求体不是有效 JSON。')
        }
        return
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendError(req, res, 400, 'invalid-body', '请求体必须是 JSON 对象。')
        return
      }

      const sessionId = validateSessionId(body.sessionId)
      const action = body.action

      if (action === undefined || action === null || action === 'list') {
        sendJson(req, res, 200, sessionPayload(store, sessionId))
        return
      }
      if (action === 'add') {
        const result = store.add(sessionId, body.annotation, body.message)
        sendJson(req, res, 200, sessionPayload(store, sessionId, { added: result.deduped !== true }))
        return
      }
      if (action === 'remove') {
        const ids = stringIds(body.ids, 'invalid-ids', 'ids 必须是标注 id 的字符串数组。')
        if (ids.length === 0) throw new AnnotateInputError('invalid-ids', 'ids 必须是标注 id 的字符串数组。')
        const removed = store.remove(sessionId, ids)
        sendJson(req, res, 200, sessionPayload(store, sessionId, { removed }))
        return
      }
      if (action === 'clear') {
        const removed = store.clear(sessionId)
        sendJson(req, res, 200, sessionPayload(store, sessionId, { removed }))
        return
      }
      if (action === 'resolve' || action === 'reopen') {
        const ids = stringIds(body.ids, 'invalid-ids', 'ids 必须是标注 id 的字符串数组。')
        const changed = action === 'resolve' ? store.resolve(sessionId, ids, { by: 'user' }) : store.reopen(sessionId, ids)
        sendJson(req, res, 200, sessionPayload(store, sessionId, { changed }))
        return
      }
      if (action === 'set-mode') {
        store.setMode(sessionId, body.mode)
        sendJson(req, res, 200, sessionPayload(store, sessionId))
        return
      }
      throw new AnnotateInputError(
        'invalid-action',
        '未知的 action，只支持 list、add、remove、clear、resolve、reopen、set-mode。',
      )
    } catch (error) {
      if (error instanceof AnnotateInputError) {
        try {
          sendError(req, res, 400, error.code, error.message)
        } catch {
          // The response is already gone; nothing left to report.
        }
        return
      }
      logger?.warn?.(`dsh-annotate: annotation request failed: ${String(error)}`)
      try {
        sendError(req, res, 500, 'internal', '标注读写失败。')
      } catch {
        // The response is already gone; nothing left to report.
      }
    }
  }
}

// --------------------------------------------------------------- the tool

const TIMESTAMP_PAD = number => String(number).padStart(2, '0')

/** Local `YYYY-MM-DD HH:MM`; '' when the timestamp is missing/unparseable. */
export function formatLocalTimestamp(value) {
  if (typeof value !== 'string' || value === '') return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return (
    `${date.getFullYear()}-${TIMESTAMP_PAD(date.getMonth() + 1)}-${TIMESTAMP_PAD(date.getDate())}` +
    ` ${TIMESTAMP_PAD(date.getHours())}:${TIMESTAMP_PAD(date.getMinutes())}`
  )
}

const ANNOTATION_OUTPUT_ITEM = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string' },
    style: { type: 'string', enum: ANNOTATION_STYLES },
    quote: { type: 'string' },
    note: { type: 'string' },
    status: { type: 'string', enum: ['pending', 'resolved'] },
    createdAt: { type: 'string' },
  },
  required: ['id', 'style', 'quote', 'status', 'createdAt'],
}

const TOOL_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string' },
    mode: { type: 'string', enum: INJECTION_MODES },
    total: { type: 'integer' },
    pending: { type: 'integer' },
    changed: { type: 'array', items: { type: 'string' } },
    annotations: { type: 'array', items: ANNOTATION_OUTPUT_ITEM },
  },
  required: ['action', 'mode', 'total', 'pending', 'changed', 'annotations'],
}

function renderToolResult(_args, value) {
  const annotations = Array.isArray(value?.annotations) ? value.annotations : []
  const changed = Array.isArray(value?.changed) ? value.changed : []
  const lines = []
  const action = value?.action ?? 'list'
  if (action === 'resolve') lines.push(changed.length === 0 ? '没有需要确认的标注。' : `已确认处理 ${changed.length} 条标注。`)
  if (action === 'reopen') lines.push(changed.length === 0 ? '没有标注被重新打开。' : `已重新打开 ${changed.length} 条标注。`)
  if (action === 'delete') lines.push(changed.length === 0 ? '没有标注被删除。' : `已删除 ${changed.length} 条标注。`)
  if (action === 'clear') lines.push(`已清空 ${changed.length} 条标注。`)
  if (action === 'set-mode') lines.push(`注入模式已改为 ${value?.mode === 'full' ? '完整' : '精简'}。`)
  if (annotations.length === 0) {
    lines.push('当前对话没有标注。')
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const pending = typeof value?.pending === 'number' ? value.pending : 0
  lines.push(`当前对话共 ${annotations.length} 条标注，其中 ${pending} 条待处理：`)
  for (const annotation of annotations) {
    const time = formatLocalTimestamp(annotation?.createdAt)
    const state = annotation?.status === 'resolved' ? '已处理' : '待处理'
    let line = `- [#${annotation?.id}] ${styleLabel(annotation?.style)}（${state}）“${annotation?.quote ?? ''}”`
    if (annotation?.note) line += `｜${annotation.style === 'rewrite' ? '改为' : '批注'}：${annotation.note}`
    if (time !== '') line += `（${time}）`
    lines.push(line)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

function createAnnotationsTool(store) {
  return {
    name: TOOL_NAME,
    description:
      '查看或处理用户对你之前回答做的标注（高亮/下划线/删除/批注/改写）。' +
      '处理完待处理标注后用 action=resolve 确认（ids 可省略表示全部）；' +
      '用户要看标注时 action=list；用户要撤销处理或再处理一遍用 reopen；删除用 delete/clear。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'resolve', 'reopen', 'delete', 'clear', 'set-mode'],
          description:
            'list=列出（默认）；resolve=确认已处理；reopen=重新打开让它们下一轮再出现；' +
            'delete=按 ids 删除；clear=清空；set-mode=切换注入模式（配合 mode）。',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'resolve/reopen/delete 作用的标注 id；resolve 与 reopen 省略时表示全部。',
        },
        mode: {
          type: 'string',
          enum: INJECTION_MODES,
          description: 'set-mode 时使用：brief=只注入被标注的段落；full=注入整条回答的修订视图。',
        },
      },
    },
    output: {
      schema: TOOL_OUTPUT,
      render: renderToolResult,
    },
    async execute(args, exec) {
      const sessionId = exec?.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') {
        throw new AnnotateInputError('no-session', '当前没有可用的对话，无法读取标注。')
      }
      const action = args?.action ?? 'list'
      const ids = Array.isArray(args?.ids)
        ? args.ids.filter(id => typeof id === 'string' && id.trim() !== '')
        : []
      let changed = []
      if (action === 'list') {
        // nothing to change
      } else if (action === 'resolve') {
        changed = store.resolve(sessionId, ids, { by: 'model' })
      } else if (action === 'reopen') {
        changed = store.reopen(sessionId, ids)
      } else if (action === 'delete') {
        if (ids.length === 0) throw new AnnotateInputError('missing-ids', 'delete 需要提供要删除的标注 id。')
        changed = store.list(sessionId).filter(item => ids.includes(item.id)).map(item => item.id)
        store.remove(sessionId, ids)
      } else if (action === 'clear') {
        changed = store.list(sessionId).map(item => item.id)
        store.clear(sessionId)
      } else if (action === 'set-mode') {
        store.setMode(sessionId, validateMode(args?.mode))
      } else {
        throw new AnnotateInputError('invalid-action', '未知的 action。')
      }
      const annotations = store.list(sessionId)
      return {
        action,
        mode: store.getMode(sessionId),
        total: annotations.length,
        pending: annotations.filter(item => item.status !== 'resolved').length,
        changed,
        annotations,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Annotations',
      kind: 'other',
      rawInput: { action: args?.action ?? 'list', ...(Array.isArray(args?.ids) ? { ids: args.ids } : {}) },
    }),
  }
}

// ------------------------------------------------------------- injection

function isDirectUserMessage(message) {
  const kind = message?.source?.kind
  return kind === 'user' || kind === undefined
}

/**
 * Build the pre-step listener. Exported for tests. The listener enters one
 * context message right after the user's own message on the first step of a
 * turn that has pending, still-injectable annotations.
 */
export function createPreStepListener(store, { logger, maxInjections = DEFAULT_MAX_INJECTIONS, messageId } = {}) {
  const newId = typeof messageId === 'function' ? messageId : () => `dsa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  return async function onPreStep(payload, next) {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      if (payload?.step !== 1) return decision
      if (payload?.signal?.aborted) return decision
      const sessionId = payload?.agent?.id
      if (typeof sessionId !== 'string' || sessionId === '') return decision
      // Only a turn the user started gets the context; tool continuations and
      // other plugins' synthetic turns are left alone.
      const anchorIndex = decision.messages.findLastIndex(isDirectUserMessage)
      if (anchorIndex < 0) return decision
      const pending = store.pending(sessionId)
      if (pending.length === 0) return decision
      // Count this turn for every pending annotation; the ones past the cap
      // settle as `cap` here so they stop showing up as pending in the UI.
      const marked = store.markInjected(
        sessionId,
        pending.map(item => item.id),
        { turn: payload?.turn, cap: maxInjections },
      )
      if (marked.injected.length === 0) return decision
      const snapshot = store.snapshot(sessionId)
      const injected = snapshot.annotations.filter(item => marked.injected.includes(item.id))
      const text = buildInjection({ ...snapshot, annotations: injected }, { turn: payload?.turn })
      if (text === '') return decision
      const message = Object.freeze({
        id: newId(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: SOURCE_KIND, form: 'snapshot', sections: [{ name: SOURCE_KIND, text }] },
      })
      const messages = decision.messages.slice()
      messages.splice(anchorIndex + 1, 0, message)
      return { ...decision, messages }
    } catch (error) {
      logger?.warn?.(`dsh-annotate: cannot inject annotations: ${String(error)}`)
      return decision
    }
  }
}

// ------------------------------------------------------------------ plugin

export function apply(ctx, config = {}) {
  const logger = ctx.logger ?? console
  const statePath = resolveStatePath()
  const maxInjections = Number.isInteger(config?.maxInjections) && config.maxInjections > 0
    ? config.maxInjections
    : DEFAULT_MAX_INJECTIONS
  const store = new AnnotationStore(statePath, { logger, defaultMode: config?.defaultMode })
  const handler = createAnnotationsHandler({ store, logger })

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler }),
    'dsh-annotate: annotations route',
  )

  ctx.effect(
    () => ctx.tools.register(createAnnotationsTool(store)),
    'dsh-annotate: annotations tool',
  )

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: ({ scope } = {}) => {
          try {
            const sessionId = typeof scope?.id === 'string' ? scope.id : ''
            if (sessionId === '') return ''
            return buildProtocolSection(store.pending(sessionId).length)
          } catch (error) {
            logger?.warn?.(`dsh-annotate: cannot build the annotations prompt section: ${String(error)}`)
            return ''
          }
        },
      }),
    'dsh-annotate: annotations prompt section',
  )

  if (typeof ctx.on === 'function') {
    ctx.on('agent/pre-step', createPreStepListener(store, { logger, maxInjections }))
  } else {
    logger?.warn?.('dsh-annotate: ctx.on is unavailable; annotations will not be injected')
  }

  logger?.info?.(`dsh-annotate: ready (${statePath}, mode=${store.defaultMode}, maxInjections=${maxInjections})`)
}
