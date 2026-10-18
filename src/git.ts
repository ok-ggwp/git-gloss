import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, NOTE_FORMAT, type GlossNote } from './schema.ts'
import { parsePath, unquote } from './diff.ts'

export const NOTES_REF = 'refs/notes/gloss'
// Glosses of uncommitted work (wip snapshots) live in their own notes ref,
// which sync never pushes, and the latest snapshot in a private ref that
// keeps it from being garbage-collected.
export const WIP_NOTES_REF = 'refs/notes/gloss-wip'
export const WIP_REF = 'refs/gloss/wip'
const WIP_MESSAGE = 'git-gloss wip snapshot'
export const REMOTE_NOTES_REF = 'refs/notes/remotes/origin/gloss'
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Errors whose message is fit to show the user without a stack trace.
export class GlossError extends Error {}
export class GitError extends GlossError {}

export function git(args: string[], input?: string, env: Record<string, string> = {}): string {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      input,
      // Untranslated messages: readNote recognises "no note found" by its text.
      env: { ...process.env, ...env, LC_ALL: 'C' },
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

// Untracked files that look like secrets. A snapshot is shown and sent to
// reviewers, so these are left out unless the user stages them.
const SENSITIVE = [
  /^\.env(\..*)?$/, /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/, /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /(^|[-_.])(secrets?|credentials?|tokens?|passwords?)([-_.]|$)/i, /^\.(netrc|npmrc|pypirc)$/,
]
const looksSensitive = (path: string) => SENSITIVE.some((re) => re.test(path.split('/').pop()!))

// The working tree as a tree object: tracked files, staged files, and
// untracked files except ignored ones and ones that look like secrets. Built
// in a temporary index so the real index is untouched. `excluded` lists the
// untracked files left out as possible secrets.
function workingTree(): { tree: string; excluded: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'git-gloss-index-'))
  try {
    const index = join(dir, 'index')
    const real = git(['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim()
    if (existsSync(real)) {
      copyFileSync(real, index)
      // Keep the index's timestamps: git compares them with file mtimes to
      // spot files edited in the same second as the index was written
      // ("racily clean"), and a fresh mtime would hide such edits.
      const { atime, mtime } = statSync(real)
      utimesSync(index, atime, mtime)
    }
    const env = { GIT_INDEX_FILE: index }
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ':/']).split('\0').filter(Boolean)
    const excluded = untracked.filter(looksSensitive)
    git(['add', '-A', '--', ':/'], undefined, env)
    if (excluded.length) git(['rm', '-q', '--cached', '--', ...excluded.map((p) => `:/${p}`)], undefined, env)
    return { tree: git(['write-tree'], undefined, env).trim(), excluded }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const headSha = () => gitTry(['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim() ?? null
const treeAndParent = (sha: string) => {
  const [tree, parent] = git(['log', '-1', '--format=%T %P', sha]).trim().split(' ')
  return { tree, parent: parent || null }
}

// Record uncommitted changes as a commit on top of HEAD without touching the
// branch, index or files, and point WIP_REF at it. Reuses the current
// snapshot if nothing has changed, so its gloss stays attached.
export function snapshotWorkingTree(): { sha: string; excluded: string[] } {
  const { tree, excluded } = workingTree()
  const head = headSha()
  if (head && git(['rev-parse', `${head}^{tree}`]).trim() === tree) {
    throw new GlossError('there are no uncommitted changes to snapshot')
  }
  const current = gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])?.trim()
  if (current) {
    const c = treeAndParent(current)
    if (c.tree === tree && c.parent === head) return { sha: current, excluded }
    // Only the latest snapshot is glossed and adopted; drop the old one's gloss.
    dropWipNote(current)
  }
  const sha = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', WIP_MESSAGE]).trim()
  git(['update-ref', WIP_REF, sha])
  return { sha, excluded }
}

export const dropWipNote = (sha: string) => gitTry(['notes', '--ref', WIP_NOTES_REF, 'remove', '--ignore-missing', sha])

export const isWipSnapshot = (sha: string) => gitTry(['log', '-1', '--format=%s', sha])?.trim() === WIP_MESSAGE

// Why the latest snapshot no longer matches the working tree, or null.
export function wipStaleness(sha: string): string | null {
  const s = treeAndParent(sha)
  if (s.parent !== headSha()) return 'HEAD has moved since this snapshot was taken'
  if (workingTree().tree !== s.tree) return 'the working tree has changed since this snapshot was taken'
  return null
}

export function resolveCommit(rev: string): string {
  // "wip": the latest snapshot of uncommitted work (made by `hunks wip`). A
  // branch or tag named wip still works when there is no snapshot, and can be
  // reached as heads/wip or tags/wip when there is.
  const named = gitTry(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])?.trim()
  if (rev === 'wip') {
    const sha = gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])?.trim()
    if (sha) {
      if (named) console.error('note: "wip" means the snapshot of uncommitted work; for the branch or tag, use heads/wip or tags/wip')
      const stale = wipStaleness(sha)
      if (stale) console.error(`warning: ${stale}; run \`git gloss hunks wip\` to snapshot again, then re-gloss`)
      return sha
    }
    if (!named) throw new GlossError('no snapshot of uncommitted work yet; run `git gloss hunks wip` first')
  }
  const sha = named
  if (!sha) throw new GitError(`not a commit: ${rev}`)
  return sha.trim()
}

