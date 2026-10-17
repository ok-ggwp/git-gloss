import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDiff } from '../src/diff.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gloss-test-'))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.js'), ['function upload(f) {', '  return send(f)', '}', ''].join('\n'))
  g('add', '.'); g('commit', '-qm', 'initial')
  writeFileSync(join(dir, 'app.js'), [
    'function upload(f) {',
    '  return retry(() => send(f), MAX_RETRIES)',
    '}', '',
  ].join('\n'))
  writeFileSync(join(dir, 'config.js'), 'export const MAX_RETRIES = 3\n')
  g('add', '.'); g('commit', '-qm', 'add retry')
  return dir
}

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const annotation = (groups: unknown[]) => JSON.stringify({ task: 'Retry uploads on failure', groups })

const retryCore = {
  id: 'retry-core', intent: 'Wrap send in retry', necessity: 'required', serves: 'task',
  removal_impact: 'Uploads fail on first error', hunks: ['h1'],
}
const config = {
  id: 'config', intent: 'Make retry count configurable', necessity: 'speculative', serves: 'retry-core',
  removal_impact: 'Retry count would be hardcoded', hunks: ['h2'],
}

test('parseDiff does not end a hunk on a removed line that looks like a file header', () => {
  const diff = [
    'diff --git a/x.sql b/x.sql', '--- a/x.sql', '+++ b/x.sql',
    '@@ -1,2 +1,1 @@', '--- a comment', ' select 1',
    'diff --git a/y b/y', '--- a/y', '+++ b/y', '@@ -1 +1 @@', '-a', '+b',
  ].join('\n')
  const hunks = parseDiff(diff)
  assert.deepEqual(hunks.map((h) => [h.id, h.file, h.removed, h.added]), [['h1', 'x.sql', 1, 0], ['h2', 'y', 1, 1]])
})

test('hunks lists ids for the commit', () => {
  const dir = repo()
  const r = gloss(dir, ['hunks', '--json'])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(JSON.parse(r.out).map((h: { id: string; file: string }) => [h.id, h.file]), [['h1', 'app.js'], ['h2', 'config.js']])
})

test('add rejects annotations that leave hunks uncovered or reference bad ids', () => {
  const dir = repo()
  let r = gloss(dir, ['add'], annotation([retryCore]))
  assert.equal(r.code, 1)
  assert.match(r.err, /not assigned to any group: h2/)

  r = gloss(dir, ['add'], annotation([retryCore, { ...config, serves: 'nope', hunks: ['h9'] }]))
  assert.equal(r.code, 1)
  assert.match(r.err, /unknown hunk "h9"/)
  assert.match(r.err, /serves unknown group "nope"/)

  r = gloss(dir, ['add'], annotation([{ ...retryCore, necessity: 'maybe' }]))
  assert.equal(r.code, 1)
  assert.match(r.err, /schema/)
})

test('add, show and why round-trip through git notes', () => {
  const dir = repo()
  let r = gloss(dir, ['add'], annotation([retryCore, config]))
  assert.equal(r.code, 0, r.err)

  r = gloss(dir, ['add'], annotation([retryCore, config]))
  assert.equal(r.code, 1, 'refuses to overwrite without --force')

  r = gloss(dir, ['show', '--only', 'speculative'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /Make retry count configurable/)
  assert.doesNotMatch(r.out, /Wrap send in retry/)

  r = gloss(dir, ['why', 'config.js:1', '--json'])
  assert.equal(r.code, 0, r.err)
  const why = JSON.parse(r.out)
  assert.equal(why.task, 'Retry uploads on failure')
  assert.deepEqual(why.groups.map((g: { id: string; serves_chain: string[] }) => [g.id, g.serves_chain]), [['config', ['retry-core']]])

  r = gloss(dir, ['why', 'app.js:1'])
  assert.match(r.out, /initial/)
  assert.match(r.out, /no gloss/)
})

test('review prints a prompt containing the annotated diff', () => {
  const dir = repo()
  gloss(dir, ['add'], annotation([retryCore, config]))
  const r = gloss(dir, ['review'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /### Group `config` \[speculative\]/)
  assert.match(r.out, /\+export const MAX_RETRIES = 3/)
})
