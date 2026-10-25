import { GlossError, WIP_REF, git, gitTry, resolveCommits } from '../git.ts'
import { buildPageData } from '../html/data.ts'
import { renderPage } from '../html/page.ts'
import { listRefs } from './browse.ts'

// A range page loads and lays out every commit in it, so a huge one would hang
// the browser. Narrowing it is a better answer than a spinner.
export const MAX_RANGE_COMMITS = 200

export class BadRequest extends GlossError {}

// What a page request asks for, already checked.
export type DeskQuery = { head: string | null; base: string | null; rev: string | null }
// The answer: a page, or a redirect (status 302 with a location header).
export type DeskResult = { status: number; type: string; headers: Record<string, string>; body: string }

// A revision, branch or range typed by the user or taken from the sidebar. An
// option-looking one is refused so it can never be read by git as a flag.
function revParam(url: URL, name: string): string | null {
  const v = url.searchParams.get(name)
  if (!v) return null
  if (v.startsWith('-') || v.length > 500 || v.includes('\0')) throw new BadRequest(`not a revision: ${v.slice(0, 80)}`)
  return v
}

// Runs in the server process, before any job starts: no git, only string checks.
export function parseQuery(url: URL): DeskQuery {
  return { head: revParam(url, 'head'), base: revParam(url, 'base'), rev: revParam(url, 'rev') }
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

const PAGE_HEADERS = { 'content-security-policy': "frame-ancestors 'none'" }

// The page for ?rev=&head=&base=. head and base only fill the pickers and
// choose the default rev; the rev alone decides which commits are shown.
// Runs git synchronously: only ever called in a job's child process (and by tests).
export function buildDesk(query: DeskQuery): DeskResult {
  const refs = listRefs()
  const known = new Set([...refs.branches, ...refs.remotes])
  const { head: wantHead, base: wantBase } = query
  let rev = query.rev
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
    notice = `Branch “${wantHead}” no longer exists; showing ${head ?? 'the default'} instead.`
  } else if (wantBase && !known.has(wantBase)) {
    head ??= fallback
    base = null
    notice = `The branch to compare with, “${wantBase}”, no longer exists; showing the newest commit of ${head ?? 'the default'}.`
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
      return { status: 302, type: 'text/plain', headers: { location: `/?${p}` }, body: 'redirecting' }
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
  return { status: 200, type: 'text/html', headers: PAGE_HEADERS, body: renderPage(data) }
}
