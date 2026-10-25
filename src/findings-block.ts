import { plain } from './plain.ts'

// The structured findings of a review report: a JSON array in the last
// ```gloss-findings fence of the report. `reviews --record` parses it, refuses a
// report without a usable one, and stores the result as the record's `items`.
// The report's prose stays free text; this block is the index of what needs a decision.

export const KINDS = ['defect', 'mismatch', 'missing-risk', 'simplification', 'unproven'] as const
export const SEVERITIES = ['major', 'minor', 'nit'] as const
export const BASES = ['verified', 'read'] as const

export type Item = {
  id: string
  kind: (typeof KINDS)[number]
  severity: (typeof SEVERITIES)[number]
  basis: (typeof BASES)[number]
  where?: string
  title: string
  detail?: string
}

export const MAX_ITEMS = 200
export const MAX_ID = 32
export const MAX_TITLE = 200
export const MAX_WHERE = 200
export const MAX_DETAIL = 500
// The most a block's JSON text may be: 200 items of the longest strings come to about 450 KB,
// but a report is capped at 256 KiB anyway (MAX_FINDINGS in reviews.ts), so this is never the
// limit an honest report meets. Checked before the text is parsed.
export const MAX_BLOCK_BYTES = 256 * 1024
// The most a whole report may be (readers skip a longer one), on the raw text.
export const MAX_REPORT_CHARS = 256 * 1024
const MAX_LISTED = 25
const ID = /^[A-Za-z0-9._-]{1,32}$/

// What a reviewer is told to produce; copied into the README and the gloss skill, and printed when a report is refused.
export const BLOCK_SPEC = `Put one fenced block at the end of the report, before the VERDICT line: a JSON array with one object per finding ([] if there are none):

\`\`\`gloss-findings
[{"id": "f1", "kind": "defect", "severity": "major", "basis": "verified", "where": "src/a.ts:10", "title": "one line", "detail": "why, and what to do"}]
\`\`\`

id: ${MAX_ID} characters or fewer of A-Z a-z 0-9 . _ -, unique in the report (f1, f2, ...). kind: ${KINDS.join(' | ')}. severity: ${SEVERITIES.join(' | ')}. basis: ${BASES.join(' | ')} (you ran it and saw it, or you read the code). where (optional, at most ${MAX_WHERE} characters), title (at most ${MAX_TITLE}), detail (optional, at most ${MAX_DETAIL}). At most ${MAX_ITEMS} items. The last gloss-findings block in the report counts; put it at the end. Caps are measured on the raw report text, so a JSON escape such as \\u0001 counts as six characters; the whole report may be at most ${MAX_REPORT_CHARS / 1024} KiB.`

export type Checked = { items: Item[] } | { problems: string[] }

const clip = (s: string, n = 40) => plain(s).slice(0, n)

