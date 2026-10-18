import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { commitSubject, gitTry, GlossError, resolveCommits } from '../git.ts'
import { addReviews, reviewStatus, stamp, statusPhrase, verdictOf, type ReviewRecord } from '../reviews.ts'
import { page, style } from '../render.ts'

export const usage = 'reviews [<commit> | <range> | wip] [--stamp | --record]   the reviews recorded for commits, with their findings; --stamp and --record are for review tools'

type Stamped = Record<string, { lines: string[]; groups: string[] }>

// --record reads this from stdin: a finished review and the stamp taken
// (with --stamp) before it started, so the record says what the reviewer saw.
type Recording = { stage: string; agent: string; model?: string; mode?: string; target: string; findings: string; stamp: Stamped }

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { stamp: { type: 'boolean' }, record: { type: 'boolean' } },
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
    const id = randomUUID()
    const at = new Date().toISOString()
    for (const [sha, seen] of Object.entries(input.stamp)) {
      const record: ReviewRecord = {
        review: 1, id, at, stage: input.stage, agent: input.agent,
        ...(input.model ? { model: input.model } : {}), ...(input.mode ? { mode: input.mode } : {}),
        target: input.target, lines: seen.lines, groups: seen.groups, findings: input.findings,
        ...(verdictOf(input.findings) ? { verdict: verdictOf(input.findings) } : {}),
      }
      addReviews(sha, [record])
    }
    const n = Object.keys(input.stamp).length
    console.log(`recorded the ${input.stage} review on ${n} commit${n === 1 ? '' : 's'}`)
    return 0
  }

  const { shas } = resolveCommits(positionals[0] ?? 'HEAD')
  if (values.stamp) {
    console.log(JSON.stringify(Object.fromEntries(shas.map((sha) => [sha, stamp(sha)]))))
    return 0
  }

  const out: string[] = []
  for (const sha of shas) {
    const statuses = reviewStatus(sha)
    out.push(`${style('yellow', sha.slice(0, 10))} ${style('bold', commitSubject(sha))}`)
    if (!statuses.length) { out.push(style('dim', '  no reviews recorded'), ''); continue }
    for (const s of statuses) {
      out.push(`  ${statusPhrase(s)}`)
      for (const r of s.reviews) {
        out.push('', style('dim', `  ── ${r.stage} by ${r.agent}${r.model ? `:${r.model}` : ''}${r.mode ? ` (${r.mode})` : ''}, ${r.at.slice(0, 16).replace('T', ' ')}, of ${r.target}`))
        out.push(...r.findings.trim().split('\n').map((l) => `  ${l}`))
      }
      out.push('')
    }
  }
  page(out.join('\n'))
  return 0
}
