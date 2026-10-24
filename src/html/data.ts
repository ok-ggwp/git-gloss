import { commitDiff, commitSubject, git } from '../git.ts'
import { decisionSummary, readDecisions, reviewStatus, statusPhrase, verdict } from '../reviews.ts'
import { parseDiff } from '../diff.ts'
import { loadGloss } from '../loader.ts'
import type { Hunk } from '../diff.ts'
import type { GroupHunk, LoadedGloss } from '../loader.ts'
import { belowFloor } from '../render.ts'
import { showsImpact, tryAnalyze } from '../floor.ts'
import { bodyLines, changedCount, gapText, isGap, refLabel, slice, sliceStats } from '../selection.ts'
import { IMPACT, IMPACT_HELP, NECESSITY, NECESSITY_HELP, servesOf, type Attention, type AttentionLevel, type Impact, type Necessity } from '../schema.ts'

// Everything the page needs, precomputed so the client only lays it out.
export type PageLine =
  | { kind: 'add' | 'del' | 'ctx' | 'meta'; old: number | null; new: number | null; text: string }
  | { kind: 'gap'; old: null; new: null; text: string }

export type PageHunk = {
  id: string
  // "h6" or "h6:5-12": what this group claims of the hunk.
  ref: string
  file: string
  oldFile: string | null
  range: string
  status: 'ok' | 'changed' | 'missing' | 'unannotated'
  added: number
  removed: number
  alsoIn: string[]
  lines: PageLine[]
}

export type PageGroup = {
  id: string
  intent: string
  necessity: Necessity
  impact?: Impact
  impact_reason?: string
  // The group's floor from the diff, shown as a derived impact when none is declared.
  impact_derived?: Impact
  // Always a list (normalised with servesOf), which the client relies on.
  serves: string[]
  removal_impact: string
  evidence?: string
  notes?: string
  stale: number
  total: number
  added: number
  removed: number
  // Lines changed, with hunks shared between groups split evenly among them,
  // so the necessity bar adds up to the size of the commit.
  weight: number
  hunks: PageHunk[]
}

// One commit's part of the page. A commit in a range may have no gloss; then
// its whole diff is listed as unannotated.
export type CommitData = {
  sha: string
  subject: string
  author: string
  date: string
  glossed: boolean
  task: string
  summary?: string
  // The declared attention, or null when the gloss declares none ("unrated").
  attention: Attention | null
  // Computed on read, not stored: the floor, the attention derived when none is
  // declared (with why), and whether the declared one is below the floor. Null
  // when no signals could be computed.
  computed: { floor: AttentionLevel; derived: { level: AttentionLevel; reasons: string[] }; below: boolean; timedOut: string[] } | null
  warnings: string[]
  groups: PageGroup[]
  // Group ids in review order: the attention's focus groups first, then by
  // impact (declared, else derived) high to low, then by size, ties in the
  // order of `groups`. Empty when there is no gloss.
  order: string[]
  unannotated: PageHunk[]
  alternatives: { option: string; rejected_because: string }[]
  risks: string[]
  // Per review stage: whether the commit as it is now was reviewed, and the
  // reviews' reports (shown as text).
  reviews: PageReview[]
}

export type PageReview = {
  stage: string
  state: 'seen' | 'code-changed' | 'gloss-changed'
  verdict: 'clean' | 'issues' | 'unknown'
  phrase: string
  entries: PageEntry[]
}

// The most decisions listed per review (the newest); the summary counts all of them.
export const MAX_PAGE_DECISIONS = 200

export type PageEntry = {
  id: string
  agent: string
  model?: string
  mode?: string
  at: string
  target: string
  findings: string
  // Only on an entry that is not clean or that has decisions: what was decided
  // about it (oldest first), whether the arbiter marked it complete, and the
  // summary line. A clean review with no decisions has none of the three.
  decisions?: { outcome: string; finding: string; note?: string; by: string; at: string }[]
  complete?: boolean
  summary?: string
  // The review's own verdict and how many per-finding decisions it has in all
  // (`decisions` holds only the newest MAX_PAGE_DECISIONS of them).
  verdict?: 'clean' | 'issues'
  decisionCount?: number
}

