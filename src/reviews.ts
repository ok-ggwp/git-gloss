import { createHash, randomUUID } from 'node:crypto'
import { commitDiff, git, gitCleanup, gitTry, GlossError, readNote, rethrowTimeout } from './git.ts'
import { parseDiff, type Hunk } from './diff.ts'
import type { Annotation, Group } from './schema.ts'
import { bodyLines } from './selection.ts'
import { plain } from './plain.ts'
import { checkItems, MAX_REPORT_CHARS, type Item } from './findings-block.ts'

// Reviews of commits (by git-gud, or anything else that records them), kept
// beside the glosses so a reader can see whether a gloss was checked. One JSON
// record per line: notes from different people and machines combine by taking
// every line (git's cat_sort_uniq), with no conflicts.
export const REVIEWS_REF = 'refs/notes/gloss-reviews'

export type ReviewRecord = {
  review: 1
  // Shared by the records one review run leaves on each commit it covered.
  id: string
  at: string
  // bugs, honesty, improve, or another name for another kind of review.
  stage: string
  agent: string
  model?: string
  // How the reviewer ran: direct (the user's own settings) or sandboxed.
  mode?: string
  // What was asked for: a commit, a range, or wip.
  target: string
  // What the reviewer saw of this commit: a key per changed line, and per
  // gloss group, so later readers can tell whether the code or the gloss
  // changed since. Keys are content hashes, so they hold through rebases,
  // squashes and a wip gloss adopted onto commits.
  lines: string[]
  groups: string[]
  // The review's report, as the reviewer wrote it.
  findings: string
  // From the report's last VERDICT line: clean (nothing worth acting on) or
  // issues; absent when the report has none.
  verdict?: 'clean' | 'issues'
  // The report's structured findings (its gloss-findings block), validated when
  // recorded. Absent on a record made before they were required: a legacy review,
  // listed and shown like any other but with no findings to decide.
  items?: Item[]
}

// The report's VERDICT line, which has to be a line of its own among the
// last three, so a verdict quoted in the body can't stand in for it.
export function verdictOf(findings: string): 'clean' | 'issues' | undefined {
  const tail = findings.trim().split('\n').filter((l) => l.trim()).slice(-3).reverse()
  for (const line of tail) {
    // The whole line, give or take markdown: not a sentence that starts so.
    const m = /^\W*VERDICT:\W*(CLEAN|ISSUES)\W*$/i.exec(line.trim())
    if (m) return m[1].toLowerCase() as 'clean' | 'issues'
  }
  return undefined
}

const key = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

// One key per changed line, repeated for repeated lines (a second "}" is a
// second key), so adding another copy of a reviewed line isn't "seen". A
// change with no lines (a binary file, a mode change, a pure rename) is keyed
// by its file and content hash.
export const lineKeys = (hunks: Hunk[]): string[] =>
  hunks.flatMap((h) => {
    const lines = bodyLines(h).filter((l) => l.idx !== null)
    return lines.length ? lines.map((l) => key(`${h.file}\0${l.raw}`)) : [key(`meta\0${h.file}\0${h.hash}`)]
  }).sort()

// A group's meaning, without its id or hunk references (which change when a
// gloss is carried or adopted) and without the notes carrying adds.
export function groupKey(g: Group): string {
  const notes = (g.notes ?? '').replace(/\s*\((?:from [0-9a-f]{7,}|also served [^)]*)\)/g, '').trim()
  const serves = (Array.isArray(g.serves) ? g.serves : [g.serves]).slice().sort()
  return key(JSON.stringify([g.intent, g.necessity, serves, g.removal_impact, g.evidence ?? '', notes]))
}

// The gloss's parts a reviewer checks: each group, each risk and each
// rejected alternative (keyed one by one, so a squash that combines several
// glosses' risks still matches the reviews of each). The task and summary
// are left out: carrying joins them.
export function glossKeys(a: Annotation): string[] {
  return [
    ...a.groups.map(groupKey),
    ...(a.risks ?? []).map((r) => key(`risk\0${r}`)),
    ...(a.alternatives ?? []).map((x) => key(`alternative\0${x.option}\0${x.rejected_because}`)),
  ]
}

