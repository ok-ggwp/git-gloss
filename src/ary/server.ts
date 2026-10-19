import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { GlossError, WIP_REF, gitTry, resolveCommits } from '../git.ts'
import { buildPageData } from '../html/data.ts'
import { escapeHtml, renderPage } from '../html/page.ts'
import { listLog, listRefs } from './browse.ts'

const asset = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

// A range page loads and lays out every commit in it, so a huge one would hang
// the browser. Narrowing it is a better answer than a spinner.
export const MAX_RANGE_COMMITS = 200

// The shell page loads only its own script and style, and may frame only
// /view pages. Those carry their own policy: an inline script with a nonce.
const SHELL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'"

class BadRequest extends GlossError {}

// A revision, branch or range typed by the user or taken from the sidebar. An
// option-looking one is refused so it can never be read by git as a flag.
function revParam(url: URL, name: string, required = true): string | null {
  const v = url.searchParams.get(name)
  if (!v) {
    if (required) throw new BadRequest(`missing ?${name}=`)
    return null
  }
  if (v.startsWith('-') || v.length > 500 || v.includes('\0')) throw new BadRequest(`not a revision: ${v.slice(0, 80)}`)
  return v
}

const intParam = (url: URL, name: string, fallback: number, min: number, max: number) => {
  const n = Number(url.searchParams.get(name) ?? fallback)
  return Number.isInteger(n) && n >= min ? Math.min(n, max) : fallback
}

function send(res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    // Everything reflects the repo as it is now.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  })
  res.end(body)
}

const sendJson = (res: ServerResponse, data: unknown) => send(res, 200, 'application/json', JSON.stringify(data))

function viewPage(url: URL): string {
  const rev = revParam(url, 'rev')!
  // "wip" is the latest snapshot of uncommitted work. The server never takes
  // one (that is `git gloss hunks wip`): browsing doesn't change anything.
  const target = rev === 'wip' ? gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])?.trim() : rev
  if (!target) throw new GlossError('no snapshot of uncommitted work yet; run `git gloss hunks wip` first')
  const { shas, merges, range } = resolveCommits(target)
  if (shas.length > MAX_RANGE_COMMITS) {
    throw new GlossError(`${rev} has ${shas.length} commits; a page shows at most ${MAX_RANGE_COMMITS}. Pick a narrower range.`)
  }
  return renderPage(buildPageData(shas, range, merges))
}

function route(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const shell = (name: string, type: string) => send(res, 200, type, asset(name), type === 'text/html' ? { 'content-security-policy': SHELL_CSP } : {})
  switch (url.pathname) {
    case '/': return shell('./index.html', 'text/html')
    case '/ary.js': return shell('./client.js', 'text/javascript')
    case '/ary.css': return shell('./style.css', 'text/css')
    case '/api/refs': return sendJson(res, listRefs())
    case '/api/log':
      return sendJson(res, listLog(revParam(url, 'head')!, revParam(url, 'base', false), intParam(url, 'limit', 100, 1, 500), intParam(url, 'skip', 0, 0, 1e6), (url.searchParams.get('q') ?? '').slice(0, 200)))
    case '/view':
      // The page may only be framed by the shell, not by another site.
      return send(res, 200, 'text/html', viewPage(url), { 'content-security-policy': "frame-ancestors 'self'" })
    default: return send(res, 404, 'text/plain', 'not found')
  }
}

export function createAry(port: () => number): Server {
  return createServer((req, res) => {
    // A web page on another site can make the browser send requests here, and
    // with DNS rebinding even read the answers. Only our own origin's host
    // names get through; the server is read-only besides.
    const allowed = [`127.0.0.1:${port()}`, `localhost:${port()}`]
    if (!allowed.includes((req.headers.host ?? '').toLowerCase())) return send(res, 403, 'text/plain', `forbidden host: this server answers to ${allowed.join(' and ')} (it listens on this machine only; through an SSH tunnel, forward the same port number)`)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'read-only', { allow: 'GET, HEAD' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    try {
      route(req, res, url)
    } catch (err) {
      if (!(err instanceof GlossError)) {
        console.error(err)
        return send(res, 500, 'text/plain', 'internal error')
      }
      const status = err instanceof BadRequest ? 400 : 422
      if (url.pathname === '/view') {
        send(res, status, 'text/html', `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><pre style="white-space:pre-wrap;font:14px/1.5 system-ui;padding:16px">${escapeHtml(err.message)}</pre>`, { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'" })
      } else {
        send(res, status, 'application/json', JSON.stringify({ error: err.message }))
      }
    }
  })
}
