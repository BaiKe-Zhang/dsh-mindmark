// Unit tests for the dsh-mindmark store (node:test, no network).
//
// Every test works inside a private temp directory so the real Harness home is
// never touched; the whole tree is removed once the file finishes.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import {
  AnnotationStore,
  AnnotateInputError,
  MAX_ANNOTATIONS_PER_SESSION,
  MAX_CONTEXT_LENGTH,
  MAX_ID_LENGTH,
  MAX_ROOT_SELECTOR_LENGTH,
  backupPathFor,
  emptyState,
  generateAnnotationId,
  loadStateFile,
  normalizeState,
  resolveStatePath,
  saveStateFile,
  validateAnnotationInput,
  validateSessionId,
} from '../src/store.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mindmark-store-'))
after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let fileCounter = 0
function tempFile(label) {
  fileCounter += 1
  return path.join(tempRoot, `${label}-${fileCounter}`, 'annotations', 'state.json')
}

function readState(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function makeAnnotation(overrides = {}) {
  return {
    id: 'ann_1',
    style: 'highlight',
    quote: '重点内容',
    prefix: '前文',
    suffix: '后文',
    rootSelector: 'body > div',
    createdAt: '2026-11-03T02:20:00.000Z',
    ...overrides,
  }
}

test('resolveStatePath resolves $DSH_HOME/annotations/state.json with a ~/.dsh fallback', () => {
  const home = path.join(tempRoot, 'dsh-home')
  assert.equal(resolveStatePath({ DSH_HOME: home }), path.join(home, 'annotations', 'state.json'))
  assert.equal(
    resolveStatePath({ DSH_HOME: '   ' }),
    path.join(os.homedir(), '.dsh', 'annotations', 'state.json'),
  )
  assert.equal(resolveStatePath({}), path.join(os.homedir(), '.dsh', 'annotations', 'state.json'))
})

test('normalizeState never throws and returns a safe empty document for garbage', () => {
  for (const raw of [undefined, null, 0, 'nope', true, [], { sessions: [] }, { sessions: 'x' }, { sessions: null }]) {
    assert.deepEqual(normalizeState(raw), emptyState())
  }
})

test('normalizeState drops malformed records, truncates context and keeps extra fields', () => {
  const state = normalizeState({
    version: 1,
    sessions: {
      sess_ok: {
        annotations: [
          makeAnnotation({ id: 'ann_ok', extra: 'keep-me' }),
          makeAnnotation({ id: '' }),
          makeAnnotation({ style: 'sparkle' }),
          makeAnnotation({ quote: '   ' }),
          makeAnnotation({ quote: 'x'.repeat(2001) }),
          makeAnnotation({ createdAt: 42 }),
          makeAnnotation({
            id: 'ann_long',
            prefix: 'p'.repeat(200),
            suffix: 's'.repeat(200),
            rootSelector: 'r'.repeat(400),
          }),
          'not-an-object',
          null,
        ],
      },
      sess_empty: { annotations: [] },
      sess_bad_annotations: { annotations: 'nope' },
      sess_not_object: 42,
    },
  })

  assert.deepEqual(Object.keys(state.sessions), ['sess_ok'])
  const annotations = state.sessions.sess_ok.annotations
  assert.equal(annotations.length, 2)
  assert.equal(annotations[0].id, 'ann_ok')
  assert.equal(annotations[0].extra, 'keep-me')
  assert.equal(annotations[1].prefix.length, MAX_CONTEXT_LENGTH)
  assert.equal(annotations[1].suffix.length, MAX_CONTEXT_LENGTH)
  assert.equal(annotations[1].rootSelector.length, MAX_ROOT_SELECTOR_LENGTH)
})

test('normalizeState re-applies the per-session cap, keeping the newest', () => {
  const annotations = Array.from({ length: MAX_ANNOTATIONS_PER_SESSION + 5 }, (_, index) =>
    makeAnnotation({ id: `ann_${index}`, quote: `引用 ${index}` }),
  )
  const state = normalizeState({ sessions: { sess_cap: { annotations } } })
  const list = state.sessions.sess_cap.annotations
  assert.equal(list.length, MAX_ANNOTATIONS_PER_SESSION)
  assert.equal(list[0].quote, '引用 5')
  assert.equal(list.at(-1).quote, `引用 ${MAX_ANNOTATIONS_PER_SESSION + 4}`)
})

test('validateSessionId enforces the session-id bounds', () => {
  assert.equal(validateSessionId('sess_x'), 'sess_x')
  assert.equal(validateSessionId('x'.repeat(200)), 'x'.repeat(200))
  for (const value of ['', '   ', 42, null, undefined, 'x'.repeat(201)]) {
    assert.throws(() => validateSessionId(value), /会话 ID 无效/)
  }
})

test('validateAnnotationInput fills defaults and truncates oversized hints', () => {
  const generated = validateAnnotationInput({ style: 'underline', quote: '  选中的文字  ' })
  assert.match(generated.id, /^ann_/)
  assert.ok(generated.id.length <= MAX_ID_LENGTH)
  assert.ok(!Number.isNaN(new Date(generated.createdAt).getTime()))
  assert.equal(generated.prefix, '')
  assert.equal(generated.suffix, '')
  assert.equal(generated.rootSelector, '')
  assert.equal(generated.quote, '  选中的文字  ')

  const long = validateAnnotationInput({
    id: 'i'.repeat(200),
    style: 'highlight',
    quote: 'q',
    prefix: 'p'.repeat(200),
    suffix: 's'.repeat(200),
    rootSelector: 'r'.repeat(400),
    createdAt: '2026-11-03T02:20:00.000Z',
  })
  assert.equal(long.id.length, MAX_ID_LENGTH)
  assert.equal(long.prefix.length, MAX_CONTEXT_LENGTH)
  assert.equal(long.suffix.length, MAX_CONTEXT_LENGTH)
  assert.equal(long.rootSelector.length, MAX_ROOT_SELECTOR_LENGTH)
})

test('validateAnnotationInput rejects malformed wire records with Chinese messages', () => {
  assert.throws(() => validateAnnotationInput(null), AnnotateInputError)
  assert.throws(() => validateAnnotationInput({ style: 'sparkle', quote: 'x' }), /标注类型/)
  assert.throws(() => validateAnnotationInput({ style: 'highlight', quote: '   ' }), /标注文本/)
  assert.throws(() => validateAnnotationInput({ style: 'highlight', quote: 'x'.repeat(2001) }), /标注文本/)
  assert.throws(() => validateAnnotationInput({ style: 'highlight', quote: 'x', createdAt: 7 }), /时间/)
  assert.throws(
    () => validateAnnotationInput({ style: 'highlight', quote: 'x', prefix: 7 }),
    /上下文/,
  )
  try {
    validateAnnotationInput({})
    assert.fail('expected a validation error')
  } catch (error) {
    assert.ok(error instanceof AnnotateInputError)
    assert.equal(error.code, 'invalid-annotation-style')
  }
})

test('generateAnnotationId produces small, distinct ids', () => {
  const ids = new Set(Array.from({ length: 50 }, () => generateAnnotationId()))
  assert.equal(ids.size, 50)
  for (const id of ids) {
    assert.match(id, /^ann_/)
    assert.ok(id.length <= MAX_ID_LENGTH)
  }
})

test('AnnotationStore lists oldest first, isolates sessions and dedupes identical marks', () => {
  const file = tempFile('dedupe')
  const store = new AnnotationStore(file)
  assert.deepEqual(store.list('sess_a'), [])

  const first = store.add('sess_a', makeAnnotation({ id: 'ann_first', createdAt: '2026-11-03T01:00:00.000Z' }))
  assert.equal(first.deduped, false)
  assert.deepEqual(store.list('sess_a').map(annotation => annotation.id), ['ann_first'])

  store.add(
    'sess_a',
    makeAnnotation({ id: 'ann_second', quote: '另一段', createdAt: '2026-11-03T03:00:00.000Z' }),
  )
  assert.deepEqual(store.list('sess_a').map(annotation => annotation.id), ['ann_first', 'ann_second'])
  assert.deepEqual(store.list('sess_b'), [], 'sessions are isolated')

  // Same (style, quote, prefix, suffix): refreshed in place, moved to the end.
  const refreshed = store.add(
    'sess_a',
    makeAnnotation({ id: 'ann_third', createdAt: '2026-11-04T05:00:00.000Z' }),
  )
  assert.equal(refreshed.deduped, true)
  assert.equal(refreshed.annotation.id, 'ann_first')
  assert.equal(refreshed.annotation.createdAt, '2026-11-04T05:00:00.000Z')
  const list = store.list('sess_a')
  assert.equal(list.length, 2)
  assert.deepEqual(list.map(annotation => annotation.id), ['ann_second', 'ann_first'])
})

test('AnnotationStore caps one session at 300 annotations, dropping the oldest', () => {
  const file = tempFile('cap')
  const store = new AnnotationStore(file)
  for (let index = 0; index < MAX_ANNOTATIONS_PER_SESSION + 1; index += 1) {
    store.add('sess_cap', makeAnnotation({ id: `ann_${index}`, quote: `引用 ${index}` }))
  }
  const list = store.list('sess_cap')
  assert.equal(list.length, MAX_ANNOTATIONS_PER_SESSION)
  assert.equal(list[0].quote, '引用 1')
  assert.equal(list.at(-1).quote, `引用 ${MAX_ANNOTATIONS_PER_SESSION}`)

  store.add('sess_other', makeAnnotation({ id: 'ann_other', quote: '别处' }))
  assert.equal(store.list('sess_other').length, 1)
})

test('remove and clear drop empty session keys instead of leaving residue', () => {
  const file = tempFile('residue')
  const store = new AnnotationStore(file)
  store.add('sess_remove', makeAnnotation({ id: 'ann_a' }))
  store.add('sess_remove', makeAnnotation({ id: 'ann_b', quote: '第二段' }))

  assert.equal(store.remove('sess_remove', ['ann_a', 'missing']), 1)
  assert.equal(store.list('sess_remove').length, 1)
  assert.deepEqual(Object.keys(readState(file).sessions), ['sess_remove'])

  assert.equal(store.remove('sess_remove', ['ann_b']), 1)
  assert.deepEqual(store.list('sess_remove'), [])
  assert.deepEqual(readState(file).sessions, {}, 'the empty session key is written out')

  store.add('sess_clear', makeAnnotation({ id: 'ann_c', quote: '清空前' }))
  assert.equal(store.clear('sess_clear'), 1)
  assert.deepEqual(readState(file).sessions, {})
  assert.deepEqual(store.list('sess_clear'), [])

  assert.equal(store.remove('sess_unknown', ['x']), 0)
  assert.equal(store.clear('sess_unknown'), 0)
})

test('annotations survive a full store round-trip in a temp dir', () => {
  const file = tempFile('roundtrip')
  const store = new AnnotationStore(file)
  const record = makeAnnotation({ id: 'ann_persisted', quote: '会被保存' })
  store.add('sess_rt', record)
  assert.ok(fs.existsSync(file))

  const reopened = new AnnotationStore(file)
  const annotations = reopened.list('sess_rt')
  assert.equal(annotations.length, 1)
  for (const [key, value] of Object.entries(record)) {
    assert.deepEqual(annotations[0][key], value)
  }
  const onDisk = readState(file)
  assert.equal(onDisk.version, 2)
  assert.equal(onDisk.sessions.sess_rt.annotations[0].id, 'ann_persisted')
  assert.ok(
    fs.readdirSync(path.dirname(file)).every(name => !name.endsWith('.tmp')),
    'no temp files are left behind',
  )
})

test('save keeps one previous good copy as state.backup.json', () => {
  const file = tempFile('backup')
  const store = new AnnotationStore(file)
  store.add('sess_b', makeAnnotation({ id: 'ann_one' }))
  store.add('sess_b', makeAnnotation({ id: 'ann_two', quote: '第二段' }))

  const backup = backupPathFor(file)
  assert.equal(path.basename(backup), 'state.backup.json')
  assert.ok(fs.existsSync(backup))
  const previous = JSON.parse(fs.readFileSync(backup, 'utf8'))
  assert.deepEqual(
    previous.sessions.sess_b.annotations.map(annotation => annotation.id),
    ['ann_one'],
  )
})

test('a corrupt state file is moved aside and treated as empty', () => {
  const file = tempFile('corrupt')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ this is not json', 'utf8')

  const warnings = []
  const store = new AnnotationStore(file, { logger: { warn: message => warnings.push(message) } })
  assert.deepEqual(store.list('sess_x'), [])
  assert.ok(warnings.some(message => message.includes('unreadable')))
  assert.ok(
    fs.readdirSync(path.dirname(file)).some(name => name.startsWith('state.json.corrupt-')),
    'the corrupt original is kept as a backup',
  )

  // The store keeps working and rewrites a valid document.
  store.add('sess_x', makeAnnotation({ id: 'ann_after_corrupt' }))
  assert.equal(readState(file).sessions.sess_x.annotations.length, 1)
})

test('a save failure is logged but never thrown', () => {
  const warnings = []
  const blocker = path.join(tempRoot, 'not-a-directory')
  fs.writeFileSync(blocker, 'x', 'utf8')
  const file = path.join(blocker, 'annotations', 'state.json')

  let store
  assert.doesNotThrow(() => {
    store = new AnnotationStore(file, { logger: { warn: message => warnings.push(message) } })
  })
  const added = store.add('sess_fail', makeAnnotation({ id: 'ann_memory_only' }))
  assert.equal(added.deduped, false)
  assert.equal(store.list('sess_fail').length, 1, 'in-memory state stays usable')
  assert.equal(store.lastSaveError !== null, true)
  assert.ok(warnings.length >= 1)
})

test('loadStateFile treats a missing file as an empty document', () => {
  assert.deepEqual(loadStateFile(tempFile('missing')), emptyState())
})

test('saveStateFile prunes empty session keys from the document', () => {
  const file = tempFile('prune')
  const state = emptyState()
  state.sessions.empty = { annotations: [] }
  state.sessions.kept = { annotations: [makeAnnotation({ id: 'ann_kept' })] }
  saveStateFile(file, state)

  const onDisk = readState(file)
  assert.deepEqual(Object.keys(onDisk.sessions), ['kept'])
  assert.equal(onDisk.sessions.kept.annotations[0].id, 'ann_kept')
})