// What a reviewer of `sha` sees now: its changed lines and its gloss's groups.
export function stamp(sha: string): { lines: string[]; groups: string[] } {
  let groups: string[] = []
  try {
    const note = readNote(sha)
    groups = note ? glossKeys(note.annotation) : []
  } catch (err) { rethrowTimeout(err) /* an unreadable gloss: nothing to stamp */ }
  return { lines: lineKeys(parseDiff(commitDiff(sha))), groups }
}

// What a review record may hold, for readers and for `--record`. The line
// carries a stamp of one 16-character key per changed line, so it can be large
// for a large change (16,000 changed lines make about 300 KB) without being
// junk: measured, JSON.parse reads 32 MB in under 0.1 s. So the line is only
// bounded generously (8 MiB, about 440,000 changed lines), and the report text,
// which is what gets rendered and printed, is bounded on its own.
export const MAX_REVIEW_LINE = 8 * 1024 * 1024
export const MAX_FINDINGS = MAX_REPORT_CHARS
const warnedLong = new Set<string>()
// How many records the last read of each commit's reviews had to skip for size or invalid items, so a gate can fail closed.
const skippedAt = new Map<string, number>()
export const skippedCount = (sha: string): number => { readReviews(sha); return skippedAt.get(sha) ?? 0 }

export function readReviews(sha: string): ReviewRecord[] {
  const raw = gitTry(['notes', '--ref', REVIEWS_REF, 'show', sha])
  if (!raw) return []
  // A rebase can join a note onto one with the same lines; each counts once.
  const kept: string[] = []
  let skipped = 0
  for (const l of new Set(raw.split('\n'))) {
    if (!l.trim()) continue
    if (l.length <= MAX_REVIEW_LINE) kept.push(l)
    else if (!mayBeDecision(l)) skipped++
  }
  const records = kept.flatMap((line) => {
    try {
      const r = JSON.parse(line)
      // Records arrive from other machines; skip any that aren't whole.
      const ok = r?.review === 1 && Array.isArray(r.lines) && Array.isArray(r.groups) &&
        ['id', 'at', 'stage', 'agent', 'target', 'findings'].every((k) => typeof r[k] === 'string') &&
        ['model', 'mode'].every((k) => r[k] === undefined || typeof r[k] === 'string') &&
        (r.verdict === undefined || r.verdict === 'clean' || r.verdict === 'issues')
      // Everything shown later may reach a terminal: clean it once, here. The
      // id stays as written, since decisions refer to it.
      // A line that is not a whole review is skipped, and counted unless it is a decision line (those
      // are read, and checked, by readDecisions): a gate must know it could not read something.
      if (!ok) { if (r?.decision !== 1) skipped++; return [] }
      if (r.findings.length > MAX_FINDINGS) { skipped++; return [] }
      // Items are checked as they were when recorded; a record whose are not whole is skipped
      // like any malformed one (read as legacy, its open findings would vanish). Rebuilt, never copied.
      let items: Item[] | undefined
      if (r.items !== undefined) {
        const checked = checkItems(r.items)
        if (!('items' in checked)) { skipped++; return [] }
        items = checked.items
      }
      const one = (v: string) => plain(v)
      return [{
        ...r, ...(items ? { items } : {}), at: one(r.at), stage: one(r.stage), agent: one(r.agent), target: one(r.target), findings: plain(r.findings, true),
        ...(r.model !== undefined ? { model: one(r.model) } : {}), ...(r.mode !== undefined ? { mode: one(r.mode) } : {}),
      } as ReviewRecord]
    } catch {
      skipped++ // not JSON
      return []
    }
  })
  skippedAt.set(sha, skipped)
  // Said once per commit, though several readers ask for the same note.
  if (skipped && !warnedLong.has(sha)) {
    warnedLong.add(sha)
    console.error(`warning: skipped ${skipped} review record${skipped === 1 ? '' : 's'} on ${sha.slice(0, 10)}: malformed, over the size caps of report ${MAX_FINDINGS / 1024} KiB, line ${MAX_REVIEW_LINE / 1024 / 1024} MiB or with items that are not valid; what they said is not counted`)
  }
  return records
}

