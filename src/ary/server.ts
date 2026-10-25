import { createServer, type Server, type ServerResponse } from 'node:http'
import { GlossError } from '../git.ts'
import { escapeHtml } from '../html/page.ts'
import { BadRequest, parseQuery } from './desk.ts'
import { JobPool, poolOptionsFromEnv, type PoolOptions } from './jobs.ts'

export { MAX_RANGE_COMMITS } from './desk.ts'

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
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

function errorPage(res: ServerResponse, status: number, message: string): void {
  send(res, status, 'text/html', `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><pre style="white-space:pre-wrap;font:14px/1.5 system-ui;padding:16px">${escapeHtml(message)}</pre><p style="font:14px/1.5 system-ui;padding:0 16px"><a href="/">Back to the default view</a></p>`, { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
}

// The page is built in a child process (jobs.ts), so git never blocks this loop. The query is
// checked here first: a refused request starts nothing. Answers: 503 + Retry-After when
// all slots are busy, 504 when the build outlives GIT_GLOSS_ARY_TIMEOUT, 502 when its
// output passes GIT_GLOSS_ARY_MAX_OUTPUT, 422 for what git or the repo says. A client that
// leaves cancels its job.
function route(res: ServerResponse, url: URL, pool: JobPool): void {
  if (url.pathname !== '/') return send(res, 404, 'text/plain', 'not found')
  const job = pool.start(parseQuery(url))
  if (!job) return send(res, 503, 'text/plain', 'busy: too many pages are being built; retry in a moment', { 'retry-after': '1' })
  res.on('close', () => { if (!res.writableFinished) job.cancel() })
  job.result.then((r) => {
    if (r.kind === 'cancelled' || res.destroyed || res.writableEnded) return
    if (r.kind === 'error') return r.status === 500 ? send(res, 500, 'text/plain', 'internal error') : errorPage(res, r.status, r.message)
    send(res, r.status, r.type, r.body, r.headers)
  })
}

export function createAry(port: () => number, overrides: Partial<PoolOptions> = {}): Server {
  const pool = new JobPool({ ...poolOptionsFromEnv(), ...overrides })
  const server = createServer((req, res) => {
    // A web page on another site can make the browser send requests here, and
    // with DNS rebinding even read the answers. Only our own origin's host
    // names get through; the server is read-only besides.
    const allowed = [`127.0.0.1:${port()}`, `localhost:${port()}`]
    if (!allowed.includes((req.headers.host ?? '').toLowerCase())) return send(res, 403, 'text/plain', `forbidden host: this server answers to ${allowed.join(' and ')} (it listens on this machine only; through an SSH tunnel, forward the same port number)`)
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'text/plain', 'read-only', { allow: 'GET, HEAD' })
    try {
      // A request target need not be a URL ("//[" is not), and a throw here would end the process.
      let url: URL
      try { url = new URL(req.url ?? '/', 'http://localhost') } catch { throw new BadRequest('not a valid request target') }
      route(res, url, pool)
    } catch (err) {
      if (!(err instanceof GlossError)) {
        console.error(err)
        return send(res, 500, 'text/plain', 'internal error')
      }
      const status = err instanceof BadRequest ? 400 : 422
      errorPage(res, status, err.message)
    }
  })
  // Closing the server stops what it is building, and nothing outlives the process.
  const exitKill = () => pool.killAllNow()
  process.on('exit', exitKill)
  server.on('close', () => process.off('exit', exitKill))
  const close = server.close.bind(server)
  server.close = (cb?: (err?: Error) => void) => {
    pool.cancelAll()
    const r = close(cb)
    server.closeAllConnections()
    return r
  }
  return server
}
