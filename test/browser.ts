import { execFileSync, spawn, spawnSync } from 'node:child_process'

export const chromium = ['chromium', 'google-chrome-stable', 'google-chrome'].find((b) => spawnSync('which', [b]).status === 0)

// The page's DOM after its scripts ran, from plain `chromium --dump-dom`: no
// WebSocket needed, so it works on any Node. Pass the URL (with any #hash).
export function dumpDom(url: string, opts: { flags?: string[]; timeout?: number } = {}): string {
  return execFileSync(chromium!, ['--headless=new', '--disable-gpu', '--no-sandbox', ...(opts.flags ?? []), '--dump-dom', url], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: opts.timeout ?? 60000,
  })
}

// Driving the page over the DevTools protocol needs the global WebSocket of
// Node 22; package.json allows Node 20, where these tests skip.
export const skipBrowse: string | false =
  !chromium ? 'no Chromium found' : typeof WebSocket === 'undefined' ? 'needs Node 22+ (global WebSocket) to drive Chromium' : false

type Send = (method: string, params?: object) => Promise<any>
export type Evaluate = (js: string) => Promise<unknown>
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const KEYS: Record<string, [string, number, string | undefined]> = { Enter: ['Enter', 13, '\r'], o: ['KeyO', 79, 'o'] }
// A real key press (down, up) on whatever has focus, then a short wait for the page to react.
export async function press(send: Send, key: keyof typeof KEYS) {
  const [code, vk, text] = KEYS[key]
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, text })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
  await sleep(150)
}

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
  opts: { scheme?: 'light' | 'dark'; flags?: string[]; initScript?: string } = {},
) {
  const port = 9300 + Math.floor(Math.random() * 600)
  const chrome = spawn(chromium!, ['--headless=new', '--no-sandbox', '--disable-gpu', ...(opts.flags ?? []), `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
  const list = async (): Promise<{ id: string; type: string; webSocketDebuggerUrl: string }[]> => (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const ready = async (evaluate: Evaluate) => {
    for (let i = 0; i < 50 && !(await evaluate('!!document.querySelector("main .commit")')); i++) await sleep(100)
  }
  const sockets: WebSocket[] = []
  try {
    let targets: Awaited<ReturnType<typeof list>> | undefined
    for (let i = 0; i < 100 && !targets; i++) {
      await sleep(100)
      try { targets = await list() } catch { /* not up yet */ }
    }
    const page = await connect(targets!.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
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
      let target: Awaited<ReturnType<typeof list>>[number] | undefined
      for (let i = 0; i < 50 && !target; i++) {
        await sleep(100)
        target = (await list()).find((t) => t.type === 'page' && !known.has(t.id))
      }
      const tab = await connect(target!.webSocketDebuggerUrl)
      sockets.push(tab.ws)
      await ready(tab.evaluate)
      return tab.evaluate
    }
    await steps(page.evaluate, page.send, openTab)
  } finally {
    for (const ws of sockets) ws.close()
    chrome.kill()
  }
}