export const OUTCOMES = ['fixed', 'follow-up', 'rejected', 'accepted'] as const
export type Outcome = (typeof OUTCOMES)[number]

// What the arbiter of a review did about it, one line in the same note as the
// review it answers. Either one finding's outcome, or `complete: true`: the
// arbiter has finished and no more decisions are coming (which is what tells
// "5 ignored" from "all arbitrated"). Findings are free text, so `finding`
// is whatever names the finding ("1", "Rework: wip rule claim").
export type DecisionRecord = {
  decision: 1
  review: string
  at: string
  by: string
  finding?: string
  outcome?: Outcome
  note?: string
  complete?: true
}

const MAX_TEXT = 2000
const MAX_BY = 200
// A decision line is a few hundred bytes; anything this long is junk, skipped
// before it is parsed.
export const MAX_DECISION_LINE = 16 * 1024

// A line over the review cap is told from an over-cap decision line (junk, skipped
// silently) without parsing it: `"decision"` among its first 64 characters. Key order is
// free, so this is a heuristic: a rare over-cap review line that mentions it there is
// silent too; and an over-cap decision line whose "decision" key lies beyond the first 64
// characters is counted as a skipped review record, with a warning.
const mayBeDecision = (line: string) => line.slice(0, 64).includes('"decision"')

// The shape rule for a decision, shared by the reader and the writer so they cannot
// drift: a complete marker has no finding, outcome or note; any other decision has a
// finding, an outcome and optionally a note.
export const isValidDecision = (r: { finding?: unknown; outcome?: unknown; note?: unknown; complete?: unknown }): boolean => {
  const text = (v: unknown) => typeof v === 'string' && v.length <= MAX_TEXT
  return r.complete === true
    ? r.finding === undefined && r.outcome === undefined && r.note === undefined
    : r.complete === undefined && text(r.finding) && plain(r.finding as string).trim().length > 0 &&
      OUTCOMES.includes(r.outcome as Outcome) && (r.note === undefined || text(r.note))
}

// Reads the decisions on a commit that answer a review recorded on it.
export function readDecisions(sha: string): DecisionRecord[] {
  const raw = gitTry(['notes', '--ref', REVIEWS_REF, 'show', sha])
  if (!raw) return []
  const lines = [...new Set(raw.split('\n'))].filter((l) => l.length <= MAX_DECISION_LINE)
  if (!lines.length) return []
  const ids = new Set(readReviews(sha).map((r) => r.id))
  return lines.flatMap((line) => {
    try {
      const r = JSON.parse(line)
      const str = (k: string) => typeof r?.[k] === 'string'
      const ok = r?.decision === 1 && ids.has(r.review) && str('at') && str('by') && isValidDecision(r) &&
        r.at.length <= 64 && r.by.length <= MAX_BY
      return ok ? [r as DecisionRecord] : []
    } catch {
      return []
    }
  })
}

export const checkBy = (by: string) => {
  if (!by) throw new GlossError('--by needs a name (or set git config user.name)')
  if (by.length > MAX_BY) throw new GlossError(`--by is too long (${by.length} characters; at most ${MAX_BY})`)
}

// Who a decision is by: --by, else git's user.name, else "unknown"; checked like any --by.
export const resolveBy = (arg: string | undefined): string => {
  const by = arg !== undefined ? arg.trim() : gitTry(['config', 'user.name'])?.trim() || 'unknown'
  checkBy(by)
  return by
}

