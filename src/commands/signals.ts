import { plain } from '../plain.ts'
import { parseArgs } from 'node:util'
import { loadConfig } from '../config.ts'
import { commitDiff, diffBetween, git, GitError, resolveCommit, workingDiff } from '../git.ts'
import { parseDiff } from '../diff.ts'
import { analyze, CONFIG_EDIT_NOTE, type ChangeSignals } from '../signals.ts'
import { impactRank } from '../attention.ts'
import { ATTENTION_STYLE, impactTag, page, style } from '../render.ts'

export const usage = 'signals [<commit> | <range> | wip] [--json]   what the diff itself says about attention: path classes, pattern hits, dependency bumps and the computed floor'

const pct = (x: number) => `${Math.round(x * 100)}%`
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

const statsLine = (s: ChangeSignals['stats']) =>
  `${plural(s.files, 'file')}, ${plural(s.hunks, 'hunk')}, +${s.added} -${s.removed}, ${plural(s.testFiles, 'test file')}` +
  (s.hunks ? ` (${pct(s.testHunkShare)} of hunks in tests)` : '')

// The short form `hunks` prints at its end: the floor, the files that set it,
// and the stats.
export function summaryLines(sig: ChangeSignals, max = 6): string[] {
  const out = [style('bold', 'signals:') + ` floor attention = ${style(['bold', ATTENTION_STYLE[sig.floor.attention]], sig.floor.attention)}`]
  const files = sig.files.filter((f) => impactRank(f.floor) >= impactRank('shared'))
    .sort((a, b) => impactRank(b.floor) - impactRank(a.floor) || a.file.localeCompare(b.file))
  for (const f of files.slice(0, max)) out.push(`  ${(f.floor + ':').padEnd(10)} ${plain(f.file)}${f.why.length ? ` (${plain(f.why.join('; '))})` : ''}`)
  if (files.length > max) out.push(`  ... and ${files.length - max} more at shared or above (git gloss signals)`)
  for (const r of sig.floor.reasons.filter((r) => / files changed /.test(r))) out.push(`  large:     ${plain(r)}`)
  if (sig.floor.reasons.includes(CONFIG_EDIT_NOTE)) out.push(`  note:      ${CONFIG_EDIT_NOTE}`)
  out.push(`  stats: ${statsLine(sig.stats)}`)
  return out
}

function detailLines(sig: ChangeSignals, label: string): string[] {
  const out = [style('bold', `signals for ${label}:`) + ` floor attention = ${style(['bold', ATTENTION_STYLE[sig.floor.attention]], sig.floor.attention)}` +
    style('dim', `  (floor impact: ${sig.floor.impact})`)]
  for (const r of sig.floor.reasons) out.push(`  why: ${plain(r)}`)
  out.push(`  stats: ${statsLine(sig.stats)}`)

  const notable = sig.hunks.filter((h) => impactRank(h.floor) > impactRank('module') || h.hits.length)
  if (notable.length) out.push('', style('bold', 'hunks with signals'))
  for (const h of notable) {
    out.push(`  ${style('bold', h.id.padEnd(5))} ${impactTag(h.floor, 11)} ${plain(h.file)}` +
      style('dim', `  [${h.classes.join(', ') || 'no class'}]${h.why.length ? ' ' + plain(h.why.join('; ')) : ''}`))
    for (const x of h.hits.slice(0, 8)) {
      out.push(`        ${h.id}:${x.line} ${x.sign} ${x.class} pattern "${x.name}"${x.damped ? style('dim', ' (damped: test, docs or lockfile path)') : ''}  ${style('dim', plain(x.text))}`)
    }
    if (h.hits.length > 8) out.push(style('dim', `        ... ${h.hits.length - 8} more hits (--json)`))
  }
  const quiet = sig.hunks.length - notable.length
  if (quiet) out.push(style('dim', `  (${plural(quiet, 'other hunk')} at module or below, no pattern hits)`))

  if (sig.dependencies.length) out.push('', style('bold', 'dependency changes'))
  for (const d of sig.dependencies) {
    out.push(`  ${plain(d.file)} (${d.kind}${d.format ? `, parsed as ${d.format}` : d.kind === 'lockfile' ? ', no version detail for this format' : ''})`)
    for (const b of d.bumps.slice(0, 20)) {
      const what = plain(b.kind === 'bump' ? `${b.name} ${b.from} -> ${b.to}` : b.kind === 'added' ? `+ ${b.name} ${b.to}` : `- ${b.name} ${b.from}`)
      out.push(`    ${what}${b.unrelated ? style('yellow', '  (transitive: no manifest change names it)') : ''}`)
    }
    if (d.bumps.length > 20) out.push(style('dim', `    ... ${d.bumps.length - 20} more (--json)`))
  }
  return out
}

// The diff to analyse: wip is the working tree as it is now (no snapshot is taken).
function target(arg: string): { diff: string; label: string } {
  if (arg === 'wip') return { diff: workingDiff().diff, label: 'uncommitted changes' }
  if (arg.includes('...')) throw new GitError(`${arg}: use A..B for the commits on B since A`)
  if (arg.includes('..')) {
    const [a, b] = arg.split('..')
    const base = git(['merge-base', '--end-of-options', a || 'HEAD', b || 'HEAD']).trim()
    return { diff: diffBetween(base, resolveCommit(b || 'HEAD')), label: arg }
  }
  const sha = resolveCommit(arg)
  return { diff: commitDiff(sha), label: sha.slice(0, 10) }
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } })
  const { diff, label } = target(positionals[0] ?? 'HEAD')
  const sig = analyze(parseDiff(diff), loadConfig())
  if (values.json) {
    console.log(JSON.stringify({ target: label, ...sig }, null, 2))
    return 0
  }
  page(detailLines(sig, label).join('\n'))
  return 0
}
