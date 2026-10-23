import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, noteFormat } from '../src/schema.ts'
import { combineAttention } from '../src/attention.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'attn-test-'))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const write = (file: string, lines: string[]) => writeFileSync(join(dir, file), lines.join('\n') + '\n')
  const commit = (msg: string, groups?: object[], attention?: object) => {
    g('add', '-A')
    g('commit', '-qm', msg)
    if (groups) {
      const r = gloss(dir, ['add'], JSON.stringify({ task: msg, groups, ...(attention ? { attention } : {}) }))
      assert.equal(r.code, 0, r.err)
    }
    return g('rev-parse', 'HEAD')
  }
  write('app.js', ['function main() {', '  run()', '}'])
  write('util.js', ['export const a = 1'])
  commit('base')
  return { dir, g, write, commit }
}

const group = (id: string, hunks: string[], extra: object = {}) =>
  ({ id, hunks, intent: `${id} intent`, necessity: 'required', serves: 'task', removal_impact: `no ${id}`, ...extra })

const noteOf = (dir: string, rev = 'HEAD') => JSON.parse(execFileSync('git', ['notes', '--ref', 'gloss', 'show', rev], { cwd: dir, encoding: 'utf8' }))

// Two hunks (one per file), glossed with impact and attention.
function rated() {
  const r = repo()
  r.write('app.js', ['function main() {', '  run()', '  log()', '}'])
  r.write('util.js', ['export const a = 2'])
  r.commit('change both', [
    group('quiet', ['h1'], { impact: 'local', necessity: 'mechanical' }),
    group('risky', ['h2'], { impact: 'sensitive', impact_reason: 'writes to the device' }),
  ], { level: 'careful', focus: ['risky', 'quiet'], reasons: ['device write'] })
  return r
}

const base = { task: 't', groups: [group('a', ['h1'])] }

test('the schema accepts impact and attention and rejects bad values', () => {
  const ok = (extra: object) => Annotation.safeParse({ ...base, ...extra }).success
  assert.ok(ok({}))
  assert.ok(ok({ groups: [group('a', ['h1'], { impact: 'contract', impact_reason: 'public API' })] }))
  assert.ok(ok({ attention: { level: 'must-read', focus: ['a'], reasons: ['x'], override_reason: 'y' } }))
  assert.ok(!ok({ groups: [group('a', ['h1'], { impact: 'huge' })] }), 'bad impact')
  assert.ok(!ok({ groups: [group('a', ['h1'], { impact_reason: 'x'.repeat(121) })] }), 'long reason')
  assert.ok(!ok({ attention: { level: 'urgent' } }), 'bad level')
  assert.ok(!ok({ attention: { level: 'look', focus: ['a', 'b', 'c', 'd'] } }), 'more than 3 focus groups')
  assert.ok(!ok({ attention: { level: 'look', focus: [] } }), 'empty focus')
})

test('add refuses a focus group that does not exist, or is repeated', () => {
  const { dir, write, g } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  g('add', '-A'); g('commit', '-qm', 'x')
  const add = (attention: object) => gloss(dir, ['add', '--dry-run'], JSON.stringify({ task: 't', groups: [group('a', ['h1'])], attention }))
  let r = add({ level: 'look', focus: ['nope'] })
  assert.equal(r.code, 1)
  assert.match(r.err, /attention\.focus names unknown group "nope"/)
  r = add({ level: 'look', focus: ['a', 'a'] })
  assert.match(r.err, /lists a group twice/)
  r = add({ level: 'look', focus: ['a', 'b', 'c', 'd'] })
  assert.match(r.err, /schema/)
  assert.equal(add({ level: 'look', focus: ['a'] }).code, 0)
})

test('a note is format 4 only when it uses the new fields', () => {
  const a = (extra: object, g: object = {}) => Annotation.parse({ task: 't', groups: [group('a', ['h1'], g)], ...extra })
  assert.equal(noteFormat(a({})), 1)
  assert.equal(noteFormat(a({}, { hunks: ['h1:1-2'] })), 2)
  assert.equal(noteFormat(a({}, { serves: ['x', 'y'] })), 3)
  assert.equal(noteFormat(a({}, { impact: 'local' })), 4)
  assert.equal(noteFormat(a({}, { impact_reason: 'r' })), 4)
  assert.equal(noteFormat(a({ attention: { level: 'skim' } })), 4)

  const { dir, write, g } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  write('util.js', ['export const a = 2'])
  g('add', '-A'); g('commit', '-qm', 'x')
  const plain = JSON.stringify({ task: 't', groups: [group('a', ['h1']), group('b', ['h2'])] })
  assert.equal(gloss(dir, ['add'], plain).code, 0)
  assert.equal(noteOf(dir).gloss, 1)
  const fmt3 = JSON.stringify({ task: 't', groups: [group('a', ['h1']), group('b', ['h2'], { serves: 'task' }), group('s', ['h2'], { necessity: 'supporting', serves: ['a', 'b'] })] })
  assert.equal(gloss(dir, ['add', '--force'], fmt3).code, 0)
  assert.equal(noteOf(dir).gloss, 3, 'an existing format-3 gloss still writes as 3')
  const withImpact = JSON.stringify({ task: 't', groups: [group('a', ['h1'], { impact: 'module' }), group('b', ['h2'])] })
  assert.equal(gloss(dir, ['add', '--force'], withImpact).code, 0)
  assert.equal(noteOf(dir).gloss, 4)
})

