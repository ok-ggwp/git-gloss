import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from './run.ts'
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from './browser.ts'

// Chromium aborts ("Socket path too long") when its scratch dir under TMPDIR
// makes a unix socket path longer than 108 bytes. A long TMPDIR (reviewers use
// one) must not crash it.
test('dumpDom works with a long TMPDIR', { skip: chromium ? false : 'no Chromium found' }, () => {
  const base = mkdtempSync(join(tmpdir(), 'long-tmpdir-'))
  try {
    const long = join(base, 'scratch-directory-with-a-long-name', 'and-one-more-level-of-it')
    mkdirSync(long, { recursive: true })
    assert.ok(long.length >= 60)
    const code = `import { dumpDom } from ${JSON.stringify(join(import.meta.dirname, 'browser.ts'))}
process.stdout.write(dumpDom('data:text/html,<p id=hello>hi</p>'))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TMPDIR: long }, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /<p id="hello">hi<\/p>/)
    assert.deepEqual(readdirSync(long), [], 'the run left entries behind')
  } finally { rmSync(base, { recursive: true, force: true }) }
})
