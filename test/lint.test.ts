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

// Hunk ids are looked up by file name (from `hunks`), never assumed.
const FILES: Record<string, [string, string]> = {
  '.github/workflows/ci.yml': ['on: push\n', 'on: pull_request\n'],
  'package-lock.json': [lock('7.1.0'), lock('7.1.2')],
  'src/app.js': ['run()\n', 'run2()\n'],
  'src/util.js': ['a()\n', 'b()\n'],
  'test/app.test.js': ['t1()\n', 't2()\n'],
}

function repo() {
  const dir = tmp('lint-')
  const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@e.com'); g('config', 'user.name', 'T')
  const write = (f: string, t: string) => { mkdirSync(dirname(join(dir, f)), { recursive: true }); writeFileSync(join(dir, f), t) }
  for (const [f, [a]] of Object.entries(FILES)) write(f, a)
  g('add', '-A'); g('commit', '-qm', 'base')
  for (const [f, [, b]] of Object.entries(FILES)) write(f, b)
  g('add', '-A'); g('commit', '-qm', 'change')
  const ids: Record<string, string> = {}
  for (const m of run(dir, ['hunks', 'HEAD']).out.matchAll(/^(h\d+)\s+(\S+)\s/gm)) ids[m[2]] = m[1]
  return { dir, g, h: (f: string) => ids[Object.keys(ids).find((k) => k.endsWith(f))!] }
}

type Ctx = ReturnType<typeof repo>
const grp = (id: string, hunks: string[], extra: object = {}) =>
  ({ id, hunks, intent: id, necessity: 'required', serves: 'task', impact: 'module', removal_impact: `no ${id}`, ...extra })

// A gloss that lint finds nothing in: every file under a group rated at its floor.
function cleanGroups(c: Ctx, over: Record<string, object> = {}) {
  const h = c.h
  return [
    grp('ci', [h('ci.yml')], { impact: 'contract', impact_reason: 'ci definition', ...over.ci }),
    grp('lock', [h('package-lock.json')], { necessity: 'mechanical', impact: 'contract', impact_reason: 'versions', ...over.lock }),
    grp('app', [h('src/app.js')], over.app),
    grp('util', [h('src/util.js')], over.util),
    grp('tests', [h('test/app.test.js')], { necessity: 'supporting', serves: ['app', 'util'], impact: 'local', ...over.tests }),
  ]
}
const annotation = (groups: object[], extra: object = {}) =>
  ({ task: 't', groups, risks: ['a risk'], attention: { level: 'must-read', reasons: ['floor'] }, ...extra })
function glossed(c: Ctx, groups: object[], extra: object = {}, flags: string[] = []) {
  const r = run(c.dir, ['add', 'HEAD', ...flags], JSON.stringify(annotation(groups, extra)))
  assert.equal(r.code, 0, r.err)
}
// What `add` refuses can still be in a note (a stale gloss, a pushed one): rewrite the stored groups.
function plant(c: Ctx, groups: object[]) {
  const sha = c.g('rev-parse', 'HEAD')
  const note = JSON.parse(c.g('notes', '--ref', 'refs/notes/gloss', 'show', sha))
  const file = join(tmp('plant-'), 'g.json')
  writeFileSync(file, JSON.stringify({ ...note, annotation: { ...note.annotation, groups } }))
  c.g('notes', '--ref', 'refs/notes/gloss', 'add', '-f', '-F', file, sha)
}
const lint = (c: Ctx, ...a: string[]) => run(c.dir, ['lint', 'HEAD', ...a])
const codes = (c: Ctx, ...a: string[]) => (JSON.parse(lint(c, '--json', ...a).out).findings as { code: string; group?: string; hunk?: string }[])

test('lint is a known command', () => {
  const c = repo()
  const r = run(c.dir, ['lint', 'HEAD'])
  assert.doesNotMatch(r.err, /unknown command/)
})

test('a clean gloss prints clean, exit 0', () => {
  const c = repo()
  glossed(c, cleanGroups(c))
  const r = lint(c)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim(), 'clean')
  assert.deepEqual(JSON.parse(lint(c, '--json').out).findings, [])
  assert.equal('incomplete' in JSON.parse(lint(c, '--json').out), false)
})

test('no-impact: an unrated group, but not a mechanical one on plain source', () => {
  const c = repo()
  glossed(c, cleanGroups(c, { app: { impact: undefined }, util: { necessity: 'mechanical', impact: undefined } }))
  const f = codes(c)
  assert.deepEqual(f.filter((x) => x.code === 'no-impact').map((x) => x.group), ['app'])
})

test('impact-below-floor: a rating under the floor of its hunks', () => {
  const c = repo()
  glossed(c, cleanGroups(c, { ci: { impact: 'local' } }))
  assert.deepEqual(codes(c).filter((x) => x.code === 'impact-below-floor').map((x) => x.group), ['ci'])
})