function pageReviews(sha: string): PageReview[] {
  const all = readDecisions(sha)
  return reviewStatus(sha).map((s) => ({
    stage: s.stage,
    state: s.code === 'changed' ? 'code-changed'
      : (s.stage === 'honesty' || s.stage === 'improve') && s.gloss === 'changed' ? 'gloss-changed' : 'seen',
    verdict: verdict(s),
    phrase: statusPhrase(s),
    entries: s.reviews.map((r): PageEntry => {
      const entry: PageEntry = { id: r.id, agent: r.agent, model: r.model, mode: r.mode, at: r.at, target: r.target, findings: r.findings }
      const ds = all.filter((d) => d.review === r.id)
      if (r.verdict === 'clean' && !ds.length) return entry
      const done = ds.filter((d) => d.outcome).sort((a, b) => a.at.localeCompare(b.at))
      entry.decisions = done.slice(-MAX_PAGE_DECISIONS).map((d) => ({ outcome: d.outcome!, finding: d.finding!, ...(d.note ? { note: d.note } : {}), by: d.by, at: d.at }))
      entry.complete = ds.some((d) => d.complete)
      entry.summary = decisionSummary(ds)
      entry.verdict = r.verdict
      entry.decisionCount = done.length
      return entry
    }),
  }))
}

export type PageData = {
  // The range as given (e.g. "main..feature"), or null for a single commit.
  range: string | null
  // Merge commits in the range, which the page lists but doesn't review.
  merges: { sha: string; subject: string }[]
  necessity: { name: Necessity; help: string }[]
  impact: { name: Impact; help: string }[]
  commits: CommitData[]
  generated: string
  // Only when served by `git gloss ary`: what the branch pickers in the top bar show.
  ary?: AryData
}

export type AryData = {
  repo: string
  branches: string[]
  remotes: string[]
  defaultBase: string | null
  // What is selected: the pickers' values and the revision box.
  head: string | null
  base: string | null
  rev: string
  // Said when a head or base in the URL no longer exists.
  notice: string | null
}

// The lines to show for a selection: the @@ header, then the slice, with
// changed lines that belong to other groups collapsed into gap rows.
export function pageLines(h: Hunk, selected: Set<number> | null): PageLine[] {
  const body = bodyLines(h)
  if (body.every((l) => l.kind === 'meta')) return body.map((l) => ({ kind: 'meta', old: null, new: null, text: l.raw }))
  const header: PageLine = { kind: 'meta', old: null, new: null, text: h.text.split('\n')[0] }
  return [header, ...slice(body, selected).map((l): PageLine => isGap(l)
    ? { kind: 'gap', old: null, new: null, text: gapText(l.gap) }
    : { kind: l.kind, old: l.oldNo, new: l.newNo, text: l.kind === 'meta' ? l.raw : l.raw.slice(1) })]
}

// A glossed hunk that is no longer in the commit: shown as a placeholder so
// the reader can see what the gloss refers to, rather than it vanishing.
function missingHunk(h: GroupHunk): PageHunk {
  const s = h.stored
  return {
    id: h.id,
    ref: refLabel(h.id, h.lines),
    file: s?.file ?? '?',
    oldFile: s?.oldFile && s.oldFile !== s.file ? s.oldFile : null,
    range: s && (s.newLines || s.oldLines) ? `-${s.oldStart},${s.oldLines} +${s.newStart},${s.newLines}` : '',
    status: 'missing',
    added: 0,
    removed: 0,
    alsoIn: [],
    lines: [],
  }
}

function pageHunk(h: Hunk, lines: Set<number> | null, status: PageHunk['status'], alsoIn: string[]): PageHunk {
  const counts = sliceStats(h, lines)
  return {
    id: h.id,
    ref: refLabel(h.id, lines),
    file: h.file,
    oldFile: h.oldFile && h.oldFile !== h.file ? h.oldFile : null,
    range: h.newLines || h.oldLines ? `-${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}` : 'file header',
    status,
    added: counts.added,
    removed: counts.removed,
    alsoIn,
    lines: pageLines(h, lines),
  }
}

// The order a reviewer should read a commit's groups in. Deterministic: a
// stable sort over the groups as they come, so ties keep their order.
export function reviewOrder(groups: PageGroup[], focus: string[] = []): string[] {
  const rank = (g: PageGroup) => IMPACT.indexOf((g.impact ?? g.impact_derived)!) + 1 // 0: unrated
  const first = (g: PageGroup) => (focus.includes(g.id) ? focus.indexOf(g.id) : focus.length)
  return groups
    .map((g, i) => ({ g, i }))
    .sort((a, b) => first(a.g) - first(b.g) || rank(b.g) - rank(a.g) || (b.g.added + b.g.removed) - (a.g.added + a.g.removed) || a.i - b.i)
    .map((x) => x.g.id)
}

const allLines = (h: Hunk) => Array.from({ length: changedCount(h) }, (_, i) => i + 1)

