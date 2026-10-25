import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { within } from './timing.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
const gloss = (cwd: string, args: string[]) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', timeout: 60_000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

// A bare origin, a publisher repo with one glossed commit, and a reader that ran `init`.
function setup() {
  const root = tmp('syncref-')
  const origin = join(root, 'origin.git')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const pub = join(root, 'pub')
  execFileSync('git', ['init', '-q', '-b', 'main', pub])
  git(pub, 'config', 'user.email', 'p@e'); git(pub, 'config', 'user.name', 'p')
  writeFileSync(join(pub, 'a.txt'), 'a\n')
  git(pub, 'add', '-A'); git(pub, 'commit', '-qm', 'base')
  git(pub, 'push', '-q', origin, 'main')
  git(pub, 'notes', '--ref', 'refs/notes/gloss', 'add', '-m', 'hello', 'HEAD')
  const reader = join(root, 'reader')
  execFileSync('git', ['clone', '-q', origin, reader])
  git(reader, 'config', 'user.email', 'r@e'); git(reader, 'config', 'user.name', 'r')
  assert.equal(gloss(reader, ['init']).code, 0)
  return { origin, pub, reader }
}

test('sync works after the remote moves its notes from refs/notes/gloss/x to refs/notes/gloss', () => {
  const { origin, pub, reader } = setup()
  git(pub, 'push', '-q', origin, 'refs/notes/gloss:refs/notes/gloss/x')
  git(reader, 'fetch', '-q')
  assert.match(git(reader, 'for-each-ref', 'refs/notes/remotes/origin/'), /gloss\/x/)
  git(pub, 'push', '-q', origin, ':refs/notes/gloss/x')
  git(pub, 'push', '-q', origin, 'refs/notes/gloss:refs/notes/gloss')
  const r = gloss(reader, ['sync'])
  assert.equal(r.code, 0, r.err)
  assert.equal(git(reader, 'notes', '--ref', 'refs/notes/gloss', 'show', 'HEAD').trim(), 'hello')
  assert.doesNotMatch(git(reader, 'for-each-ref', 'refs/notes/remotes/origin/'), /gloss\/x/, 'the stale ref is gone')
  git(reader, 'fetch', '-q') // plain fetch works again too
})

test('a conflicting stale tracking ref under reviews is cleared too, and nothing else is touched', () => {
  const { origin, pub, reader } = setup()
  git(pub, 'notes', '--ref', 'refs/notes/gloss-reviews', 'add', '-m', 'r1', 'HEAD')
  git(pub, 'push', '-q', origin, 'refs/notes/gloss-reviews:refs/notes/gloss-reviews/old')
  git(reader, 'fetch', '-q')
  const other = git(reader, 'rev-parse', 'HEAD').trim()
  git(reader, 'update-ref', 'refs/notes/remotes/origin/other/keep', other)
  git(reader, 'update-ref', 'refs/notes/remotes/upstream/gloss/x', other)
  git(pub, 'push', '-q', origin, ':refs/notes/gloss-reviews/old')
  git(pub, 'push', '-q', origin, 'refs/notes/gloss-reviews:refs/notes/gloss-reviews', 'refs/notes/gloss:refs/notes/gloss')
  const r = gloss(reader, ['sync'])
  assert.equal(r.code, 0, r.err)
  assert.equal(git(reader, 'notes', '--ref', 'refs/notes/gloss-reviews', 'show', 'HEAD').trim(), 'r1')
  const refs = git(reader, 'for-each-ref', '--format=%(refname)', 'refs/notes/remotes/')
  assert.match(refs, /origin\/other\/keep/)
  assert.match(refs, /upstream\/gloss\/x/)
  assert.doesNotMatch(refs, /gloss-reviews\/old/)
})

test('a remote that once published thousands of refs under refs/notes/gloss/ does not stall sync', () => {
  const { origin, pub, reader } = setup()
  git(pub, 'push', '-q', origin, 'refs/notes/gloss:refs/heads/seed') // the objects must be in origin
  const sha = git(pub, 'rev-parse', 'refs/notes/gloss').trim()
  const N = 3000
  const lines = (verb: string) => Array.from({ length: N }, (_, i) => verb === 'create' ? `create refs/notes/gloss/n${i} ${sha}` : `delete refs/notes/gloss/n${i}`).join('\n') + '\n'
  execFileSync('git', ['update-ref', '--stdin'], { cwd: origin, input: lines('create') })
  git(reader, 'fetch', '-q')
  assert.ok(git(reader, 'for-each-ref', 'refs/notes/remotes/origin/gloss/').split('\n').length > N)
  execFileSync('git', ['update-ref', '--stdin'], { cwd: origin, input: lines('delete') })
  git(pub, 'push', '-q', origin, 'refs/notes/gloss:refs/notes/gloss')
  const t0 = performance.now()
  const r = gloss(reader, ['sync'])
  within('sync after thousands of stale tracking refs', performance.now() - t0, 20_000)
  assert.equal(r.code, 0, r.err)
  assert.equal(git(reader, 'notes', '--ref', 'refs/notes/gloss', 'show', 'HEAD').trim(), 'hello')
  assert.equal(git(reader, 'for-each-ref', 'refs/notes/remotes/origin/gloss/').trim(), '')
})

test('a fetch that still fails says what to run', () => {
  const { origin, pub, reader } = setup()
  git(pub, 'push', '-q', origin, 'refs/notes/gloss:refs/notes/gloss')
  // A stale lock on the tracking ref: git cannot lock it, whatever sync cleared.
  mkdirSync(join(reader, '.git', 'refs', 'notes', 'remotes', 'origin'), { recursive: true })
  writeFileSync(join(reader, '.git', 'refs', 'notes', 'remotes', 'origin', 'gloss.lock'), '')
  const r = gloss(reader, ['sync'])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /git remote prune origin/)
})

test('a stale child ref git cannot lock is a hinted failure, not a raw fatal', () => {
  const { origin, pub, reader } = setup()
  git(pub, 'push', '-q', origin, 'refs/notes/gloss:refs/notes/gloss/x')
  git(reader, 'fetch', '-q')
  git(pub, 'push', '-q', origin, ':refs/notes/gloss/x')
  git(pub, 'push', '-q', origin, 'refs/notes/gloss:refs/notes/gloss')
  writeFileSync(join(reader, '.git', 'refs', 'notes', 'remotes', 'origin', 'gloss', 'x.lock'), '')
  const r = gloss(reader, ['sync'])
  assert.notEqual(r.code, 0)
  assert.match(r.err, /git remote prune origin/)
})
