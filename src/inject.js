// dsh-annotate — the model-facing text for a batch of pending annotations.
//
// Two view modes, chosen per session by the user:
//   • `brief`: only the annotated passages, each with a little context;
//   • `full`:  the whole captured message with inline markers (a revision view).
// Both carry the annotation ids so the model can settle them with the
// `annotations` tool (`action: resolve`).

export const STYLE_META = {
  highlight: { label: '高亮', meaning: '这是用户要的：保留并强化这个方向' },
  underline: { label: '下划线', meaning: '这里不够：展开、澄清或给出依据' },
  strike: { label: '删除', meaning: '去掉：下一版不要再出现' },
  comment: { label: '批注', meaning: '按批注内容处理，并逐条回应' },
  rewrite: { label: '改写', meaning: '以用户改写后的文字为准' },
}

export const TOOL_NAME = 'annotations'
export const SOURCE_KIND = 'dsh-annotate'
export const BRIEF_CONTEXT_CHARS = 60
export const MAX_FULL_MESSAGE_CHARS = 12000

function styleLabel(style) {
  return STYLE_META[style]?.label ?? '标注'
}

function flat(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

function clip(text, max) {
  const value = flat(text)
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function compareCreatedAt(left, right) {
  const a = Date.parse(left?.createdAt ?? '') || 0
  const b = Date.parse(right?.createdAt ?? '') || 0
  return a - b
}

/** The legend every injection shares; also reused by the prompt section. */
export function legendText() {
  return Object.values(STYLE_META)
    .map(meta => `${meta.label}=${meta.meaning}`)
    .join('；')
}

/** One annotation as a brief line pair (numbered, with its id). */
export function briefLine(annotation, index) {
  const label = styleLabel(annotation.style)
  const quote = clip(annotation.quote, 300)
  const head = `${index + 1}. [#${annotation.id}] ${label}：“${quote}”`
  const lines = [head]
  if (annotation.style === 'comment' && annotation.note) lines.push(`   用户批注：${clip(annotation.note, 600)}`)
  if (annotation.style === 'rewrite' && annotation.note) lines.push(`   改为：“${clip(annotation.note, 600)}”`)
  const prefix = clip(annotation.prefix, BRIEF_CONTEXT_CHARS)
  const suffix = clip(annotation.suffix, BRIEF_CONTEXT_CHARS)
  if (prefix !== '' || suffix !== '') {
    const left = prefix === '' ? '' : `…${prefix.slice(-BRIEF_CONTEXT_CHARS)}`
    const right = suffix === '' ? '' : `${suffix.slice(0, BRIEF_CONTEXT_CHARS)}…`
    lines.push(`   上下文：${left}【${clip(annotation.quote, 120)}】${right}`)
  }
  return lines.join('\n')
}

function marker(annotation, number) {
  const label = styleLabel(annotation.style)
  const quote = flat(annotation.quote)
  if (annotation.style === 'rewrite') return `[[#${number} ${label}：${quote} → ${flat(annotation.note)}]]`
  if (annotation.style === 'comment') return `[[#${number} ${label}：${quote} ‖ 用户批注：${flat(annotation.note)}]]`
  return `[[#${number} ${label}：${quote}]]`
}

/**
 * Render one captured message with inline markers. Overlapping annotations
 * cannot both be inlined; the later ones are returned in `leftover` for the
 * brief fallback. Each inlined annotation gets a sequence number that the
 * footnote maps back to its id.
 */
export function renderFullMessage(text, annotations, startNumber = 1) {
  const sorted = [...annotations]
    .filter(item => Number.isInteger(item.messageStart) && Number.isInteger(item.messageEnd))
    .sort((a, b) => a.messageStart - b.messageStart || a.messageEnd - b.messageEnd)
  const inlined = []
  const leftover = []
  let cursor = 0
  let out = ''
  let number = startNumber
  for (const item of sorted) {
    const start = Math.max(0, Math.min(item.messageStart, text.length))
    const end = Math.max(start, Math.min(item.messageEnd, text.length))
    const slice = text.slice(start, end)
    // The offsets must still describe the quote; otherwise the capture went stale.
    if (start < cursor || end <= start || flat(slice) !== flat(item.quote)) {
      leftover.push(item)
      continue
    }
    out += text.slice(cursor, start)
    out += marker({ ...item, quote: slice }, number)
    inlined.push({ number, annotation: item })
    number += 1
    cursor = end
  }
  out += text.slice(cursor)
  return { text: out, inlined, leftover, nextNumber: number }
}

/**
 * Build the whole injection. `snapshot` is `store.snapshot(sessionId)`
 * restricted to the annotations being injected; `turn` is the turn that is
 * about to start. Returns '' when there is nothing to say.
 */
export function buildInjection(snapshot, { turn } = {}) {
  const pending = [...(snapshot?.annotations ?? [])].sort(compareCreatedAt)
  if (pending.length === 0) return ''
  const mode = snapshot?.mode === 'full' ? 'full' : 'brief'
  const ids = pending.map(item => item.id)
  const lines = []
  const turnLabel = Number.isInteger(turn) ? `（第 ${turn} 轮之前）` : ''
  lines.push(`## 用户对你之前回答的标注${turnLabel}`)
  lines.push('')
  lines.push(`用户在你之前的回答上做了 ${pending.length} 处标注，这是用户修改后希望你理解的样子。含义：${legendText()}。`)
  lines.push('')

  if (mode === 'full') {
    const groups = new Map()
    const unanchored = []
    for (const item of pending) {
      const message = item.messageKey !== '' ? snapshot.messages?.[item.messageKey] : undefined
      if (message === undefined || typeof message.text !== 'string') {
        unanchored.push(item)
        continue
      }
      if (!groups.has(item.messageKey)) groups.set(item.messageKey, { message, items: [] })
      groups.get(item.messageKey).items.push(item)
    }
    let number = 1
    const footnotes = []
    for (const [, group] of groups) {
      const text = group.message.text.length > MAX_FULL_MESSAGE_CHARS
        ? `${group.message.text.slice(0, MAX_FULL_MESSAGE_CHARS)}\n…（后文略）`
        : group.message.text
      const rendered = renderFullMessage(text, group.items, number)
      number = rendered.nextNumber
      const where = Number.isInteger(group.message.turn) ? `第 ${group.message.turn} 轮的回答` : '你的一条回答'
      lines.push(`### ${where}（修订视图，标记写作 [[#序号 类型：原文]]）`)
      lines.push('')
      lines.push(rendered.text)
      lines.push('')
      for (const entry of rendered.inlined) {
        footnotes.push(`#${entry.number} → id ${entry.annotation.id}（${styleLabel(entry.annotation.style)}）`)
      }
      unanchored.push(...rendered.leftover)
    }
    if (footnotes.length > 0) {
      lines.push('标记序号对应的标注 id：')
      lines.push(...footnotes.map(line => `- ${line}`))
      lines.push('')
    }
    if (unanchored.length > 0) {
      lines.push('### 其余标注（未能内嵌到完整消息里）')
      lines.push('')
      unanchored.sort(compareCreatedAt).forEach((item, index) => lines.push(briefLine(item, index)))
      lines.push('')
    }
  } else {
    pending.forEach((item, index) => lines.push(briefLine(item, index)))
    lines.push('')
  }

  lines.push(
    `按这些标注调整你的下一条回答。处理完后调用 \`${TOOL_NAME}\` 工具，action 传 resolve，ids 传已处理的标注 id` +
      `（全部处理可省略 ids）：${ids.map(id => `#${id}`).join('、')}。` +
      '还需要用户确认、或打算下一轮再处理的标注，不要 resolve，它们会再次出现。',
  )
  return lines.join('\n')
}

/** The static protocol section shown while a session has pending annotations. */
export function buildProtocolSection(pendingCount) {
  if (!Number.isInteger(pendingCount) || pendingCount <= 0) return ''
  return [
    '## 用户标注协议',
    '',
    '用户可以在对话里像在 Word 中一样对你的回答做标注：' + legendText() + '。',
    `待处理的标注会在每一轮开始时作为一条用户上下文消息送给你（当前 ${pendingCount} 条）。` +
      `处理完要调用 \`${TOOL_NAME}\` 工具（action: resolve，可带 ids）确认，否则它们会在下一轮再次出现；` +
      '想看完整列表用 action: list。',
  ].join('\n')
}