// What `--decide` may name: a finding id of a review that has structured findings.
// A legacy review (recorded before they were required) has none to decide.
export const requireItems = (items: Item[] | undefined): Item[] => {
  if (!items) throw new GlossError('that review was recorded without structured findings (a gloss-findings block), so it has no findings to decide; review again with a report that has the block')
  return items
}

export const checkFinding = (items: Item[] | undefined, finding: string | undefined): string => {
  const list = requireItems(items)
  const id = finding?.trim()
  if (!id) throw new GlossError('--decide needs --finding <the id of a finding of the review>')
  if (!list.some((i) => i.id === id)) {
    const known = list.slice(0, 20).map((i) => i.id).join(', ')
    throw new GlossError(`the review has no finding "${plain(id).slice(0, 40)}"` + (list.length ? ` (its findings: ${known}${list.length > 20 ? ', ...' : ''})` : ' (it has no findings)'))
  }
  return id
}

export const checkDecision = (d: { finding?: string; outcome?: string; note?: string }, items: Item[] | undefined): string => {
  const finding = checkFinding(items, d.finding)
  if (!OUTCOMES.includes(d.outcome as Outcome)) throw new GlossError(`--outcome must be one of ${OUTCOMES.join(', ')}`)
  if (d.note && d.note.length > MAX_TEXT) throw new GlossError(`--note is too long (${d.note.length} characters; at most ${MAX_TEXT})`)
  // The reader's rule is the one rule: nothing it would skip is written.
  if (!isValidDecision({ ...d, finding })) throw new GlossError('that decision is not valid: it needs a finding, an outcome, and optionally a note')
  return finding
}

// The review's items with where each stands: open, or the outcome of the latest decision
// naming its id. Null for a legacy review (no items). Decisions naming no item are not counted.
export type ItemStatus = { item: Item; status: 'open' | Outcome; decision?: DecisionRecord }
export function itemStatuses(r: ReviewRecord, decisions: DecisionRecord[]): ItemStatus[] | null {
  if (!r.items) return null
  const latest = new Map<string, DecisionRecord>()
  for (const d of decisions.filter((d) => d.review === r.id && d.outcome && d.finding !== undefined).sort((a, b) => a.at.localeCompare(b.at))) latest.set(d.finding!, d)
  return r.items.map((item) => {
    const decision = latest.get(item.id)
    return decision ? { item, status: decision.outcome!, decision } : { item, status: 'open' }
  })
}

// "3 findings: 1 open, 1 fixed, 1 follow-up".
export function findingsSummary(rows: ItemStatus[]): string {
  const parts = (['open', ...OUTCOMES] as const).map((k) => [k, rows.filter((r) => r.status === k).length] as const).filter(([, n]) => n)
  return `${rows.length} finding${rows.length === 1 ? '' : 's'}${parts.length ? `: ${parts.map(([k, n]) => `${n} ${k}`).join(', ')}` : ''}`
}

// Decisions in the order of the review's items (the order the reviewer listed them); ones
// naming no item, such as old text decisions, follow in the order given.
export function byItemOrder(r: ReviewRecord, ds: DecisionRecord[]): DecisionRecord[] {
  const at = new Map((r.items ?? []).map((i, n) => [i.id, n] as const))
  const rank = (d: DecisionRecord) => at.get(d.finding ?? '') ?? at.size
  return ds.map((d, n) => [d, n] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([d]) => d)
}

// "3 fixed, 1 rejected · complete", or "2 decided · not marked complete".
export function decisionSummary(ds: DecisionRecord[], complete = ds.some((d) => d.complete)): string {
  const counts = OUTCOMES.map((o) => [o, ds.filter((d) => d.outcome === o).length] as const).filter(([, n]) => n)
  const n = counts.reduce((a, [, c]) => a + c, 0)
  if (!n) return complete ? 'none · complete' : 'none yet'
  return `${complete ? counts.map(([o, c]) => `${c} ${o}`).join(', ') : `${n} decided`} · ${complete ? 'complete' : 'not marked complete'}`
}

