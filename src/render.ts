import { spawnSync } from 'node:child_process'
import { styleText } from 'node:util'
import type { Hunk } from './diff.ts'
import { gitTry } from './git.ts'
import { refLabel, sliceStats } from './selection.ts'
import { IMPACT, servesOf, type Attention, type AttentionLevel, type Group, type GlossNote, type Impact, type Necessity } from './schema.ts'

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

const IMPACT_STYLE: Record<Impact, 'gray' | 'white' | 'yellow' | 'magenta' | 'red'> = {
  local: 'gray',
  module: 'white',
  shared: 'yellow',
  contract: 'magenta',
  sensitive: 'red',
}

// "[contract]", padded to `pad` columns.
export function impactTag(i: Impact, pad = 0): string {
  return style(['bold', IMPACT_STYLE[i]], `[${i}]`) + ' '.repeat(Math.max(0, pad - i.length - 2))
}

// Width of the widest impact tag, "[sensitive]".
export const IMPACT_W = Math.max(...IMPACT.map((i) => i.length)) + 2

const ATTENTION_STYLE: Record<AttentionLevel, 'gray' | 'cyan' | 'yellow' | 'red'> = {
  skim: 'gray',
  look: 'cyan',
  careful: 'yellow',
  'must-read': 'red',
}

// "attention: CAREFUL · focus: a, b" with the reasons beneath; "unrated" for
// a gloss that declares none.
export function attentionBlock(a: Attention | undefined): string[] {
  if (!a) return [style('dim', 'attention: unrated')]
  const head = `attention: ${style(['bold', ATTENTION_STYLE[a.level]], a.level.toUpperCase())}` +
    (a.focus?.length ? ` · focus: ${a.focus.join(', ')}` : '')
  return [head, ...(a.reasons ?? []).flatMap((r) => field('•', r)),
    ...(a.override_reason ? field('override:', a.override_reason) : [])]
}

export const termWidth = () => Math.min(process.stdout.columns || 100, 120)

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

// "h6:5-12  src/x.ts  -10,20 +10,25  +6 -2", with counts for the selected lines.
export function hunkLabel(h: Hunk, lines: Set<number> | null = null): string {
  const range = h.newLines || h.oldLines
    ? `-${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}`
    : 'file header'
  const file = h.oldFile && h.oldFile !== h.file ? `${h.oldFile} → ${h.file}` : h.file
  const s = sliceStats(h, lines)
  return `${style('bold', refLabel(h.id, lines))}  ${file}  ${style('dim', range)}  ${style('green', `+${s.added}`)} ${style('red', `-${s.removed}`)}`
}

export function colorDiff(text: string, indent = ''): string {
  return text
    .split('\n')
    .map((l) => {
      const s: Style | null = l.startsWith('@@') ? 'cyan'
        : l.startsWith('+') ? 'green'
        : l.startsWith('-') ? 'red'
        : l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('⋯') ? 'dim'
        : null
      return indent + (s ? style(s, l) : l)
    })
    .join('\n')
}

export function groupHeader(g: Group): string[] {
  const impact = g.impact ? ` [${g.impact}]` : ''
  const prefix = `■ [${g.necessity}]${impact} `
  const out = wrap(g.intent, termWidth() - prefix.length).map((l, i) =>
    (i === 0 ? `${style('bold', '■')} ${necessityTag(g.necessity)}${g.impact ? ' ' + impactTag(g.impact) : ''} ` : ' '.repeat(prefix.length)) + style('bold', l))
  out[out.length - 1] += ' ' + style('dim', `(${g.id})`)
  const serves = servesOf(g)
  if (serves[0] !== 'task') out.push(...field('serves:', serves.join(', ')))
  out.push(...field('if removed:', g.removal_impact))
  if (g.impact_reason) out.push(...field('impact:', g.impact_reason))
  if (g.evidence) out.push(...field('evidence:', g.evidence))
  if (g.notes) out.push(...field('notes:', g.notes))
  return out
}

export function risksBlock(note: GlossNote): string[] {
  const risks = note.annotation.risks ?? []
  return risks.length ? ['', style('bold', 'Risks'), ...risks.flatMap((r) => field('•', r))] : []
}

export function noteFooter(note: GlossNote): string[] {
  const out: string[] = []
  const a = note.annotation
  if (a.alternatives?.length) {
    out.push('', style('bold', 'Alternatives considered'))
    for (const alt of a.alternatives) out.push(...field('•', `${alt.option}: ${alt.rejected_because}`))
  }
  return [...out, ...risksBlock(note)]
}

// The pager git would use for `git gloss`: pager.gloss if set (false turns it
// off), else GIT_PAGER, core.pager, PAGER, less. `git --no-pager` reaches us
// as GIT_PAGER=cat.
export function pagerCommand(): string | null {
  if (process.env.GIT_PAGER_IN_USE) return null
  const own = gitTry(['config', 'pager.gloss'])?.trim()
  if (own !== undefined && own !== '') {
    const off = gitTry(['config', '--type=bool', 'pager.gloss'])?.trim()
    if (off === 'false') return null
    if (off !== 'true') return own
  }
  const pager = gitTry(['var', 'GIT_PAGER'])?.trim()
  return !pager || pager === 'cat' ? null : pager
}

// Run the pager; print directly only if it could not run at all. Quitting the
// pager early makes our write fail with EPIPE, which is not a reason to dump
// the rest of the output on the terminal.
export function runPager(pager: string, text: string): void {
  const r = spawnSync('sh', ['-c', pager], {
    input: text + '\n',
    stdio: ['pipe', 'inherit', 'inherit'],
    env: { LESS: 'FRX', LV: '-c', ...process.env, GIT_PAGER_IN_USE: 'true' },
  })
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code
  if ((r.error && code !== 'EPIPE') || r.status === 127) console.log(text)
}

// Page output that won't fit on screen, as git does.
export function page(text: string): void {
  const rows = process.stdout.rows
  const pager = process.stdout.isTTY && rows && text.split('\n').length >= rows ? pagerCommand() : null
  if (pager) runPager(pager, text)
  else console.log(text)
}
