import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

// A repo whose commits can be glossed as they're made.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'carry-test-'))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const write = (file: string, lines: string[]) => writeFileSync(join(dir, file), lines.join('\n') + '\n')
  const commit = (msg: string, groups?: object[], task = msg) => {
    g('add', '-A')
    g('commit', '-qm', msg)
    if (groups) {
      const r = gloss(dir, ['add'], JSON.stringify({ task, groups }))
      assert.equal(r.code, 0, r.err)
    }
    return g('rev-parse', 'HEAD')
  }
  write('app.js', ['function main() {', '  run()', '}'])
  commit('base')
  return { dir, g, write, commit }
}

const group = (id: string, hunks: string[], extra: object = {}) =>
  ({ id, hunks, intent: `${id} intent`, necessity: 'required', serves: 'task', removal_impact: `no ${id}`, ...extra })

const noteOf = (dir: string, rev = 'HEAD') => JSON.parse(execFileSync('git', ['notes', '--ref', 'gloss', 'show', rev], { cwd: dir, encoding: 'utf8' }))
const groupsOf = (dir: string, rev = 'HEAD') =>
  Object.fromEntries(noteOf(dir, rev).annotation.groups.map((x: { id: string; hunks: string[] }) => [x.id, x.hunks]))

test('a squash takes each line\'s group from the commit that last wrote it', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  log("v1")', '}'])
  write('util.js', ['export const helper = 1'])
  commit('one', [group('logging', ['h1']), group('helper', ['h2'])])
  write('app.js', ['function main() {', '  run()', '  log("v2")', '}'])
  commit('two', [group('better-log', ['h1'])])
  g('rm', '-q', 'util.js')
  write('test.js', ['test(main)'])
  commit('three', [group('drop-helper', ['h2']), group('tests', ['h1'], { necessity: 'supporting', serves: 'drop-helper' })])
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')

  const r = gloss(dir, ['carry', 'main~1..feat'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /carried 2 groups from [0-9a-f]{7}, [0-9a-f]{7} onto/)
  // logging's v1 line was rewritten by two; helper's file was emptied by three
  // and drop-helper's change (removing a line the base never had) is gone too.
  assert.match(r.out, /no change left in [0-9a-f]{7}: [0-9a-f]{7}:logging, [0-9a-f]{7}:helper, [0-9a-f]{7}:drop-helper/)
  assert.deepEqual(groupsOf(dir), { 'better-log': ['h1'], tests: ['h2'] })
  const note = noteOf(dir)
  assert.equal(note.annotation.task, 'two; three')
  // tests served drop-helper, which kept nothing; it now serves the task and says so.
  const tests = note.annotation.groups.find((x: { id: string }) => x.id === 'tests')
  assert.equal(tests.serves, 'task')
  assert.match(tests.notes, /also served drop-helper, which has no change left here/)
  assert.match(tests.notes, /\(from [0-9a-f]{7}\)/)
  assert.equal(note.sources.length, 2)
})

test('lines changed while combining are reported, never guessed', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  const source = commit('add stop', [group('stop', ['h1'])])
  g('checkout', '-q', 'main')
  write('app.js', ['function main() {', '  run()', '  stop() // edited', '}'])
  commit('picked by hand')
  const r = gloss(dir, ['carry', source])
  assert.equal(r.code, 1)
  assert.match(r.out, /none of its changes match/)
  assert.equal(spawnSync('git', ['notes', '--ref', 'gloss', 'list', 'HEAD'], { cwd: dir }).status, 1, 'no note written')
})

test('a partly matching target gets the matched lines and a list of gaps', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  stop()', '  done()', '}'])
  const source = commit('add stop and done', [group('stop', ['h1'])])
  g('checkout', '-q', 'main')
  write('app.js', ['function main() {', '  run()', '  stop()', '  finish()', '}'])
  commit('picked with an edit')
  const r = gloss(dir, ['carry', source])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { stop: ['h1:1'] })
  assert.match(r.out, /not explained by the sources[^\n]*: h1:2/)
})

test('a cherry-pick onto a different base keeps the whole gloss', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '}', '', 'function extra() {', '  return 1', '}'])
  const source = commit('add extra', [group('extra', ['h1'])])
  g('checkout', '-q', 'main')
  write('app.js', ['// header', '', 'function main() {', '  run()', '}'])
  commit('main moves on')
  g('cherry-pick', source)
  const r = gloss(dir, ['carry', source])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { extra: ['h1'] })
})