// Adds records (reviews or decisions) to a commit's note, keeping each line once. Several
// reviews can finish at once, so the write is a compare-and-swap: the new
// notes commit is built under a private ref, and the reviews ref moves to it
// only if nobody else moved it meanwhile; otherwise it starts again.
export function addReviews(sha: string, records: (ReviewRecord | DecisionRecord | string)[]): void {
  // A string is a note line kept exactly as it was (see copyReviews).
  const mine = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
  // git notes needs it under refs/notes; named so the refs/notes/gloss*
  // fetch glob never matches it.
  const tmp = `refs/notes/tmp-gloss-reviews-${process.pid}-${randomUUID().slice(0, 8)}`
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      const old = gitTry(['rev-parse', '-q', '--verify', REVIEWS_REF])?.trim() ?? null
      if (old) git(['update-ref', tmp, old])
      else gitCleanup(['update-ref', '-d', tmp])
      const existing = (gitTry(['notes', '--ref', tmp, 'show', sha]) ?? '').split('\n').filter(Boolean)
      const lines = [...new Set([...existing, ...mine])].sort()
      git(['notes', '--ref', tmp, 'add', '-f', '-F', '-', sha], lines.join('\n') + '\n')
      const next = git(['rev-parse', tmp]).trim()
      // An empty old value means "must not exist yet".
      if (gitTry(['update-ref', REVIEWS_REF, next, old ?? '']) !== null) return
    }
    throw new GlossError(`couldn't record the review on ${sha.slice(0, 10)}: other processes kept writing reviews at the same time`)
  } finally {
    gitCleanup(['update-ref', '-d', tmp])
  }
}

// Whether a note line is a decision record (valid or not): over the decision cap it is told by the
// start of the line, as readReviews does.
const isDecisionLine = (l: string) => {
  // Over the review line cap a line is told by its start, as readReviews does (and skips silently).
  if (l.length > MAX_REVIEW_LINE) return mayBeDecision(l)
  // Any other line is a decision only if it parses as one, whatever its length: a long malformed line
  // that looks like one is counted as unreadable by readReviews, so it is copied like any such line.
  try { return JSON.parse(l)?.decision === 1 } catch { return false }
}

// Reviews follow a gloss onto commits made from the reviewed ones (adopt, carry, a wip re-snapshot);
// their keys decide what they still cover there. Review lines are copied exactly as stored, also the
// ones this version cannot read (a newer writer's, malformed ones): losing one would let the gate pass
// on the new commit where it fails on the old one, and the reader skips and counts it there as here.
// Decisions are copied only when valid, and only with a review that is on the commit.
export function copyReviews(from: string[], to: string): void {
  const lines = from.flatMap((sha) => {
    const raw = gitTry(['notes', '--ref', REVIEWS_REF, 'show', sha])
    return raw ? [...new Set(raw.split('\n'))].filter((l) => l.trim() && !isDecisionLine(l)) : []
  })
  const records = [...lines, ...from.flatMap(readDecisions)]
  if (records.length) addReviews(to, records)
}

export type StageStatus = {
  stage: string
  reviews: ReviewRecord[]
  // What the commit is made of now: its gloss groups, and its changed lines.
  now: { lines: string[]; groups: string[] }
  // Whether this stage's reviews saw every changed line of the commit, and
  // every group of its current gloss (null: no gloss to have seen).
  code: 'seen' | 'changed'
  gloss: 'seen' | 'changed' | null
}

