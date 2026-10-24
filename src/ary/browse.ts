import { basename } from 'node:path'
import { git, gitTry } from '../git.ts'

// What the pickers in the page need: git queries only, nothing is written.

export type RefsData = {
  repo: string
  // The checked-out branch, or null on a detached HEAD.
  current: string | null
  // Newest first.
  branches: string[]
  remotes: string[]
  // A branch to compare others against (main, master, ...), if the repo has one.
  defaultBase: string | null
}

function refList(namespace: string): string[] {
  return git(['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(refname:short)', namespace])
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\0'))
    // refs/remotes/<remote>/HEAD is a pointer to another branch, not a branch.
    .filter(([full]) => !full.endsWith('/HEAD'))
    .map(([, name]) => name)
}

export function listRefs(): RefsData {
  const branches = refList('refs/heads')
  const remotes = refList('refs/remotes')
  const names = new Set([...branches, ...remotes])
  return {
    repo: basename(git(['rev-parse', '--show-toplevel']).trim()),
    current: gitTry(['symbolic-ref', '--short', '--quiet', 'HEAD'])?.trim() || null,
    branches,
    remotes,
    defaultBase: ['main', 'master', 'origin/main', 'origin/master'].find((n) => names.has(n)) ?? null,
  }
}
