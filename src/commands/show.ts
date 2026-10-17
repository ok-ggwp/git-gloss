import { parseArgs } from 'node:util'
import { resolveCommit } from '../git.ts'
import type { Hunk } from '../diff.ts'
import { loadGloss, type LoadedGroup } from '../loader.ts'
import { NECESSITY, type Necessity } from '../schema.ts'
import {
  colorDiff, field, groupHeader, hunkLabel, necessityWord, noteFooter, page, risksBlock, style, termWidth, wrap,
} from '../render.ts'

export const usage =
  'show [<commit>] [-g <group>]... [--full] [--diff] [--only <necessity,...>]   summarise a gloss; expand groups with -g'

function stats(hunks: Hunk[]): { count: number; added: number; removed: number } {
  return {
    count: hunks.length,
    added: hunks.reduce((n, h) => n + h.added, 0),
    removed: hunks.reduce((n, h) => n + h.removed, 0),
  }
}

const currentHunks = (g: LoadedGroup) => g.hunks.flatMap((h) => (h.current ? [h.current] : []))

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      group: { type: 'string', short: 'g', multiple: true },
      full: { type: 'boolean' },
      diff: { type: 'boolean' },
      only: { type: 'string' },
    },
  })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')
  const gloss = loadGloss(sha)
  if (!gloss) {
    console.error(`${sha.slice(0, 10)} has no gloss (annotate it with \`git gloss add\`)`)
    return 1
  }

  const only = values.only?.split(',').map((s) => s.trim()) as Necessity[] | undefined
  const unknown = only?.filter((n) => !NECESSITY.includes(n))
  if (unknown?.length) {
    console.error(`error: unknown necessity ${unknown.join(', ')}; expected ${NECESSITY.join(', ')}`)
    return 2
  }
  const ids = gloss.groups.map((g) => g.group.id)
  const missing = values.group?.filter((id) => !ids.includes(id))
  if (missing?.length) {
    console.error(`error: no group ${missing.join(', ')} in this gloss; groups are ${ids.join(', ')}`)
    return 2
  }

  const a = gloss.note.annotation
  const short = sha.slice(0, 7)
  const out: string[] = [`${style('yellow', sha.slice(0, 10))} ${style('bold', gloss.subject)}`]
  out.push(...field('task:', a.task, 0))
  if (a.summary) out.push(...field('summary:', a.summary, 0))
  for (const w of gloss.warnings) out.push(...field('⚠', w, 0).map((l) => style('red', l)))

  const groups = gloss.groups
    .filter((g) => !only || only.includes(g.group.necessity))
    .filter((g) => !values.group || values.group.includes(g.group.id))

  if (!groups.length) {
    console.error(`no groups match ${[values.group && `-g ${values.group.join(',')}`, only && `--only ${only.join(',')}`].filter(Boolean).join(' and ')}`)
    return 1
  }

  // -g: chosen groups with their code. --full: every group's details, plus
  // alternatives and risks. --diff: --full plus code.
  if (values.group || values.full || values.diff) {
    const withCode = values.diff || !!values.group
    for (const g of groups) {
      out.push('', ...groupHeader(g.group))
      if (!withCode) continue
      for (const h of g.hunks) {
        if (!h.current) { out.push('', style('red', `  ${h.id}: no longer in this commit's diff`)); continue }
        if (h.status === 'changed') out.push('', style('red', `  ${h.id}: content changed since it was glossed`))
        out.push('', '  ' + hunkLabel(h.current), colorDiff(h.current.text, '    '))
      }
    }
    if (gloss.unannotated.length && !only && !values.group) {
      out.push('', style(['bold', 'red'], '■ Unannotated hunks'))
      for (const h of gloss.unannotated) {
        out.push('  ' + hunkLabel(h))
        if (withCode) out.push(colorDiff(h.text, '    '), '')
      }
    }
    if (!values.group) out.push(...noteFooter(gloss.note))
    page(out.join('\n'))
    return 0
  }

  // Summary: one line per group.
  const sorted = [...groups].sort((x, y) => NECESSITY.indexOf(x.group.necessity) - NECESSITY.indexOf(y.group.necessity))
  const tally = NECESSITY.map((n) => [n, gloss.groups.filter((g) => g.group.necessity === n).length] as const)
    .filter(([, c]) => c > 0)
    .map(([n, c]) => `${c} ${necessityWord(n)}`)
  const showing = groups.length < gloss.groups.length ? style('dim', `  (showing ${groups.length}: --only ${only?.join(',')})`) : ''
  out.push('', `${style('bold', `${gloss.groups.length} groups:`)} ${tally.join(style('dim', ' · '))}${showing}`, '')

  const rows = sorted.map((g) => {
    const s = stats(currentHunks(g))
    const stale = g.hunks.filter((h) => h.status !== 'ok').length
    return {
      g, stale,
      stat: `${s.count} hunk${s.count === 1 ? '' : 's'}`, added: `+${s.added}`, removed: `-${s.removed}`,
    }
  })
  const un = stats(gloss.unannotated)
  const idW = Math.max(...rows.map((r) => r.g.group.id.length))
  const statW = Math.max(...rows.map((r) => r.stat.length), un.count ? 8 : 0)
  const addW = Math.max(...rows.map((r) => r.added.length))
  const remW = Math.max(...rows.map((r) => r.removed.length))
  const intentCol = 2 + 11 + 2 + idW + 2
  const statsW = 2 + statW + 1 + addW + 1 + remW
  const intentW = Math.max(20, termWidth() - intentCol - statsW)
  for (const r of rows) {
    // Intents wrap within their column rather than being cut off; the stats
    // stay on the first line so the numbers still line up.
    const [first, ...rest] = wrap(r.g.group.intent, intentW)
    out.push(
      `  ${necessityWord(r.g.group.necessity, 11)}  ${style('bold', r.g.group.id.padEnd(idW))}  ` +
      `${first.padEnd(intentW)}  ` +
      style('dim', r.stat.padStart(statW)) + ' ' + style('green', r.added.padStart(addW)) + ' ' + style('red', r.removed.padStart(remW)),
      ...rest.map((l) => ' '.repeat(intentCol) + l),
    )
    if (r.stale) {
      out.push(' '.repeat(intentCol) + style('red', `⚠ ${r.stale} of ${r.g.hunks.length} hunk(s) changed or gone since glossing`))
    }
  }
  if (un.count && !only) {
    out.push(`  ${style(['bold', 'red'], 'unannotated'.padEnd(11))}  ${style('red', `${un.count} hunk(s) not in any group: ${gloss.unannotated.map((h) => h.id).join(', ')}`)}`)
  }

  out.push(...risksBlock(gloss.note))
  const alts = a.alternatives?.length ?? 0
  out.push(
    '',
    style('dim', `Expand a group:  git gloss show ${short} -g <group>`),
    style('dim', `Everything:      --full (details${alts ? `, ${alts} alternative${alts === 1 ? '' : 's'} considered` : ''})   --diff (details and code)`),
  )
  page(out.join('\n'))
  return 0
}
