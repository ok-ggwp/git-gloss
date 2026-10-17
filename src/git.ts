import { execFileSync } from 'node:child_process'
import { Annotation, type GlossNote } from './schema.ts'

export const NOTES_REF = 'refs/notes/gloss'
export const REMOTE_NOTES_REF = 'refs/notes/remotes/origin/gloss'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Errors whose message is fit to show the user without a stack trace.
export class GlossError extends Error {}
export class GitError extends GlossError {}

export function git(args: string[], input?: string): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      input,
      // Untranslated messages: readNote recognises "no note found" by its text.
      env: { ...process.env, LC_ALL: 'C' },
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
// commit). Every option that changes which hunks git produces, or their order,
// is pinned so hunk ids are the same regardless of the user's diff config.
export function commitDiff(sha: string): string {
  const parent = gitTry(['rev-parse', '--verify', '--quiet', `${sha}^1`])?.trim() || EMPTY_TREE
  return git([
    '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '-U3',
    '-O/dev/null', '--diff-algorithm=myers', '--indent-heuristic',
    '--inter-hunk-context=0', '--no-relative', '--submodule=short', '-l1000',
    parent, sha,
  ])
}

export function readNote(sha: string): GlossNote | null {
  let raw: string
  try {
    raw = git(['notes', '--ref', NOTES_REF, 'show', sha])
  } catch (err) {
    if (/no note found/i.test((err as Error).message)) return null
    throw err
  }
  const at = `the gloss on ${sha.slice(0, 10)}`
  let data: Partial<GlossNote>
  try {
    data = JSON.parse(raw)
  } catch {
    // notes.rewriteMode=concatenate joins two notes when a rebase squashes
    // glossed commits together.
    if (/}\s*\n\s*{/.test(raw)) {
      throw new GlossError(`${at} holds several glosses joined together (from a squash or fixup); re-gloss it with \`git gloss add --force\``)
    }
    throw new GlossError(`${at} is not valid JSON; replace it with \`git gloss add --force\``)
  }
  if (typeof data?.gloss === 'number' && data.gloss > 1) {
    throw new GlossError(`${at} was written by a newer git-gloss (format ${data.gloss}); upgrade to read it`)
  }
  const annotation = Annotation.safeParse(data?.annotation)
  if (data?.gloss !== 1 || !Array.isArray(data.hunks) || !annotation.success) {
    throw new GlossError(`${at} is malformed; replace it with \`git gloss add --force\``)
  }
  return { ...(data as GlossNote), annotation: annotation.data }
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
