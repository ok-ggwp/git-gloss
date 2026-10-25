import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from './run.ts'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The guard against /tmp leaking again: whatever a test process creates through
// tmp() must be gone when it exits, however it exits.
const mod = join(import.meta.dirname, 'tmp.ts')
const scripts: Record<string, { tail: string; status: number }> = {
  'exits normally': { tail: '', status: 0 },
  'throws': { tail: 'throw new Error("boom")', status: 1 },
  'calls process.exit': { tail: 'process.exit(3)', status: 3 },
  'gets SIGTERM': { tail: 'process.kill(process.pid, "SIGTERM"); setTimeout(() => {}, 5000)', status: 143 },
}

for (const [name, { tail, status }] of Object.entries(scripts)) {
  test(`tmp(): nothing is left in TMPDIR when the process ${name}`, () => {
    const fresh = mkdtempSync(join(tmpdir(), 'tmp-guard-'))
    try {
      const code = `import { tmp } from ${JSON.stringify(mod)}
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
const d = tmp('x-'); mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'f'), 'data'); tmp('y-')
${tail}`
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TMPDIR: fresh }, encoding: 'utf8' })
      assert.equal(r.status, status, r.stderr)
      assert.deepEqual(readdirSync(fresh), [])
    } finally { rmSync(fresh, { recursive: true, force: true }) }
  })
}