test('repeated lines are shared out, and clashing ids get the source\'s position', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '}', 'function a() {', '}'])
  commit('a', [group('fn', ['h1'])])
  write('app.js', ['function main() {', '  run()', '}', 'function a() {', '}', 'function b() {', '}'])
  commit('b', [group('fn', ['h1'])])
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')
  const r = gloss(dir, ['carry', 'main~1..feat'])
  assert.equal(r.code, 0, r.err)
  // Four added lines, two "}": each function's group gets one.
  assert.deepEqual(groupsOf(dir), { 'fn-1': ['h1:1-2'], 'fn-2': ['h1:3-4'] })
})

test('lines follow a file renamed later in the branch', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('old.js', ['export const one = 1', 'export const two = 2', 'export const three = 3'])
  commit('add', [group('module', ['h1'])])
  g('mv', 'old.js', 'new.js')
  write('new.js', ['export const one = 1', 'export const two = 2', 'export const three = 3', 'export const four = 4'])
  commit('rename and extend', [group('four', ['h1'])])
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')
  const r = gloss(dir, ['carry', 'main~1..feat'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { module: ['h1:1-3'], four: ['h1:4'] })
})

test('carry won\'t replace a hand-written gloss without --force, but replaces joined notes and carried glosses', () => {
  const { dir, g, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const one = commit('one', [group('one', ['h1'])])
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  const two = commit('two', [group('two', ['h1'])])
  g('reset', '-q', '--soft', 'HEAD~2')
  commit('both')
  // What notes.rewriteMode=concatenate leaves after a squash.
  g('notes', '--ref', 'gloss', 'add', '-f', '-m', JSON.stringify(noteOf(dir, one)) + '\n\n' + JSON.stringify(noteOf(dir, two)), 'HEAD')
  let r = gloss(dir, ['carry', one, two])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { one: ['h1:1'], two: ['h1:2'] })
  // A carried gloss is replaced freely; a hand-written one needs --force.
  assert.equal(gloss(dir, ['carry', one, two]).code, 0)
  assert.equal(gloss(dir, ['add', '--force'], JSON.stringify({ task: 'by hand', groups: [group('mine', ['h1'])] })).code, 0)
  r = gloss(dir, ['carry', one, two])
  assert.equal(r.code, 1)
  assert.match(r.err, /already has a gloss; pass --force/)
  assert.equal(gloss(dir, ['carry', one, two, '--force']).code, 0)
})

test('a carried gloss can be replaced by a fresh one without --force', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const source = commit('one', [group('one', ['h1'])])
  g('checkout', '-q', 'main')
  write('other.js', ['x'])
  commit('main moves on')
  g('cherry-pick', source)
  assert.equal(gloss(dir, ['carry', source]).code, 0)
  const r = gloss(dir, ['add'], JSON.stringify({ task: 'fresh', groups: [group('fresh', ['h1'])] }))
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { fresh: ['h1'] })
})

test('a source gloss copied onto a changed commit is read by content, not by hunk position', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('zeta.js', ['export const z = 1'])
  const s1 = commit('zeta', [group('zz', ['h1'])])
  g('checkout', '-q', 'main')
  write('aaa.js', ['export const a = 1'])
  write('zeta.js', ['export const z = 1'])
  const s2 = commit('aaa and zeta')
  // As notes.rewriteRef does when a rebase changes a commit's diff: S1's gloss
  // (zz is h1) on S2, where h1 is now aaa.js and zeta.js is h2.
  g('notes', '--ref', 'gloss', 'copy', s1, s2)
  g('checkout', '-q', '-b', 'other', 'main~1')
  write('other.js', ['x'])
  commit('elsewhere')
  g('cherry-pick', s2)
  const r = gloss(dir, ['carry', s2])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { zz: ['h2'] })
  assert.match(r.out, /not explained by the sources[^\n]*: h1/)
})

test('a source whose gloss can\'t be read is named, not passed off as unglossed changes', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const one = commit('one', [group('one', ['h1'])])
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  const two = commit('two', [group('two', ['h1'])])
  g('notes', '--ref', 'gloss', 'add', '-f', '-m', 'not json', one)
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')
  const r = gloss(dir, ['carry', one, two])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, new RegExp(`skipped sources whose gloss can't be read: ${one.slice(0, 7)} \\(is not valid JSON`))
  assert.match(r.out, /never glossed, or in a skipped source\): h1:1/)
})

