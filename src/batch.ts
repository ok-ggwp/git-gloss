import { closeSync, openSync, readSync } from 'node:fs'
import { GlossError } from './git.ts'
import { addReviews, checkDecision, requireItems, MAX_DECISION_LINE, readDecisions, resolveBy, type DecisionRecord } from './reviews.ts'
import type { Item } from './findings-block.ts'
import { plain } from './plain.ts'

// Limits for `reviews --decide-file`, checked before anything is parsed or written.
export const MAX_BATCH_ENTRIES = 500
export const MAX_BATCH_BYTES = 1024 * 1024
// What one --decide-file may write to a commit (bytes of its record lines): the 1 MiB input
// cap alone would still let a file add about 1 MiB to every commit of a range. Honest
// decisions are a few hundred bytes each; this is a guard against bloat, not against unreadable data.
export const MAX_BATCH_WRITE_BYTES = 512 * 1024

export type BatchEntry = { finding: string; outcome: DecisionRecord['outcome']; note?: string }
export type Batch = { entries: BatchEntry[]; complete: boolean }

// Reads a file, or stdin for "-", never more than MAX_BATCH_BYTES: a read that
// goes past it is refused without holding the rest (also for a pipe or /dev/zero).
export function readBounded(src: string): string {
  const what = src === '-' ? 'stdin' : plain(src)
  const fail = (e: unknown) => new GlossError(`--decide-file: can't read ${what}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`)
  const buf = Buffer.allocUnsafe(MAX_BATCH_BYTES + 1)
  let fd = 0, total = 0
  try {
    if (src !== '-') fd = openSync(src, 'r')
    // Until end of input; a full buffer means the input is over the limit.
    while (total < buf.length) {
      let n: number
      try { n = readSync(fd, buf, total, buf.length - total, null) } catch (e) {
        // A non-blocking pipe with nothing yet: wait a little (no busy spin) and ask again.
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') throw e
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
        continue
      }
      if (n === 0) break
      total += n
    }
  } catch (e) {
    throw fail(e)
  } finally {
    if (fd !== 0) closeSync(fd)
  }
  if (total > MAX_BATCH_BYTES) throw new GlossError(`--decide-file: the input is over ${MAX_BATCH_BYTES / 1024 / 1024} MiB; split the decisions into several files`)
  return buf.toString('utf8', 0, total)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
// Accepts a bare array of {finding, outcome, note?} (finding is an item id of the review), or
// {review?, complete?: boolean, decisions: [...]}. Unknown keys are ignored (the template's
// severity, kind and title among them). Everything is checked here, an unknown or repeated id
// as an error; nothing is written.
export function parseBatch(text: string, reviewId: string, items: Item[] | undefined): Batch {
  // A legacy review has nothing to decide, whatever the file holds.
  requireItems(items)
  let data: unknown
  try { data = JSON.parse(text) } catch (e) {
    throw new GlossError(`--decide-file: not valid JSON (${e instanceof RangeError ? 'nested too deeply' : plain((e as Error).message).slice(0, 120)})`)
  }
  let list: unknown[]
  let complete = false
  if (Array.isArray(data)) list = data
  else if (isObject(data)) {
    const d = data.decisions
    const c = data.complete
    if (c !== undefined && typeof c !== 'boolean') throw new GlossError('--decide-file: "complete" must be true or false')
    complete = c === true
    const r = data.review
    if (r !== undefined && r !== '' && r !== reviewId) throw new GlossError(`--decide-file: the file is for review ${plain(String(r)).slice(0, 80)}, not ${plain(reviewId)}`)
    if (!Array.isArray(d)) throw new GlossError('--decide-file: the object needs a "decisions" array')
    list = d
  } else throw new GlossError('--decide-file: expected an array of {finding, outcome, note?}, or an object with a "decisions" array')
  if (list.length > MAX_BATCH_ENTRIES) throw new GlossError(`--decide-file: ${list.length} entries; at most ${MAX_BATCH_ENTRIES} per file`)
  if (!list.length && !complete) throw new GlossError('--decide-file: no decisions in the file')
  // addReviews keeps a repeated line once, so a repeated finding would be counted but not written.
  const firstAt = new Map<string, number>()
  const entries = list.map((e, i): BatchEntry => {
    const at = `--decide-file: entry ${i + 1}`
    if (!isObject(e)) throw new GlossError(`${at} is not an object`)
    const finding = e.finding, outcome = e.outcome, note = e.note
    if (typeof finding !== 'string') throw new GlossError(`${at} has no "finding" text`)
    const label = `${at} ("${plain(finding).slice(0, 40)}")`
    if (outcome === undefined || outcome === '') throw new GlossError(`${label} has an empty outcome; fill it in or delete the row`)
    if (typeof outcome !== 'string') throw new GlossError(`${label}: "outcome" must be a string`)
    if (note !== undefined && typeof note !== 'string') throw new GlossError(`${label}: "note" must be a string`)
    let id: string
    try { id = checkDecision({ finding, outcome, note }, items) } catch (err) {
      if (err instanceof GlossError) throw new GlossError(`${label}: ${err.message.replace(/^--/, '')}`)
      throw err
    }
    const seen = firstAt.get(id)
    if (seen !== undefined) throw new GlossError(`${label} repeats entry ${seen}`)
    firstAt.set(id, i + 1)
    return { finding: id, outcome: outcome as BatchEntry['outcome'], ...(note ? { note } : {}) }
  })
  return { entries, complete }
}

// A record that, as written, is a line readers would skip (escapes make control characters longer).
export function checkLength(record: DecisionRecord, what: string) {
  if (JSON.stringify(record).length > MAX_DECISION_LINE) throw new GlossError(`${what} is too long to record: the finding and note, as written, exceed what readers accept; shorten them`)
}

// The skeleton `--decide-template` prints: one row per item of the review, outcome left empty.
// Only finding, outcome and note are read back; the rest is there to read while filling it in.
export function template(reviewId: string, items: Item[] | undefined) {
  requireItems(items)
  return {
    review: reviewId, complete: false,
    decisions: items!.map((i) => ({ finding: i.id, severity: i.severity, kind: i.kind, title: i.title, outcome: '', note: '' })),
  }
}

// Everything `reviews --decide-file` needs before it writes: the checked entries, the
// holders of the review, and the records (with the complete marker last). Nothing is written.
export function prepareBatch(src: string, id: string, byArg: string | undefined, lookup: (id: string) => { holders: string[]; items: Item[] | undefined }) {
  const text = readBounded(src)
  const { holders, items } = lookup(id)
  const batch = parseBatch(text, id, items)
  const by = resolveBy(byArg)
  const at = new Date().toISOString()
  const records: DecisionRecord[] = batch.entries.map((e, i) => {
    const r: DecisionRecord = { decision: 1, review: id, at, by, finding: e.finding, outcome: e.outcome, ...(e.note ? { note: e.note } : {}) }
    checkLength(r, `--decide-file: entry ${i + 1}`)
    return r
  })
  if (batch.complete) records.push({ decision: 1, review: id, at, by, complete: true })
  const bytes = records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)) + 1, 0)
  if (bytes > MAX_BATCH_WRITE_BYTES) {
    throw new GlossError(`--decide-file: the ${records.length} records come to ${Math.ceil(bytes / 1024)} KiB as written; at most ${MAX_BATCH_WRITE_BYTES / 1024} KiB per file; shorten the findings and notes or split the file`)
  }
  return { batch, holders, records }
}

