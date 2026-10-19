import { basename } from 'node:path'
import { NOTES_REF, WIP_NOTES_REF, WIP_REF, git, gitTry, wipStaleness } from '../git.ts'
import { REVIEWS_REF } from '../reviews.ts'

// What the browser's sidebar needs: git queries only, nothing is written.

export type BranchInfo = { name: string; date: string; subject: string }

export type RefsData = {
  repo: string
  // The checked-out branch, or null on a detached HEAD.
  current: string | null
  branches: BranchInfo[]
  remotes: BranchInfo[]
  // A branch to compare others against (main, master, ...), if the repo has one.
  defaultBase: string | null
  wip: { sha: string; glossed: boolean; stale: string | null } | null
}

export type LogEntry = {
  sha: string
  subject: string
  author: string
  date: string
  merge: boolean
  glossed: boolean
  reviewed: boolean
}

export type LogData = { commits: LogEntry[]; more: boolean; total: number | null }

// The commits a notes ref has notes on ("<note> <commit>" per line). A missing
// ref is no notes.
function notedCommits(ref: string): Set<string> {
  const lines = (gitTry(['notes', '--ref', ref, 'list']) ?? '').split('\n')
  return new Set(lines.filter(Boolean).map((l) => l.split(' ')[1]))
}

function refList(namespace: string): BranchInfo[] {
  return git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(refname:short)%00%(committerdate:relative)%00%(subject)', namespace])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\0'))
    // refs/remotes/<remote>/HEAD is a pointer to another branch, not a branch.
    .filter(([full]) => !full.endsWith('/HEAD'))
    .map(([, name, date, subject]) => ({ name, date, subject }))
}

export function listRefs(): RefsData {
  const branches = refList('refs/heads')
  const remotes = refList('refs/remotes')
  const names = new Set([...branches, ...remotes].map((b) => b.name))
  const wipSha = gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])?.trim()
  let stale: string | null = null
  if (wipSha) {
    try {
      stale = wipStaleness(wipSha)
    } catch {
      // Staleness is advice; the snapshot is still viewable without it.
    }
  }
  return {
    repo: basename(git(['rev-parse', '--show-toplevel']).trim()),
    current: gitTry(['symbolic-ref', '--short', '--quiet', 'HEAD'])?.trim() || null,
    branches,
    remotes,
    defaultBase: ['main', 'master', 'origin/main', 'origin/master'].find((n) => names.has(n)) ?? null,
    wip: wipSha ? { sha: wipSha, glossed: notedCommits(WIP_NOTES_REF).has(wipSha), stale } : null,
  }
}

// Newest first: the commits of `head`, or only those not in `base` when given.
// `query` keeps the commits whose message or author contains it (any case).
export function listLog(head: string, base: string | null, limit: number, skip: number, query = ''): LogData {
  const range = base ? `${base}..${head}` : head
  const format = '--format=%H%x00%an%x00%aI%x00%s%x00%P'
  let out: string
  if (query) {
    // git ANDs --grep with --author, so ask for each on its own and merge, then
    // list the union by commit date (what --no-walk=sorted gives, which can
    // differ from the order of an unfiltered log when dates are skewed).
    const shas = new Set<string>()
    for (const filter of ['--grep', '--author']) {
      const found = git(['log', '--format=%H', '--regexp-ignore-case', '--fixed-strings', `${filter}=${query}`, '--end-of-options', range, '--'])
      for (const sha of found.split('\n').filter(Boolean)) shas.add(sha)
    }
    // No -n or --skip here: git then walks on to the parents, so page by hand.
    out = shas.size
      ? git(['log', '--no-walk=sorted', '--stdin', format], [...shas].join('\n') + '\n').split('\n').slice(skip, skip + limit + 1).join('\n')
      : ''
  } else {
    // One more than asked for, to know whether there are more.
    out = git(['log', format, '-n', String(limit + 1), '--skip', String(skip), '--end-of-options', range, '--'])
  }
  const glossed = notedCommits(NOTES_REF)
  const reviewed = notedCommits(REVIEWS_REF)
  const rows = out.split('\n').filter(Boolean).map((l) => l.split('\0'))
  return {
    commits: rows.slice(0, limit).map(([sha, author, date, subject, parents]): LogEntry => ({
      sha, author, date, subject,
      merge: parents.includes(' '),
      glossed: glossed.has(sha),
      reviewed: reviewed.has(sha),
    })),
    more: rows.length > limit,
    total: base && !query ? Number(git(['rev-list', '--count', '--end-of-options', range, '--']).trim()) : null,
  }
}
