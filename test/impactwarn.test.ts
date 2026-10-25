import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmp } from './tmp.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')
const run = (cwd: string, args: string[], input?: string) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const lock = (v: string) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/some-pkg': { version: v } } }, null, 2) + '\n'

function repo(extra: string[] = []) {
  const dir = tmp('impactwarn-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@e.com'); g('config', 'user.name', 'T')
  const write = (f: string, t: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t) }
  write('package-lock.json', lock('7.1.0')); write('app.js', 'run()\n'); write('util.js', 'a()\n'); for (const f of extra) write(f, 'x()\n')
  g('add', '-A'); g('commit', '-qm', 'base')
  write('package-lock.json', lock('7.1.2')); write('app.js', 'run2()\n'); write('util.js', 'b()\n'); for (const f of extra) write(f, 'y()\n')
  g('add', '-A'); g('commit', '-qm', 'change')
  return dir
}
const grp = (id: string, hunks: string[], extra: object = {}) =>
  ({ id, hunks, intent: id, necessity: 'required', serves: 'task', removal_impact: `no ${id}`, ...extra })
const add = (dir: string, groups: object[], extra: string[] = ['--dry-run']) =>
  run(dir, ['add', ...extra], JSON.stringify({ task: 't', groups }))
// hunks: h2 = lockfile, h1 = app.js, h3 = util.js
const mech = { necessity: 'mechanical' }
const rated = { impact: 'contract', impact_reason: 'versions' }

test('a non-mechanical group without impact warns and names it', () => {
  const r = add(repo(), [grp('lock', ['h2'], rated), grp('a', ['h1']), grp('b', ['h3'], { impact: 'local' })])
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /warning: no impact rated on group "a"; rate impact on every group except a mechanical one on plain source \(floor module or below\), see the gloss skill/)
})

test('a purely mechanical group on a local or module floor does not warn', () => {
  const r = add(repo(), [grp('lock', ['h2'], rated), grp('a', ['h1'], mech), grp('b', ['h3'], { impact: 'local' })])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.err, /no impact rated/)
})

test('a mechanical lockfile bump without impact warns with its floor', () => {
  const r = add(repo(), [grp('lock', ['h2'], mech), grp('a', ['h1'], mech), grp('b', ['h3'], { impact: 'local' })])
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /warning: no impact rated on group "lock" \(lock: floor contract: package-lock\.json/)
  assert.doesNotMatch(r.err, /"a"/)
})

test('all groups rated: no impact warning', () => {
  const r = add(repo(), [grp('lock', ['h2'], rated), grp('a', ['h1'], { impact: 'module' }), grp('b', ['h3'], { impact: 'local' })])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.err, /no impact rated/)
})

test('more than 10 unrated groups: ten names and "and N more"', () => {
  const files = Array.from({ length: 9 }, (_, i) => `f${String(i).padStart(2, '0')}.js`)
  const dir = repo(files)
  // diff order is by path: h1 app.js, h2-h10 f00-f08, h11 package-lock.json, h12 util.js,
  // so the lockfile group g10 falls in the "and 2 more" tail but still shows in the floored list
  const groups = Array.from({ length: 12 }, (_, i) => grp(`g${i}`, [`h${i + 1}`], { impact: undefined }))
  const r = add(dir, groups)
  assert.equal(r.code, 0, r.err)
  const line = r.err.split('\n').find((l) => /no impact rated/.test(l))!
  assert.match(line, /group "g0", "g1", "g2", "g3", "g4", "g5", "g6", "g7", "g8", "g9" and 2 more/)
  assert.doesNotMatch(line, /"g10"|"g11"/, 'the tail is not named')
  assert.match(line, /\(g10: floor contract: package-lock\.json/, 'the tail still reports its floors')
})

test('two groups on floor signals both appear in the floored list', () => {
  const dir = repo(['zz/package.json'])
  const r = add(dir, [grp('a', ['h1'], { impact: 'local' }), grp('lock', ['h2'], mech), grp('b', ['h3'], { impact: 'local' }), grp('man', ['h4'], mech)])
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /group "lock", "man" \(lock: floor contract: package-lock\.json[^;]*; man: floor contract: zz\/package\.json/)
})

test('the warning changes neither the exit code nor what is stored', () => {
  const dir = repo()
  const r = add(dir, [grp('lock', ['h2'], mech), grp('a', ['h1']), grp('b', ['h3'])], [])
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /no impact rated on group "lock", "a", "b"/)
  const notes = execFileSync('git', ['notes', '--ref=gloss', 'show', 'HEAD'], { cwd: dir, encoding: 'utf8' })
  assert.doesNotMatch(notes, /no impact rated|"impact"/)
  const kept = JSON.parse(notes).annotation.groups
  assert.ok(Array.isArray(kept) && kept.length === 3 && kept.every((g: object) => !('impact' in g)), 'groups stored as given')
})
