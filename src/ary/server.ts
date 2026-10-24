import { createServer, type Server, type ServerResponse } from 'node:http'
import { GlossError, WIP_REF, git, gitTry, resolveCommits } from '../git.ts'
import { buildPageData } from '../html/data.ts'
import { escapeHtml, renderPage } from '../html/page.ts'
import { listRefs } from './browse.ts'

// A range page loads and lays out every commit in it, so a huge one would hang
// the browser. Narrowing it is a better answer than a spinner.
export const MAX_RANGE_COMMITS = 200

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

// The page may not be framed by anyone: it shows the code of your commits.
const PAGE_HEADERS = { 'content-security-policy': "frame-ancestors 'none'" }

function errorPage(res: ServerResponse, status: number, message: string): void {
  send(res, status, 'text/html', `<!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark"><pre style="white-space:pre-wrap;font:14px/1.5 system-ui;padding:16px">${escapeHtml(message)}</pre><p style="font:14px/1.5 system-ui;padding:0 16px"><a href="/">Back to the default view</a></p>`, { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" })
}

// The commits of `head` the page shows when nothing else is chosen: those
// beyond `base` (when a page can show them all), or else the newest one (as a sha, so a branch called "wip"
// doesn't mean the snapshot).
function defaultRev(head: string | null, base: string | null): string | null {
  if (!head) return null
  if (base) {
    // A range beyond what a page shows would only be an error page: show the newest commit.
    const n = Number(git(['rev-list', '--count', '--end-of-options', `${base}..${head}`, '--']).trim())
    if (n > 0 && n <= MAX_RANGE_COMMITS) return `${base}..${head}`
  }
  return gitTry(['rev-parse', '--verify', '--quiet', `${head}^{commit}`])?.trim() || null
}

// The page for ?rev=&head=&base=. head and base only fill the pickers and
// choose the default rev; the rev alone decides which commits are shown.
function deskPage(url: URL, res: ServerResponse): void {
  const refs = listRefs()
  const known = new Set([...refs.branches, ...refs.remotes])
  const wantHead = revParam(url, 'head', false)
  const wantBase = revParam(url, 'base', false)
  let rev = revParam(url, 'rev', false)
  // The default base goes with the default branch.
  const baseFor = (head: string | null) => (head === refs.defaultBase ? null : refs.defaultBase)
  // A link or bookmark may name a branch that has since been deleted or
  // renamed: use the usual choice instead, and say so.
  let head = wantHead && known.has(wantHead) ? wantHead : null
  const fallback = refs.current || refs.defaultBase || refs.branches[0] || null
  let base: string | null
  let notice: string | null = null
  if (wantHead && !head) {
    head = fallback
    base = baseFor(head)
    notice = `Branch \u201c${wantHead}\u201d no longer exists; showing ${head ?? 'the default'} instead.`
  } else if (wantBase && !known.has(wantBase)) {
    head ??= fallback
    base = null
    notice = `The branch to compare with, \u201c${wantBase}\u201d, no longer exists; showing the newest commit of ${head ?? 'the default'}.`
  } else if (head) {
    base = wantBase
  } else {
    head = fallback
    base = wantBase ?? baseFor(head)
  }
  if (!rev) {
    // Opening with nothing chosen shows the uncommitted work, if snapshotted;
    // choosing a branch shows that branch.
    const wip = !wantHead && !wantBase && gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])
    rev = wip ? 'wip' : defaultRev(head, base)
    if (!rev) throw new GlossError(head ? `${head} has no commits to show` : 'there are no branches to show; pass ?rev= to view a commit')
    if (!notice) {
      const p = new URLSearchParams({ rev })
      if (head) p.set('head', head)
      if (base) p.set('base', base)
      return send(res, 302, 'text/plain', 'redirecting', { location: `/?${p}` })
    }
  }
  // "wip" is the latest snapshot of uncommitted work. The server never takes
  // one (that is `git gloss hunks wip`): browsing doesn't change anything.
  const target = rev === 'wip' ? gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])?.trim() : rev
  if (!target) throw new GlossError('no snapshot of uncommitted work yet; run `git gloss hunks wip` first')
  const { shas, merges, range } = resolveCommits(target)
  if (shas.length > MAX_RANGE_COMMITS) {
    throw new GlossError(`${rev} has ${shas.length} commits; a page shows at most ${MAX_RANGE_COMMITS}. Pick a narrower range.`)
  }
  const data = buildPageData(shas, range, merges)
  data.ary = { repo: refs.repo, branches: refs.branches, remotes: refs.remotes, defaultBase: refs.defaultBase, head, base, rev, notice }
  send(res, 200, 'text/html', renderPage(data), PAGE_HEADERS)
}

function route(res: ServerResponse, url: URL): void {
  if (url.pathname === '/') return deskPage(url, res)
  send(res, 404, 'text/plain', 'not found')
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
      route(res, url)
    } catch (err) {
      if (!(err instanceof GlossError)) {
        console.error(err)
        return send(res, 500, 'text/plain', 'internal error')
      }
      const status = err instanceof BadRequest ? 400 : 422
      errorPage(res, status, err.message)
    }
  })
}