// A repo with git-gloss's hooks installed, running this checkout's git-gloss.
function hooked() {
  const r = repo()
  const bin = mkdtempSync(join(tmpdir(), 'gloss-bin-'))
  writeFileSync(join(bin, 'git-gloss'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_EDITOR: 'true' }
  const run = (...args: string[]) => {
    const p = spawnSync('git', args, { cwd: r.dir, env, encoding: 'utf8' })
    assert.equal(p.status, 0, p.stderr)
    return p.stdout + p.stderr
  }
  assert.equal(spawnSync(process.execPath, [BIN, 'init', '--hooks'], { cwd: r.dir, env }).status, 0)
  return { ...r, run, env }
}

test('a rebase that squashes and fixes up glossed commits combines their glosses', () => {
  const { dir, g, write, commit, run } = hooked()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  commit('one', [group('one', ['h1'])])
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  commit('two', [group('two', ['h1'])])
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '  three()', '}'])
  commit('three', [group('three', ['h1'])])
  run('-c', 'sequence.editor=sed -i \'2s/^pick/fixup/;3s/^pick/squash/\'', 'rebase', '-i', 'main')
  assert.equal(g('rev-list', '--count', 'main..HEAD'), '1')
  assert.deepEqual(groupsOf(dir), { one: ['h1:1'], two: ['h1:2'], three: ['h1:3'] })
  assert.equal(gloss(dir, ['show']).code, 0)
})

test('an amend that changes a glossed commit\'s diff keeps the gloss for the unchanged lines', () => {
  const { dir, g, write, commit, run } = hooked()
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  commit('one', [group('one', ['h1'])])
  const before = noteOf(dir).created_at
  run('commit', '-q', '--amend', '-m', 'one, reworded')
  assert.equal(noteOf(dir).created_at, before, 'a message-only amend keeps the copied gloss as it is')
  write('app.js', ['function main() {', '  run()', '  one()', '  extra()', '}'])
  g('add', '-A')
  const out = run('commit', '-q', '--amend', '--no-edit')
  assert.deepEqual(groupsOf(dir), { one: ['h1:1'] })
  assert.match(out, /git-gloss: carried 1 group[\s\S]*not explained by the sources[^\n]*: h1:2/)
})

test('a cherry-pick takes its gloss along, with or without -x', () => {
  const { dir, g, write, commit, run } = hooked()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const one = commit('one', [group('one', ['h1'])])
  write('extra.js', ['x'])
  const two = commit('two', [group('two', ['h1'])])
  g('checkout', '-q', 'main')
  write('other.js', ['y'])
  commit('main moves on')
  let out = run('cherry-pick', one)
  assert.match(out, /git-gloss: carried 1 group from/)
  assert.deepEqual(groupsOf(dir), { one: ['h1'] })
  out = run('cherry-pick', '-x', two)
  assert.deepEqual(groupsOf(dir), { two: ['h1'] })
})

