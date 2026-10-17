import { styleText } from 'node:util'
import type { Hunk } from './diff.ts'
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
  const out = [`${style('bold', '■')} ${necessityTag(g.necessity)} ${style('bold', g.intent)} ${style('dim', `(${g.id})`)}`]
  if (g.serves !== 'task') out.push(`  ${style('dim', 'serves:')} ${g.serves}`)
  out.push(`  ${style('dim', 'if removed:')} ${g.removal_impact}`)
  if (g.evidence) out.push(`  ${style('dim', 'evidence:')} ${g.evidence}`)
  if (g.notes) out.push(`  ${style('dim', 'notes:')} ${g.notes}`)
  return out
}

export function noteFooter(note: GlossNote): string[] {
  const out: string[] = []
  const a = note.annotation
  if (a.alternatives?.length) {
    out.push('', style('bold', 'Alternatives considered'))
    for (const alt of a.alternatives) out.push(`  • ${alt.option} ${style('dim', `— ${alt.rejected_because}`)}`)
  }
  if (a.risks?.length) {
    out.push('', style('bold', 'Risks'))
    for (const r of a.risks) out.push(`  • ${r}`)
  }
  return out
}
