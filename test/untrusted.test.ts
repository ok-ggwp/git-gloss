import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from './run.ts'
import net from 'node:net'
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { browse, skipBrowse } from './browser.ts'
import { within } from './timing.ts'

// The adversarial checks of the untrusted-input audit (TODO.md, "Untrusted input"):
// notes, branch names and commit text arrive from collaborators and remotes.

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 30 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

// main with a base commit, and a glossed second commit.
function repo() {
  const dir = tmp('untrusted-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.js'), 'a\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'app.js'), 'b\n')
  g('add', '-A')
  g('commit', '-qm', 'two')
  const sha = g('rev-parse', 'HEAD')
  const added = gloss(dir, ['add'], JSON.stringify({ task: 't', groups: [{ id: 'g', hunks: ['h1'], intent: 'edit', necessity: 'required', serves: 'task', removal_impact: 'nothing works' }] }))
  assert.equal(added.code, 0, added.err)
  return { dir, g, sha }
}

// A review note as a remote could have pushed it: written straight into the ref, with whatever text.
function plantReview(g: (...a: string[]) => string, sha: string, findings: string, extra: object = {}) {
  const rec = { review: 1, id: 'planted', at: '2026-01-01T00:00:00Z', stage: 'honesty', agent: 'evil', target: 'HEAD', lines: [], groups: [], findings, ...extra }
  const file = join(tmp('plant-'), 'note')
  writeFileSync(file, JSON.stringify(rec) + '\n')
  g('notes', '--ref', 'refs/notes/gloss-reviews', 'append', '-F', file, sha)
}

test('in a real browser, markdown that is quadratic to scan does not hang the page', { skip: skipBrowse }, async () => {
  const { dir, g, sha } = repo()
  // Each of these made the scanner re-read the rest of the text at every marker.
  plantReview(g, sha, '*a '.repeat(30000))
  plantReview(g, sha, '['.repeat(60000), { stage: 'bugs' })
  plantReview(g, sha, '[a](x'.repeat(20000), { stage: 'improve' })
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    const ms = Number(await evaluate("(() => { const t = performance.now(); document.querySelectorAll('.rvrow').forEach((b) => b.click()); return performance.now() - t })()"))
    within('markdown', ms, 20_000)
  })
})

test('a review line over the size cap is skipped with a warning, not parsed or shown', () => {
  const { dir, g, sha } = repo()
  plantReview(g, sha, 'a normal report', { id: 'ok', agent: 'kept' })
  plantReview(g, sha, 'x'.repeat(300 * 1024), { id: 'huge', agent: 'toolong' })
  const r = gloss(dir, ['reviews', sha])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /kept/)
  assert.doesNotMatch(r.out, /toolong/)
  assert.ok(r.out.length < 10_000, `printed ${r.out.length} bytes`)
  assert.match(r.err, /skipped 1 review record/)
  // once per command, not once per reader
  assert.equal(r.err.match(/skipped/g)!.length, 1)
})

// Piped output has no colour, so any escape or control byte in it came from the repository.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/

test('escape sequences in a gloss note or a file name never reach the terminal output', () => {
  const { dir, g, sha } = repo()
  const esc = (s: string) => `${s}\x1b]0;PWNED\x07\x1b]52;c;cHduZWQ=\x07\x1b[2J\x1b[8m`
  const note = {
    gloss: 4, hunks: [],
    annotation: {
      task: esc('task'), summary: esc('summary'), risks: [esc('risk')], alternatives: [{ option: esc('opt'), rejected_because: esc('why') }],
      groups: [{ id: 'g', hunks: ['h1'], intent: esc('intent'), necessity: 'required', serves: 'task', removal_impact: esc('impact'), evidence: esc('evidence'), notes: esc('notes'), impact_reason: esc('reason') }],
    },
  }
  const file = join(tmp('note-'), 'n.json')
  writeFileSync(file, JSON.stringify(note))
  g('notes', '--ref', 'refs/notes/gloss', 'add', '-f', '-F', file, sha)
  writeFileSync(join(dir, esc('f') + '.js'), 'x\n')
  g('add', '-A')
  g('commit', '-qm', 'files')
  for (const args of [['show', sha], ['show', sha, '--full'], ['show', sha, '--diff'], ['show', `${sha}~1..${sha}`], ['why', 'app.js:1'], ['hunks', 'HEAD'], ['signals', 'HEAD'], ['reviews', sha]]) {
    const r = gloss(dir, args)
    assert.doesNotMatch(r.out + r.err, CONTROL, `git gloss ${args.join(' ')} printed a control character`)
  }
})