// Whether reviews saw every changed line, counting repeats: each distinct
// stamp (reviews of different commits, as for a squash) contributes its
// lines; reviews of the same stamp count once.
function covers(reviews: ReviewRecord[], lines: string[]): boolean {
  const seen = new Map<string, number>()
  const stamps = new Set<string>()
  for (const r of reviews) {
    const id = r.lines.join(',')
    if (stamps.has(id)) continue
    stamps.add(id)
    const counts = new Map<string, number>()
    for (const l of r.lines) counts.set(l, (counts.get(l) ?? 0) + 1)
    for (const [l, n] of counts) seen.set(l, (seen.get(l) ?? 0) + n)
  }
  const need = new Map<string, number>()
  for (const l of lines) need.set(l, (need.get(l) ?? 0) + 1)
  return [...need].every(([l, n]) => (seen.get(l) ?? 0) >= n)
}

// Per stage: whether the commit as it is now was reviewed. A commit squashed
// from several reviewed ones is covered when their reviews together saw all
// of it.
export function reviewStatus(sha: string, current = stamp(sha)): StageStatus[] {
  const byStage = new Map<string, ReviewRecord[]>()
  for (const r of readReviews(sha)) byStage.set(r.stage, [...(byStage.get(r.stage) ?? []), r])
  return [...byStage].map(([stage, reviews]) => {
    const groups = new Set(reviews.flatMap((r) => r.groups))
    return {
      stage,
      now: current,
      reviews: reviews.sort((a, b) => b.at.localeCompare(a.at)),
      code: covers(reviews, current.lines) ? 'seen' : 'changed',
      gloss: current.groups.length ? (current.groups.every((g) => groups.has(g)) ? 'seen' : 'changed') : null,
    }
  })
}

// Whether this stage's reviews still apply to the commit as it is now.
export const current = (s: StageStatus) =>
  s.code === 'seen' && !((s.stage === 'honesty' || s.stage === 'improve') && s.gloss === 'changed')

// What the reviews concluded about the commit as it is now. Each part of it
// (a gloss group for honesty and improve, else a changed line) takes the
// verdict of the latest review that saw it, so fixing a gloss and having it
// reviewed again replaces the earlier verdict for the parts it saw. Issues
// if any part's latest review found some; clean if every part's said clean.
export function verdict(s: StageStatus): 'clean' | 'issues' | 'unknown' {
  const v = latestVerdicts(s)
  return v.includes('issues') ? 'issues' : v.length && v.every((x) => x === 'clean') ? 'clean' : 'unknown'
}

// The newest review that saw each part of the commit (a gloss group for honesty and
// improve, else a changed line); `needVerdict` skips reviews that have no VERDICT line.
function latestReviews(s: StageStatus, needVerdict: boolean): ReviewRecord[] {
  const byGroups = (s.stage === 'honesty' || s.stage === 'improve') && s.now.groups.length
  const parts = byGroups ? s.now.groups : s.now.lines
  // s.reviews is newest first.
  const latest = new Set<ReviewRecord>()
  for (const part of parts) {
    // A review without a verdict line says nothing either way, so it doesn't
    // replace an earlier one's.
    const r = s.reviews.find((r) => (!needVerdict || r.verdict) && (byGroups ? r.groups : r.lines).includes(part))
    if (r) latest.add(r)
  }
  return [...latest]
}

const latestVerdicts = (s: StageStatus): (ReviewRecord['verdict'])[] => latestReviews(s, true).map((r) => r.verdict)

// Whether the review's own stamp no longer fits the commit: it saw a changed line that is gone
// (or, for honesty and improve, a gloss group that is gone), or its stage no longer covers the
// commit. Per review: a newer clean review that makes the stage current does not clear an older
// review's label.
export function reviewStale(s: StageStatus, r: ReviewRecord): boolean {
  if (!current(s)) return true
  const now = new Map<string, number>()
  for (const l of s.now.lines) now.set(l, (now.get(l) ?? 0) + 1)
  for (const l of r.lines) {
    const n = now.get(l) ?? 0
    if (!n) return true
    now.set(l, n - 1)
  }
  return (s.stage === 'honesty' || s.stage === 'improve') && r.groups.some((g) => !s.now.groups.includes(g))
}

export type OpenItem = { review: ReviewRecord; item: Item; stale: boolean; shas: string[] }