test('a squash merge keeping git\'s message is glossed on commit; any other is found with --find --squash', () => {
  const { dir, g, write, commit, run } = hooked()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  commit('one', [group('one', ['h1'])])
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  commit('two', [group('two', ['h1'])])
  g('checkout', '-q', 'main')
  run('merge', '-q', '--squash', 'feat')
  run('commit', '-q')
  assert.deepEqual(groupsOf(dir), { one: ['h1:1'], two: ['h1:2'] })

  // Undo it, gloss and all: the same change by the same author in the same
  // second would otherwise be found as a cherry-pick of it.
  g('notes', '--ref', 'gloss', 'remove', 'HEAD')
  g('reset', '-q', '--hard', 'HEAD~1')
  run('merge', '-q', '--squash', 'feat')
  run('commit', '-q', '-m', 'Add one and two (#12)')
  assert.equal(spawnSync('git', ['notes', '--ref', 'gloss', 'list', 'HEAD'], { cwd: dir }).status, 1, 'nothing to go on at commit time')
  let r = gloss(dir, ['carry', '--find'])
  assert.match(r.out, /found no glossed commits[^\n]*add --squash/)
  r = gloss(dir, ['carry', '--find', '--squash'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { one: ['h1:1'], two: ['h1:2'] })
})

test('--find recognises commits a server rebased (same author and author date, same changes)', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  commit('one', [group('one', ['h1'])])
  g('checkout', '-q', 'main')
  write('other.js', ['y'])
  commit('main moves on')
  // As GitHub's "Rebase and merge" does: a new committer and date, same author.
  execFileSync('git', ['cherry-pick', 'feat'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' } })
  const r = gloss(dir, ['carry', '--find'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { one: ['h1'] })
})

test('sync glosses a squash merge made on the server and shares it', () => {
  const origin = mkdtempSync(join(tmpdir(), 'carry-origin-'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const { dir, g, write, commit } = repo()
  g('remote', 'add', 'origin', origin)
  g('push', '-q', '-u', 'origin', 'main')
  assert.equal(gloss(dir, ['init']).code, 0)
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  commit('one', [group('one', ['h1'])])
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  commit('two', [group('two', ['h1'])])
  g('push', '-q', 'origin', 'feat')
  assert.equal(gloss(dir, ['sync']).code, 0)

  // The server: squash the branch onto main with its own message, delete the branch.
  const server = mkdtempSync(join(tmpdir(), 'carry-server-'))
  execFileSync('git', ['clone', '-q', origin, server])
  const s = (...args: string[]) => execFileSync('git', ['-c', 'user.name=GitHub', '-c', 'user.email=gh@example.com', ...args], { cwd: server, stdio: 'pipe' })
  s('merge', '-q', '--squash', 'origin/feat')
  s('commit', '-qm', 'Add one and two (#7)')
  s('push', '-q', 'origin', 'main', ':feat')

  g('fetch', '-q', '--prune')
  const r = gloss(dir, ['sync'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /carried 2 groups from [0-9a-f]{7}, [0-9a-f]{7} onto/)
  const squash = g('rev-parse', 'origin/main')
  assert.deepEqual(groupsOf(dir, squash), { one: ['h1:1'], two: ['h1:2'] })
  // It was pushed: a fresh clone that fetches glosses sees it.
  s('fetch', '-q', 'origin', 'refs/notes/gloss:refs/notes/gloss')
  assert.deepEqual(groupsOf(server, squash), { one: ['h1:1'], two: ['h1:2'] })
  // A second sync checks nothing again.
  assert.doesNotMatch(gloss(dir, ['sync']).out, /carried/)
})

test('versions lists every gloss a commit has had, and restores one', () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  commit('one', [group('first', ['h1'])])
  assert.equal(gloss(dir, ['add', '--force'], JSON.stringify({ task: 'second', groups: [group('second', ['h1'])] })).code, 0)
  let r = gloss(dir, ['versions'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /  1 [^\n]*\[current\]\n\s+1 group: second[\s\S]*  2 [^\n]*\n\s+1 group: first/)
  assert.match(gloss(dir, ['versions', '--show', '2']).out, /"id": "first"/)
  r = gloss(dir, ['versions', '--restore', '2'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(groupsOf(dir), { first: ['h1'] })
  assert.match(gloss(dir, ['versions', '--restore', '9']).err, /from 1 to 3/)
})

test('a wip group dropped by a new snapshot can be restored, even after git gc', () => {
  const { dir, g, write } = repo()
  write('app.js', ['function main() {', '  run()', '  keep()', '}'])
  write('extra.js', ['export const extra = 1'])
  gloss(dir, ['hunks', 'wip'])
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({ task: 't', groups: [group('keep', ['h1']), group('extra', ['h2'])] })).code, 0)
  // Rewrite extra.js: its group can't carry over to the new snapshot.
  write('extra.js', ['export const extra = 2'])
  assert.match(gloss(dir, ['hunks', 'wip']).err, /not kept[^\n]*extra/)
  // Put it back (with another change, so this snapshot can't be identical to
  // the first), take a new snapshot, and collect garbage hard.
  write('extra.js', ['export const extra = 1'])
  write('other.js', ['export const other = 1'])
  gloss(dir, ['hunks', 'wip'])
  g('reflog', 'expire', '--expire=now', '--all')
  g('gc', '-q', '--prune=now')
  const r = gloss(dir, ['versions', 'wip'])
  // Each version is a numbered line followed by its summary.
  const m = /^\s+(\d+) [^\n]*\n\s+2 groups: keep, extra/m.exec(r.out)
  assert.ok(m, r.out)
  const n = Number(m[1])
  const restored = gloss(dir, ['versions', 'wip', '--restore', String(n)])
  assert.equal(restored.code, 0, restored.err)
  assert.match(restored.out, /restored 2 groups/)
  assert.match(gloss(dir, ['show', 'wip']).out, /extra/)
})

test('the gloss that loses a sync conflict is still listed by versions', () => {
  const origin = mkdtempSync(join(tmpdir(), 'carry-origin-'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const a = repo()
  a.write('app.js', ['function main() {', '  run()', '  one()', '}'])
  a.commit('one', [group('first', ['h1'])])
  a.g('remote', 'add', 'origin', origin)
  a.g('push', '-q', '-u', 'origin', 'main')
  assert.equal(gloss(a.dir, ['sync']).code, 0)
  const b = mkdtempSync(join(tmpdir(), 'carry-b-'))
  execFileSync('git', ['clone', '-q', origin, b])
  execFileSync('git', ['config', 'user.email', 'b@example.com'], { cwd: b })
  execFileSync('git', ['config', 'user.name', 'B'], { cwd: b })
  assert.equal(gloss(b, ['sync']).code, 0)
  // Both re-gloss the same commit; B's is newer and wins.
  assert.equal(gloss(a.dir, ['add', '--force'], JSON.stringify({ task: 'a', groups: [group('from-a', ['h1'])] })).code, 0)
  execFileSync('sleep', ['1'])
  assert.equal(gloss(b, ['add', '--force'], JSON.stringify({ task: 'b', groups: [group('from-b', ['h1'])] })).code, 0)
  assert.equal(gloss(b, ['sync']).code, 0)
  assert.match(gloss(a.dir, ['sync']).out, /kept theirs \(newer\)/)
  assert.deepEqual(groupsOf(a.dir), { 'from-b': ['h1'] })
  const r = gloss(a.dir, ['versions'])
  assert.match(r.out, /1 group: from-b[\s\S]*1 group: from-a[\s\S]*1 group: first/)
})

test('an unrelated commit that repeats some of a glossed branch\'s lines is not taken for a squash of it', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '}', 'function helper() {', '  return null', '}'])
  commit('helper', [group('helper', ['h1'])])
  g('checkout', '-q', 'main')
  write('app.js', ['function main() {', '  run()', '}', 'function other() {', '  return null', '}'])
  commit('other')
  const r = gloss(dir, ['carry', '--find', '--squash'])
  assert.match(r.out, /found no glossed commits/)
  assert.equal(spawnSync('git', ['notes', '--ref', 'gloss', 'list', 'HEAD'], { cwd: dir }).status, 1)
})

test('versions ignores git moving notes into fan-out directories', () => {
  const { dir, g, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  commit('one', [group('first', ['h1'])])
  // Enough notes that git splits the notes tree into ab/cdef… directories.
  const blobs = execFileSync('sh', ['-c', 'for i in $(seq 1 300); do echo "blob $i" | git hash-object -w --stdin; done'], { cwd: dir, encoding: 'utf8' }).trim().split('\n')
  for (const b of blobs) g('notes', '--ref', 'gloss', 'add', '-m', '{}', b)
  assert.ok(g('ls-tree', '--name-only', 'refs/notes/gloss').split('\n').some((p) => p.length === 2), 'the notes tree has fanned out')
  const r = gloss(dir, ['versions'])
  assert.equal(r.out.split('\n').filter((l) => /^\s+\d+ {2}\d{4}-/.test(l)).length, 1, r.out)
  assert.doesNotMatch(r.out, /removed/)
})

test('sync checks a commit again once the glosses it came from arrive', () => {
  const origin = mkdtempSync(join(tmpdir(), 'carry-origin-'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const { dir, g, write, commit } = repo()
  write('base.js', ['x'])
  commit('something glossed', [group('base', ['h1'])])
  g('remote', 'add', 'origin', origin)
  g('push', '-q', '-u', 'origin', 'main')
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const one = commit('one')
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('Add one (#3)')
  g('push', '-q', 'origin', 'main')
  g('fetch', '-q')
  assert.doesNotMatch(gloss(dir, ['sync']).out, /carried/, 'nothing to carry yet')
  assert.equal(gloss(dir, ['add', one], JSON.stringify({ task: 'one', groups: [group('one', ['h1'])] })).code, 0)
  const r = gloss(dir, ['sync'])
  assert.match(r.out, /carried 1 group from/)
  assert.deepEqual(groupsOf(dir), { one: ['h1'] })
})
