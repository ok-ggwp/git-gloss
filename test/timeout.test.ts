import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from './run.ts'
import { tmp } from './tmp.ts'
import { within } from './timing.ts'

// A hung git must fail git-gloss with a clear message, not hang it.
const bin = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
// kill -0 also succeeds on a zombie (killed, not yet reaped), so read its state
const alive = (pid: number) => {
  try { return !/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false }
}
// the group's members die at SIGKILL, but a loaded machine can take a moment to deliver it
const gone = (pids: number[]) => { for (let i = 0; i < 50 && pids.some(alive); i++) spawnSync('sleep', ['0.1']); return pids.filter(alive) }

// A repo, and a fake `git` first on PATH: it runs the real git, except for
// `rev-list`, where it records its pid, starts a sleeping child (when
// `grandchild`) and then sleeps 60 s itself.
// `skip`: let that many calls of the subcommand through before hanging. `glossed`: HEAD~1 has a
// gloss (written with the real git) and HEAD is a second commit, on branch main.
function setup(grandchild: boolean, sub = 'rev-list', locking = false, { skip = 0, glossed = false } = {}) {
  const dir = tmp('to-')
  const run = (...a: string[]) => spawnSync(realGit, a, { cwd: dir, encoding: 'utf8' })
  const commit = (msg: string, ...extra: string[]) => run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', ...extra, '-m', msg)
  run('init', '-q', '-b', 'main')
  if (glossed) {
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    run('add', '-A'); commit('first')
    const g = JSON.stringify({ task: 't', groups: [{ id: 'g', hunks: ['h1'], intent: 'i', necessity: 'required', serves: 'task', removal_impact: 'r' }] })
    const r = spawnSync(process.execPath, [bin, 'add'], { cwd: dir, input: g, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    writeFileSync(join(dir, 'b.txt'), 'two\n')
    run('add', '-A'); commit('second')
  } else commit('x', '--allow-empty')
  const fake = join(dir, 'fakebin')
  const pids = join(dir, 'pids')
  const lock = join(dir, 'fake.lock')
  spawnSync('mkdir', [fake])
  writeFileSync(join(fake, 'git'), `#!/bin/sh
case " $* " in *" ${sub} "*)
  n=$(cat '${join(dir, 'count')}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${join(dir, 'count')}'
  [ $n -le ${skip} ] && exec '${realGit}' "$@"
  echo $$ >> '${pids}'
  ${locking ? `touch '${lock}'; sleep 60 & echo $! >> '${pids}'; trap "rm -f '${lock}'; kill $!; exit 0" TERM; wait` : grandchild ? `sleep 60 & echo $! >> '${pids}'; wait` : 'exec sleep 60'} ;;
esac
exec '${realGit}' "$@"
`)
  chmodSync(join(fake, 'git'), 0o755)
  const pidList = () => (existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : [])
  const cli = (env: Record<string, string>, limit = 20_000, args = ['show', 'HEAD..HEAD']) => {
    const t0 = Date.now()
    const r = spawnSync(process.execPath, [bin, ...args], {
      cwd: dir, encoding: 'utf8', timeout: limit,
      env: { ...process.env, PATH: `${fake}:${process.env.PATH}`, ...env },
    })
    return { r, ms: Date.now() - t0 }
  }
  const real = (...a: string[]) => run(...a).stdout
  return { cli, pidList, lock, real, dir, run }
}
const reap = (pids: number[]) => { for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } } }

test('a hung git fails the command at GIT_GLOSS_GIT_TIMEOUT, with a message and no stack trace', () => {
  const { cli, pidList } = setup(false)
  try {
    const { r, ms } = cli({ GIT_GLOSS_GIT_TIMEOUT: '1500' })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /git rev-list --reverse --no-merges timed out after 1\.5 s \(set GIT_GLOSS_GIT_TIMEOUT to change the limit\)/)
    assert.doesNotMatch(r.stderr, /\n\s+at /)
    within('hung git fails', ms, 15_000)
    const pids = pidList()
    assert.ok(pids.length >= 1, 'the fake git never ran')
    assert.deepEqual(gone(pids), [], 'the hung git was left running')
  } finally { reap(pidList()) }
})

test('GIT_GLOSS_GIT_TIMEOUT: 0 disables the limit, garbage and negatives are ignored', async () => {
  const { parseGitTimeout } = await import('../src/git.ts')
  assert.equal(parseGitTimeout('0'), 0)
  assert.equal(parseGitTimeout('2500'), 2500)
  for (const bad of [undefined, '', '  ', 'abc', '-5', 'NaN', 'Infinity', '1e999']) assert.equal(parseGitTimeout(bad), 120_000, String(bad))
})

