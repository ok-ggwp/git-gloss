import { parseArgs } from 'node:util'
import { commitSubject, gitTry, readNote, resolveCommits } from '../git.ts'
import type { Hunk } from '../diff.ts'
import { refLabel, sliceStats, sliceText } from '../selection.ts'
import { loadGloss, type LoadedGloss, type LoadedGroup } from '../loader.ts'
import { impactRank } from '../attention.ts'
import { showsImpact, tryAnalyze } from '../floor.ts'
import { IMPACT, NECESSITY, isImpact, isNecessity, type Group, type Impact, type Necessity } from '../schema.ts'
import { current, decisionSummary, plain, readDecisions, readReviews, reviewStatus, statusPhrase, verdict, type StageStatus } from '../reviews.ts'
import {
  attentionBlock, colorDiff, derivedImpactTag, field, groupHeader, hunkLabel, IMPACT_W, impactTag, necessityWord, noteFooter, page, style, termWidth, wrap,
} from '../render.ts'

export const usage =
  'show [<commit> | <range>] [-g <group>]... [--full] [--diff] [--only <necessity|impact,...> (a group must match each kind named)] [--sort impact]   summarise a gloss, or each commit in a range'

// Counts over the lines each part selects, not whole hunks, so groups that
// split a hunk don't both count all of it.
function stats(parts: { hunk: Hunk; lines: Set<number> | null }[]): { count: number; added: number; removed: number } {
  const s = parts.map((p) => sliceStats(p.hunk, p.lines))
  return {
    count: parts.length,
    added: s.reduce((n, x) => n + x.added, 0),
    removed: s.reduce((n, x) => n + x.removed, 0),
  }
}

const currentParts = (g: LoadedGroup) => g.hunks.flatMap((h) => (h.current ? [{ hunk: h.current, lines: h.lines }] : []))

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      group: { type: 'string', short: 'g', multiple: true },
      full: { type: 'boolean' },
      diff: { type: 'boolean' },
      only: { type: 'string' },
      sort: { type: 'string' },
    },
  })
  const names = values.only?.split(',').map((s) => s.trim())
  const unknown = names?.filter((n) => !isNecessity(n) && !isImpact(n))
  if (unknown?.length) {
    console.error(`error: unknown necessity or impact ${unknown.join(', ')}; expected ${NECESSITY.join(', ')} or ${IMPACT.join(', ')}`)
    return 2
  }
  const only: Only | undefined = names && { names, necessities: names.filter(isNecessity), impacts: names.filter(isImpact) }
  if (values.sort !== undefined && values.sort !== 'impact') {
    console.error(`error: unknown sort ${values.sort}; expected impact`)
    return 2
  }

  const { shas, merges, range } = resolveCommits(positionals[0] ?? 'HEAD')
  if (!range) {
    const gloss = loadGloss(shas[0])
    if (!gloss) {
      console.error(`${shas[0].slice(0, 10)} has no gloss (annotate it with \`git gloss add\`)`)
      return 1
    }
    const sha = shas[0]
    const ids = gloss.groups.map((g) => g.group.id)
    const missing = values.group?.filter((id) => !ids.includes(id))
    if (missing?.length) {
      // Usually the group is in an earlier commit's gloss, e.g. one shown just
      // before HEAD moved. Look a little way back for one that has them all.
      const earlier = (gitTry(['rev-list', '--max-count=30', `${sha}~1`]) ?? '').split('\n').filter(Boolean).find((c) => {
        try {
          const groups = readNote(c)?.annotation.groups.map((g) => g.id) ?? []
          return missing.every((id) => groups.includes(id))
        } catch {
          return false
        }
      })
      const flags = missing.map((id) => `-g ${id}`).join(' ')
      console.error(`error: the gloss on ${sha.slice(0, 7)} (${gloss.subject}) has no group ${missing.join(', ')}; its groups are ${ids.join(', ')}` +
        (earlier ? `\n  found in ${earlier.slice(0, 7)} (${commitSubject(earlier)}): git gloss show ${earlier.slice(0, 7)} ${flags}` : ''))
      return 2
    }
    const out = renderCommit(sha, gloss, values, only, true)
    if (!out) {
      console.error(`no groups match ${[values.group && `-g ${values.group.join(',')}`, only && `--only ${only.names.join(',')}`].filter(Boolean).join(' and ')}`)
      return 1
    }
    page(out.join('\n'))
    return 0
  }

  // A range: each commit in turn, oldest first. Group ids repeat across
  // commits, so -g is for single commits.
  if (values.group) {
    console.error('error: -g needs a single commit; pick one from the range, e.g. git gloss show <commit> -g <group>')
    return 2
  }
  const glosses = shas.map((sha) => loadGloss(sha))
  const glossed = glosses.filter(Boolean).length
  const stale = glosses.filter((g) => g?.stale).length
  // How many glossed commits had their gloss checked: an honesty review that
  // saw this code and this gloss.
  const honesty = shas.map((sha, i) => (glosses[i] ? reviewStatus(sha).find((r) => r.stage === 'honesty' && current(r)) : undefined))
  const vetted = honesty.filter(Boolean).length
  const flagged = honesty.filter((r) => r && verdict(r) === 'issues').length
  const out: string[] = [
    style('bold', `${range}: ${shas.length} commit${shas.length === 1 ? '' : 's'}, ${glossed} glossed`) +
      (glossed ? style(vetted === glossed ? 'green' : 'yellow', `, ${vetted} honesty-reviewed`) : '') +
      (flagged ? style('yellow', ` (${flagged} with issues)`) : '') +
      (stale ? style('red', ` (${stale} stale)`) : '') +
      (merges.length ? style('dim', `  (${merges.length} merge${merges.length === 1 ? '' : 's'} not shown)`) : ''),
  ]
  shas.forEach((sha, i) => {
    out.push('', style('dim', '─'.repeat(Math.min(termWidth(), 60))))
    const gloss = glosses[i]
    if (!gloss) {
      out.push(`${style('yellow', sha.slice(0, 10))} ${style('bold', plain(commitSubject(sha)))}`, style('dim', 'no gloss for this commit'))
      return
    }
    // An --only filter can leave a commit with nothing to show; say so and move on.
    out.push(...(renderCommit(sha, gloss, values, only, false) ??
      [`${style('yellow', sha.slice(0, 10))} ${style('bold', plain(gloss.subject))}`, style('dim', `no ${only?.names.join('/')} groups`)]))
  })
  if (glossed) out.push('', style('dim', 'One commit in detail: git gloss show <commit> --full   (or -g <group> for its code)'))
  page(out.join('\n'))
  return 0
}

