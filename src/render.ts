import { spawnSync } from 'node:child_process'
import { styleText } from 'node:util'
import type { Hunk } from './diff.ts'
import { gitTry } from './git.ts'
import type { Group, GlossNote, Necessity } from './schema.ts'

type Style = Parameters<typeof styleText>[0]

export const style = (s: Style, text: string) => styleText(s, text)

const NECESSITY_STYLE: Record<Necessity, 'green' | 'cyan' | 'gray' | 'yellow' | 'blue' | 'magenta'> = {
  required: 'green',
  supporting: 'cyan',
  mechanical: 'gray',
  incidental: 'yellow',
  defensive: 'blue',
  speculative: 'magenta',
}

export function necessityTag(n: Necessity): string {
  return style(['bold', NECESSITY_STYLE[n]], `[${n}]`)
}

export function necessityWord(n: Necessity, pad = 0): string {
  return style(NECESSITY_STYLE[n], n.padEnd(pad))
}

export const termWidth = () => Math.min(process.stdout.columns || 100, 120)

export function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, ' ')
  return flat.length > width ? flat.slice(0, Math.max(0, width - 1)) + '…' : flat
}

// Word-wrap plain text to `width` columns.
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word }
    else line = line ? `${line} ${word}` : word
  }
  lines.push(line)
  return lines
}

// "label text" with continuation lines hanging under the text.
export function field(label: string, text: string, indent = 2): string[] {
  const hang = indent + label.length + 1
  const [first, ...rest] = wrap(text, Math.max(20, termWidth() - hang))
  return [' '.repeat(indent) + style('dim', label) + ' ' + first, ...rest.map((l) => ' '.repeat(hang) + l)]
}

export function hunkLabel(h: Hunk): string {
  const range = h.newLines || h.oldLines
    ? `-${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`
    : 'file header'
  const file = h.oldFile && h.oldFile !== h.file ? `${h.oldFile} → ${h.file}` : h.file
  return `${style('bold', h.id)}  ${file}  ${style('dim', range)}  ${style('green', `+${h.added}`)} ${style('red', `-${h.removed}`)}`
}

export function colorDiff(text: string, indent = ''): string {
  return text
    .split('\n')
    .map((l) => {
      const s: Style | null = l.startsWith('@@') ? 'cyan'
        : l.startsWith('+') ? 'green'
        : l.startsWith('-') ? 'red'
        : l.startsWith('diff ') || l.startsWith('index ') ? 'dim'
        : null
      return indent + (s ? style(s, l) : l)
    })
    .join('\n')
}

export function groupHeader(g: Group): string[] {
  const prefix = `■ [${g.necessity}] `
  const out = wrap(g.intent, termWidth() - prefix.length).map((l, i) =>
    (i === 0 ? `${style('bold', '■')} ${necessityTag(g.necessity)} ` : ' '.repeat(prefix.length)) + style('bold', l))
  out[out.length - 1] += ' ' + style('dim', `(${g.id})`)
  if (g.serves !== 'task') out.push(...field('serves:', g.serves))
  out.push(...field('if removed:', g.removal_impact))
  if (g.evidence) out.push(...field('evidence:', g.evidence))
  if (g.notes) out.push(...field('notes:', g.notes))
  return out
}

export function noteFooter(note: GlossNote): string[] {
  const out: string[] = []
  const a = note.annotation
  if (a.alternatives?.length) {
    out.push('', style('bold', 'Alternatives considered'))
    for (const alt of a.alternatives) out.push(...field('•', `${alt.option}: ${alt.rejected_because}`))
  }
  if (a.risks?.length) {
    out.push('', style('bold', 'Risks'))
    for (const r of a.risks) out.push(...field('•', r))
  }
  return out
}

// Print through git's pager (core.pager, GIT_PAGER, PAGER, else less) when the
// output won't fit on screen, as git itself does.
export function page(text: string): void {
  const rows = process.stdout.rows
  if (!process.stdout.isTTY || !rows || text.split('\n').length < rows) {
    console.log(text)
    return
  }
  const pager = gitTry(['var', 'GIT_PAGER'])?.trim()
  if (!pager || pager === 'cat') {
    console.log(text)
    return
  }
  const r = spawnSync('sh', ['-c', pager], {
    input: text + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { LESS: 'FRX', LV: '-c', ...process.env },
  })
  if (r.error) console.log(text)
}