// The same decision, whenever it was made: what a re-run must not record twice.
const sameDecision = (r: DecisionRecord) => JSON.stringify([r.review, r.finding ?? null, r.outcome ?? null, r.note ?? null, r.by, r.complete ?? null])

// The records not yet on that commit: one equal to the LATEST decision for its finding
// there is left out, but not one equal to an earlier decision that a later one reversed.
// A re-run of a file after a partly failed write adds only what is missing (each run has
// its own `at`).
export function newRecords(sha: string, records: DecisionRecord[]): DecisionRecord[] {
  const latest = new Map<string, string>()
  for (const r of [...readDecisions(sha)].sort((a, b) => a.at.localeCompare(b.at))) latest.set(JSON.stringify([r.review, r.finding ?? null]), sameDecision(r))
  return records.filter((r) => latest.get(JSON.stringify([r.review, r.finding ?? null])) !== sameDecision(r))
}

// Write the records to each holder, one write per commit, leaving out what it has. Counts
// as it goes: decisions written (the most any one commit got, so a range counts a file once),
// whether the complete marker was written, commits written, records skipped.
export function applyBatch(holders: string[], records: DecisionRecord[]) {
  let decisions = 0, written = 0, skipped = 0, marked = false
  for (const sha of holders) {
    const todo = newRecords(sha, records)
    skipped += records.length - todo.length
    if (!todo.length) continue
    addReviews(sha, todo)
    written++
    const fresh = todo.filter((r) => !r.complete).length
    decisions = Math.max(decisions, fresh)
    if (todo.some((r) => r.complete)) marked = true
  }
  return { decisions, marked, written, skipped }
}