// A gloss as a remote could have pushed it, with its hunk record matching the commit's one hunk.
function plantGloss(g: (...a: string[]) => string, sha: string, annotation: object) {
  const hunks = [{ id: 'h1', file: 'app.js', oldFile: 'app.js', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]
  const file = join(tmp('plant-'), 'gloss.json')
  writeFileSync(file, JSON.stringify({ gloss: 4, hunks, annotation }))
  g('notes', '--ref', 'refs/notes/gloss', 'add', '-f', '-F', file, sha)
}
const group = (i: number) => ({ id: `g${i}`, hunks: ['h1'], intent: 'i', necessity: 'required', serves: 'task', removal_impact: 'r' })

test('a gloss with absurdly many groups or risks is refused, not rendered (quadratic page, stack overflow)', () => {
  const { dir, g, sha } = repo()
  // exactly one over the cap, each group claiming one line, so only the cap can refuse it (not the claim-factor check)
  const small = (i: number) => ({ ...group(i), hunks: ['h1:1'] })
  plantGloss(g, sha, { task: 't', groups: Array.from({ length: 500 }, (_, i) => small(i)) })
  assert.equal(gloss(dir, ['show', sha]).code, 0, '500 groups are allowed')
  plantGloss(g, sha, { task: 't', groups: Array.from({ length: 501 }, (_, i) => small(i)) })
  const many = gloss(dir, ['show', sha])
  assert.equal(many.code, 1)
  assert.match(many.err, /malformed/)
  plantGloss(g, sha, { task: 't', groups: [group(1)], risks: Array.from({ length: 501 }, (_, i) => `risk ${i}`) })
  assert.match(gloss(dir, ['show', sha]).err, /malformed/, 'one risk over the cap')
  plantGloss(g, sha, { task: 't', groups: [group(1)], risks: Array.from({ length: 200_000 }, (_, i) => `risk ${i}`) })
  const risks = gloss(dir, ['show', sha])
  assert.doesNotMatch(risks.err, /RangeError|at .*\.ts:\d+/, 'no stack trace')
  assert.equal(risks.code, 1)
  assert.match(risks.err, /malformed/)
  // a large but real gloss still reads
  plantGloss(g, sha, { task: 't', groups: Array.from({ length: 100 }, (_, i) => group(i)), risks: Array.from({ length: 100 }, (_, i) => `risk ${i}`) })
  assert.equal(gloss(dir, ['show', sha]).code, 0)
})

// A repo whose last commit rewrites f.txt (`lines` lines, so 2 x lines changed lines): one hunk.
function bigHunkRepo(lines: number) {
  const dir = tmp('untrusted-big-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'f.txt'), Array.from({ length: lines }, (_, i) => `a${i}`).join('\n') + '\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'f.txt'), Array.from({ length: lines }, (_, i) => `b${i}`).join('\n') + '\n')
  g('commit', '-qam', 'rewrite')
  return { dir, g, sha: g('rev-parse', 'HEAD') }
}
const shared = (groups: number) => ({ task: 't', groups: Array.from({ length: groups }, (_, i) => group(i)) })
const timed = (dir: string, args: string[], input?: string) => {
  const t = Date.now()
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, input, encoding: 'utf8', timeout: 40_000, maxBuffer: 1 << 30 })
  return { code: r.status, err: r.stderr, ms: Date.now() - t }
}

