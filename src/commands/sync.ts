import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { git, gitTry, GitError, NOTES_REF } from '../git.ts'
import { carryNew } from '../origins.ts'
import { carry } from './carry.ts'

export const usage = 'sync [<remote>]   fetch, merge and push glosses (default remote: origin)'

const MAX_ATTEMPTS = 3

// Map of annotated object → note blob for a notes ref, or empty if it doesn't exist.
function noteList(ref: string): Map<string, string> {
  const out = gitTry(['notes', '--ref', ref, 'list']) ?? ''
  return new Map(out.split('\n').filter(Boolean).map((line) => {
    const [blob, object] = line.split(' ')
    return [object, blob] as [string, string]
  }))
}

// created_at from a note, or null if the note isn't JSON we can read (for
// example one written by a newer git-gloss). Notes are never validated or
// rewritten here, so sync passes through formats it doesn't understand.
function createdAt(blob: string): string | null {
  try {
    const value = JSON.parse(git(['cat-file', 'blob', blob]))?.created_at
    return typeof value === 'string' ? value : null
  } catch {
    return null
  }
}

// The notes at a commit of a notes ref, e.g. the merge base. Notes trees fan
// paths out (ab/cdef…), so joining the path gives the annotated object.
function notesAt(commit: string): Map<string, string> {
  const out = git(['ls-tree', '-r', '--full-tree', commit])
  return new Map(out.split('\n').filter(Boolean).map((line) => {
    const [meta, path] = line.split('\t')
    return [path.replaceAll('/', ''), meta.split(' ')[2]] as [string, string]
  }))
}