export function commitData(gloss: LoadedGloss): CommitData {
  const [author, date] = git(['log', '-1', '--format=%an%x00%aI', gloss.sha]).trim().split('\0')
  const a = gloss.note.annotation
  const an = tryAnalyze(gloss)
  // Same threshold as `show`: derived impact badges only where the diff puts a group above module.
  const derivedImpact = showsImpact(gloss.groups.map((x) => x.group), an)

  // Which groups claim each changed line, so shared lines are split between
  // their groups in the bar and each hunk can link to the groups it shares
  // lines with. A header-only hunk counts as one shared unit.
  const owners = new Map<Hunk, Map<number, string[]>>()
  const claimed = (h: Hunk, lines: Set<number> | null) => (changedCount(h) ? [...(lines ?? allLines(h))] : [0])
  for (const g of gloss.groups) {
    for (const h of g.hunks) {
      if (!h.current) continue
      const byLine = owners.get(h.current) ?? new Map<number, string[]>()
      for (const i of claimed(h.current, h.lines)) byLine.set(i, [...(byLine.get(i) ?? []), g.group.id])
      owners.set(h.current, byLine)
    }
  }

  const groups = gloss.groups
    .map(({ group: g, hunks }): PageGroup => {
      const live = hunks.filter((h): h is GroupHunk & { current: Hunk } => h.current !== null)
      const counts = live.map((h) => sliceStats(h.current, h.lines))
      const shares = (h: GroupHunk & { current: Hunk }) => claimed(h.current, h.lines).map((i) => owners.get(h.current)!.get(i)!)
      return {
        id: g.id,
        intent: g.intent,
        necessity: g.necessity,
        impact: g.impact,
        impact_reason: g.impact_reason,
        impact_derived: g.impact || !derivedImpact ? undefined : an?.groups.get(g.id)?.floor,
        serves: servesOf(g),
        removal_impact: g.removal_impact,
        evidence: g.evidence,
        notes: g.notes,
        stale: hunks.filter((h) => h.status !== 'ok').length,
        total: hunks.length,
        added: counts.reduce((n, c) => n + c.added, 0),
        removed: counts.reduce((n, c) => n + c.removed, 0),
        weight: live.reduce((n, h) => n + (changedCount(h.current) ? shares(h).reduce((w, o) => w + 1 / o.length, 0) : 0), 0),
        hunks: hunks.map((h) => h.current
          ? pageHunk(h.current, h.lines, h.status, [...new Set(shares(h as GroupHunk & { current: Hunk }).flat())].filter((id) => id !== g.id))
          : missingHunk(h)),
      }
    })
    .sort((x, y) => NECESSITY.indexOf(x.necessity) - NECESSITY.indexOf(y.necessity))

  return {
    sha: gloss.sha,
    subject: gloss.subject,
    author,
    date,
    glossed: true,
    task: a.task,
    summary: a.summary,
    attention: a.attention ?? null,
    computed: an ? { floor: an.floor, derived: an.derived, below: belowFloor(a.attention, an), timedOut: an.timedOut } : null,
    warnings: gloss.warnings,
    groups,
    order: reviewOrder(groups, a.attention?.focus),
    unannotated: gloss.unannotated.map((u) => pageHunk(u.hunk, u.lines, 'unannotated', [])),
    alternatives: a.alternatives ?? [],
    risks: a.risks ?? [],
    reviews: pageReviews(gloss.sha),
  }
}

function unglossedData(sha: string): CommitData {
  const [author, date] = git(['log', '-1', '--format=%an%x00%aI', sha]).trim().split('\0')
  return {
    sha,
    subject: commitSubject(sha),
    author,
    date,
    glossed: false,
    task: '',
    attention: null,
    computed: null,
    warnings: [],
    groups: [],
    order: [],
    unannotated: parseDiff(commitDiff(sha)).map((h) => pageHunk(h, null, 'unannotated', [])),
    alternatives: [],
    risks: [],
    reviews: pageReviews(sha),
  }
}

export function buildPageData(shas: string[], range: string | null = null, merges: string[] = []): PageData {
  return {
    range,
    merges: merges.map((sha) => ({ sha, subject: commitSubject(sha) })),
    necessity: NECESSITY.map((name) => ({ name, help: NECESSITY_HELP[name] })),
    impact: IMPACT.map((name) => ({ name, help: IMPACT_HELP[name] })),
    commits: shas.map((sha) => {
      const gloss = loadGloss(sha)
      return gloss ? commitData(gloss) : unglossedData(sha)
    }),
    generated: new Date().toISOString(),
  }
}
