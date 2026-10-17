import { git } from '../git.ts'
import type { Hunk } from '../diff.ts'
import type { GroupHunk, LoadedGloss } from '../loader.ts'
import { bodyLines, changedCount, gapText, isGap, refLabel, slice, sliceStats } from '../selection.ts'
import { NECESSITY, NECESSITY_HELP, type Necessity } from '../schema.ts'

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
  serves: string
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

export type PageData = {
  sha: string
  subject: string
  author: string
  date: string
  task: string
  summary?: string
  warnings: string[]
  necessity: { name: Necessity; help: string }[]
  groups: PageGroup[]
  unannotated: PageHunk[]
  alternatives: { option: string; rejected_because: string }[]
  risks: string[]
  generated: string
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

const allLines = (h: Hunk) => Array.from({ length: changedCount(h) }, (_, i) => i + 1)

export function buildPageData(gloss: LoadedGloss): PageData {
  const [author, date] = git(['log', '-1', '--format=%an%x00%aI', gloss.sha]).trim().split('\0')
  const a = gloss.note.annotation

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
        serves: g.serves,
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
    task: a.task,
    summary: a.summary,
    warnings: gloss.warnings,
    necessity: NECESSITY.map((name) => ({ name, help: NECESSITY_HELP[name] })),
    groups,
    unannotated: gloss.unannotated.map((u) => pageHunk(u.hunk, u.lines, 'unannotated', [])),
    alternatives: a.alternatives ?? [],
    risks: a.risks ?? [],
    generated: new Date().toISOString(),
  }
}
