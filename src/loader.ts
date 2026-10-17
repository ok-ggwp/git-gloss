import { commitDiff, commitSubject, readNote } from './git.ts'
import { parseDiff, type Hunk } from './diff.ts'
import type { GlossNote, Group, HunkLocation } from './schema.ts'

// ok: the commit's diff still has this hunk, unchanged.
// changed: same location, different content (e.g. the note was carried onto an amended commit).
// missing: no hunk at that location any more.
export type HunkStatus = 'ok' | 'changed' | 'missing'

export type ResolvedHunk = {
  id: string
  stored: HunkLocation | null
  current: Hunk | null
  status: HunkStatus
}

export type LoadedGroup = { group: Group; hunks: ResolvedHunk[] }

export type LoadedGloss = {
  sha: string
  subject: string
  note: GlossNote
  groups: LoadedGroup[]
  // Hunks in the commit's diff that no group covers.
  unannotated: Hunk[]
  stale: boolean
  warnings: string[]
}

const locationKey = (h: HunkLocation) =>
  [h.file, h.oldFile ?? '', h.oldStart, h.oldLines, h.newStart, h.newLines].join('\0')

// Hunks are matched by their stored location and content hash, never by id
// alone: ids are positional, so any change in diff output would otherwise put
// the wrong code under a group without anyone noticing.
export function loadGloss(sha: string): LoadedGloss | null {
  const note = readNote(sha)
  if (!note) return null

  const current = parseDiff(commitDiff(sha))
  const byLocation = new Map(current.map((h) => [locationKey(h), h]))
  const used = new Set<Hunk>()
  const resolved = new Map<string, ResolvedHunk>()
  for (const stored of note.hunks) {
    // Same changes anywhere in the file (it may have moved in a rebase), else
    // the same location with different changes, else gone.
    let match = stored.hash ? current.find((h) => h.hash === stored.hash && !used.has(h)) : undefined
    let status: HunkStatus = 'ok'
    if (!match) {
      match = byLocation.get(locationKey(stored))
      if (match && used.has(match)) match = undefined
      if (match && stored.hash) status = 'changed'
    }
    if (!match) status = 'missing'
    if (match) used.add(match)
    resolved.set(stored.id, { id: stored.id, stored, current: match ?? null, status })
  }

  const groups = note.annotation.groups.map((group) => ({
    group,
    hunks: group.hunks.map(
      (id): ResolvedHunk => resolved.get(id) ?? { id, stored: null, current: null, status: 'missing' },
    ),
  }))

  const covered = new Set(groups.flatMap((g) => g.hunks.map((h) => h.current)))
  const unannotated = current.filter((h) => !covered.has(h))

  const bad = [...resolved.values()].filter((h) => h.status !== 'ok').length
  const matched = new Set([...resolved.values()].map((h) => h.current))
  const unknown = current.filter((h) => !matched.has(h)).length
  const warnings: string[] = []
  if (bad || unknown) {
    warnings.push(
      `this gloss no longer matches the commit (${bad} glossed hunk(s) changed or gone, ${unknown} new); ` +
        'the commit was probably amended or rebased after glossing. Re-gloss it with `git gloss add --force`.',
    )
  }

  return { sha, subject: commitSubject(sha), note, groups, unannotated, stale: warnings.length > 0, warnings }
}