test('attention-below-floor: declared under the floor with no override_reason', () => {
  const c = repo()
  glossed(c, cleanGroups(c), { attention: { level: 'skim' } }, ['--allow-underrate'])
  assert.ok(codes(c).some((x) => x.code === 'attention-below-floor'))
  const c2 = repo()
  glossed(c2, cleanGroups(c2), { attention: { level: 'skim', override_reason: 'docs only' } }, ['--allow-underrate'])
  assert.ok(!codes(c2).some((x) => x.code === 'attention-below-floor'))
})

test('mechanical-on-floor: mechanical over a floor signal that is not a lockfile', () => {
  const c = repo()
  glossed(c, cleanGroups(c, { ci: { necessity: 'mechanical' } }))
  assert.deepEqual(codes(c).filter((x) => x.code === 'mechanical-on-floor').map((x) => x.group), ['ci'])
  // the skill's own example, a mechanical lockfile bump at contract, is not reported
  assert.ok(!codes(c).some((x) => x.code === 'mechanical-on-floor' && x.group === 'lock'))
})

test('unknown-serves: names a group that does not exist; "task" is fine', () => {
  const c = repo()
  glossed(c, cleanGroups(c))
  plant(c, cleanGroups(c, { util: { serves: 'ghost' } }))
  const f = codes(c).filter((x) => x.code === 'unknown-serves')
  assert.deepEqual(f.map((x) => x.group), ['util'])
})

test('test-serves-nothing: serves task, nothing, or an unknown group', () => {
  for (const serves of ['task', 'ghost']) {
    const c = repo()
    glossed(c, cleanGroups(c))
    plant(c, cleanGroups(c, { tests: { serves } }))
    assert.deepEqual(codes(c).filter((x) => x.code === 'test-serves-nothing').map((x) => x.group), ['tests'], serves)
  }
})

test('required-but-nothing-breaks: whole-text and leading phrases only', () => {
  const hit = ['Nothing.', 'nothing breaks', 'No effect on users', 'None', 'Nothing would break; it only reads better']
  const miss = ['Nothing else would work', 'none of the callers can parse input', 'Uploads fail on the first 503']
  for (const [texts, expected] of [[hit, ['app']], [miss, []]] as const) {
    for (const t of texts) {
      const c = repo()
      glossed(c, cleanGroups(c, { app: { removal_impact: t } }))
      const got = codes(c).filter((x) => x.code === 'required-but-nothing-breaks').map((x) => x.group)
      assert.deepEqual(got, expected, t)
    }
  }
})

test('missing-risks: careful or above with no risks', () => {
  const c = repo()
  glossed(c, cleanGroups(c), { risks: undefined })
  assert.ok(codes(c).some((x) => x.code === 'missing-risks'))
  const c2 = repo()
  glossed(c2, cleanGroups(c2), { risks: undefined, attention: { level: 'must-read' } })
  assert.ok(codes(c2).some((x) => x.code === 'missing-risks'))
})

test('missing-risks: the boundary is careful; a declared look needs no risks', () => {
  for (const [level, expected] of [['look', false], ['careful', true]] as const) {
    const c = repo()
    glossed(c, cleanGroups(c), { risks: undefined, attention: { level, override_reason: 'boundary test' } })
    assert.equal(codes(c).some((x) => x.code === 'missing-risks'), expected, level)
  }
})

test('uncovered-hunks: a commit whose gloss leaves a hunk out', () => {
  const c = repo()
  glossed(c, cleanGroups(c))
  plant(c, cleanGroups(c).filter((g: any) => g.id !== 'util'))
  const f = codes(c).filter((x) => x.code === 'uncovered-hunks')
  assert.deepEqual(f.map((x) => x.hunk), [c.h('src/util.js')])
})

test('findings do not change the exit code; text output is grouped with a summary; --json has the shape', () => {
  const c = repo()
  glossed(c, cleanGroups(c))
  plant(c, cleanGroups(c, { app: { impact: undefined }, util: { serves: 'ghost' } }))
  const r = lint(c)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /^group app\n {2}no-impact /m)
  assert.match(r.out, /^group util\n {2}unknown-serves /m)
  assert.match(r.out.trim().split('\n').at(-1)!, /^2 findings$/)
  const j = JSON.parse(lint(c, '--json').out)
  assert.match(j.target, /^[0-9a-f]{10}$/)
  for (const f of j.findings) assert.deepEqual(Object.keys(f).filter((k) => !['code', 'group', 'hunk', 'message'].includes(k)), [])
  assert.deepEqual(j.findings.map((f: any) => f.code), ['no-impact', 'unknown-serves'])
})

test('a malformed config makes lint say incomplete, never clean', () => {
  const c = repo()
  glossed(c, cleanGroups(c))
  plant(c, cleanGroups(c, { app: { impact: undefined } }))
  // the config is read from the base branch: commit the broken one on main, then lint the glossed commit
  const sha = c.g('rev-parse', 'HEAD')
  mkdirSync(join(c.dir, '.gloss'), { recursive: true })
  writeFileSync(join(c.dir, '.gloss/config.json'), '{ not json')
  c.g('add', '-A'); c.g('commit', '-qm', 'broken config')
  const lint = (...a: string[]) => run(c.dir, ['lint', sha, ...a])
  const r = lint()
  assert.equal(r.code, 0)
  assert.match(r.err, /signals unavailable/)
  assert.match(r.out, /^incomplete: the rating checks need the diff signals/m)
  assert.doesNotMatch(r.out, /clean/)
  const j = JSON.parse(lint('--json').out)
  assert.equal(j.incomplete, true)
})

