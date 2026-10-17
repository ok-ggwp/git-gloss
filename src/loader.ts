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

// Pair each stored hunk with a current one: first by the hash of its changes
// (it may have moved in a rebase), then by location (same place, different
// changes). Hash matches all go first so a location fallback can't take a
// hunk that a later stored hunk matches exactly.
export function matchHunks(stored: HunkLocation[], current: Hunk[]): Map<string, ResolvedHunk> {
  const used = new Set<Hunk>()
  const resolved = new Map<string, ResolvedHunk>()
  for (const s of stored) {
    const match = s.hash ? current.find((h) => h.hash === s.hash && !used.has(h)) : undefined
    if (match) {
      used.add(match)
      resolved.set(s.id, { id: s.id, stored: s, current: match, status: 'ok' })
    }
  }
  const byLocation = new Map(current.map((h) => [locationKey(h), h]))
  for (const s of stored) {
    if (resolved.has(s.id)) continue
    const match = byLocation.get(locationKey(s))
    if (match && !used.has(match)) {
      used.add(match)
      // Glosses written before hashes existed can only be matched by location.
      resolved.set(s.id, { id: s.id, stored: s, current: match, status: s.hash ? 'changed' : 'ok' })
    } else {
      resolved.set(s.id, { id: s.id, stored: s, current: null, status: 'missing' })
    }
  }
  return resolved
}

// Hunks are matched by their stored location and content hash, never by id
// alone: ids are positional, so any change in diff output would otherwise put
// the wrong code under a group without anyone noticing.
export function loadGloss(sha: string): LoadedGloss | null {
  const note = readNote(sha)
  if (!note) return null

  const current = parseDiff(commitDiff(sha))
  const resolved = matchHunks(note.hunks, current)

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