test('a glossed commit without attention shows as unrated', () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  write('util.js', ['export const a = 2'])
  commit('plain', [group('a', ['h1', 'h2'])])
  const r = gloss(dir, ['show'])
  assert.match(r.out, /attention: unrated/)
  assert.doesNotMatch(r.out, /\[(local|module|shared|contract|sensitive)\]/)
  assert.match(r.out, /^ {2}required {2,}a {2}/m, 'rows have no impact column')
})

test('show leads with the attention, badges groups, and --sort / --only take impact', () => {
  const { dir } = rated()
  let r = gloss(dir, ['show'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /attention: CAREFUL · focus: risky, quiet/)
  assert.match(r.out, /• device write/)
  const rows = r.out.split('\n').filter((l) => /^ {2}(required|mechanical) /.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 3))
  assert.deepEqual(rows, [['required', '[sensitive]', 'risky'], ['mechanical', '[local]', 'quiet']])

  r = gloss(dir, ['show', '--sort', 'impact'])
  const order = r.out.split('\n').filter((l) => /^ {2}(required|mechanical) /.test(l)).map((l) => l.trim().split(/\s+/)[2])
  assert.deepEqual(order, ['risky', 'quiet'])
  assert.equal(gloss(dir, ['show', '--sort', 'size']).code, 2)

  r = gloss(dir, ['show', '--only', 'local'])
  assert.match(r.out, /^ {2}mechanical .*quiet/m); assert.doesNotMatch(r.out, /^ {2}required/m)
  r = gloss(dir, ['show', '--only', 'sensitive,contract'])
  assert.match(r.out, /^ {2}required .*risky/m); assert.doesNotMatch(r.out, /^ {2}mechanical/m)
  r = gloss(dir, ['show', '--only', 'required,sensitive'])
  assert.match(r.out, /^ {2}required .*risky/m); assert.doesNotMatch(r.out, /^ {2}mechanical/m)
  r = gloss(dir, ['show', '--only', 'mechanical,sensitive'])
  assert.equal(r.code, 1, 'no group is both')
  r = gloss(dir, ['show', '--only', 'huge'])
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown necessity or impact huge/)

  r = gloss(dir, ['show', '-g', 'risky'])
  assert.match(r.out, /\[required\] \[sensitive\] risky intent/)
  assert.match(r.out, /impact: writes to the device/)
})

test('html shows the attention banner, focus links and impact badges', () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  const html = readFileSync(out, 'utf8')
  const page = JSON.parse(/<script type="application\/json" id="gloss-data">(.*?)<\/script>/s.exec(html)![1])
  const c = page.commits[0]
  assert.deepEqual(c.attention, { level: 'careful', focus: ['risky', 'quiet'], reasons: ['device write'] })
  assert.deepEqual(c.groups.map((g: { id: string; impact: string }) => [g.id, g.impact]), [['risky', 'sensitive'], ['quiet', 'local']])
  assert.equal(c.groups[0].impact_reason, 'writes to the device')
  assert.deepEqual(page.impact.map((i: { name: string }) => i.name), ['local', 'module', 'shared', 'contract', 'sensitive'])
  // The client turns these into the banner, the badge and the jump links.
  assert.match(html, /function attentionBanner/)
  assert.match(html, /look here first: /)
  assert.match(html, /levelBadge\('impact', g\.impact\)/)
  assert.match(html, /--impact-sensitive/)
})

test('html data marks a gloss without attention as unrated', () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  write('util.js', ['export const a = 2'])
  commit('plain', [group('a', ['h1', 'h2'])])
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  const html = readFileSync(out, 'utf8')
  const page = JSON.parse(/<script type="application\/json" id="gloss-data">(.*?)<\/script>/s.exec(html)![1])
  assert.equal(page.commits[0].attention, null)
  assert.equal(page.commits[0].groups[0].impact, undefined)
})