test('many groups claiming the same big hunk are refused at write and read time, within seconds', () => {
  // 500 groups x 20,000 changed lines = 10 million claimed lines (the page took over 40 s to build)
  const { dir, g, sha } = bigHunkRepo(10_000)
  const added = timed(dir, ['add', sha], JSON.stringify(shared(500)))
  assert.equal(added.code, 1, added.err)
  assert.match(added.err, /claim \d+ changed lines/)
  assert.doesNotMatch(added.err, /--force/, 'the message says what to change')
  within('claims add', added.ms, 30_000)
  const file = join(tmp('plant-'), 'gloss.json')
  const hunks = [{ id: 'h1', file: 'f.txt', oldFile: 'f.txt', oldStart: 1, oldLines: 10_000, newStart: 1, newLines: 10_000 }]
  writeFileSync(file, JSON.stringify({ gloss: 4, hunks, annotation: shared(500) }))
  g('notes', '--ref', 'refs/notes/gloss', 'add', '-F', file, sha)
  for (const args of [['html', sha, '-o', join(dir, 'page.html')], ['show', sha]]) {
    const r = timed(dir, args)
    assert.equal(r.code, 1, r.err)
    assert.match(r.err, /claim \d+ changed lines/)
    within(`claims ${args[0]}`, r.ms, 30_000)
  }
})

test('groups sharing one big hunk, as one group per dependency in a lockfile bump does, are accepted and read', () => {
  // 7 groups x 4,000 changed lines = 28,000 claimed; 50 x 4,000 = 200,000 (html builds in about half a second)
  const { dir, sha } = bigHunkRepo(2_000)
  for (const n of [7, 50]) {
    const added = timed(dir, ['add', sha, '--force'], JSON.stringify(shared(n)))
    assert.equal(added.code, 0, added.err)
    for (const args of [['show', sha], ['html', sha, '-o', join(dir, 'page.html')]]) {
      const r = timed(dir, args)
      assert.equal(r.code, 0, `${n} groups, ${args[0]}: ${r.err}`)
      within(`shared ${n} ${args[0]}`, r.ms, 30_000)
    }
  }
})

test('one group over a change to 600 files (600 hunks) is accepted and read', () => {
  const dir = tmp('untrusted-600-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'x'), 'x\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  for (let i = 0; i < 600; i++) writeFileSync(join(dir, `f${i}.txt`), `${i}\n`)
  g('add', '-A')
  g('commit', '-qm', 'many files')
  const refs = Array.from({ length: 600 }, (_, i) => `h${i + 1}`)
  const added = gloss(dir, ['add'], JSON.stringify({ task: 't', groups: [{ ...group(1), hunks: refs }] }))
  assert.equal(added.code, 0, added.err)
  assert.equal(gloss(dir, ['show', 'HEAD']).code, 0)
  assert.equal(gloss(dir, ['html', 'HEAD', '-o', join(dir, 'p.html')]).code, 0)
})

test('sync does not adopt a remote notes ref that is not a notes commit', () => {
  const { dir, g } = repo()
  const bare = tmp('remote-')
  execFileSync('git', ['init', '-q', '--bare', bare])
  g('remote', 'add', 'origin', bare)
  g('push', '-q', 'origin', 'main')
  // A compromised remote points its notes refs at a tree and a blob.
  const tree = execFileSync('git', ['mktree'], { cwd: bare, input: '', encoding: 'utf8' }).trim()
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: bare, input: 'junk', encoding: 'utf8' }).trim()
  execFileSync('git', ['update-ref', 'refs/notes/gloss', tree], { cwd: bare })
  execFileSync('git', ['update-ref', 'refs/notes/gloss-reviews', blob], { cwd: bare })
  g('update-ref', '-d', 'refs/notes/gloss')
  const r = gloss(dir, ['sync'])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.err, /not a notes commit/)
  // nothing was adopted: new glosses and reviews can still be written
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/notes/gloss'], { cwd: dir }).status, 1)
  assert.equal(spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/notes/gloss-reviews'], { cwd: dir }).status, 1)
})

