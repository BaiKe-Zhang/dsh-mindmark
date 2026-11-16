// Unit tests for the lesson store (distilled preferences in $DSH_HOME/AGENTS.md).

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import {
  BLOCK_END,
  BLOCK_START,
  composeInstructions,
  LessonStore,
  MAX_LESSONS,
  normalizeLesson,
  parseInstructions,
  resolveInstructionsPath,
} from '../src/lessons.js'

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mindmark-lessons-'))
after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true })
})

let counter = 0
function tempFile() {
  counter += 1
  return path.join(tempRoot, `home-${counter}`, 'AGENTS.md')
}

test('resolveInstructionsPath follows DSH_HOME with a ~/.dsh fallback', () => {
  assert.equal(resolveInstructionsPath({ DSH_HOME: 'C:/x/home' }), path.join('C:/x/home', 'AGENTS.md'))
  assert.equal(resolveInstructionsPath({}), path.join(os.homedir(), '.dsh', 'AGENTS.md'))
})

test('normalizeLesson strips bullets, dates and whitespace, and clips', () => {
  assert.equal(normalizeLesson('  - [2026-11-16]  先给 例子 '), '先给 例子')
  assert.equal(normalizeLesson('• x'), 'x')
  assert.equal(normalizeLesson(7), '')
  assert.equal(normalizeLesson('长'.repeat(400)).length, 300)
})

test('parse/compose keep user content outside the managed block byte for byte', () => {
  const body = '# My rules\n\nAlways be brief.\n\n' + BLOCK_START + '\n## t\n\n- [2026-11-01] 旧偏好\n' + BLOCK_END + '\n\n# Tail\nkeep me\n'
  const parsed = parseInstructions(body)
  assert.equal(parsed.before, '# My rules\n\nAlways be brief.\n\n')
  assert.deepEqual(parsed.lessons, [{ date: '2026-11-01', text: '旧偏好' }])
  assert.equal(parsed.after, '\n\n# Tail\nkeep me\n')
  const out = composeInstructions(parsed, [...parsed.lessons, { date: '2026-11-16', text: '新偏好' }])
  assert.ok(out.startsWith('# My rules\n\nAlways be brief.\n\n' + BLOCK_START))
  assert.ok(out.includes('- [2026-11-01] 旧偏好\n- [2026-11-16] 新偏好\n' + BLOCK_END))
  assert.ok(out.endsWith('\n\n# Tail\nkeep me\n'))
  // removing every lesson drops the block but keeps the rest
  assert.equal(composeInstructions(parsed, []), '# My rules\n\nAlways be brief.\n\n# Tail\nkeep me\n')
  // a file without a block is left untouched
  assert.deepEqual(parseInstructions('plain\n'), { before: 'plain\n', lessons: [], after: '' })
})

test('LessonStore adds with dedupe, lists, removes by text or index, and creates the file', () => {
  const file = tempFile()
  const store = new LessonStore(file)
  assert.deepEqual(store.list(), [])
  assert.ok(!fs.existsSync(file), 'listing never creates the file')
  const first = store.add(['解释概念时先给具体例子', '  解释概念时先给具体例子 ', '不要用列表'])
  assert.deepEqual(first.added, ['解释概念时先给具体例子', '不要用列表'])
  assert.deepEqual(first.skipped, ['解释概念时先给具体例子'])
  assert.ok(fs.existsSync(file))
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.includes(BLOCK_START) && text.includes(BLOCK_END))
  assert.match(text, /- \[\d{4}-\d{2}-\d{2}\] 解释概念时先给具体例子/)
  assert.deepEqual(store.add('不要用列表').added, [])
  assert.deepEqual(store.remove(['2']), ['不要用列表'])
  assert.deepEqual(store.remove('不存在的'), [])
  assert.deepEqual(store.remove(['解释概念时先给具体例子']), ['解释概念时先给具体例子'])
  assert.deepEqual(store.list(), [])
  assert.equal(fs.readFileSync(file, 'utf8'), '')
})

test('LessonStore keeps the newest lessons when the cap is exceeded', () => {
  const store = new LessonStore(tempFile())
  store.add(Array.from({ length: MAX_LESSONS + 5 }, (_, i) => `偏好 ${i}`))
  const lessons = store.list()
  assert.equal(lessons.length, MAX_LESSONS)
  assert.equal(lessons[0].text, '偏好 5')
  assert.equal(lessons[lessons.length - 1].text, `偏好 ${MAX_LESSONS + 4}`)
})

test('an unreadable file is treated as empty and a user file with other content survives', () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '# mine\n\n- rule A\n')
  const store = new LessonStore(file, { logger: { warn() {} } })
  store.add('新偏好')
  const text = fs.readFileSync(file, 'utf8')
  assert.ok(text.startsWith('# mine\n\n- rule A\n\n' + BLOCK_START))
  assert.ok(text.trimEnd().endsWith(BLOCK_END))
})