test('combineAttention takes the highest level, ranks focus by impact, and unions reasons', () => {
  const groups = [group('a', []), group('b', [], { impact: 'contract' }), group('c', [], { impact: 'sensitive' }), group('d', [], { impact: 'contract' })] as never[]
  const merged = combineAttention(
    [{ level: 'look', focus: ['a', 'b'], reasons: ['r1'] }, { level: 'must-read', focus: ['c', 'd', 'b'], reasons: ['r1', 'r2'] }],
    (_, id) => id, groups)!
  assert.equal(merged.level, 'must-read')
  assert.deepEqual(merged.focus, ['c', 'b', 'd'], 'highest impact first, ties in order, deduplicated, at most 3')
  assert.deepEqual(merged.reasons, ['r1', 'r2'])
  const renamed = combineAttention([{ level: 'skim', focus: ['b'] }], (_, id) => (id === 'b' ? undefined : id), groups)!
  assert.equal(renamed.focus, undefined, 'a focus group that is gone is dropped')
})

test('squashing takes the highest attention, ranks focus by impact and maps renamed groups', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  log()', '}'])
  commit('one', [group('logging', ['h1'], { impact: 'module' })], { level: 'look', focus: ['logging'], reasons: ['new log'] })
  write('util.js', ['export const a = 2'])
  commit('two', [group('logging', ['h1'], { impact: 'sensitive', impact_reason: 'device write' })], { level: 'must-read', focus: ['logging'], reasons: ['device'] })
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')

  const r = gloss(dir, ['carry', 'main~1..feat'])
  assert.equal(r.code, 0, r.err)
  const note = noteOf(dir)
  assert.equal(note.gloss, 4)
  const ids = note.annotation.groups.map((x: { id: string }) => x.id)
  assert.deepEqual(ids, ['logging-1', 'logging-2'], 'clashing ids are renamed')
  assert.equal(note.annotation.attention.level, 'must-read')
  assert.deepEqual(note.annotation.attention.focus, ['logging-2', 'logging-1'], 'most impactful first, ids follow the renames')
  assert.deepEqual(note.annotation.attention.reasons, ['new log', 'device'])
  assert.deepEqual(note.annotation.groups.map((x: { impact: string }) => x.impact), ['module', 'sensitive'])
  assert.equal(gloss(dir, ['show']).code, 0)
})

test('carrying a wip gloss keeps the attention and drops focus groups left behind', () => {
  const { dir, write, g } = repo()
  write('app.js', ['function main() {', '  run()', '  log()', '}'])
  write('util.js', ['export const a = 2'])
  assert.equal(gloss(dir, ['hunks', 'wip']).code, 0)
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({
    task: 't', groups: [group('x', ['h1'], { impact: 'contract', impact_reason: 'api' }), group('y', ['h2'], { impact: 'local' })],
    attention: { level: 'careful', focus: ['y', 'x'] },
  })).code, 0)
  g('checkout', '-q', 'app.js')
  const r = gloss(dir, ['hunks', 'wip'])
  assert.equal(r.code, 0, r.err)
  const show = gloss(dir, ['show', 'wip'])
  assert.match(show.out, /attention: CAREFUL · focus: y\n/)
  assert.doesNotMatch(show.out, /\bx\b.*intent/)
})

test('combineAttention keeps an override_reason only from parts at the combined level', () => {
  const groups = [group('a', [])] as never[]
  const merged = combineAttention(
    [{ level: 'skim', override_reason: 'mostly renames' }, { level: 'must-read' }], (_, id) => id, groups)!
  assert.equal(merged.level, 'must-read')
  assert.equal(merged.override_reason, undefined, 'a lower level was discarded, and so is its excuse')
  const both = combineAttention(
    [{ level: 'look', override_reason: 'x' }, { level: 'look', override_reason: 'y' }, { level: 'skim', override_reason: 'z' }], (_, id) => id, groups)!
  assert.equal(both.override_reason, 'x; y')
})

test('squashing a rated commit with an unrated one leaves the squash unrated', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  log()', '}'])
  commit('one', [group('logging', ['h1'], { impact: 'local' })], { level: 'skim', focus: ['logging'] })
  write('util.js', ['export const a = 2'])
  commit('two', [group('logic', ['h1'])])
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')

  const r = gloss(dir, ['carry', 'main~1..feat'])
  assert.equal(r.code, 0, r.err)
  assert.equal(noteOf(dir).annotation.attention, undefined, 'an unrated source makes the combined gloss unrated')
  assert.match(gloss(dir, ['show']).out, /attention: unrated/)
})