// What the open-findings gate looks at, per commit: its stage statuses (for the stale label)
// and its decisions.
export type Held = { sha: string; statuses: StageStatus[]; decisions: DecisionRecord[] }
export const heldBy = (sha: string, statuses = reviewStatus(sha), decisions = readDecisions(sha)): Held => ({ sha, statuses, decisions })

// The findings with no decision yet, over some commits (a target). Fail-closed model: every item
// of every structured review (a record with items) held by any of the commits counts, whatever its
// stage and whether the code changed since; a clean re-run of a stage clears nothing; a legacy record
// has no items and hides nothing. A review that spans several commits is one review: its items are
// counted once, and an item is decided by the latest decision for (review, item) among the decisions
// of ALL the commits, so one made through a narrower target counts for the whole review. Staleness
// (the code or gloss changed since the review) is only a label, never a reason to drop an item.
export function openFindings(held: Held[]): OpenItem[] {
  const reviews = new Map<string, { review: ReviewRecord; stale: boolean; shas: string[] }>()
  for (const { sha, statuses } of held) {
    for (const s of statuses) {
      for (const review of s.reviews) {
        if (!review.items) continue
        const e = reviews.get(review.id) ?? { review, stale: false, shas: [] }
        e.stale ||= reviewStale(s, review)
        e.shas.push(sha)
        reviews.set(review.id, e)
      }
    }
  }
  const decisions = held.flatMap((h) => h.decisions)
  return [...reviews.values()].flatMap(({ review, stale, shas }) =>
    (itemStatuses(review, decisions) ?? []).filter((x) => x.status === 'open').map((x) => ({ review, item: x.item, stale, shas })))
}

export const openItems = (sha: string, statuses?: StageStatus[], decisions?: DecisionRecord[]): OpenItem[] => openFindings([heldBy(sha, statuses, decisions)])

// Whether any structured review in these statuses lists findings (so "no open findings" is a statement).
export const hasItems = (statuses: StageStatus[]) => statuses.some((s) => s.reviews.some((r) => r.items?.length))

// Whether a review older than the ones deciding the verdict found issues:
// a clean result is then shown as following an earlier one with issues.
export const earlierIssues = (s: StageStatus) =>
  verdict(s) !== 'issues' && s.reviews.some((r) => r.verdict === 'issues')

// What a verdict means for each stage: improve's "issues" are suggestions.
const WORDS: Record<string, { clean: string; issues: string }> = {
  bugs: { clean: 'no defects found', issues: 'defects found' },
  adversarial: { clean: 'no exploit found', issues: 'exploit or failing case found' },
  mutate: { clean: 'all mutations caught', issues: 'surviving mutations' },
  improve: { clean: 'nothing to improve', issues: 'suggestions' },
  default: { clean: 'no issues', issues: 'issues found' },
}

// One short phrase per stage, for summaries: "honesty: issues found (claude,
// 2026-10-18)". A review says the commit was checked, not that it passed.
export function statusPhrase(s: StageStatus): string {
  const latest = s.reviews[0]
  const who = `${latest.agent}${latest.model ? `:${latest.model}` : ''}, ${latest.at.slice(0, 10)}${s.reviews.length > 1 ? `, ${s.reviews.length} reviews` : ''}`
  if (s.code === 'changed') return `${s.stage}: code changed since review (${who})`
  if (!current(s)) {
    const never = s.reviews.every((r) => !r.groups.length)
    return `${s.stage}: ${never ? 'reviewed before it was glossed' : 'gloss changed since review'} (${who})`
  }
  const v = verdict(s)
  const words = Object.hasOwn(WORDS, s.stage) ? WORDS[s.stage] : WORDS.default
  return `${s.stage}: ${v === 'clean' ? words.clean : v === 'issues' ? words.issues : 'reviewed'} (${who}` +
    `${earlierIssues(s) ? '; an earlier review found issues' : ''})`
}
