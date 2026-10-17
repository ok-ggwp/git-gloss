import { execFileSync } from 'node:child_process'
import type { GlossNote } from './schema.ts'

export const NOTES_REF = 'refs/notes/gloss'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export class GitError extends Error {}

export function git(args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      input,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim()
    throw new GitError(stderr || `git ${args.join(' ')} failed`)
  }
}

export function gitTry(args: string[], input?: string): string | null {
  try {
    return git(args, input)
  } catch {
    return null
  }
}

export function resolveCommit(rev: string): string {
  const sha = gitTry(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  if (!sha) throw new GitError(`not a commit: ${rev}`)
  return sha.trim()
}

export function commitSubject(sha: string): string {
  return git(['log', '-1', '--format=%s', sha]).trim()
}

// Diff of a commit against its first parent (or the empty tree for a root
// commit), with prefixes and colour pinned so user config can't break parsing.
export function commitDiff(sha: string): string {
  const parent = gitTry(['rev-parse', '--verify', '--quiet', `${sha}^1`])?.trim() || EMPTY_TREE
  return git([
    '-c', 'core.quotePath=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '-U3',
    parent, sha,
  ])
}

export function readNote(sha: string): GlossNote | null {
  const raw = gitTry(['notes', '--ref', NOTES_REF, 'show', sha])
  return raw ? (JSON.parse(raw) as GlossNote) : null
}

export function writeNote(sha: string, note: GlossNote): void {
  git(['notes', '--ref', NOTES_REF, 'add', '-f', '-F', '-', sha], JSON.stringify(note, null, 2) + '\n')
}

export type BlameResult = { commit: string; origLine: number; origFile: string }

export function blameLine(file: string, line: number, rev?: string): BlameResult {
  const args = ['blame', '--porcelain', '-L', `${line},${line}`]
  if (rev) args.push(rev)
  args.push('--', file)
  const out = git(args).split('\n')
  const [commit, origLine] = out[0].split(' ')
  const filename = out.find((l) => l.startsWith('filename '))
  return { commit, origLine: Number(origLine), origFile: filename ? filename.slice(9) : file }
}
