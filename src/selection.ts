import type { Hunk } from './diff.ts'

// A group's claim on a hunk: the whole hunk ("h6") or some of its changed
// lines ("h6:5-12", "h6:1-3,7"). Changed lines (+ and -) are numbered from 1 in
// diff order; context lines have no number. Counting only changed lines keeps a
// range valid when a rebase alters context, the same lines the hunk hash covers.
export type HunkRef = { hunk: string; ranges: [number, number][] | null }

export const REF_PATTERN = /^(h\d+)(?::(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*))?$/

export function parseRef(ref: string): HunkRef | null {
  const m = REF_PATTERN.exec(ref)
  if (!m) return null
  if (!m[2]) return { hunk: m[1], ranges: null }
  const ranges = m[2].split(',').map((part): [number, number] => {
    const [a, b] = part.split('-').map(Number)
    return [a, b ?? a]
  })
  return { hunk: m[1], ranges }
}

export function formatRanges(lines: Iterable<number>): string {
  const sorted = [...new Set(lines)].sort((x, y) => x - y)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`)
    i = j
  }
  return parts.join(',')
}

export const refLabel = (id: string, lines: Set<number> | null) => (lines ? `${id}:${formatRanges(lines)}` : id)

export type BodyLine = {
  raw: string
  kind: 'add' | 'del' | 'ctx' | 'meta'
  // 1-based number among the hunk's changed lines; null for context and markers.
  idx: number | null
  oldNo: number | null
  newNo: number | null
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// Parsed bodies are cached per hunk: callers ask for the same hunk's lines
// many times (counts, slices, coverage), and re-parsing made splitting a large
// hunk quadratic.
const parsed = new WeakMap<Hunk, BodyLine[]>()

// The hunk's lines after its @@ header, with changed-line numbers and file
// line numbers. A header-only change (binary, rename) is all 'meta'.
export function bodyLines(h: Hunk): BodyLine[] {
  let lines = parsed.get(h)
  if (!lines) parsed.set(h, (lines = parseBody(h)))
  return lines
}

function parseBody(h: Hunk): BodyLine[] {
  const [header, ...body] = h.text.split('\n')
  const m = HUNK_HEADER.exec(header)
  if (!m) return h.text.split('\n').map((raw) => ({ raw, kind: 'meta', idx: null, oldNo: null, newNo: null }))
  let oldNo = Number(m[1]), newNo = Number(m[2]), idx = 0
  return body.map((raw): BodyLine => {
    if (raw[0] === '+') return { raw, kind: 'add', idx: ++idx, oldNo: null, newNo: newNo++ }
    if (raw[0] === '-') return { raw, kind: 'del', idx: ++idx, oldNo: oldNo++, newNo: null }
    if (raw[0] === '\\') return { raw, kind: 'meta', idx: null, oldNo: null, newNo: null }
    return { raw, kind: 'ctx', idx: null, oldNo: oldNo++, newNo: newNo++ }
  })
}

export const changedCount = (h: Hunk) => bodyLines(h).filter((l) => l.idx !== null).length

export type Gap = { gap: number }
export type Sliced = BodyLine | Gap
export const isGap = (l: Sliced): l is Gap => 'gap' in l

// The part of a hunk a selection covers: selected changed lines, context
// within `context` lines of them, and a gap marker for each run of changed
// lines that belong elsewhere. A null selection is the whole hunk.
export function slice(lines: BodyLine[], selected: Set<number> | null, context = 3): Sliced[] {
  if (!selected) return lines
  const keep = lines.map((l) => l.idx !== null && selected.has(l.idx))
  const near = lines.map((_, i) => keep.slice(Math.max(0, i - context), i + context + 1).some(Boolean))
  const out: Sliced[] = []
  lines.forEach((l, i) => {
    if (keep[i] || (l.kind === 'meta' && near[i])) out.push(l)
    else if (l.idx !== null) {
      const last = out[out.length - 1]
      if (last && isGap(last)) last.gap++
      else out.push({ gap: 1 })
    } else if (l.kind === 'ctx' && near[i]) out.push(l)
  })
  return out
}

// Lines a group's view leaves out: claimed by other groups, or (under --partial) by none.
export const gapText = (n: Gap['gap']) => `⋯ ${n} changed line${n === 1 ? '' : 's'} not in this group`

// Text form of a slice for terminal and prompt output: the @@ header, kept
// lines verbatim, gaps as marker lines that can't be read as diff lines.
export function sliceText(h: Hunk, selected: Set<number> | null): string {
  if (!selected) return h.text
  const header = h.text.split('\n')[0]
  return [header, ...slice(bodyLines(h), selected).map((l) => (isGap(l) ? gapText(l.gap) : l.raw))].join('\n')
}

export function sliceStats(h: Hunk, selected: Set<number> | null): { added: number; removed: number } {
  if (!selected) return { added: h.added, removed: h.removed }
  const lines = bodyLines(h).filter((l) => l.idx !== null && selected.has(l.idx))
  return { added: lines.filter((l) => l.kind === 'add').length, removed: lines.filter((l) => l.kind === 'del').length }
}

// One selection per hunk for a group's refs, in order of first mention. A
// whole-hunk ref wins over ranges for the same hunk. Ranges are clamped to the
// hunk's changed-line count, so an oversized range (from a typo, a stale or a
// hand-edited note) can't build an enormous set; refs to unknown hunks keep
// an empty selection.
export function selections(refs: string[], changedOf: (hunk: string) => number | undefined): Map<string, Set<number> | null> {
  const out = new Map<string, Set<number> | null>()
  for (const ref of refs) {
    const r = parseRef(ref)
    if (!r) continue
    const prev = out.get(r.hunk)
    if (prev === null) continue
    if (!r.ranges) { out.set(r.hunk, null); continue }
    const set = prev ?? new Set<number>()
    const n = changedOf(r.hunk) ?? 0
    for (const [a, b] of r.ranges) for (let i = Math.max(1, a); i <= Math.min(b, n); i++) set.add(i)
    out.set(r.hunk, set)
  }
  return out
}

export type Claim = { hunk: Hunk; lines: Set<number> | null }
export type Uncovered = { hunk: Hunk; lines: Set<number> | null }

// Changed lines that no claim covers. A hunk with no claims at all is
// uncovered whole (lines: null); a header-only hunk is covered by any claim.
export function uncovered(hunks: Hunk[], claims: Claim[]): Uncovered[] {
  const out: Uncovered[] = []
  for (const h of hunks) {
    const mine = claims.filter((c) => c.hunk === h)
    if (!mine.length) { out.push({ hunk: h, lines: null }); continue }
    if (mine.some((c) => c.lines === null)) continue
    const covered = new Set(mine.flatMap((c) => [...c.lines!]))
    const missing = new Set<number>()
    const n = changedCount(h)
    for (let i = 1; i <= n; i++) if (!covered.has(i)) missing.add(i)
    if (missing.size) out.push({ hunk: h, lines: missing })
  }
  return out
}

// Every group's page carries the lines it claims, and building it costs more
// than linear in them: measured, 200,000 claimed lines build in about half a
// second, 1,000,000 in 3 to 10 s, 5,000,000 in over a minute. Sharing a hunk
// between a few dozen groups is normal (one per dependency in a lockfile); the
// budget is far above that, and a gloss may always claim 5 times the diff.
export const MAX_CLAIMED_LINES = 500_000
const MAX_CLAIM_FACTOR = 5

// A message for a gloss whose groups claim too many lines, or null. Used when a
// gloss is written and when it is read, so `add` never writes one readers refuse.
export function claimsProblem(claims: Claim[], hunks: Hunk[]): string | null {
  let total = 0
  for (const h of hunks) total += changedCount(h)
  let claimed = 0
  for (const c of claims) claimed += c.lines ? c.lines.size : changedCount(c.hunk)
  const limit = Math.max(MAX_CLAIMED_LINES, MAX_CLAIM_FACTOR * total)
  if (claimed <= limit) return null
  return `the groups claim ${claimed} changed lines in all (the commit has ${total}; at most ${limit} are allowed): give each group only the lines it explains (h1:1-40) instead of the whole hunk, or use fewer groups on the same hunk`
}