test('errors: no gloss and a bad revision exit 1 through GlossError', () => {
  const c = repo()
  const r = run(c.dir, ['lint', 'HEAD'])
  assert.equal(r.code, 1)
  assert.match(r.err, /has no gloss/)
  assert.equal(run(c.dir, ['lint', 'nope-not-a-rev']).code, 1)
  assert.equal(run(c.dir, ['lint', 'HEAD~1..HEAD']).code, 1)
})

test('lint wip: the snapshot of uncommitted work', () => {
  const c = repo()
  writeFileSync(join(c.dir, 'src/app.js'), 'run3()\n')
  assert.equal(run(c.dir, ['hunks', 'wip']).code, 0)
  const r = run(c.dir, ['add', 'wip'], JSON.stringify({ task: 't', groups: [grp('app', ['h1'], { impact: undefined })] }))
  assert.equal(r.code, 0, r.err)
  const l = run(c.dir, ['lint', 'wip'])
  assert.equal(l.code, 0, l.err)
  assert.match(l.out, /no-impact/)
})

// Everything printed must be free of control characters other than newline.
const CONTROL = /[\x00-\x09\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩​‎‏﻿]/
test('hostile input: escapes, bidi and prototype-like ids print as text and do not crash', () => {
  const c = repo()
  const sha = c.g('rev-parse', 'HEAD')
  const evil = (s: string) => `${s}\x1b]52;c;cHduZWQ=\x07\x1b[2J‮​x`
  glossed(c, cleanGroups(c))
  const note = JSON.parse(c.g('notes', '--ref', 'refs/notes/gloss', 'show', sha))
  const h = c.h
  const groups = [
    { id: 'constructor', hunks: [h('package-lock.json')], intent: 'i', necessity: 'required', serves: evil('ghost'), removal_impact: evil('Nothing'), impact: 'module' },
    { id: 'proto', hunks: [h('ci.yml'), h('src/app.js'), h('src/util.js'), h('test/app.test.js')], intent: 'i', necessity: 'required', serves: ['__proto__', 'constructor'], removal_impact: evil('Nothing breaks'), impact: 'local' },
  ]
  const file = join(tmp('plant-'), 'g.json')
  writeFileSync(file, JSON.stringify({ ...note, annotation: { task: 't', groups } }))
  c.g('notes', '--ref', 'refs/notes/gloss', 'add', '-f', '-F', file, sha)
  for (const args of [[], ['--json']]) {
    const r = lint(c, ...args)
    assert.equal(r.code, 0, r.err)
    assert.doesNotMatch(r.out.replace(/\n/g, '') + r.err, CONTROL)
    assert.doesNotMatch(r.err, /at .*\.ts:\d+/, 'no stack trace')
    assert.match(r.out, /unknown-serves/)
    assert.match(r.out, /__proto__/)
  }
})

test('a group id with an escape sequence is refused by the reader, not echoed', () => {
  const c = repo()
  const sha = c.g('rev-parse', 'HEAD')
  const groups = [{ id: 'a\x1b]52;c;x\x07b', hunks: ['h1'], intent: 'i', necessity: 'required', serves: 'task', removal_impact: 'r' }]
  const file = join(tmp('plant-'), 'g.json')
  writeFileSync(file, JSON.stringify({ gloss: 4, hunks: [], annotation: { task: 't', groups } }))
  c.g('notes', '--ref', 'refs/notes/gloss', 'add', '-f', '-F', file, sha)
  const r = lint(c)
  assert.equal(r.code, 1)
  assert.doesNotMatch(r.out + r.err, /\x1b/)
})

test('config-edit: a change that edits .gloss/config.json says it is rated with the base config', () => {
  const c = repo()
  mkdirSync(join(c.dir, '.gloss'), { recursive: true })
  writeFileSync(join(c.dir, '.gloss/config.json'), '{}\n')
  c.g('add', '-A'); c.g('commit', '-qm', 'config edit')
  const hunk = run(c.dir, ['hunks', 'HEAD']).out.match(/^(h\d+)\s+\.gloss\/config\.json\s/m)![1]
  glossed(c, [grp('cfg', [hunk], { impact: 'shared', impact_reason: 'root config' })])
  const f = codes(c).filter((x) => x.code === 'config-edit')
  assert.equal(f.length, 1)
  assert.equal(f[0].group, undefined)
  assert.match((f[0] as any).message, /config\.json is edited here; this change is rated with the base branch's config/)
  assert.match(lint(c).out, /^whole gloss\n {2}config-edit +.*config\.json is edited here/m)
  // advisory like the rest
  assert.equal(lint(c).code, 0)
  // and not reported when the change leaves the config alone
  const c2 = repo()
  glossed(c2, cleanGroups(c2))
  assert.ok(!codes(c2).some((x) => x.code === 'config-edit'))
})
