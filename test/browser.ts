import { spawn, spawnSync } from './run.ts'
import * as cp from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { onCleanup, tmp } from './tmp.ts'

// One dir for the profile and one for Chromium's own org.chromium.* scratch
// (via TMPDIR), both under the tmp() root. Chromium makes a unix socket at
// <TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket and aborts ("Socket
// path too long") past 108 bytes, so a long TMPDIR must never reach it: when the
// path would pass 90 bytes it gets a short dir of its own in /tmp instead.
function sandbox() {
  const profile = tmp('c-')
  let scratch = tmp('t-')
  if (`${scratch}/org.chromium.Chromium.XXXXXX/SingletonSocket`.length > 90) {
    const short = mkdtempSync('/tmp/g-')
    onCleanup(() => rmSync(short, { recursive: true, force: true }))
    scratch = short
  }
  return { flag: `--user-data-dir=${profile}`, env: { ...process.env, TMPDIR: scratch } }
}

// GLOSS_CHROMIUM names another executable (test/hangguard.test.ts uses a stub that leaves helper processes).
export const chromium = process.env.GLOSS_CHROMIUM ?? ['chromium', 'google-chrome-stable', 'google-chrome'].find((b) => spawnSync('which', [b]).status === 0)

// Chromium runs as a tree (browser, zygote, gpu, renderers). Each launch gets its
// own process group, so the whole tree can be killed with one signal to -pid, and
// is waited for until no member is left: a killed browser alone leaves helpers behind.
const groupAlive = (pid: number) => { try { process.kill(-pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }
const killGroup = (pid: number | undefined) => { if (pid) try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
async function groupGone(pid: number | undefined, wait = 5000) {
  const end = Date.now() + wait
  while (pid && groupAlive(pid) && Date.now() < end) await sleep(20)
}

// The coreutils `timeout` wrapper bounds Chromium's life even if the test process
// is killed with SIGKILL, when nothing of ours can run (the wrapper is its own
// group leader, and on expiry kills its whole group). Not on macOS: feature-detected.
const LIFETIME = Number(process.env.GLOSS_CHROMIUM_LIFETIME ?? 600)
const hasTimeout = spawnSync('timeout', ['--version'], { stdio: 'ignore' }).status === 0
const lifetime = (cmd: string, args: string[]): [string, string[]] =>
  hasTimeout ? ['timeout', ['--signal=KILL', String(LIFETIME), cmd, ...args]] : [cmd, args]

// The page's DOM after its scripts ran, from plain `chromium --dump-dom`: no
// WebSocket needed, so it works on any Node. Pass the URL (with any #hash).
export function dumpDom(url: string, opts: { flags?: string[]; timeout?: number } = {}): string {
  const box = sandbox()
  const [cmd, args] = lifetime(chromium!, ['--headless=new', '--disable-gpu', '--no-sandbox', box.flag, ...(opts.flags ?? []), '--dump-dom', url])
  // node's raw spawnSync, not run.ts's: on a timeout run.ts throws before the pid is known here,
  // and the group must be killed on that path above all (the wrapper is SIGKILLed alone by node).
  const r = cp.spawnSync(cmd, args, {
    env: box.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout ?? 60000, killSignal: 'SIGKILL',
    detached: true, // works for spawnSync, though its typings omit it
  } as object)
  killGroup(r.pid) // helpers a finished or timed-out dump may leave
  if ((r.error as any)?.code === 'ETIMEDOUT') throw new Error(`chromium --dump-dom timed out after ${opts.timeout ?? 60000} ms`)
  if (r.status !== 0) throw new Error(`chromium --dump-dom failed (status ${r.status}, signal ${r.signal})`)
  return String(r.stdout)
}

// Driving the page over the DevTools protocol needs the global WebSocket of
// Node 22; package.json allows Node 20, where these tests skip.
export const skipBrowse: string | false =
  !chromium ? 'no Chromium found' : typeof WebSocket === 'undefined' ? 'needs Node 22+ (global WebSocket) to drive Chromium' : false

type Send = (method: string, params?: object) => Promise<any>
export type Evaluate = (js: string) => Promise<unknown>
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Waits until `probe` returns something truthy, polling every 100 ms, for up to
// `deadline` ms: a slow machine waits longer instead of failing on a fixed poll count.
export async function waitFor<T>(probe: () => Promise<T | undefined | false | null | ''>, what: string, deadline = 30_000, stop?: AbortSignal): Promise<T> {
  const end = Date.now() + deadline
  let last: unknown
  for (;;) {
    stop?.throwIfAborted()
    let v: T | undefined | false | null | '' = undefined
    try { v = await probe() } catch (e) { last = e }
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out after ${deadline} ms waiting for ${what}${last ? `; last error: ${last instanceof Error ? last.message : last}` : ''}`)
    await sleep(100)
  }
}

const KEYS: Record<string, [string, number, string | undefined]> = { Enter: ['Enter', 13, '\r'], o: ['KeyO', 79, 'o'] }
// A real key press (down, up) on whatever has focus, then a short wait for the page to react.
export async function press(send: Send, key: keyof typeof KEYS) {
  const [code, vk, text] = KEYS[key]
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  await sleep(150)
}

// A whole browse() call (start, load, steps) must end within this, or it fails and the browser is killed.
const BROWSE_DEADLINE = 100_000

async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl)
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pending = new Map<number, (v: any) => void>()
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(String(m.data))
    pending.get(d.id)?.(d.result)
    pending.delete(d.id)
  })
  const send: Send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
  const evaluate: Evaluate = async (js) => (await send('Runtime.evaluate', { expression: js, returnByValue: true })).result.value
  return { ws, send, evaluate }
}

// Opens the page in headless Chromium and hands the steps a way to evaluate
// JavaScript in it, the raw protocol `send`, and `openTab` for a second tab of
// the same browser. `scheme` emulates prefers-color-scheme; `flags` go to Chromium; `initScript` runs before the page's own scripts.
export async function browse(
  url: string,
  steps: (evaluate: Evaluate, send: Send, openTab: (url: string) => Promise<Evaluate>) => Promise<void>,
  opts: { scheme?: 'light' | 'dark'; flags?: string[]; initScript?: string; deadline?: number } = {},
) {
  const port = 9300 + Math.floor(Math.random() * 600)
  const box = sandbox()
  const [cmd, args] = lifetime(chromium!, ['--headless=new', '--no-sandbox', '--disable-gpu', box.flag, ...(opts.flags ?? []), `--remote-debugging-port=${port}`, 'about:blank'])
  // timeout: 0 = no node-side limit (the group is killed below, and `timeout` bounds a killed test process)
  const chrome = spawn(cmd, args, { stdio: 'ignore', env: box.env, detached: true, timeout: 0 })
  const pid = chrome.pid
  // If the test process dies mid-run, kill the whole Chromium tree before its profile is removed.
  const forget = onCleanup(() => { killGroup(pid) })
  const list = async (): Promise<{ id: string; type: string; webSocketDebuggerUrl: string }[]> => (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const ready = async (evaluate: Evaluate) => {
    await waitFor(() => evaluate('!!document.querySelector("main .commit")'), 'the page to render', 30_000, stop.signal)
  }
  const sockets: WebSocket[] = []
  const stop = new AbortController() // set when the deadline fires or browse ends: late polling stops at once
  try {
    const deadline = opts.deadline ?? BROWSE_DEADLINE
    let timer: NodeJS.Timeout
    const hung = new Promise<never>((_, reject) => { timer = setTimeout(() => { stop.abort(); reject(new Error(`browse timed out after ${deadline} ms (a step or Chromium hung)`)) }, deadline) })
    await Promise.race([run(), hung]).finally(() => clearTimeout(timer))
  } finally {
    stop.abort()
    for (const ws of sockets) ws.close()
    killGroup(pid)
    await groupGone(pid)
    if (!pid || !groupAlive(pid)) forget()
  }
  async function run() {
    const first = await waitFor(async () => (await list()).find((t) => t.type === 'page'), 'Chromium to start', 30_000, stop.signal)
    const page = await connect(first.webSocketDebuggerUrl)
    sockets.push(page.ws)
    await page.send('Page.enable')
    if (opts.scheme) await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: opts.scheme }] })
    if (opts.initScript) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: opts.initScript })
    await page.send('Page.navigate', { url })
    await ready(page.evaluate)
    // A second tab of the same browser context, opened with noopener: it shares
    // localStorage with the first tab but starts with its own, empty sessionStorage.
    const openTab = async (tabUrl: string) => {
      const known = new Set((await list()).map((t) => t.id))
      // userGesture, or the popup blocker refuses window.open
      await page.send('Runtime.evaluate', { expression: `window.open(${JSON.stringify(tabUrl)}, '_blank', 'noopener') && 1`, userGesture: true })
      const target = await waitFor(async () => (await list()).find((t) => t.type === 'page' && !known.has(t.id)), 'the new tab', 30_000, stop.signal)
      const tab = await connect(target.webSocketDebuggerUrl)
      sockets.push(tab.ws)
      await ready(tab.evaluate)
      return tab.evaluate
    }
    await steps(page.evaluate, page.send, openTab)
  }
}
