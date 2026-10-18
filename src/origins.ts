import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { commitDiff, diffBetween, EMPTY_TREE, git, gitTry, NOTES_REF } from './git.ts'
import { parseDiff, type Hunk } from './diff.ts'
import { bodyLines } from './selection.ts'

// Commits that have a gloss and are in this repository (a teammate's gloss
// can arrive before, or without, the commit it describes).
export function glossedCommits(): string[] {
  const shas = (gitTry(['notes', '--ref', NOTES_REF, 'list']) ?? '').split('\n').filter(Boolean).map((l) => l.split(' ')[1])
  if (!shas.length) return []
  return git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], shas.join('\n') + '\n')
    .split('\n').filter((l) => l.endsWith(' commit')).map((l) => l.split(' ')[0])
}

const diffs = new Map<string, Hunk[]>()
const diffOf = (sha: string) => {
  let d = diffs.get(sha)
  if (!d) diffs.set(sha, (d = parseDiff(commitDiff(sha))))
  return d
}

// git's patch-id: the same for two commits that make the same changes,
// wherever they sit in history.
function patchId(sha: string): string | null {
  const diff = gitTry(['show', '--format=', '--no-color', '--no-ext-diff', sha])
  return diff ? git(['patch-id', '--stable'], diff).split(' ')[0] || null : null
}

// Where a commit's changes came from, among commits with a gloss:
// 1. its message: "(cherry picked from commit X)" (cherry-pick -x), or the
//    "Squashed commit of the following:" list git merge --squash writes;
// 2. a commit with the same author, author date and patch-id: a cherry-pick
//    or a rebase (both keep the author date), including GitHub's
//    "Rebase and merge";
// 3. with `squash`, a branch not merged into the commit whose combined diff is
//    at least 80% the same as the commit's: a squash merge, including
//    GitHub's "Squash and merge", whatever its message says.
// Returns the source commits, oldest first, or null.
export function findOrigins(target: string, opts: { squash?: boolean; glossed?: string[] } = {}): string[] | null {
  const glossed = new Set(opts.glossed ?? glossedCommits())
  glossed.delete(target)
  if (!glossed.size) return null

  const message = git(['log', '-1', '--format=%B', target])
  const named = [
    ...[...message.matchAll(/\(cherry picked from commit ([0-9a-f]{7,64})\)/g)].map((m) => m[1]),
    ...(/^Squashed commit of the following:/m.test(message) ? [...message.matchAll(/^commit ([0-9a-f]{40,64})$/gm)].map((m) => m[1]) : []),
  ].map((s) => gitTry(['rev-parse', '-q', '--verify', `${s}^{commit}`])?.trim()).filter((s): s is string => !!s && glossed.has(s))
  // git lists squashed commits newest first.
  if (named.length) return [...new Set(named)].reverse()

  const ident = (sha: string) => git(['log', '-1', '--format=%an%x00%ae%x00%ad', '--date=raw', sha]).trim()
  const mine = ident(target)
  const same = git(['log', '--no-walk=unsorted', '--stdin', '--format=%H%x00%an%x00%ae%x00%ad', '--date=raw'], [...glossed].join('\n'))
    .split('\n').filter(Boolean).filter((l) => l.slice(l.indexOf('\0') + 1) === mine).map((l) => l.slice(0, l.indexOf('\0')))
  if (same.length) {
    const id = patchId(target)
    const match = id && same.find((s) => patchId(s) === id)
    if (match) return [match]
  }

  if (!opts.squash) return null
  return squashSources(target, [...glossed])
}

