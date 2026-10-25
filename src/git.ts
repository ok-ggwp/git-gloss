import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, NOTE_FORMAT, type GlossNote } from './schema.ts'
import { parsePath, unquote } from './diff.ts'
import { plain } from './plain.ts'

export const NOTES_REF = 'refs/notes/gloss'
// Glosses of uncommitted work (wip snapshots) live in their own notes ref,
// which sync never pushes, and the latest snapshot in a private ref that
// keeps it from being garbage-collected. refs/worktree/ refs are per
// worktree, so each linked worktree has its own snapshot.
export const WIP_NOTES_REF = 'refs/notes/gloss-wip'
export const WIP_REF = 'refs/worktree/gloss/wip'
const WIP_MESSAGE = 'git-gloss wip snapshot'
export const REMOTE_NOTES_REF = 'refs/notes/remotes/origin/gloss'
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Errors whose message is fit to show the user without a stack trace.
export class GlossError extends Error {}
export class GitError extends GlossError {
  // git's exit code, when it ran and failed (1 is often "no", 128 a real failure).
  status?: number
  // The call was killed at GIT_GLOSS_GIT_TIMEOUT: unlike a failure, not an answer.
  timedOut = false
}

// How long one git call may run before it is killed (ms; 0 = no limit). A
// hung git (a stuck filesystem, a credential helper, a lock) would otherwise
// hang git-gloss for good. Read once at load: GIT_GLOSS_GIT_TIMEOUT overrides;
// a value that is not a non-negative number is ignored.
// A timed-out git gets SIGTERM, not SIGKILL: git removes its lock files
// (index.lock, a ref's .lock) on SIGTERM, while SIGKILL would leave one that
// fails every later command. A git that ignores SIGTERM is waited for, with
// no second-stage kill (execFileSync only returns when the child ends), so
// such a git still hangs git-gloss.
// Network calls (fetch, push, ls-remote) get NETWORK_TIMEOUT (600 s) instead:
// a slow link would otherwise fail at 120 s and every retry would fail again.
// GIT_GLOSS_NETWORK_TIMEOUT (ms, 0 = none) sets that limit alone; failing it,
// GIT_GLOSS_GIT_TIMEOUT, when set, applies to both.
export function parseGitTimeout(raw: string | undefined, fallback = 120_000): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}
const GIT_TIMEOUT = parseGitTimeout(process.env.GIT_GLOSS_GIT_TIMEOUT)
export const NETWORK_TIMEOUT = parseGitTimeout(process.env.GIT_GLOSS_NETWORK_TIMEOUT, parseGitTimeout(process.env.GIT_GLOSS_GIT_TIMEOUT, 600_000))