// Validates a parsed value as a list of items. All-or-nothing: either every item is good
// (returned as fresh, sanitised objects) or the problems are listed (all of them, up to a few).
export function checkItems(raw: unknown): Checked {
  if (!Array.isArray(raw)) return { problems: ['the block must be a JSON array of findings ([] if there are none)'] }
  if (raw.length > MAX_ITEMS) return { problems: [`the block has ${raw.length} items; at most ${MAX_ITEMS}: group related findings`] }
  const problems: string[] = []
  const items: Item[] = []
  const firstAt = new Map<string, number>()
  raw.forEach((e, i) => {
    const n = i + 1
    if (typeof e !== 'object' || e === null || Array.isArray(e)) { problems.push(`item ${n} is not an object`); return }
    const o = e as Record<string, unknown>
    const name = typeof o.id === 'string' ? `item ${n} ("${clip(o.id)}")` : `item ${n}`
    const bad = (msg: string) => problems.push(`${name}: ${msg}`)
    const str = (k: string, max: number, required: boolean): string | undefined => {
      const v = o[k]
      if (v === undefined) { if (required) bad(`"${k}" is missing`); return undefined }
      if (typeof v !== 'string') { bad(`"${k}" must be a string`); return undefined }
      if (v.length > max) { bad(`"${k}" is too long (${v.length} characters; at most ${max})`); return undefined }
      const t = k === 'detail' ? plain(v, true).trim() : plain(v).trim()
      if (!t && required) { bad(`"${k}" is empty`); return undefined }
      return t
    }
    const enumOf = <T extends string>(k: string, allowed: readonly T[]): T | undefined => {
      const v = o[k]
      if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T
      bad(`"${k}" must be one of ${allowed.join(', ')}`)
      return undefined
    }
    let id: string | undefined
    if (typeof o.id !== 'string' || !ID.test(o.id)) bad(`"id" must be 1 to ${MAX_ID} characters of A-Z a-z 0-9 . _ -`)
    else {
      id = o.id
      const seen = firstAt.get(id)
      if (seen !== undefined) { bad(`"id" repeats item ${seen}; ids must be unique`); id = undefined } else firstAt.set(id, n)
    }
    const kind = enumOf('kind', KINDS)
    const severity = enumOf('severity', SEVERITIES)
    const basis = enumOf('basis', BASES)
    const where = str('where', MAX_WHERE, false)
    const title = str('title', MAX_TITLE, true)
    const detail = str('detail', MAX_DETAIL, false)
    if (id !== undefined && kind && severity && basis && title) {
      items.push({ id, kind, severity, basis, ...(where ? { where } : {}), title, ...(detail ? { detail } : {}) })
    }
  })
  if (problems.length) {
    const listed = problems.slice(0, MAX_LISTED)
    if (problems.length > MAX_LISTED) listed.push(`... and ${problems.length - MAX_LISTED} more problems`)
    return { problems: listed }
  }
  return { items }
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

// The block of a report, by this rule: lines are read in order tracking code fences as
// CommonMark does (a fence opens with 3 or more backticks or tildes, indented at most 3
// spaces; it closes on a line of only that character, at least as many, with no info
// string); a fence opened inside another one is just text. The block is the LAST fence,
// outside any other fence, opened with backticks and the info string `gloss-findings`
// (trailing spaces allowed). So an example quoted in a longer or other fence earlier in
// the report is not a block, and when a report has two real ones the later counts.
export function findBlock(report: string): { body: string } | { problem: string } {
  const lines = report.split('\n')
  let open: { ch: string; len: number; findings: boolean } | null = null
  let last: { start: number; end: number | null } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i]
    if (open) {
      const m = CLOSE.exec(line)
      if (m && m[1][0] === open.ch && m[1].length >= open.len) {
        if (open.findings) last!.end = i
        open = null
      }
      continue
    }
    const m = FENCE.exec(line)
    if (!m || (m[1][0] === '`' && m[2].includes('`'))) continue
    const findings = m[1][0] === '`' && m[2].trim() === 'gloss-findings'
    open = { ch: m[1][0], len: m[1].length, findings }
    if (findings) last = { start: i, end: null }
  }
  if (!last) return { problem: 'no gloss-findings block: the report must end with a fenced block (three backticks, then gloss-findings) holding a JSON array of the findings, [] if there are none' }
  if (last.end === null) return { problem: `the gloss-findings fence on line ${last.start + 1} is not closed (it needs a closing line of at least as many backticks)` }
  return { body: lines.slice(last.start + 1, last.end).join('\n') }
}

// The report's items, or every problem found in its block.
export function parseFindingsBlock(report: string): Checked {
  const found = findBlock(report)
  if ('problem' in found) return { problems: [found.problem] }
  if (found.body.length > MAX_BLOCK_BYTES) return { problems: [`the gloss-findings block is too long (${found.body.length} characters; at most ${MAX_BLOCK_BYTES / 1024} KiB)`] }
  if (!found.body.trim()) return { problems: ['the gloss-findings block is empty: it must hold a JSON array ([] if there are none)'] }
  let data: unknown
  try { data = JSON.parse(found.body) } catch (e) {
    return { problems: [`the gloss-findings block is not valid JSON (${e instanceof RangeError ? 'nested too deeply' : plain((e as Error).message).slice(0, 120)})`] }
  }
  return checkItems(data)
}