// Changed lines as a multiset of "file, +/- text".
function changedLines(hunks: Hunk[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const h of hunks) for (const l of bodyLines(h)) {
    if (l.idx === null) continue
    const key = `${h.file}\0${l.raw}`
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

// How alike two diffs are: the changed lines they share, as a share of the
// larger one. A squash's diff is (nearly) its branch's combined diff, so this
// is near 1; an unrelated commit that happens to repeat a few of a branch's
// lines scores low, however small it is.
function similarity(a: Hunk[], b: Hunk[]): number {
  const [x, y] = [changedLines(a), changedLines(b)]
  let shared = 0, nx = 0, ny = 0
  for (const n of x.values()) nx += n
  for (const n of y.values()) ny += n
  for (const [k, n] of x) shared += Math.min(n, y.get(k) ?? 0)
  return Math.max(nx, ny) ? shared / Math.max(nx, ny) : 0
}

// The unmerged branch the target is a squash of: the one whose combined
// diff (from where it left the target's parent to its tip) is at least 80%
// the same as the target's, best first.
function squashSources(target: string, glossed: string[]): string[] | null {
  const parent = gitTry(['rev-parse', '-q', '--verify', `${target}^1`])?.trim()
  if (!parent) return null
  // Branch history the target doesn't contain, from glossed commits and
  // branch heads; its tips are the candidate squashed branches.
  const heads = (gitTry(['for-each-ref', '--format=%(objectname)', 'refs/heads/', 'refs/remotes/']) ?? '').split('\n').filter(Boolean)
  const when = Number(git(['log', '-1', '--format=%ct', target]).trim())
  const rows = git(['rev-list', '--parents', ...new Set([...glossed, ...heads]), '--not', target, '--'])
    .split('\n').filter(Boolean).map((l) => l.split(' '))
  const hasChild = new Set(rows.flatMap(([, ...parents]) => parents))
  const tips = rows.map(([c]) => c).filter((c) => !hasChild.has(c))
    .filter((c) => Number(git(['log', '-1', '--format=%ct', c]).trim()) <= when)
  const glossedSet = new Set(glossed)
  const mine = diffOf(target)

  let best: { sources: string[]; score: number } | null = null
  for (const tip of tips) {
    const base = gitTry(['merge-base', tip, parent])?.trim()
    const shas = git(['rev-list', '--reverse', '--no-merges', base ? `${base}..${tip}` : tip, '--']).split('\n').filter((s) => glossedSet.has(s))
    if (!shas.length) continue
    const score = similarity(mine, parseDiff(diffBetween(base || EMPTY_TREE, tip)))
    if (score >= 0.8 && (!best || score > best.score)) best = { sources: shas, score }
  }
  return best?.sources ?? null
}

// Unglossed commits on `starts` (a remote's branches, commits being pushed)
// that may have been made from glossed ones by a squash or rebase merge, a
// cherry-pick: each is glossed from its origins when they are found. Checks
// are remembered in .git/gloss-checked with how many glossed commits there
// were, so a commit is checked again only once more glosses have arrived (its
// origins' glosses may come later, from a teammate). Returns what was carried.
export function carryNew(starts: string[], carry: (sources: string[], target: string) => { written: boolean; message: string }): string[] {
  if (!starts.length) return []
  const glossed = glossedCommits()
  if (!glossed.length) return []
  const memo = git(['rev-parse', '--git-path', 'gloss-checked']).trim()
  const checked = new Map((existsSync(memo) ? readFileSync(memo, 'utf8').split('\n').filter(Boolean) : [])
    .map((l) => { const [sha, n] = l.split(' '); return [sha, Number(n) || 0] as const }))
  // A commit made from glossed ones is newer than the oldest of them.
  const oldest = Math.min(...git(['log', '--no-walk=unsorted', '--stdin', '--format=%ct'], glossed.join('\n'))
    .split('\n').filter(Boolean).map(Number))
  const glossedSet = new Set(glossed)
  const targets = git(['rev-list', '--no-merges', `--since=${oldest}`, ...starts, '--']).split('\n')
    .filter((s) => s && !glossedSet.has(s) && (checked.get(s) ?? -1) < glossed.length)
  const out: string[] = []
  for (const target of targets.reverse()) {
    const origins = findOrigins(target, { squash: true, glossed })
    if (origins) {
      const res = carry(origins, target)
      if (res.written) { out.push(res.message); glossed.push(target); glossedSet.add(target) }
    }
    appendFileSync(memo, `${target} ${glossed.length}\n`)
  }
  return out
}