test('in a real browser, hostile text from commits, notes and reviews stays text: no handler runs, no element is made, links are inert, and a group id cannot pose as read', { skip: skipBrowse }, async () => {
  const dir = tmp('untrusted-dom-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  const bomb = (n: number) => `<img src=x onerror="window.__pwn=${n}"></script><script>window.__pwn=${n}</script>`
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', `"><svg onload=window.__pwn=1>`)
  writeFileSync(join(dir, 'a.js'), 'a\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'a.js'), 'b\n')
  writeFileSync(join(dir, `f"><img src=x onerror=window.__pwn=2>'.js`), '<img src=x onerror=window.__pwn=3>\n')
  g('add', '-A')
  g('commit', '-qm', bomb(4))
  const sha = g('rev-parse', 'HEAD')
  const hunks = [{ id: 'h1', file: 'a.js', oldFile: 'a.js', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]
  const links = '[a](javascript:window.__pwn=5) [b]( JaVaScRiPt:window.__pwn=6) [c](data:text/html,<script>window.__pwn=7</script>) ![d](x" onerror="window.__pwn=8) [e](&#106;avascript:window.__pwn=9) **[f](vbscript:x)**'
  const grp = (id: string, hunk: string) => ({ id, hunks: [hunk], intent: bomb(10) + links, necessity: 'required', serves: 'task', removal_impact: bomb(11), evidence: links, notes: links, impact_reason: bomb(12) })
  const file = join(tmp('plant-'), 'gloss.json')
  writeFileSync(file, JSON.stringify({
    gloss: 4, hunks,
    annotation: { task: bomb(13), summary: links, risks: [bomb(14), links], alternatives: [{ option: bomb(15), rejected_because: links }], groups: [grp('constructor', 'h1'), grp('other', 'h2')] },
  }))
  g('notes', '--ref', 'refs/notes/gloss', 'add', '-f', '-F', file, sha)
  plantReview(g, sha, `${bomb(16)}\n\n${links}\n\n- ${links}\n\n\`${links}\`\n\n# ${bomb(17)}\n\nVERDICT: ISSUES`, { stage: `"><img src=x onerror=window.__pwn=18>`, agent: bomb(19), model: bomb(20), mode: bomb(21), target: bomb(22) })
  const out = join(dir, 'page.html')
  const r = gloss(dir, ['html', '-o', out])
  assert.equal(r.code, 0, r.err)
  await browse(`file://${out}`, async (evaluate) => {
    // "constructor" is a group id like any other: nothing is read until the reader says so
    assert.match(String(await evaluate("document.querySelector('.prog').textContent")), /^0 of 2 read/)
    // open every view: every button, a few times over (the rail changes as views open)
    for (let i = 0; i < 3; i++) {
      await evaluate("[...document.querySelectorAll('button')].forEach((b) => { try { b.click() } catch (e) {} })")
    }
    const facts = await evaluate(`JSON.stringify({
      pwn: window.__pwn === undefined ? null : window.__pwn,
      made: [...document.querySelectorAll('img, svg, iframe, object, embed, form, input, link, base')].map((e) => e.tagName),
      // the page's own two scripts and its one CSP meta, and nothing else
      scripts: document.scripts.length, metas: document.querySelectorAll('meta[http-equiv]').length,
      handlers: [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name)),
      links: [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')).filter((h) => !/^#[A-Za-z0-9._%-]*$/.test(h)),
      url: location.href.replace(/#.*/, ''),
      text: document.body.textContent,
    })`)
    const f = JSON.parse(String(facts))
    assert.equal(f.pwn, null, 'a handler ran')
    assert.deepEqual(f.made, [])
    assert.deepEqual([f.scripts, f.metas], [2, 1])
    assert.deepEqual(f.handlers, [])
    assert.deepEqual(f.links, [])
    assert.equal(f.url, `file://${out}`, 'navigated')
    // the payloads are on the page as text, so they were rendered rather than dropped
    assert.match(f.text, /onerror="window\.__pwn=4"/)
    assert.match(f.text, /javascript:window\.__pwn=5/)
  })
})

// Runs `git gloss ary` in dir for the duration of fn, which gets the port and a raw-request helper.
async function withAry(dir: string, fn: (port: number, raw: (request: string) => Promise<string>, alive: () => boolean) => Promise<void>) {
  const child = spawn(process.execPath, [BIN, 'ary', '--no-open'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.once('data', (d) => resolve(String(d).trim()))
      child.once('exit', (code) => reject(new Error(`exited with ${code} before listening`)))
    })
    const port = Number(new URL(url).port)
    const raw = (request: string) => new Promise<string>((resolve) => {
      const s = net.connect(port, '127.0.0.1')
      let out = ''
      s.on('data', (d) => { out += d })
      s.on('close', () => resolve(out))
      s.on('error', () => resolve(out))
      s.write(request)
      setTimeout(() => s.destroy(), 3000)
    })
    await fn(port, raw, () => child.exitCode === null && child.signalCode === null)
  } finally {
    child.kill()
  }
}

test('ary survives request targets that are not URLs (a web page can send "//[")', async () => {
  const { dir } = repo()
  await withAry(dir, async (port, raw, alive) => {
    for (const target of ['//[', '//:80/', 'http://[::1', '//a:b/']) {
      const r = await raw(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`)
      assert.ok(alive(), `the server died on ${target}`)
      assert.match(r, /^HTTP\/1\.1 (400|404|200|302|422) /, target)
    }
    assert.match(await raw(`GET /x HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 404 /)
  })
})

test('ary answers only its own host names and read-only methods, refuses option-like revisions, and escapes what it echoes', async () => {
  const { dir } = repo()
  await withAry(dir, async (port, raw) => {
    const get = (path: string, host: string | null = `127.0.0.1:${port}`, method = 'GET') =>
      raw(`${method} ${path} HTTP/1.1\r\n${host === null ? '' : `Host: ${host}\r\n`}Content-Length: 0\r\nConnection: close\r\n\r\n`)
    const status = (r: string) => Number(/^HTTP\/1\.1 (\d+)/.exec(r)?.[1])
    for (const host of [`127.0.0.1.evil.com:${port}`, `localhost.:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `[::1]:${port}`, `evil@127.0.0.1:${port}`, 'evil.com', '', `127.0.0.1:0${port}`]) {
      assert.equal(status(await get('/?rev=HEAD', host)), 403, `Host: ${host}`)
    }
    assert.equal(status(await get('/?rev=HEAD', null)), 400, 'HTTP/1.1 needs a Host')
    assert.equal(status(await raw('GET /?rev=HEAD HTTP/1.0\r\n\r\n')), 403, 'no Host at all')
    for (const host of [`LOCALHOST:${port}`, `localhost:${port}`]) assert.equal(status(await get('/?rev=HEAD', host)), 200, `Host: ${host}`)
    for (const method of ['POST', 'OPTIONS', 'TRACE', 'PUT', 'DELETE', 'PATCH']) {
      const r = await get('/?rev=HEAD', undefined, method)
      assert.equal(status(r), 405, method)
      assert.doesNotMatch(r, /access-control-allow/i, 'no CORS for any origin')
    }
    // options and odd revisions are refused before git sees them, and nothing is written
    const out = join(tmp('o-'), 'pwned')
    for (const q of [`rev=--output=${out}`, `rev=%2d%2doutput=${out}`, `head=--output=${out}`, `base=--output=${out}`, 'rev=a%00b', `rev=main..--output=${out}`]) {
      const r = await get(`/?${q}`)
      assert.ok([400, 422].includes(status(r)), `${q}: ${status(r)}`)
    }
    assert.throws(() => execFileSync('test', ['-e', out]), 'git wrote a file named by a query')
    // error pages: escaped, no script allowed, not sniffable
    const bad = await get('/?rev=--%3Cscript%3Ealert(1)%3C/script%3E')
    assert.equal(status(bad), 400)
    assert.doesNotMatch(bad, /<script>/)
    assert.match(bad, /&lt;script&gt;/)
    assert.match(bad, /content-security-policy: default-src 'none'/i)
    assert.match(bad, /x-content-type-options: nosniff/i)
    const unknown = await get('/?rev=%3Cscript%3Ealert(1)%3C/script%3E')
    assert.doesNotMatch(unknown, /<script>alert/)
    // the page itself may not be framed, and is never cached
    const page = await get('/?rev=HEAD')
    assert.match(page, /content-security-policy: frame-ancestors 'none'/i)
    assert.match(page, /cache-control: no-store/i)
    assert.match(page, /content-type: text\/html; charset=utf-8/i)
    // a branch or head named in the query that doesn't exist is shown as text only
    const gone = await get('/?rev=HEAD&head=%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E')
    assert.equal(status(gone), 200)
    assert.doesNotMatch(gone, /<img src=x/)
  })
})

test('html writes its default file under the cache dir with a name made only of commit ids, whatever the branch names are', () => {
  const { dir, g } = repo()
  // legal ref names that look like paths
  g('branch', 'a/b/c')
  g('branch', 'x/y', 'main~1')
  const cache = tmp('cache-')
  const r = gloss(dir, ['html', 'x/y..a/b/c'], undefined, { XDG_CACHE_HOME: cache })
  assert.equal(r.code, 0, r.err)
  const file = r.out.trim()
  assert.match(file.slice(cache.length), /^\/git-gloss\/[0-9a-f]{10}\.\.[0-9a-f]{10}\.html$/)
  assert.equal(statSync(join(cache, 'git-gloss')).mode & 0o777, 0o700)
  const single = gloss(dir, ['html', 'HEAD'], undefined, { XDG_CACHE_HOME: cache }).out.trim()
  assert.match(single.slice(cache.length), /^\/git-gloss\/[0-9a-f]{10}\.html$/)
})

test('in a real browser, hostile branch names and query values in the ary desk stay text', { skip: skipBrowse }, async () => {
  const { dir, g, sha } = repo()
  const evil = `x"><img/src=x/onerror=window.__pwn=1>`
  g('branch', evil)
  g('branch', `</script><script>window.__pwn=2</script>`)
  g('branch', `ja'v"as;cript(window.__pwn=3)`)
  await withAry(dir, async (port) => {
    const base = `http://127.0.0.1:${port}/`
    for (const q of [`?rev=${sha}`, `?rev=${sha}&head=${encodeURIComponent(evil)}`, `?rev=${sha}&head=${encodeURIComponent(evil + 'gone')}&base=${encodeURIComponent(evil + 'gone')}`, `?rev=${sha}&base=${encodeURIComponent(evil + 'gone')}`]) {
      await browse(base + q, async (evaluate) => {
        await evaluate("[...document.querySelectorAll('.combo-btn')].forEach((b) => b.click())")
        const f = JSON.parse(String(await evaluate(`JSON.stringify({
          pwn: window.__pwn === undefined ? null : window.__pwn,
          made: [...document.querySelectorAll('img, svg, iframe, object, embed, base')].map((e) => e.tagName),
          scripts: document.scripts.length,
          text: document.body.textContent,
        })`)))
        assert.equal(f.pwn, null, `a handler ran for ${q}`)
        assert.deepEqual(f.made, [], q)
        assert.equal(f.scripts, 2, q)
        assert.ok(f.text.includes('onerror=window.__pwn=1>') || !q.includes('head'), `the branch name is shown as text for ${q}`)
      })
    }
  })
})

test('deeply nested or prototype-keyed notes are read without a crash or a stack trace', () => {
  const { dir, g, sha } = repo()
  const put = (ref: string, text: string) => {
    const file = join(tmp('plant-'), 'n')
    writeFileSync(file, text)
    g('notes', '--ref', ref, 'add', '-f', '-F', file, sha)
  }
  const deep = '['.repeat(1_500_000) + ']'.repeat(1_500_000)
  put('refs/notes/gloss', `{"gloss":4,"hunks":[],"annotation":${deep}}`)
  put('refs/notes/gloss-reviews', deep + '\n' + '{"review":1,"a":' + deep + '}')
  const t = Date.now()
  for (const args of [['show', sha], ['reviews', sha], ['signals', sha], ['html', sha, '-o', join(dir, 'p.html')]]) {
    const r = gloss(dir, args)
    assert.doesNotMatch(r.err, /RangeError|\.ts:\d+|at .*\(/, `git gloss ${args[0]}: ${r.err.slice(0, 200)}`)
    assert.ok(r.code === 0 || r.code === 1, `git gloss ${args[0]} exited ${r.code}`)
  }
  within('nesting', Date.now() - t, 60_000)
  // a gloss with __proto__ and constructor keys everywhere still reads, and its extra keys are dropped
  put('refs/notes/gloss', JSON.stringify({ gloss: 4 }).slice(0, -1) + ',"__proto__":{"polluted":1},"hunks":[],"annotation":{"__proto__":{"x":1},"constructor":{"prototype":{"p":1}},"task":"t","groups":[{"id":"g","__proto__":{"isAdmin":true},"hunks":["h1"],"intent":"i","necessity":"required","serves":"task","removal_impact":"r"}]}}')
  const ok = gloss(dir, ['show', sha, '--full'])
  assert.equal(ok.code, 0, ok.err)
  assert.doesNotMatch(ok.out, /polluted|isAdmin/)
})

test('a file name with a tab or control character still matches its gloss and still works with why', () => {
  const dir = tmp('untrusted-name-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'x'), 'x\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  const name = 'a\tb\x1b]0;T\x07c.js'
  writeFileSync(join(dir, name), 'one\ntwo\n')
  g('add', '-A')
  g('commit', '-qm', 'odd name')
  const added = gloss(dir, ['add'], JSON.stringify({ task: 't', groups: [{ id: 'g', hunks: ['h1'], intent: 'zzgroup', necessity: 'required', serves: 'task', removal_impact: 'r' }] }))
  assert.equal(added.code, 0, added.err)
  const shown = gloss(dir, ['show', 'HEAD'])
  assert.doesNotMatch(shown.out, /no longer matches|unannotated/, 'the gloss matches its commit')
  assert.doesNotMatch(shown.out + shown.err, CONTROL)
  const why = gloss(dir, ['why', `${name}:1`])
  assert.equal(why.code, 0, why.err)
  assert.match(why.out, /zzgroup/, 'why finds the group')
  assert.doesNotMatch(why.out + why.err, CONTROL)
  for (const args of [['hunks', 'HEAD'], ['signals', 'HEAD']]) assert.doesNotMatch(gloss(dir, args).out, CONTROL)
})

test('a review stage named like an Object property is shown as a stage', () => {
  const { dir, g, sha } = repo()
  // with the lines and groups the commit has now, so the review is current and its verdict phrase is shown
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', sha]).out)[sha]
  for (const stage of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) plantReview(g, sha, 'ok\n\nVERDICT: CLEAN', { stage, id: stage, ...stamp, verdict: 'clean' })
  const r = gloss(dir, ['reviews', sha])
  assert.doesNotMatch(r.out + r.err, /undefined|\[native|function/)
  assert.match(r.out, /constructor: /)
  assert.match(gloss(dir, ['show', sha]).out, /constructor: /)
})

test('huge alternatives and attention reasons lists are refused, not a crash (show spreads them into a call)', () => {
  const { dir, g, sha } = repo()
  const alternatives = Array.from({ length: 200_000 }, (_, i) => ({ option: `o${i}`, rejected_because: 'r' }))
  const reasons = Array.from({ length: 200_000 }, (_, i) => `reason ${i}`)
  // one list at a time, so each cap has to do its own work
  for (const extra of [{ alternatives }, { attention: { level: 'careful', reasons } }]) {
    plantGloss(g, sha, { task: 't', groups: [group(1)], ...extra })
    for (const args of [['show', sha], ['html', sha, '-o', join(dir, 'p.html')]]) {
      const r = gloss(dir, args)
      assert.doesNotMatch(r.err, /RangeError|at .*\.ts:\d+/, `${Object.keys(extra)} ${args[0]}: ${r.err.slice(0, 200)}`)
      assert.equal(r.code, 1, `${Object.keys(extra)} ${args[0]}`)
      assert.match(r.err, /malformed/)
    }
  }
})

const OSC = '\x1b]52;c;cHduZWQ=\x07\x1b[2J'

test('a commit subject, a dependency name or version, and a file name with escapes never reach why, signals or review output', () => {
  const dir = tmp('untrusted-print-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  // pnpm's lockfile is read line by line, so a name or version can carry raw escape bytes (package-lock.json's JSON escapes them)
  const lock = (version: string) => `lockfileVersion: '9.0'\npackages:\n  foo\x1b]52;c;cHduZWQ=\x07@${version}:\n    resolution: {integrity: x}\n`
  writeFileSync(join(dir, 'pnpm-lock.yaml'), lock('1.0.0'))
  writeFileSync(join(dir, 'app.js'), 'one\ntwo\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'pnpm-lock.yaml'), lock('1.0.1\x1b[2J'))
  writeFileSync(join(dir, 'app.js'), 'one\nchanged\n')
  g('add', '-A')
  g('commit', '-qm', `subject ${OSC}`)
  const glossAll = (n: number) => gloss(dir, ['add'], JSON.stringify({ task: 't', groups: [{ id: 'g', hunks: Array.from({ length: n }, (_, i) => `h${i + 1}`), intent: 'all', necessity: 'required', serves: 'task', removal_impact: 'r' }] }))
  assert.equal(glossAll(2).code, 0)
  // a later commit changes the same line, so why shows the older step with its subject
  writeFileSync(join(dir, 'app.js'), 'one\nagain\n')
  g('commit', '-qam', 'later')
  // a commit whose file name and subject carry escapes (its code is plain, as `review` prints code as it is)
  writeFileSync(join(dir, `name${OSC}.js`), 'x\n')
  g('add', '-A')
  g('commit', '-qm', `odd ${OSC}`)
  assert.equal(glossAll(1).code, 0)
  // and one with no gloss at all, whose diff `review` lists under its file name
  writeFileSync(join(dir, `bare${OSC}.js`), 'y\n')
  g('add', '-A')
  g('commit', '-qm', 'unglossed')
  const cases: [string, string[]][] = [['why', ['why', 'app.js:2', '--history']], ['signals', ['signals', 'HEAD~3']], ['review', ['review', 'HEAD~1']], ['review of a range', ['review', 'HEAD~2..HEAD']]]
  for (const [name, args] of cases) {
    const r = gloss(dir, args)
    assert.equal(r.code, 0, `${name}: ${r.err}`)
    const bad = (r.out + r.err).split('\n').find((l) => l.includes('\x1b'))
    assert.equal(bad, undefined, `git gloss ${name} printed an escape: ${JSON.stringify(bad)}`)
  }
  // the dependency lines were really printed
  assert.match(gloss(dir, ['signals', 'HEAD~3']).out, /foo.* 1\.0\.0 -> 1\.0\.1/)
})

test('a review of a commit with 16,000 changed lines is recorded, read, and its decision kept (the stamp makes the line long, not the report)', () => {
  const { dir, sha } = bigHunkRepo(8_000)
  assert.equal(gloss(dir, ['add'], JSON.stringify(shared(1))).code, 0)
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', sha]).out)
  const rec = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'honesty', agent: 'claude', target: sha, findings: 'Looks inaccurate.\n\nVERDICT: ISSUES', stamp }))
  assert.equal(rec.code, 0, rec.err)
  const shown = gloss(dir, ['reviews', sha])
  assert.equal(shown.code, 0, shown.err)
  assert.doesNotMatch(shown.err, /skipped/)
  assert.match(shown.out, /Looks inaccurate/)
  const id = /"id":"([^"]+)"/.exec(execFileSync('git', ['notes', '--ref', 'refs/notes/gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }))![1]
  const decided = gloss(dir, ['reviews', sha, '--decide', id, '--finding', '1', '--outcome', 'fixed', '--by', 'me'])
  assert.equal(decided.code, 0, decided.err)
  assert.match(gloss(dir, ['reviews', sha]).out, /fixed: 1/)
  assert.match(gloss(dir, ['show', sha]).out, /honesty: /)
  assert.match(gloss(dir, ['show', sha]).out, /decisions: 1 decided/)
})

test('a review line of 10 MB is skipped with a warning, within a generous bound; and --record refuses a report that readers would skip', () => {
  const { dir, g, sha } = repo()
  plantReview(g, sha, 'x'.repeat(10 * 1024 * 1024), { id: 'junk', agent: 'toolong' })
  const t = Date.now()
  const r = gloss(dir, ['reviews', sha])
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /skipped 1 review record/)
  assert.doesNotMatch(r.out, /toolong/)
  within('10MB line', Date.now() - t, 30_000)
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', sha]).out)
  const rec = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'a', target: sha, findings: 'y'.repeat(300 * 1024), stamp }))
  assert.equal(rec.code, 1)
  assert.match(rec.err, /findings are too long/)
  assert.equal(spawnSync('git', ['notes', '--ref', 'refs/notes/gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.includes('"stage":"bugs"'), false, 'nothing was recorded')
})
