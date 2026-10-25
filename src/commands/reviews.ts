import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { commitSubject, gitTry, GlossError, resolveCommits } from '../git.ts'
import { addReviews, checkDecision, findingsSummary, heldBy, itemStatuses, openFindings, requireItems, skippedCount, resolveBy, isValidDecision, MAX_FINDINGS, MAX_REVIEW_LINE, decisionSummary, readDecisions, readReviews, reviewStatus, stamp, statusPhrase, verdictOf, type DecisionRecord, type ItemStatus, type ReviewRecord } from '../reviews.ts'
import { BLOCK_SPEC, parseFindingsBlock } from '../findings-block.ts'
import { plain } from '../plain.ts'
import { page, style } from '../render.ts'
import { applyBatch, checkLength, prepareBatch, template } from '../batch.ts'

export const usage = 'reviews [<commit> | <range> | wip] [--stamp | --record]   the reviews recorded for commits, with their findings (a table, then the report) and what was decided about them\n  reviews <target> --open   print the findings with no decision yet; exit 1 if there are any (legacy reviews have none)\n  reviews <target> --decide <review-id> --finding <id> --outcome <fixed|follow-up|rejected|accepted> [--note <text>] [--by <name>]\n  reviews <target> --decide <review-id> --complete   the arbiter is done\n  reviews <target> --decide-template <review-id>   print a JSON skeleton of the findings (by id) of a review to fill in\n  reviews <target> --decide <review-id> --decide-file <file|->   record every decision of the filled-in skeleton at once, or none; --record needs the report to end with a gloss-findings block (see the README); --stamp, --record and --decide are for tools'

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
      outcome: { type: 'string' }, open: { type: 'boolean' }, 'decide-file': { type: 'string' }, 'decide-template': { type: 'string' }, note: { type: 'string' }, complete: { type: 'boolean' }, by: { type: 'string' },
    },
  })

  const batchFlag = values['decide-file'] !== undefined ? '--decide-file' : values['decide-template'] !== undefined ? '--decide-template' : null
  if (batchFlag) {
    for (const k of ['finding', 'outcome', 'note', 'complete', 'stamp', 'record'] as const) {
      if (values[k] !== undefined) throw new GlossError(`${batchFlag} cannot be combined with --${k}`)
    }
    if (values['decide-file'] !== undefined && values['decide-template'] !== undefined) throw new GlossError('--decide-file and --decide-template cannot be combined')
    if (batchFlag === '--decide-template' && (values.decide !== undefined || values.by !== undefined)) throw new GlossError('--decide-template takes the review id itself and no --decide or --by')
    if (batchFlag === '--decide-file' && values.decide === undefined) throw new GlossError('--decide-file goes with --decide <review-id>')
  }

  if (values.open) {
    for (const k of ['decide', 'finding', 'outcome', 'note', 'complete', 'by', 'stamp', 'record'] as const) {
      if (values[k] !== undefined) throw new GlossError(`--open cannot be combined with --${k}`)
    }
    if (batchFlag) throw new GlossError(`--open cannot be combined with ${batchFlag}`)
  }

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
    if (input.findings.length > MAX_FINDINGS) throw new GlossError(`--record: the report, including its gloss-findings block, is too long (${input.findings.length} characters; readers skip reports over ${MAX_FINDINGS / 1024} KiB, measured on the raw text, so JSON escapes count); shorten the prose or the block`)
    // The report's findings are its gloss-findings block; without a usable one nothing is recorded,
    // and every problem is listed so a tool can hand them back to the reviewer.
    const block = parseFindingsBlock(input.findings)
    if ('problems' in block) throw new GlossError(`--record: the report's gloss-findings block is missing or not usable, so nothing was recorded:\n${block.problems.map((p) => `  - ${p}`).join('\n')}\n\n${BLOCK_SPEC}`)
    const id = randomUUID()
    const at = new Date().toISOString()
    for (const [sha, seen] of Object.entries(input.stamp)) {
      const record: ReviewRecord = {
        review: 1, id, at, stage: input.stage, agent: input.agent,
        ...(input.model ? { model: input.model } : {}), ...(input.mode ? { mode: input.mode } : {}),
        target: input.target, lines: seen.lines, groups: seen.groups, findings: input.findings, items: block.items,
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
  const target = positionals[0] ?? 'HEAD'
  // Every commit of the target holding that review gets the decision.
  const holdersOf = (id: string) => {
    const holders = shas.filter((sha) => readReviews(sha).some((r) => r.id === id))
    if (!holders.length) {
      const known = [...new Set(shas.flatMap(readReviews).map((r) => r.id))]
      throw new GlossError(`no review ${id} on ${target}` + (known.length ? ` (reviews there: ${plain(known.join(', '))})` : ' (it has no reviews)'))
    }
    return holders
  }
  // The review's holders and its items (the same on each holder: they were recorded together).
  const lookup = (id: string) => {
    const holders = holdersOf(id)
    return { holders, items: holders.flatMap(readReviews).find((r) => r.id === id)?.items }
  }
  if (values['decide-template'] !== undefined) {
    const id = values['decide-template']
    console.log(JSON.stringify(template(id, lookup(id).items), null, 2))
    return 0
  }
  if (values['decide-file'] !== undefined) {
    const id = values.decide!
    // Everything is checked before the first write: one bad entry records nothing.
    const { holders, records } = prepareBatch(values['decide-file'], id, values.by, lookup)
    const { decisions: n, marked, written, skipped } = applyBatch(holders, records)
    console.log(`recorded ${n} decision${n === 1 ? '' : 's'} on ${written} commit${written === 1 ? '' : 's'}${marked ? ' and marked the review complete' : ''}${skipped ? ` (${skipped} already recorded)` : ''}`)
    return 0
  }
  if (values.decide !== undefined) {
    const id = values.decide
    const { holders, items } = lookup(id)
    let finding: string | undefined
    if (values.complete) {
      if (!isValidDecision({ complete: true, finding: values.finding, outcome: values.outcome, note: values.note })) {
        throw new GlossError('--complete marks the review as arbitrated; it takes no --finding, --outcome or --note')
      }
      requireItems(items)
    } else finding = checkDecision(values, items)
    const by = resolveBy(values.by)
    const record: DecisionRecord = {
      decision: 1, review: id, at: new Date().toISOString(), by,
      ...(values.complete ? { complete: true } : {
        finding: finding!, outcome: values.outcome as DecisionRecord['outcome'],
        ...(values.note ? { note: values.note } : {}),
      }),
    }
    // Control characters are written as 6-byte escapes, so check the line itself against the reader's cap.
    checkLength(record, 'that decision')
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

  if (values.open) {
    // Over the whole target: a review that spans commits is one review, decided by the decisions of all of them.
    const open = openFindings(shas.map((sha) => heldBy(sha)))
    const out: string[] = []
    let nStale = 0
    for (const review of [...new Set(open.map((o) => o.review))]) {
      const mine = open.filter((o) => o.review === review)
      const stale = mine[0].stale
      out.push(style('dim', `${review.stage} review ${plain(review.id)}${stale ? ' (stale review)' : ''}, on ${mine[0].shas.map((x) => x.slice(0, 10)).join(', ')}`), ...table(mine.map((o) => ({ item: o.item, status: 'open' as const })), '  '))
      if (stale) {
        nStale += mine.length
        out.push(`${mine.length} open on stale reviews: ${review.stage} ${mine.map((o) => o.item.id).join(', ')} (code changed since; decide them or re-review)`)
      }
      out.push('')
    }
    // A gate must not pass on what it could not read.
    const unread = shas.map((sha) => [sha, skippedCount(sha)] as const).filter(([, n]) => n)
    const skipped = unread.reduce((n, [, c]) => n + c, 0)
    if (skipped) out.push(`${skipped} review record${skipped === 1 ? '' : 's'} could not be read on ${unread.map(([sha]) => sha.slice(0, 10)).join(', ')} (malformed, over the size caps or invalid items); the gate cannot pass on what it could not read`)
    out.push(open.length ? `${open.length} open finding${open.length === 1 ? '' : 's'}${nStale ? ` (${nStale} on stale reviews)` : ''}` : 'no open findings')
    page(out.join('\n'))
    return open.length || skipped ? 1 : 0
  }

  // Decisions are written to every commit holding a review: each is listed once over the target.
  const allDecisions = [...new Map(shas.flatMap(readDecisions).map((d) => [JSON.stringify(d), d] as const)).values()]
  const out: string[] = []
  for (const sha of shas) {
    const statuses = reviewStatus(sha)
    // Decisions of the whole target count for a review that spans commits, as for --open.
    const decisions = allDecisions
    out.push(`${style('yellow', sha.slice(0, 10))} ${style('bold', plain(commitSubject(sha)))}`)
    if (!statuses.length) { out.push(style('dim', '  no reviews recorded'), ''); continue }
    for (const s of statuses) {
      out.push(`  ${statusPhrase(s)}`)
      for (const r of s.reviews) {
        out.push('', style('dim', `  ── ${r.stage} by ${r.agent}${r.model ? `:${r.model}` : ''}${r.mode ? ` (${r.mode})` : ''}, ${r.at.slice(0, 16).replace('T', ' ')}, of ${r.target}, id ${plain(r.id)}`))
        const ds = decisions.filter((d) => d.review === r.id)
        const rows = itemStatuses(r, decisions)
        if (rows) {
          out.push(...table(rows, '  '))
          out.push('', `  ${findingsSummary(rows)}${ds.some((d) => d.complete) ? ' · marked complete' : ''}`)
          for (const x of rows) {
            if (x.decision?.note) out.push(`    ${x.item.id}: ${plain(x.decision.note)} ${style('dim', `(${plain(x.decision.by)}, ${plain(x.decision.at).slice(0, 10)})`)}`)
          }
          // Decisions that name no finding of this review (old text refs, strays) are shown as stored.
          const known = new Set(rows.map((x) => x.item.id))
          const stray = ds.filter((d) => d.outcome && !known.has(d.finding!)).sort((a, b) => a.at.localeCompare(b.at))
          if (stray.length) {
            out.push('', '  decisions naming no finding:')
            for (const d of stray) out.push(`    ${d.outcome}: ${plain(d.finding!)}${d.note ? ` — ${plain(d.note)}` : ''} ${style('dim', `(${plain(d.by)}, ${plain(d.at).slice(0, 10)})`)}`)
          }
          out.push('', style('dim', '  --- report ---'))
        } else {
          out.push(style('dim', '  recorded without structured findings (no gloss-findings block): nothing to decide'))
        }
        out.push(...r.findings.trim().split('\n').map((l) => `  ${l}`))
        // A legacy review's decisions are shown as they were stored.
        if (!rows && (r.verdict !== 'clean' || ds.length)) {
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

// `id  severity  kind  basis  status  title`, one row per finding, in the reviewer's order.
function table(rows: ItemStatus[], indent: string): string[] {
  const cols = rows.map((r) => [r.item.id, r.item.severity, r.item.kind, r.item.basis, r.status, r.item.title])
  const head = ['id', 'severity', 'kind', 'basis', 'status', 'title']
  const width = head.map((h, i) => Math.max(h.length, ...cols.map((c) => c[i].length)))
  const line = (c: string[]) => indent + c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(width[i]))).join('  ')
  return [style('dim', line(head)), ...cols.map((c) => line(c))]
}
