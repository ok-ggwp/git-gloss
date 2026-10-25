import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseGitTimeout } from '../git.ts'
import type { DeskQuery } from './desk.ts'

// Pages are built in a child process (src/ary/page-job.ts), never in the server
// process: git is called synchronously there, and a slow or hung git would stop
// the server answering anything. Each child leads its own process group, so a
// job that is cancelled, times out or is stopped takes its git with it.
const JOB = fileURLToPath(new URL(`./page-job${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url))

export type JobResult =
  | { kind: 'page'; status: number; type: string; headers: Record<string, string>; body: Buffer }
  | { kind: 'error'; status: number; message: string }
  | { kind: 'cancelled' }

export type Job = { result: Promise<JobResult>; cancel(): void }

// execPath and execArgv are for tests; the child runs like this process does (a source checkout on a
// Node that runs TypeScript, else dist/, as bin/git-gloss.js chooses), with the flags of this process that it needs (childExecArgv).
export type PoolOptions = { max: number; timeoutMs: number; maxOutput: number; execPath?: string; execArgv?: string[] }

const posInt = (raw: string | undefined, fallback: number) => (raw !== undefined && /^[1-9]\d*$/.test(raw.trim()) ? Number(raw) : fallback)

// GIT_GLOSS_ARY_JOBS (page builds at once, 4), GIT_GLOSS_ARY_TIMEOUT (ms a build may take, 300000, 0 = no
// limit; each git call has its own GIT_GLOSS_GIT_TIMEOUT inside it), GIT_GLOSS_ARY_MAX_OUTPUT (bytes, 32 MiB; a build holds up to twice that while the output is joined).
export function poolOptionsFromEnv(env = process.env): PoolOptions {
  return {
    max: posInt(env.GIT_GLOSS_ARY_JOBS, 4),
    // setTimeout fires at once for more than 2^31-1 ms (24.8 days): a limit that large means none
    timeoutMs: ((t) => (t > 2 ** 31 - 1 ? 0 : t))(parseGitTimeout(env.GIT_GLOSS_ARY_TIMEOUT, 300_000)),
    maxOutput: posInt(env.GIT_GLOSS_ARY_MAX_OUTPUT, 32 * 1024 * 1024),
  }
}

// The flags of this process the child needs to run the same code (type stripping on a Node that
// has it behind a flag, warnings, source maps, heap size). Anything else is left out: an `-e`
// script, `--input-type` or `--import` of the parent would make the child run something else.
const KEEP = /^--(no-)?experimental-[\w-]+(=.*)?$|^--(no-warnings|enable-source-maps|disable-warning=.+|max-old-space-size=\d+|stack-size=\d+)$/
export const childExecArgv = (argv: string[]): string[] => argv.filter((a) => KEEP.test(a))

// After SIGTERM the group gets this long before SIGKILL, but only while its leader (node) is still
// alive: the leader dies on SIGTERM at once and its exit sends SIGKILL to the rest of the group, so
// git rarely gets the grace. ary's git calls are read-only (see TODO).
const GRACE_MS = 2000

type Entry = { killNow(): void; cancel(): void }

export class JobPool {
  private live = new Set<Entry>()
  private opts: PoolOptions
  constructor(opts: PoolOptions) { this.opts = opts }

  // null: all slots are taken (the caller answers 503; nothing is queued).
  start(query: DeskQuery): Job | null {
    if (this.live.size >= this.opts.max) return null
    const { timeoutMs, maxOutput } = this.opts
    let settle!: (r: JobResult) => void
    const result = new Promise<JobResult>((resolve) => { settle = resolve })
    const entry: Entry = { killNow: () => {}, cancel: () => {} }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(this.opts.execPath ?? process.execPath, [...(this.opts.execArgv ?? childExecArgv(process.execArgv)), JOB, JSON.stringify(query)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      console.error(err)
      return { result: Promise.resolve({ kind: 'error', status: 500, message: 'internal error' }), cancel() {} }
    }
    this.live.add(entry)
    const pid = child.pid
    const killGroup = (sig: NodeJS.Signals) => { if (pid) { try { process.kill(-pid, sig) } catch { /* gone */ } } }
    let timers: NodeJS.Timeout[] = []
    let stopping = false
    const stop = () => {
      if (stopping) return
      stopping = true
      killGroup('SIGTERM')
      timers.push(setTimeout(() => killGroup('SIGKILL'), GRACE_MS).unref())
    }
    entry.killNow = () => killGroup('SIGKILL')
    entry.cancel = () => { settle({ kind: 'cancelled' }); stop() }
    if (timeoutMs > 0) {
      timers.push(setTimeout(() => {
        settle({ kind: 'error', status: 504, message: `building this page took longer than ${timeoutMs / 1000} s and was stopped (GIT_GLOSS_ARY_TIMEOUT sets the limit)` })
        stop()
      }, timeoutMs).unref())
    }
    const chunks: Buffer[] = []
    let size = 0
    let err = ''
    child.stdout!.on('data', (d: Buffer) => {
      size += d.length
      if (size > maxOutput) {
        chunks.length = 0
        settle({ kind: 'error', status: 502, message: `the page is more than ${maxOutput} bytes; pick a narrower range` })
        stop()
        return
      }
      if (!stopping) chunks.push(d)
    })
    child.stderr!.on('data', (d: Buffer) => { if (err.length < 8192) err += d })
    child.on('error', (e) => {
      // a spawn failure may not be followed by 'close': free the slot here
      console.error(e)
      for (const t of timers) clearTimeout(t)
      this.live.delete(entry)
      settle({ kind: 'error', status: 500, message: 'internal error' })
    })
    child.on('close', (code) => {
      for (const t of timers) clearTimeout(t)
      timers = []
      // a straggler of the group (a git the job left behind) goes with it
      killGroup('SIGKILL')
      this.live.delete(entry)
      if (stopping) return settle({ kind: 'cancelled' })
      const all = Buffer.concat(chunks)
      const nl = all.indexOf(10)
      if (code !== 0 || nl < 0) {
        console.error(err.trim() || `page job ended with code ${code}`)
        return settle({ kind: 'error', status: 500, message: 'internal error' })
      }
      try {
        const head = JSON.parse(all.subarray(0, nl).toString('utf8'))
        if (typeof head.error === 'string') return settle({ kind: 'error', status: head.status, message: head.error })
        settle({ kind: 'page', status: head.status, type: head.type, headers: head.headers, body: all.subarray(nl + 1) })
      } catch (e) {
        console.error(e)
        settle({ kind: 'error', status: 500, message: 'internal error' })
      }
    })
    return { result, cancel: () => entry.cancel() }
  }

  // Stops every running job: SIGTERM now, SIGKILL after the grace period.
  cancelAll(): void { for (const j of [...this.live]) j.cancel() }
  // Synchronous and final, for a process that is exiting.
  killAllNow(): void { for (const j of this.live) j.killNow() }
}