// Commits whose glosses may be shared with the remote: those it already has
// (reachable from its remote-tracking branches) and, from the pre-push hook,
// those being pushed now. Glosses of other commits (private branches, local
// work) stay local.
function shareable(remote: string, pushing: string[]): Set<string> {
  const tips = (gitTry(['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}/`]) ?? '').split('\n').filter(Boolean)
  const starts = [...tips, ...pushing]
  if (!starts.length) return new Set()
  return new Set(git(['rev-list', ...starts, '--']).split('\n').filter(Boolean))
}

const PUSH_REF = 'refs/notes/gloss-sync-tmp'

type Outcome = { fetched: number; pushed: number; withheld: number; conflicts: string[] }

// One fetch → merge → push round. Returns null if the push lost a race with
// someone else's push and the round should be retried.
function round(remote: string, pushing: string[], carried: string[]): Outcome | null {
  const tracking = `refs/notes/remotes/${remote}/gloss`
  const remoteHas = gitTry(['ls-remote', '--exit-code', remote, NOTES_REF]) !== null
  if (remoteHas) git(['fetch', '-q', remote, `+${NOTES_REF}:${tracking}`])

  const local = noteList(NOTES_REF)
  const theirs = remoteHas ? noteList(tracking) : new Map<string, string>()
  // The last state both sides shared. A gloss changed on one side only is
  // simply taken from that side (as the merge below does); only a gloss
  // changed on both sides since then is a conflict.
  const hasLocal = gitTry(['rev-parse', '-q', '--verify', NOTES_REF]) !== null
  const baseCommit = remoteHas && hasLocal ? gitTry(['merge-base', NOTES_REF, tracking])?.trim() : null
  const base = baseCommit ? notesAt(baseCommit) : new Map<string, string>()

  let fetched = 0
  const conflicts: string[] = []
  const takeTheirs: [string, string][] = []
  for (const object of new Set([...local.keys(), ...theirs.keys()])) {
    const [mine, other, was] = [local.get(object), theirs.get(object), base.get(object)]
    if (mine === other) continue
    if (mine === was) { if (other !== undefined) fetched++; continue } // only they changed it
    if (other === was) continue // only we changed it: pushed below if shareable
    // Deleted on one side, changed on the other: keep the gloss rather than
    // lose a correction. (-s ours alone would keep a local deletion.)
    if (mine === undefined) {
      takeTheirs.push([object, other!]); fetched++
      conflicts.push(`${object.slice(0, 10)}: kept theirs (you deleted it, they changed it)`)
      continue
    }
    if (other === undefined) {
      conflicts.push(`${object.slice(0, 10)}: kept yours (they deleted it, you changed it)`)
      continue
    }
    // Both sides changed it: keep the newer gloss, since a re-gloss with
    // --force is normally a correction. Ties and unreadable notes keep yours.
    const [a, b] = [createdAt(mine), createdAt(other)]
    const theirsNewer = a !== null && b !== null && b > a
    if (theirsNewer) { takeTheirs.push([object, other]); fetched++ }
    conflicts.push(`${object.slice(0, 10)}: kept ${theirsNewer ? 'theirs' : 'yours'}` +
      (a === null || b === null ? " (couldn't read both glosses' dates)" : ' (newer)'))
  }

  if (remoteHas) {
    if (!hasLocal) {
      git(['update-ref', NOTES_REF, tracking])
    } else {
      // -s ours makes the remote history an ancestor of ours, so the push
      // below fast-forwards; the newer-wins choices are applied on top.
      git(['notes', '--ref', NOTES_REF, 'merge', '-q', '-s', 'ours', tracking])
    }
    for (const [object, blob] of takeTheirs) git(['notes', '--ref', NOTES_REF, 'add', '-f', '-C', blob, object])
  }

  // Commits made on the remote by squash or rebase merges (or being pushed
  // after a local squash or cherry-pick) get the gloss of the commits they
  // came from, so it goes out with the rest.
  const tips = (gitTry(['for-each-ref', '--format=%(objectname)', `refs/remotes/${remote}/`]) ?? '').split('\n').filter(Boolean)
  carried.push(...carryNew([...tips, ...pushing], carry))

  // What to send: glosses that differ from the remote's, of commits it may
  // see. They are added on top of the remote's notes history in a scratch
  // ref, so the push fast-forwards and carries nothing else; local history
  // (with any withheld glosses) never leaves the machine.
  const allowed = shareable(remote, pushing)
  const merged = noteList(NOTES_REF)
  const toPush = [...merged].filter(([object, blob]) => allowed.has(object) && theirs.get(object) !== blob)
  const withheld = [...merged.keys()].filter((o) => !allowed.has(o) && !theirs.has(o)).length
  if (!toPush.length) return { fetched, pushed: 0, withheld, conflicts }

  try {
    if (remoteHas) git(['update-ref', PUSH_REF, tracking])
    else gitTry(['update-ref', '-d', PUSH_REF])
    for (const [object, blob] of toPush) git(['notes', '--ref', PUSH_REF, 'add', '-f', '-C', blob, object])
    try {
      // --no-verify: don't run the pre-push hook for the notes push itself,
      // which would call sync again.
      git(['push', '-q', '--no-verify', remote, `${PUSH_REF}:${NOTES_REF}`])
    } catch (err) {
      if (/\(fetch first\)|non-fast-forward/.test((err as Error).message)) return null
      throw err
    }
    // Record what the remote now has, so the next sync's merge base is right.
    git(['notes', '--ref', NOTES_REF, 'merge', '-q', '-s', 'ours', PUSH_REF])
  } finally {
    gitTry(['update-ref', '-d', PUSH_REF])
  }
  return { fetched, pushed: toPush.length, withheld, conflicts }
}

export function run(argv: string[]): number {
  // --pushing (from the pre-push hook): read the refs being pushed from stdin,
  // as git gives them to the hook, so glosses of those commits go too.
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { pushing: { type: 'boolean' } } })
  if (values.pushing && process.stdin.isTTY) console.error('note: --pushing reads the refs being pushed from stdin, as the pre-push hook gives them; ignoring it here')
  const pushing = values.pushing && !process.stdin.isTTY
    ? readFileSync(0, 'utf8').split('\n').map((l) => l.split(' ')[1]).filter((sha) => sha && !/^0+$/.test(sha))
    : []
  const remote = positionals[0] ?? 'origin'
  // Only configured remotes: the name becomes part of a ref and an argument,
  // and a URL has no stable place to keep the remote's glosses.
  const remotes = (gitTry(['remote']) ?? '').split('\n').filter(Boolean)
  if (!remotes.includes(remote)) {
    throw new GitError(`no remote named "${remote}"${remotes.length ? `; remotes are ${remotes.join(', ')}` : ''}`)
  }

  const carried: string[] = []
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = round(remote, pushing, carried)
    if (!outcome) continue
    const parts = [`fetched ${outcome.fetched}`, `pushed ${outcome.pushed}`]
    if (!outcome.fetched && !outcome.pushed && !outcome.conflicts.length) {
      console.log(`glosses already in sync with ${remote}`)
    } else {
      console.log(`synced glosses with ${remote}: ${parts.join(', ')}` +
        (outcome.conflicts.length ? `, ${outcome.conflicts.length} glossed on both sides` : ''))
      for (const c of outcome.conflicts) console.log(`  ${c}`)
    }
    for (const c of carried) console.log(c)
    if (outcome.withheld) {
      console.log(`  kept ${outcome.withheld} gloss${outcome.withheld === 1 ? '' : 'es'} local: their commits aren't on ${remote} yet`)
    }
    return 0
  }
  throw new GitError(`gave up after ${MAX_ATTEMPTS} attempts: others kept pushing glosses to ${remote}; try again`)
}
