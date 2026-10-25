import * as cp from 'node:child_process'

// Drop-in spawnSync / execFileSync / spawn for the tests, each child limited by
// a timeout and killed with SIGKILL, so a hung git-gloss, git or Chromium fails
// the test instead of stalling the suite (node's --test-timeout fails the test
// but does NOT end its file's process while a child is still running, so the
// children must end by themselves). A timeout throws "timed out after N ms: <command>".
// Pass `timeout` in the options for a longer or shorter limit (0 = none).
// (GLOSS_CHILD_TIMEOUT, read once, lets a test of the default shorten it.)
export const CHILD_TIMEOUT = Number(process.env.GLOSS_CHILD_TIMEOUT ?? 120_000)

const label = (cmd: unknown, args: unknown) => [cmd, ...(Array.isArray(args) ? args : [])].map(String).join(' ').slice(0, 200)
// a trailing `undefined` (an options argument left out) is dropped, or the limits would land after it and be ignored
const split = (a: any[]): [any, any] => { while (a.length > 1 && a.at(-1) === undefined) a = a.slice(0, -1); const o = a.at(-1); return Array.isArray(o) || typeof o !== 'object' || o === null ? [a, {}] : [a.slice(0, -1), o] }
const limited = (o: any) => ({ timeout: CHILD_TIMEOUT, killSignal: 'SIGKILL', ...o })
const timedOut = (e: any) => e?.code === 'ETIMEDOUT'

// Sync children run under coreutils `timeout --signal=KILL`, which puts the child in its own
// process group and SIGKILLs the whole group at the limit, so a grandchild (a git, a helper)
// does not outlive a timed-out test. node's own timeout (a few seconds later) stays as the
// backstop and only reaches the direct child. Without `timeout` (no coreutils) only that
// backstop applies. (spawnSync cannot expose a pid to kill a group itself; `spawn` is not
// wrapped, since tests kill and signal those children by pid.)
const HAVE_TIMEOUT = cp.spawnSync('timeout', ['--version'], { stdio: 'ignore' }).status === 0
const GRACE = 5000
// A timed-out wrapped child ends by SIGKILL at about the limit; both tell it from a child that
// killed itself (which ends sooner).
const wrap = (cmd: any, args: any, opts: any) => {
  if (!HAVE_TIMEOUT || !(opts.timeout > 0) || typeof cmd !== 'string') return null
  return {
    cmd: 'timeout', args: ['--signal=KILL', String(opts.timeout / 1000), cmd, ...(Array.isArray(args) ? args : [])],
    opts: { ...opts, timeout: opts.timeout + GRACE },
  }
}
const expired = (signal: unknown, t0: number, limit: number) => signal === 'SIGKILL' && Date.now() - t0 >= limit - 100

export const spawnSync = ((...a: any[]) => {
  const [rest, o] = split(a)
  const opts = limited(o)
  const w = Array.isArray(rest[1]) || rest[1] === undefined ? wrap(rest[0], rest[1], opts) : null
  const t0 = Date.now()
  const r = w ? (cp.spawnSync as any)(w.cmd, w.args, w.opts) : (cp.spawnSync as any)(...rest, opts)
  if (timedOut(r.error) || (w && expired(r.signal, t0, opts.timeout))) throw new Error(`timed out after ${opts.timeout} ms: ${label(rest[0], rest[1])}`)
  return r
}) as typeof cp.spawnSync

export const execFileSync = ((...a: any[]) => {
  const [rest, o] = split(a)
  const opts = limited(o)
  const w = Array.isArray(rest[1]) || rest[1] === undefined ? wrap(rest[0], rest[1], opts) : null
  const t0 = Date.now()
  try { return w ? (cp.execFileSync as any)(w.cmd, w.args, w.opts) : (cp.execFileSync as any)(...rest, opts) } catch (e: any) {
    if (timedOut(e) || (w && expired(e?.signal, t0, opts.timeout))) throw new Error(`timed out after ${opts.timeout} ms: ${label(rest[0], rest[1])}`, { cause: e })
    throw e
  }
}) as typeof cp.execFileSync

// Async: node SIGKILLs the child at the timeout, which also lets the file's
// process exit; the test's own wait on the child then sees it end.
export const spawn = ((...a: any[]) => {
  const [rest, o] = split(a)
  return (cp.spawn as any)(...rest, limited(o))
}) as typeof cp.spawn
