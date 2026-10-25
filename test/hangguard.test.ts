import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { browse, skipBrowse } from './browser.ts'
import { tmp } from './tmp.ts'

// The guards that keep a hung test from stalling the suite: a child that never
// ends is killed and reported, and a browse() that hangs leaves no Chromium behind.
const procs = (marker: string) => spawnSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).stdout.split('\n').filter((l) => l.includes(marker))

test('a child that never ends is killed at its timeout and reported as timed out', () => {
  const marker = `hangguard-sync-${process.pid}`
  const t0 = Date.now()
  assert.throws(
    () => spawnSync(process.execPath, ['-e', `setInterval(() => {}, 1e6) // ${marker}`], { timeout: 1500 }),
    /timed out after 1500 ms/,
  )
  assert.throws(
    () => execFileSync(process.execPath, ['-e', `setInterval(() => {}, 1e6) // ${marker}`], { timeout: 1500 }),
    /timed out after 1500 ms/,
  )
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`)
  assert.deepEqual(procs(marker), [], 'the hung child was left running')
})

test('browse() with a hanging step fails at its deadline and leaves no Chromium process', { skip: skipBrowse }, async () => {
  const marker = `--hangguard-marker=${process.pid}-${Date.now()}`
  const page = 'data:text/html,<main><div class="commit">x</div></main>'
  const t0 = Date.now()
  await assert.rejects(
    browse(page, async () => { await new Promise(() => {}) }, { deadline: 4000, flags: [marker] }),
    /browse timed out after 4000 ms/,
  )
  assert.ok(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`)
  assert.deepEqual(procs(marker), [], 'Chromium processes outlived browse()')
})

// Runs `code` (an ES module) in a fresh node process with extra env, so that the
// module-load settings (GLOSS_CHILD_TIMEOUT, GLOSS_CHROMIUM) can be set.
const here = (f: string) => JSON.stringify(join(import.meta.dirname, f))
const inChild = (code: string, env: Record<string, string>) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000 })

test('the DEFAULT child timeout applies, also when the options argument is passed as undefined', () => {
  const marker = `hangguard-default-${process.pid}`
  const code = `import { spawnSync } from ${here('run.ts')}
for (const call of [() => spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1e6) // ${marker}']), () => spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1e6) // ${marker}'], undefined)]) {
  try { call(); console.log('NO-THROW') } catch (e) { console.log(String(e.message).slice(0, 40)) }
}`
  const t0 = Date.now()
  const r = inChild(code, { GLOSS_CHILD_TIMEOUT: '1200' })
  for (const line of r.stdout.trim().split('\n')) assert.match(line, /^timed out after 1200 ms/)
  assert.ok(Date.now() - t0 < 20_000)
  assert.deepEqual(procs(marker), [])
})

// A stub "chromium" that, like the real one, leaves helper processes (zygote,
// renderers) behind its own process: a parent-only kill does not reach them.
function stub(marker: string) {
  const file = join(tmp('stub-'), 'chromium')
  writeFileSync(file, `#!/bin/sh\nsh -c 'sleep 4321; : ${marker}' </dev/null >/dev/null 2>&1 &\n[ -n "$STUB_STAY" ] && exec sleep 4322\nexit 0\n`)
  chmodSync(file, 0o755)
  return file
}

test('killing a browser kills its helper processes too (process group), in browse() and dumpDom()', () => {
  const marker = `hangguard-stub-${process.pid}-${Date.now()}`
  const bin = stub(marker)
  const run = (body: string, env: Record<string, string>) => {
    const r = inChild(`import { browse, dumpDom } from ${here('browser.ts')}\n${body}`, { GLOSS_CHROMIUM: bin, ...env })
    assert.equal(r.status, 0, r.stderr)
  }
  run(`try { dumpDom('about:blank') } catch {}`, {}) // the stub exits at once, its helper stays
  assert.deepEqual(procs(marker), [], 'dumpDom left a helper process')
  run(`try { dumpDom('about:blank', { timeout: 1000 }) } catch (e) { if (!/timed out/.test(e.message)) throw e }`, { STUB_STAY: '1' }) // times out: helper and stub stay
  assert.deepEqual(procs(marker), [], 'dumpDom left a helper process after a timeout')
  const t0 = Date.now()
  run(`await browse('about:blank', async () => {}, { deadline: 1500 }).catch(() => {})`, { STUB_STAY: '1' })
  assert.deepEqual(procs(marker), [], 'browse left a helper process')
  assert.ok(Date.now() - t0 < 10_000, `browse lingered ${Date.now() - t0} ms after its deadline`)
})
