import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { commitSubject, gitTry, GlossError, resolveCommits } from '../git.ts'
import { addReviews, checkBy, checkDecision, MAX_DECISION_LINE, MAX_FINDINGS, MAX_REVIEW_LINE, decisionSummary, readDecisions, readReviews, reviewStatus, stamp, statusPhrase, verdictOf, type DecisionRecord, type ReviewRecord } from '../reviews.ts'
import { plain } from '../plain.ts'
import { page, style } from '../render.ts'

export const usage = 'reviews [<commit> | <range> | wip] [--stamp | --record]   the reviews recorded for commits, with their findings and what was decided about them\n  reviews <target> --decide <review-id> --finding <text> --outcome <fixed|follow-up|rejected|accepted> [--note <text>] [--by <name>]\n  reviews <target> --decide <review-id> --complete   the arbiter is done; --stamp, --record and --decide are for tools'

type Stamped = Record<string, { lines: string[]; groups: string[] }>

// --record reads this from stdin: a finished review and the stamp taken
// (with --stamp) before it started, so the record says what the reviewer saw.
type Recording = { stage: string; agent: string; model?: string; mode?: string; target: string; findings: string; stamp: Stamped }

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stamp: { type: 'boolean' }, record: { type: 'boolean' }, decide: { type: 'string' }, finding: { type: 'string' },
      outcome: { type: 'string' }, note: { type: 'string' }, complete: { type: 'boolean' }, by: { type: 'string' },
    },
  })

  if (values.record) {
    const input = JSON.parse(readFileSync(0, 'utf8')) as Recording
    for (const k of ['stage', 'agent', 'target', 'findings'] as const) {
      if (typeof input[k] !== 'string' || !input[k]) throw new GlossError(`--record: "${k}" is missing`)
    }
    if (!input.stamp || typeof input.stamp !== 'object') throw new GlossError('--record: "stamp" is missing (take it with --stamp before the review)')
    // Every commit the stamp names must exist before anything is written, so
    // a bad stamp records nothing rather than part of the review.
    for (const [sha, seen] of Object.entries(input.stamp)) {
      if (!/^[0-9a-f]{40,64}$/.test(sha) || gitTry(['cat-file', '-e', `${sha}^{commit}`]) === null) {
        throw new GlossError(`--record: the stamp names ${sha.slice(0, 12)}, which isn't a commit here`)
      }
      if (!Array.isArray(seen?.lines) || !Array.isArray(seen?.groups)) throw new GlossError(`--record: the stamp for ${sha.slice(0, 12)} has no lines or groups`)
    }
    // Readers skip what is over these limits, so a record that is would vanish: refuse it here instead.
    if (input.findings.length > MAX_FINDINGS) throw new GlossError(`--record: the findings are too long (${input.findings.length} characters; readers skip reports over ${MAX_FINDINGS / 1024} KiB); shorten the report`)
    const id = randomUUID()
    const at = new Date().toISOString()
    for (const [sha, seen] of Object.entries(input.stamp)) {
      const record: ReviewRecord = {
        review: 1, id, at, stage: input.stage, agent: input.agent,
        ...(input.model ? { model: input.model } : {}), ...(input.mode ? { mode: input.mode } : {}),
        target: input.target, lines: seen.lines, groups: seen.groups, findings: input.findings,
        ...(verdictOf(input.findings) ? { verdict: verdictOf(input.findings) } : {}),
      }
      if (JSON.stringify(record).length > MAX_REVIEW_LINE) throw new GlossError(`--record: the record for ${sha.slice(0, 10)} is over ${MAX_REVIEW_LINE / 1024 / 1024} MiB with its stamp, which readers skip; review fewer changed lines at a time`)
      addReviews(sha, [record])
    }
    const n = Object.keys(input.stamp).length
    console.log(`recorded the ${input.stage} review on ${n} commit${n === 1 ? '' : 's'}`)
    return 0
  }

  const { shas } = resolveCommits(positionals[0] ?? 'HEAD')
  if (values.decide !== undefined) {
    const id = values.decide
    if (values.complete) {
      if (values.finding !== undefined || values.outcome !== undefined || values.note !== undefined) {
        throw new GlossError('--complete marks the review as arbitrated; it takes no --finding, --outcome or --note')
      }
    } else checkDecision(values)
    // Every commit of the target holding that review gets the decision.
    const holders = shas.filter((sha) => readReviews(sha).some((r) => r.id === id))
    if (!holders.length) {
      const known = [...new Set(shas.flatMap(readReviews).map((r) => r.id))]
      throw new GlossError(`no review ${id} on ${positionals[0] ?? 'HEAD'}` + (known.length ? ` (reviews there: ${plain(known.join(', '))})` : ' (it has no reviews)'))
    }
    const by = values.by !== undefined ? values.by.trim() : gitTry(['config', 'user.name'])?.trim() || 'unknown'
    checkBy(by)
    const record: DecisionRecord = {
      decision: 1, review: id, at: new Date().toISOString(), by,
      ...(values.complete ? { complete: true } : {
        finding: values.finding!.trim(), outcome: values.outcome as DecisionRecord['outcome'],
        ...(values.note ? { note: values.note } : {}),
      }),
    }
    // Control characters are written as 6-byte escapes, so check the line itself against the reader's cap.
    if (JSON.stringify(record).length > MAX_DECISION_LINE) throw new GlossError('that decision is too long to record: the finding and note, as written, exceed what readers accept; shorten them')
    for (const sha of holders) addReviews(sha, [record])
    console.log(`recorded ${values.complete ? 'the review as complete' : `"${record.finding}": ${record.outcome}`} on ${holders.length} commit${holders.length === 1 ? '' : 's'}`)
    return 0
  }
  for (const k of ['finding', 'outcome', 'note', 'complete', 'by'] as const) {
    if (values[k] !== undefined) throw new GlossError(`--${k} goes with --decide <review-id>`)
  }
  if (values.stamp) {
    console.log(JSON.stringify(Object.fromEntries(shas.map((sha) => [sha, stamp(sha)]))))
    return 0
  }

  const out: string[] = []
  for (const sha of shas) {
    const statuses = reviewStatus(sha)
    const decisions = readDecisions(sha)
    out.push(`${style('yellow', sha.slice(0, 10))} ${style('bold', plain(commitSubject(sha)))}`)
    if (!statuses.length) { out.push(style('dim', '  no reviews recorded'), ''); continue }
    for (const s of statuses) {
      out.push(`  ${statusPhrase(s)}`)
      for (const r of s.reviews) {
        out.push('', style('dim', `  ── ${r.stage} by ${r.agent}${r.model ? `:${r.model}` : ''}${r.mode ? ` (${r.mode})` : ''}, ${r.at.slice(0, 16).replace('T', ' ')}, of ${r.target}, id ${plain(r.id)}`))
        out.push(...r.findings.trim().split('\n').map((l) => `  ${l}`))
        const ds = decisions.filter((d) => d.review === r.id)
        if (r.verdict !== 'clean' || ds.length) {
          out.push('', `  decisions on this review: ${decisionSummary(ds)}`)
          for (const d of ds.filter((d) => d.outcome).sort((a, b) => a.at.localeCompare(b.at))) {
            out.push(`    ${d.outcome}: ${plain(d.finding!)}${d.note ? ` — ${plain(d.note)}` : ''} ${style('dim', `(${plain(d.by)}, ${plain(d.at).slice(0, 10)})`)}`)
          }
        }
      }
      out.push('')
    }
  }
  page(out.join('\n'))
  return 0
}