test('GIT_GLOSS_GIT_TIMEOUT=0 means no limit: only the harness limit ends a hung git, and its group dies with it', () => {
  const { cli, pidList } = setup(true)
  try {
    assert.throws(() => cli({ GIT_GLOSS_GIT_TIMEOUT: '0' }, 2500), /timed out after 2500 ms/)
    const pids = pidList()
    assert.ok(pids.length >= 2, 'the fake git and its sleeping child never started')
    // the CLI, the fake git and its `sleep` are grandchildren of the test's child: all must be gone
    assert.deepEqual(gone(pids), [], 'a grandchild of the timed-out CLI outlived it')
  } finally { reap(pidList()) }
})

test('a hung git behind gitTry (an optional probe) reports the timeout, not "not a commit"', () => {
  // `show HEAD` resolves HEAD with gitTry(rev-parse): a null there used to read as "not a commit"
  const { cli, pidList } = setup(false, 'rev-parse')
  try {
    const { r } = cli({ GIT_GLOSS_GIT_TIMEOUT: '1500' }, 20_000, ['show', 'HEAD'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /^error: git rev-parse .* timed out after 1\.5 s/)
    assert.doesNotMatch(r.stderr, /not a commit|\n\s+at /)
    assert.deepEqual(gone(pidList()), [])
  } finally { reap(pidList()) }
})

test('a timed-out git is stopped with SIGTERM so its lock file is removed, and the timeout is reported', () => {
  const { cli, pidList, lock } = setup(false, 'rev-list', true)
  try {
    const { r } = cli({ GIT_GLOSS_GIT_TIMEOUT: '1500' })
    assert.match(r.stderr, /timed out after 1\.5 s/)
    assert.equal(existsSync(lock), false, 'the killed git left its lock file behind')
  } finally { reap(pidList()) }
})

// Each site that turns a git failure into a value ("broken", "unreadable", "use the defaults") must let a timeout through.
const timedOutMsg = /timed out after 1\.5 s/
const T = { GIT_GLOSS_GIT_TIMEOUT: '1500' }

test('carry: a hung git on the target\'s gloss is a timeout, not "broken", and nothing is written', () => {
  const { cli, pidList, real } = setup(false, 'notes', false, { glossed: true })
  try {
    const { r } = cli(T, 20_000, ['carry', 'HEAD~1', '--to', 'HEAD'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, timedOutMsg)
    assert.equal(real('notes', '--ref', 'gloss', 'list').trim().split('\n').length, 1, 'carry wrote a note')
  } finally { reap(pidList()) }
})

test('carry: a hung git on a source\'s gloss is a timeout, not "unreadable", and nothing is written', () => {
  // calls 1-2 read the target's (absent) gloss; the 3rd reads the source's
  const { cli, pidList, real } = setup(false, 'notes', false, { glossed: true, skip: 2 })
  try {
    const { r } = cli(T, 20_000, ['carry', 'HEAD~1', '--to', 'HEAD'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, timedOutMsg)
    assert.doesNotMatch(r.stderr + r.stdout, /unreadable|can't be read/)
    assert.equal(real('notes', '--ref', 'gloss', 'list').trim().split('\n').length, 1, 'carry wrote a note')
  } finally { reap(pidList()) }
})

test('config: a hung git finding the base branch is a timeout, not a warning and the defaults', () => {
  const { cli, pidList } = setup(false, 'merge-base', false, { glossed: true })
  try {
    const { r } = cli(T, 20_000, ['show', 'HEAD~1'])
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, timedOutMsg)
    assert.doesNotMatch(r.stderr, /trying the next candidate|built-in defaults/)
  } finally { reap(pidList()) }
})

// Network calls have their own, longer limit (GIT_GLOSS_NETWORK_TIMEOUT; else GIT_GLOSS_GIT_TIMEOUT when set; else 600 s).
function withRemote(sub: string) {
  const s = setup(false, sub, false, { glossed: true })
  const remote = tmp('to-remote-')
  spawnSync(realGit, ['init', '-q', '--bare', remote])
  s.run('remote', 'add', 'origin', remote)
  s.run('push', '-q', 'origin', 'main')
  // the remote has a gloss ref, so ls-remote and fetch have something to do
  s.run('push', '-q', 'origin', 'refs/notes/gloss:refs/notes/gloss')
  // a local-only change to push: gloss HEAD too
  const g = JSON.stringify({ task: 't', groups: [{ id: 'g', hunks: ['h1'], intent: 'i', necessity: 'required', serves: 'task', removal_impact: 'r' }] })
  spawnSync(process.execPath, [bin, 'add', 'HEAD'], { cwd: s.dir, input: g, encoding: 'utf8' })
  return s
}

test('network defaults: 600 s, GIT_GLOSS_GIT_TIMEOUT overrides both, GIT_GLOSS_NETWORK_TIMEOUT only the network', () => {
  const probe = (env: Record<string, string>) => spawnSync(process.execPath, ['-e',
    "import('./src/git.ts').then(m => console.log(JSON.stringify([m.NETWORK_TIMEOUT, m.parseGitTimeout(process.env.GIT_GLOSS_GIT_TIMEOUT)])))"],
  { cwd: join(import.meta.dirname, '..'), encoding: 'utf8', env: { ...process.env, GIT_GLOSS_GIT_TIMEOUT: '', GIT_GLOSS_NETWORK_TIMEOUT: '', ...env } }).stdout.trim()
  assert.equal(probe({}), '[600000,120000]')
  assert.equal(probe({ GIT_GLOSS_GIT_TIMEOUT: '3000' }), '[3000,3000]')
  assert.equal(probe({ GIT_GLOSS_NETWORK_TIMEOUT: '4000' }), '[4000,120000]')
  assert.equal(probe({ GIT_GLOSS_GIT_TIMEOUT: '3000', GIT_GLOSS_NETWORK_TIMEOUT: '0' }), '[0,3000]')
})

for (const sub of ['ls-remote', 'fetch', 'push']) {
  test(`sync: a hung git ${sub} is cut at the network limit, not the (longer) general one`, () => {
    const { cli, pidList } = withRemote(sub)
    try {
      // general limit 60 s, network limit 1.5 s: only a call that uses the network limit ends in time
      const { r, ms } = cli({ GIT_GLOSS_GIT_TIMEOUT: '60000', GIT_GLOSS_NETWORK_TIMEOUT: '1500' }, 25_000, ['sync'])
      assert.notEqual(r.status, 0, r.stdout)
      assert.match(r.stderr, new RegExp(`git ${sub} .*timed out after 1\\.5 s`))
      within(`hung ${sub}`, ms, 20_000)
      assert.deepEqual(gone(pidList()), [])
    } finally { reap(pidList()) }
  })
}

test('a network call is not cut at the general limit', () => {
  // the general limit is 1.5 s, the network one 60 s: a fetch that takes 3 s must succeed
  const { cli, dir } = withRemote('fetch')
  writeFileSync(join(dir, 'fakebin', 'git'), `#!/bin/sh
case " $* " in *" fetch "*|*" push "*|*" ls-remote "*) sleep 3 ;; esac
exec '${realGit}' "$@"
`)
  const { r } = cli({ GIT_GLOSS_GIT_TIMEOUT: '1500', GIT_GLOSS_NETWORK_TIMEOUT: '60000' }, 40_000, ['sync'])
  assert.equal(r.status, 0, r.stderr)
})

// Best-effort cleanup never fails a finished job, and says so on stderr when it timed out.
test('sync: a hung update-ref -d cleanup does not fail the sync, and warns once per cleanup', () => {
  // the remote has no gloss ref, so sync deletes the tmp push ref (a cleanup) before and after pushing
  const s = setup(false, 'update-ref -d', false, { glossed: true })
  const remote = tmp('to-remote-')
  spawnSync(realGit, ['init', '-q', '--bare', remote])
  s.run('remote', 'add', 'origin', remote)
  s.run('push', '-q', 'origin', 'main')
  try {
    const { r } = s.cli({ GIT_GLOSS_GIT_TIMEOUT: '1500' }, 40_000, ['sync'])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stderr, /warning: cleanup timed out, a temporary ref may be left \(git update-ref -d refs\/notes\/gloss-sync-tmp\)/)
    assert.doesNotMatch(r.stderr, /\n\s+at /)
  } finally { reap(s.pidList()) }
})

test('addReviews: a hung update-ref -d cleanup does not fail recording a review', () => {
  const s = setup(false, 'update-ref -d', false, { glossed: true })
  try {
    const stamp = JSON.parse(spawnSync(process.execPath, [bin, 'reviews', '--stamp', 'HEAD~1'], { cwd: s.dir, encoding: 'utf8' }).stdout)
    const rec = JSON.stringify({ stage: 'bugs', agent: 'x', target: 'HEAD~1', findings: '## 1 nit\n- a', stamp })
    const r = spawnSync(process.execPath, [bin, 'reviews', '--record'], {
      cwd: s.dir, encoding: 'utf8', input: rec, timeout: 60_000,
      env: { ...process.env, PATH: `${join(s.dir, 'fakebin')}:${process.env.PATH}`, GIT_GLOSS_GIT_TIMEOUT: '1500' },
    })
    assert.match(r.stderr, /warning: cleanup timed out/, r.stdout + r.stderr)
    assert.doesNotMatch(r.stderr, /error:/)
    assert.equal(r.status, 0, r.stderr)
  } finally { reap(s.pidList()) }
})