export function git(args: string[], input?: string, env: Record<string, string> = {}, limit = GIT_TIMEOUT): string {
  try {
    return execFileSync('git', args, {
      timeout: limit,
      killSignal: 'SIGTERM',
      encoding: 'utf8',
      input,
      // Untranslated messages: readNote recognises "no note found" by its text.
      env: { ...process.env, ...env, LC_ALL: 'C' },
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (err) {
    if ((err as { code?: string }).code === 'ETIMEDOUT') {
      const what = plain(args.slice(0, 3).join(' ')).slice(0, 80)
      const t = new GitError(`git ${what} timed out after ${limit / 1000} s (set GIT_GLOSS_GIT_TIMEOUT to change the limit)`)
      t.timedOut = true
      throw t
    }
    const stderr = (err as { stderr?: string }).stderr?.trim()
    const e = new GitError(stderr || `git ${args.join(' ')} failed`)
    e.status = typeof (err as { status?: unknown }).status === 'number' ? (err as { status: number }).status : undefined
    throw e
  }
}

// For a catch that turns a git failure into a value ("no gloss", "unreadable",
// "use the defaults"): a git killed at the time limit gave no answer, so the
// timeout goes on to the caller rather than become that value.
export function rethrowTimeout(err: unknown): void {
  if (err instanceof GitError && err.timedOut) throw err
}

// Best-effort cleanup (a temporary ref in a `finally`, or after success): never
// throws, not even on a timeout, so it can't fail a finished job or replace the
// first error. A timeout leaves one warning line.
export function gitCleanup(args: string[]): void {
  try {
    git(args)
  } catch (err) {
    if (err instanceof GitError && err.timedOut) process.stderr.write(`warning: cleanup timed out, a temporary ref may be left (git ${args.join(' ')})\n`)
  }
}

export function gitTry(args: string[], input?: string, limit = GIT_TIMEOUT): string | null {
  try {
    return git(args, input, {}, limit)
  } catch (err) {
    // Any failure is "no" (callers probe with this), but a git killed at the
    // time limit gave no answer: say so rather than let it read as "no".
    rethrowTimeout(err)
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
// `replaced` is the previous snapshot when this one replaces it, so the
// caller can carry its gloss over.
export function snapshotWorkingTree(): { sha: string; excluded: string[]; replaced: string | null } {
  const { tree, excluded } = workingTree()
  const head = headSha()
  if (head && git(['rev-parse', `${head}^{tree}`]).trim() === tree) {
    throw new GlossError('there are no uncommitted changes to snapshot')
  }
  const current = gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])?.trim()
  if (current) {
    const c = treeAndParent(current)
    if (c.tree === tree && c.parent === head) return { sha: current, excluded, replaced: null }
  }
  const sha = git(['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', WIP_MESSAGE], undefined, commitIdentity()).trim()
  if (current) archiveSnapshot(current)
  git(['update-ref', WIP_REF, sha])
  return { sha, excluded, replaced: current ?? null }
}

// Snapshots and archive entries are commit objects, which need an identity;
// fall back to a placeholder where git has none configured rather than fail.
function commitIdentity(): Record<string, string> {
  const ident = (v: string) => gitTry(['var', v]) !== null
  const env: Record<string, string> = {}
  if (!ident('GIT_AUTHOR_IDENT')) Object.assign(env, { GIT_AUTHOR_NAME: 'git-gloss', GIT_AUTHOR_EMAIL: 'git-gloss@localhost' })
  if (!ident('GIT_COMMITTER_IDENT')) Object.assign(env, { GIT_COMMITTER_NAME: 'git-gloss', GIT_COMMITTER_EMAIL: 'git-gloss@localhost' })
  return env
}

// A glossed snapshot that is being replaced or cleared stays reachable from
// this ref, so git gc keeps it: its old gloss, which the notes history keeps,
// still has the changes it describes (`versions wip` reads and restores them).
// Each entry is an empty commit whose parents are the previous entry and the
// snapshot. Per worktree, like WIP_REF.
export const ARCHIVE_REF = 'refs/worktree/gloss/archive'
export function archiveSnapshot(sha: string): void {
  if (rawNote(WIP_NOTES_REF, sha) === null) return
  const prev = gitTry(['rev-parse', '-q', '--verify', ARCHIVE_REF])?.trim()
  const entry = git(['commit-tree', EMPTY_TREE, ...(prev ? ['-p', prev] : []), '-p', sha, '-m', 'git-gloss: earlier glossed wip snapshot'],
    undefined, commitIdentity()).trim()
  git(['update-ref', ARCHIVE_REF, entry])
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

// The diff of uncommitted work against HEAD, as a snapshot would have it,
// without taking a snapshot: no ref is written (only objects). Hunk ids match
// those of `hunks wip` for the same working tree.
export function workingDiff(): { diff: string; excluded: string[] } {
  const { tree, excluded } = workingTree()
  const head = headSha()
  if (head && git(['rev-parse', `${head}^{tree}`]).trim() === tree) throw new GlossError('there are no uncommitted changes')
  return { diff: diffBetween(head ?? EMPTY_TREE, tree), excluded }
}

export function resolveCommit(rev: string): string {
  // "wip": the latest snapshot of uncommitted work (made by `hunks wip`). A
  // branch or tag named wip still works when there is no snapshot, and can be
  // reached as heads/wip or tags/wip when there is.
  // --end-of-options: the revision is whatever the user typed, never a flag.
  const named = gitTry(['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`])?.trim()
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
  return diffBetween(gitTry(['rev-parse', '--verify', '--quiet', `${sha}^1`])?.trim() || EMPTY_TREE, sha)
}

// The diff between two commits (or trees), with the same pinned options.
export function diffBetween(from: string, to: string): string {
  return git([
    '-c', 'core.quotePath=false', '-c', 'diff.suppressBlankEmpty=false',
    'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames',
    '--src-prefix=a/', '--dst-prefix=b/', '-U3',
    '-O/dev/null', '--diff-algorithm=myers', '--indent-heuristic',
    '--inter-hunk-context=0', '--no-relative', '--submodule=short', '-l1000',
    from, to,
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

function cleanStrings<T>(v: T): T {
  if (typeof v === 'string') return plain(v, true) as T
  if (Array.isArray(v)) return v.map(cleanStrings) as T
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanStrings(x)])) as T
  return v
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
  if (![1, 2, 3, 4].includes(data?.gloss as number) || !Array.isArray(data.hunks) || !annotation.success) {
    throw new GlossError(`${at} is malformed; replace it with \`git gloss add --force\``)
  }
  // The gloss's text is shown in a terminal, and a note can come from anyone
  // who can push to the remote: no escape sequences or control characters get through.
  return { ...(data as GlossNote), annotation: cleanStrings(annotation.data) }
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