type ShowOptions = { group?: string[]; full?: boolean; diff?: boolean; sort?: string }

// --only names necessities, impacts or both: a group must match each kind named.
type Only = { names: string[]; necessities: Necessity[]; impacts: Impact[] }
const matchesOnly = (g: Group, only: Only | undefined) => !only ||
  ((!only.necessities.length || only.necessities.includes(g.necessity)) && (!only.impacts.length || (!!g.impact && only.impacts.includes(g.impact))))

// One line on whether the commit as it is now was reviewed, per stage.
function reviewsLine(sha: string): string {
  const statuses = reviewStatus(sha)
  if (!statuses.length) return style('dim', 'reviews: none recorded')
  const color = (s: StageStatus) => (!current(s) || verdict(s) === 'issues' ? 'yellow' : verdict(s) === 'clean' ? 'green' : 'dim')
  // What was decided about the reviews that found something (or didn't say);
  // a commit with only clean reviews has nothing to decide.
  const open = readReviews(sha).filter((r) => r.verdict !== 'clean')
  const decisions = readDecisions(sha).filter((d) => open.some((r) => r.id === d.review))
  const decided = open.length
    ? ` ${style('dim', '·')} decisions: ${decisionSummary(decisions, open.every((r) => decisions.some((d) => d.review === r.id && d.complete)))}`
    : ''
  return `reviews: ${statuses.map((s) => style(color(s), statusPhrase(s))).join(style('dim', ' · '))}${decided}` +
    style('dim', `   (findings: git gloss reviews ${sha.slice(0, 7)})`)
}

