import { git } from '../git.ts'
import type { Hunk } from '../diff.ts'
import type { LoadedGloss, ResolvedHunk } from '../loader.ts'
import { NECESSITY, NECESSITY_HELP, type Necessity } from '../schema.ts'

// Everything the page needs, precomputed so the client only lays it out.
export type PageLine = { kind: 'add' | 'del' | 'ctx' | 'meta'; old: number | null; new: number | null; text: string }

export type PageHunk = {
  id: string
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

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

export function diffLines(text: string): PageLine[] {
  const [header, ...body] = text.split('\n')
  const m = HUNK_HEADER.exec(header)
  if (!m) return text.split('\n').map((t) => ({ kind: 'meta', old: null, new: null, text: t }))
  let oldNo = Number(m[1]), newNo = Number(m[2])
  const lines: PageLine[] = [{ kind: 'meta', old: null, new: null, text: header }]
  for (const l of body) {
    const text = l.slice(1)
    if (l[0] === '+') lines.push({ kind: 'add', old: null, new: newNo++, text })
    else if (l[0] === '-') lines.push({ kind: 'del', old: oldNo++, new: null, text })
    else if (l[0] === '\\') lines.push({ kind: 'meta', old: null, new: null, text: l })
    else lines.push({ kind: 'ctx', old: oldNo++, new: newNo++, text })
  }
  return lines
}

function pageHunk(h: Hunk, status: PageHunk['status'], alsoIn: string[]): PageHunk {
  return {
    id: h.id,
    file: h.file,
    oldFile: h.oldFile && h.oldFile !== h.file ? h.oldFile : null,
    range: h.newLines || h.oldLines ? `-${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines}` : 'file header',
    status,
    added: h.added,
    removed: h.removed,
    alsoIn,
    lines: diffLines(h.text),
  }
}

export function buildPageData(gloss: LoadedGloss): PageData {
  const [author, date] = git(['log', '-1', '--format=%an%x00%aI', gloss.sha]).trim().split('\0')
  const a = gloss.note.annotation

  const owners = new Map<Hunk, string[]>()
  for (const g of gloss.groups) {
    for (const h of g.hunks) if (h.current) owners.set(h.current, [...(owners.get(h.current) ?? []), g.group.id])
  }

  const groups = gloss.groups
    .map(({ group: g, hunks }): PageGroup => {
      const live = hunks.filter((h): h is ResolvedHunk & { current: Hunk } => h.current !== null)
      return {
        id: g.id,
        intent: g.intent,
        necessity: g.necessity,
        serves: g.serves,
        removal_impact: g.removal_impact,
        evidence: g.evidence,
        notes: g.notes,
        stale: hunks.filter((h) => h.status !== 'ok').length,
        added: live.reduce((n, h) => n + h.current.added, 0),
        removed: live.reduce((n, h) => n + h.current.removed, 0),
        weight: live.reduce((n, h) => n + (h.current.added + h.current.removed) / (owners.get(h.current)?.length ?? 1), 0),
        hunks: live.map((h) =>
          pageHunk(h.current, h.status as PageHunk['status'], (owners.get(h.current) ?? []).filter((id) => id !== g.id))),
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
    unannotated: gloss.unannotated.map((h) => pageHunk(h, 'unannotated', [])),
    alternatives: a.alternatives ?? [],
    risks: a.risks ?? [],
    generated: new Date().toISOString(),
  }
}
