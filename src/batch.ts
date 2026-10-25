import { closeSync, openSync, readSync } from 'node:fs'
import { GlossError } from './git.ts'
import { checkDecision, MAX_DECISION_LINE, type DecisionRecord } from './reviews.ts'
import { findingTexts } from './findings.ts'
import { plain } from './plain.ts'

// Limits for `reviews --decide-file`, checked before anything is parsed or written.
export const MAX_BATCH_ENTRIES = 500
export const MAX_BATCH_BYTES = 1024 * 1024
export const TEMPLATE_TEXT = 80

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
// Accepts a bare array of {finding, outcome, note?}, or {review?, complete?: boolean,
// decisions: [...]}. Unknown keys are ignored. Everything is checked here; nothing is written.
export function parseBatch(text: string, reviewId: string): Batch {
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
    try { checkDecision({ finding, outcome, note }) } catch (err) {
      if (err instanceof GlossError) throw new GlossError(`${label}: ${err.message.replace(/^--/, '')}`)
      throw err
    }
    const seen = firstAt.get(finding.trim())
    if (seen !== undefined) throw new GlossError(`${label} repeats entry ${seen}`)
    firstAt.set(finding.trim(), i + 1)
    return { finding: finding.trim(), outcome: outcome as BatchEntry['outcome'], ...(note ? { note } : {}) }
  })
  return { entries, complete }
}

// A record that, as written, is a line readers would skip (escapes make control characters longer).
export function checkLength(record: DecisionRecord, what: string) {
  if (JSON.stringify(record).length > MAX_DECISION_LINE) throw new GlossError(`${what} is too long to record: the finding and note, as written, exceed what readers accept; shorten them`)
}

// The skeleton `--decide-template` prints: one row per ref, outcome left empty.
export function template(reviewId: string, findings: string) {
  const rows = findingTexts(findings)
  if (rows.length > MAX_BATCH_ENTRIES) throw new GlossError(`review ${plain(reviewId)} has ${rows.length} findings; --decide-file takes at most ${MAX_BATCH_ENTRIES}`)
  return {
    review: reviewId, complete: false,
    decisions: rows.map(([ref, text]) => ({ finding: `${ref}${ref.includes('.') ? '' : ':'} ${[...plain(text).replace(/\s+/g, ' ').trim()].slice(0, TEMPLATE_TEXT).join('')}`.trim(), outcome: '', note: '' })),
  }
}