// One commit's view, or null if no group matches -g/--only. `hints` adds the
// footer on how to expand, which a range prints once instead.
function renderCommit(sha: string, gloss: LoadedGloss, values: ShowOptions, only: Only | undefined, hints: boolean): string[] | null {

  const a = gloss.note.annotation
  const short = sha.slice(0, 7)
  const out: string[] = [`${style('yellow', sha.slice(0, 10))} ${style('bold', plain(gloss.subject))}`]
  out.push(...field('task:', a.task, 0))
  if (a.summary) out.push(...field('summary:', a.summary, 0))
  for (const w of gloss.warnings) out.push(...field('⚠', w, 0).map((l) => style('red', l)))
  const an = tryAnalyze(gloss)
  out.push(...attentionBlock(a.attention, an ? { floor: an.floor, derived: an.derived } : undefined), reviewsLine(sha))

  const groups = gloss.groups
    .filter((g) => matchesOnly(g.group, only))
    .filter((g) => !values.group || values.group.includes(g.group.id))

  if (!groups.length) return null
  // --sort impact: the most consequential first, then by necessity as usual.
  const byNecessity = (x: LoadedGroup, y: LoadedGroup) => NECESSITY.indexOf(x.group.necessity) - NECESSITY.indexOf(y.group.necessity)
  const byImpact = (x: LoadedGroup, y: LoadedGroup) => impactRank(y.group.impact) - impactRank(x.group.impact) || byNecessity(x, y)
  const detail = values.group || values.full || values.diff
  // The summary lists required first; detail views keep the gloss's order unless asked.
  if (values.sort === 'impact') groups.sort(byImpact)
  else if (!detail) groups.sort(byNecessity)

  // -g: chosen groups with their code. --full: every group's details, plus
  // alternatives and risks. --diff: --full plus code.
  if (detail) {
    const withCode = values.diff || !!values.group
    for (const g of groups) {
      out.push('', ...groupHeader(g.group))
      if (!withCode) continue
      for (const h of g.hunks) {
        if (!h.current) { out.push('', style('red', `  ${h.id}: no longer in this commit's diff`)); continue }
        if (h.status === 'changed') out.push('', style('red', `  ${h.id}: content changed since it was glossed`))
        out.push('', '  ' + hunkLabel(h.current, h.lines), colorDiff(sliceText(h.current, h.lines), '    '))
      }
    }
    if (gloss.unannotated.length && !only && !values.group) {
      out.push('', style(['bold', 'red'], '■ Unannotated changes'))
      for (const u of gloss.unannotated) {
        out.push('  ' + hunkLabel(u.hunk, u.lines))
        if (withCode) out.push(colorDiff(sliceText(u.hunk, u.lines), '    '), '')
      }
    }
    if (!values.group) out.push(...noteFooter(gloss.note))
    return out
  }

  // Summary: one line per group.
  const tally = NECESSITY.map((n) => [n, gloss.groups.filter((g) => g.group.necessity === n).length] as const)
    .filter(([, c]) => c > 0)
    .map(([n, c]) => `${c} ${necessityWord(n)}`)
  const showing = groups.length < gloss.groups.length ? style('dim', `  (showing ${groups.length}: --only ${only?.names.join(',')})`) : ''
  out.push('', `${style('bold', `${gloss.groups.length} groups:`)} ${tally.join(style('dim', ' · '))}${showing}`, '')

  const rows = groups.map((g) => {
    const s = stats(currentParts(g))
    const stale = g.hunks.filter((h) => h.status !== 'ok').length
    return {
      g, stale,
      stat: `${s.count} hunk${s.count === 1 ? '' : 's'}`, added: `+${s.added}`, removed: `-${s.removed}`,
    }
  })
  const un = stats(gloss.unannotated.map((u) => ({ hunk: u.hunk, lines: u.lines })))
  const idW = Math.max(...rows.map((r) => r.g.group.id.length))
  const statW = Math.max(...rows.map((r) => r.stat.length), un.count ? 8 : 0)
  const addW = Math.max(...rows.map((r) => r.added.length))
  const remW = Math.max(...rows.map((r) => r.removed.length))
  // An impact column only when some group declares one or the diff puts one
  // above the baseline (module), so plain glosses look as before. Undeclared
  // ones show the group's floor in parentheses.
  const floorOf = (g: LoadedGroup) => an?.groups.get(g.group.id)?.floor
  const showImpact = showsImpact(gloss.groups.map((g) => g.group), an)
  const impactW = showImpact ? IMPACT_W + 2 : 0
  const anyDerived = showImpact && gloss.groups.some((g) => !g.group.impact && floorOf(g))
  const intentCol = 2 + 11 + 2 + impactW + idW + 2
  const statsW = 2 + statW + 1 + addW + 1 + remW
  const intentW = Math.max(20, termWidth() - intentCol - statsW)
  for (const r of rows) {
    // Intents wrap within their column rather than being cut off; the stats
    // stay on the first line so the numbers still line up.
    const [first, ...rest] = wrap(r.g.group.intent, intentW)
    out.push(
      `  ${necessityWord(r.g.group.necessity, 11)}  ${impactW ? (r.g.group.impact ? impactTag(r.g.group.impact, IMPACT_W) : floorOf(r.g) ? derivedImpactTag(floorOf(r.g)!, IMPACT_W) : ' '.repeat(IMPACT_W)) + '  ' : ''}${style('bold', r.g.group.id.padEnd(idW))}  ` +
      `${first.padEnd(intentW)}  ` +
      style('dim', r.stat.padStart(statW)) + ' ' + style('green', r.added.padStart(addW)) + ' ' + style('red', r.removed.padStart(remW)),
      ...rest.map((l) => ' '.repeat(intentCol) + l),
    )
    if (r.stale) {
      out.push(' '.repeat(intentCol) + style('red', `⚠ ${r.stale} of ${r.g.hunks.length} hunk(s) changed or gone since glossing`))
    }
  }
  if (un.count && !only) {
    const where = gloss.unannotated.map((u) => refLabel(u.hunk.id, u.lines)).join(', ')
    out.push(`  ${style(['bold', 'red'], 'unannotated'.padEnd(11))}  ${style('red', `+${un.added} -${un.removed} not in any group: ${where}`)}`)
  }

  if (anyDerived) out.push('', style('dim', '(impact in parentheses is derived from the diff, not declared)'))

  // Rejected alternatives and risks: short, and often what a reader most
  // lacks, so they're in the summary rather than only behind --full.
  out.push(...noteFooter(gloss.note))
  if (hints) {
    out.push(
      '',
      style('dim', `Expand a group:  git gloss show ${short} -g <group>`),
      style('dim', `Everything:      --full (each group's evidence and notes)   --diff (and code)`),
    )
  }
  return out
}
