import { commitDiff, commitSubject, GitError, GlossError, readNote } from './git.ts'
import { plain } from './plain.ts'
import { parseDiff, type Hunk } from './diff.ts'
import type { GlossNote, Group, HunkLocation } from './schema.ts'
import { changedCount, claimsProblem, selections, uncovered, type Claim, type Uncovered } from './selection.ts'

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

// lines: the group's changed lines in this hunk, or null for the whole hunk.
export type GroupHunk = ResolvedHunk & { lines: Set<number> | null }

export type LoadedGroup = { group: Group; hunks: GroupHunk[] }

export type LoadedGloss = {
  sha: string
  subject: string
  note: GlossNote
  // Every hunk of the commit's diff as it is now.
  hunks: Hunk[]
  groups: LoadedGroup[]
  // Changed lines in the commit's diff that no group covers.
  unannotated: Uncovered[]
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
  return note && loadGlossOf(sha, note)
}

// The same, for a note already read: what `versions --restore` checks a version
// with before it becomes the gloss, so it can never restore what readers refuse.
export function loadGlossOf(sha: string, note: GlossNote): LoadedGloss {

  const current = parseDiff(commitDiff(sha))
  const resolved = matchHunks(note.hunks, current)

  const groups = note.annotation.groups.map((group) => ({
    group,
    hunks: [...selections(group.hunks, (id) => { const c = resolved.get(id)?.current; return c ? changedCount(c) : undefined })].map(([id, lines]): GroupHunk => ({
      ...(resolved.get(id) ?? { id, stored: null, current: null, status: 'missing' }),
      lines,
    })),
  }))

  const claims = groups.flatMap((g) => g.hunks.flatMap((h): Claim[] => (h.current ? [{ hunk: h.current, lines: h.lines }] : [])))
  // Readers refuse what `add` refuses (see claimsProblem).
  const tooMany = claimsProblem(claims, current)
  if (tooMany) throw new GlossError(`the gloss on ${sha.slice(0, 10)} is refused: ${tooMany}`)
  const unannotated = uncovered(current, claims)

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

  return { sha, subject: commitSubject(sha), note, hunks: current, groups, unannotated, stale: warnings.length > 0, warnings }
}

// For a range: a commit whose gloss is refused (too big, malformed, over the
// caps, claims too many lines) is skipped like an unglossed one, and the
// reason comes back for the caller to warn about, so one hostile note does not
// fail the whole range. A git failure or timeout is not a refusal and still throws.
export function loadGlossInRange(sha: string): { gloss: LoadedGloss | null; refused?: string } {
  try {
    return { gloss: loadGloss(sha) }
  } catch (err) {
    if (!(err instanceof GlossError) || err instanceof GitError) throw err
    return { gloss: null, refused: err.message }
  }
}

export const refusedWarning = (sha: string, why: string) => `warning: skipping the gloss on ${sha.slice(0, 10)}, which ${plain(why).replace(/^the gloss on \S+ /, '')}`