// A commit, or the commits in a range such as "main..feature", oldest first.
// Merges are not reviewed (their first-parent diff repeats the merged
// commits) but are returned so views can say they were skipped: a merge can
// still carry conflict resolutions or edits of its own.
export function resolveCommits(arg: string): { shas: string[]; merges: string[]; range: string | null } {
  if (!arg.includes('..')) return { shas: [resolveCommit(arg)], merges: [], range: null }
  if (arg.includes('...')) {
    throw new GitError(`${arg}: "..." includes commits from both sides; use A..B for the commits on B since A`)
  }
  // --end-of-options: the argument is a revision range, never an option.
  const list = (...flags: string[]) =>
    git(['rev-list', '--reverse', ...flags, '--end-of-options', arg, '--']).split('\n').filter(Boolean)
  const shas = list('--no-merges')
  const merges = list('--merges')
  if (!shas.length && !merges.length) throw new GitError(`no commits in ${arg}`)
  return { shas, merges, range: arg }
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

function rawNote(ref: string, sha: string): string | null {
  try {
    return git(['notes', '--ref', ref, 'show', sha])
  } catch (err) {
    if (/no note found/i.test((err as Error).message)) return null
    throw err
  }
}

export function readNote(sha: string): GlossNote | null {
  // A commit's gloss, or a wip snapshot's (they are never the same object).
  const raw = rawNote(NOTES_REF, sha) ?? rawNote(WIP_NOTES_REF, sha)
  if (raw === null) return null
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
  if (typeof data?.gloss === 'number' && data.gloss > NOTE_FORMAT) {
    throw new GlossError(`${at} was written by a newer git-gloss (format ${data.gloss}); upgrade to read it`)
  }
  const annotation = Annotation.safeParse(data?.annotation)
  if (![1, 2, 3].includes(data?.gloss as number) || !Array.isArray(data.hunks) || !annotation.success) {
    throw new GlossError(`${at} is malformed; replace it with \`git gloss add --force\``)
  }
  return { ...(data as GlossNote), annotation: annotation.data }
}

export function writeNote(sha: string, note: GlossNote, ref: string = NOTES_REF): void {
  git(['notes', '--ref', ref, 'add', '-f', '-F', '-', sha], JSON.stringify(note, null, 2) + '\n')
}

export type LineStep = { commit: string; file: string; lines: number[] }

// The commits that changed lines start..end of `file`, newest first, starting
// from `commit`, following them through edits, moves within the file and
// renames. Each step gives the file's path in that commit and the lines' new
// numbers in its diff. `max` stops after that many commits (to check whether
// any older history exists without walking it). Uses git log -L, so it is
// approximate when lines are heavily rewritten. Null if git can't trace them.
export function lineHistory(file: string, start: number, end: number, commit: string, max?: number): LineStep[] | null {
  const out = gitTry([
    // showSignature would print signature checks between the commits.
    '-c', 'core.quotePath=false', '-c', 'log.showSignature=false', 'log', '--no-color', '--no-ext-diff',
    '--src-prefix=a/', '--dst-prefix=b/', `-L${start},${end}:${file}`, '--format=%x00%H',
    ...(max ? [`--max-count=${max}`] : []), commit,
  ])
  if (out === null) return null
  return out.split('\0').filter((chunk) => chunk.trim()).map((chunk) => {
    const [first, ...rest] = chunk.split('\n')
    let path = file, newNo = 0, inHunk = false
    const lines: number[] = []
    for (const l of rest) {
      if (l.startsWith('diff --git ')) { inHunk = false; continue }
      // Inside a hunk, decide by position, not prefix: an added line whose
      // text starts with "++ " would otherwise look like a "+++" header.
      if (!inHunk && l.startsWith('+++ ')) { path = parsePath(l.slice(4)) ?? path; continue }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l)
      if (h) { newNo = Number(h[1]); inHunk = true; continue }
      if (!inHunk) continue
      if (l.startsWith('+')) lines.push(newNo++)
      else if (l.startsWith(' ')) newNo++
    }
    return { commit: first.trim(), file: path, lines }
  })
}

// For one line: the commit that last changed it, and the line's number and
// file in that commit. An all-zero commit means the line isn't committed.
export type BlameResult = { commit: string; line: number; origLine: number; origFile: string }

// Blame lines start..end in one call (one record per line).
export function blameRange(file: string, start: number, end: number, rev?: string): BlameResult[] {
  const args = ['blame', '--line-porcelain', '-L', `${start},${end}`]
  if (rev) args.push(rev)
  args.push('--', file)
  const out: BlameResult[] = []
  let cur: BlameResult | null = null
  for (const l of git(args).split('\n')) {
    // 40 hex digits for SHA-1 repositories, 64 for SHA-256.
    const head = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) (\d+)/.exec(l)
    if (head) { cur = { commit: head[1], origLine: Number(head[2]), line: Number(head[3]), origFile: file }; out.push(cur); continue }
    // Porcelain C-quotes unusual file names, like diff headers do.
    if (cur && l.startsWith('filename ')) { const raw = l.slice(9); cur.origFile = raw.startsWith('"') ? unquote(raw) : raw }
  }
  return out
}
