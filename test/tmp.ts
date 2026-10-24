import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// One root per test process, removed when the process exits (also after a
// failing test or a crash), so nothing the tests create is left in /tmp.
let root: string | undefined
const cleanups = new Set<() => void>()

// Runs before the root is removed (e.g. to kill a browser still using a profile in it).
export function onCleanup(fn: () => void): () => void {
  cleanups.add(fn)
  return () => { cleanups.delete(fn) }
}

export function tmp(prefix: string): string {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), 'g-'))
    const dir = root
    // exit handlers do not run on a signal's default action: turn Ctrl-C and a
    // runner's timeout kill (SIGTERM) into a normal exit so the cleanup below runs
    for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]] as const) process.on(sig, () => process.exit(code))
    process.on('exit', () => {
      for (const fn of cleanups) { try { fn() } catch { /* best effort */ } }
      rmSync(dir, { recursive: true, force: true })
    })
  }
  return mkdtempSync(join(root, prefix))
}
