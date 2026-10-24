import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, symlinkSync, writeFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { GitError, resolveCommit } from '../src/git.ts'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmp } from './tmp.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

// A repo with main, and a feature branch of two commits, the first glossed.
function repo(): { dir: string; sha: string[] } {
  const dir = tmp('ary-test-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const commit = (msg: string, text: string) => {
    writeFileSync(join(dir, 'app.js'), text + '\n')
    g('add', '-A')
    g('commit', '-qm', msg)
    return g('rev-parse', 'HEAD')
  }
  const base = commit('base', 'a')
  g('checkout', '-q', '-b', 'feature')
  const one = commit('one', 'b')
  const two = commit('two', 'c')
  execFileSync(process.execPath, [BIN, 'add', one], {
    cwd: dir,
    input: JSON.stringify({ task: 'change b', groups: [{ id: 'g', hunks: ['h1'], intent: 'edit', necessity: 'required', serves: 'task', removal_impact: 'nothing works' }] }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  return { dir, sha: [base, one, two] }
}

// Runs `git gloss ary` in dir, for the duration of fn.
async function withServer(dir: string, fn: (url: string, port: number) => Promise<void>, args: string[] = []): Promise<void> {
  const child = spawn(process.execPath, [BIN, 'ary', '--no-open', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.split('\n')[0]) })
      child.on('exit', (code) => reject(new Error(`exited with ${code} before listening`)))
    })
    await fn(url, Number(new URL(url).port))
  } finally {
    child.kill()
  }
}

test('ary serves refs, a commit log with gloss status, and views', async () => {
  const { dir, sha } = repo()
  await withServer(dir, async (url) => {
    const refs = await (await fetch(url + 'api/refs')).json() as any
    assert.equal(refs.current, 'feature')
    assert.equal(refs.defaultBase, 'main')
    assert.deepEqual(refs.branches.map((b: any) => b.name).sort(), ['feature', 'main'])
    assert.equal(refs.wip, null)

    const log = await (await fetch(url + 'api/log?head=feature&base=main')).json() as any
    assert.deepEqual(log.commits.map((c: any) => [c.sha, c.glossed]), [[sha[2], false], [sha[1], true]], 'newest first, with gloss status')
    assert.equal(log.total, 2)
    assert.equal(log.more, false)
    const paged = await (await fetch(url + 'api/log?head=feature&limit=1')).json() as any
    assert.equal(paged.commits.length, 1)
    assert.equal(paged.more, true)
    // limit=0 would be an empty page that says there is more, so Load more
    // would loop; numbers out of range are ignored in favour of the defaults.
    for (const bad of ['limit=0', 'limit=-5&skip=-1', 'limit=x']) {
      const r = await (await fetch(url + `api/log?head=feature&${bad}`)).json() as any
      assert.equal(r.commits.length, 3, bad)
      assert.equal(r.more, false, bad)
    }

    const single = await fetch(url + `view?rev=${sha[1]}`)
    assert.equal(single.status, 200)
    assert.match(await single.text(), /id="gloss-data"/)
    // A range shows its unglossed commits too, like `html <range>`.
    const range = await (await fetch(url + 'view?rev=main..feature')).text()
    assert.equal(JSON.parse(/id="gloss-data">(.*?)<\/script>/s.exec(range)![1]).commits.length, 2)

    // Uncommitted work: shown once snapshotted, never snapshotted by browsing.
    writeFileSync(join(dir, 'app.js'), 'd\n')
    assert.equal((await (await fetch(url + 'api/refs')).json() as any).wip, null)
    execFileSync(process.execPath, [BIN, 'hunks', 'wip'], { cwd: dir, stdio: 'pipe' })
    const wip = await (await fetch(url + 'api/refs')).json() as any
    assert.equal(wip.wip.glossed, false)
    const page = await (await fetch(url + 'view?rev=wip')).text()
    assert.equal(JSON.parse(/id="gloss-data">(.*?)<\/script>/s.exec(page)![1]).commits[0].sha, wip.wip.sha)
  })
})

test('ary searches commits by message or author, within the range', async () => {
  const { dir, sha } = repo()
  const search = async (q: string, extra = '') =>
    ((await (await fetch(url + `api/log?head=feature&q=${encodeURIComponent(q)}${extra}`)).json()) as any).commits.map((c: any) => c.sha)
  let url = ''
  await withServer(dir, async (u) => {
    url = u
    assert.deepEqual(await search('ONE'), [sha[1]], 'any case, message')
    assert.deepEqual(await search('test'), [sha[2], sha[1], sha[0]], 'author, newest first')
    assert.deepEqual(await search('test', '&base=main'), [sha[2], sha[1]], 'only the commits in the range')
    assert.deepEqual(await search('nothing like it'), [])
    assert.deepEqual(await search('--all'), [], 'text is a pattern, never an option')
    assert.deepEqual(await search('o.e'), [], 'a literal, not a regexp')
    assert.deepEqual(await search('t', '&limit=1&skip=1'), [sha[1]], 'pages')
    const none = await (await fetch(u + 'api/log?head=feature&base=main&q=one')).json() as any
    assert.equal(none.total, null, 'a search has no branch total')
  })
})

test('ary serves its page and the assets the page names', async () => {
  const { dir } = repo()
  await withServer(dir, async (url) => {
    const index = await fetch(url)
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type')!, /text\/html/)
    assert.match(index.headers.get('content-security-policy')!, /script-src 'self'/)
    const html = await index.text()
    // Every file the page loads is served, with a type the browser will run.
    const js = await fetch(url + 'ary.js')
    assert.match(js.headers.get('content-type')!, /text\/javascript/)
    const css = await fetch(url + 'ary.css')
    assert.match(css.headers.get('content-type')!, /text\/css/)
    assert.match(html, /<script src="\/ary\.js">/)
    assert.match(html, /<link rel="stylesheet" href="\/ary\.css">/)
    // The shell has no tests of its own; at least it must parse.
    const script = await js.text()
    assert.doesNotThrow(() => new Script(script))
    assert.ok((await css.text()).length > 100)
  })
})

test('ary refuses what it should', async () => {
  const { dir } = repo()
  await withServer(dir, async (url, port) => {
    assert.equal((await fetch(url + 'view?rev=--output=x')).status, 400, 'an option is not a revision')
    assert.equal((await fetch(url + 'api/log?head=nope')).status, 422)
    const none = await fetch(url + 'view?rev=wip')
    assert.equal(none.status, 422)
    assert.match(await none.text(), /no snapshot/)
    assert.equal((await fetch(url + 'view')).status, 400)
    assert.equal((await fetch(url + 'nowhere')).status, 404)
    assert.equal((await fetch(url + 'api/refs', { method: 'POST' })).status, 405)
    // DNS rebinding: a foreign Host header never reaches git. (fetch won't
    // set Host, so use a raw request.)
    const { request } = await import('node:http')
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/refs', headers: { host: `evil.example:${port}` } }, (r) => { r.resume(); resolve(r.statusCode!) }).on('error', reject).end()
    })
    assert.equal(status, 403)
    // Host names are case-insensitive; a client may send them as typed.
    const upper = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/api/refs', headers: { host: `LocalHost:${port}` } }, (r) => { r.resume(); resolve(r.statusCode!) }).on('error', reject).end()
    })
    assert.equal(upper, 200)
    const hint = await new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, (r) => {
        let body = ''
        r.on('data', (d) => { body += d })
        r.on('end', () => resolve(body))
      }).on('error', reject).end()
    })
    assert.match(hint, new RegExp(`127\\.0\\.0\\.1:${port} and localhost:${port}`), 'the refusal names what is allowed')
    assert.doesNotMatch(hint, /\[::1\]/, 'the server never listens on IPv6')
    // Hostile text in an error message is escaped, not parsed.
    const bad = await (await fetch(url + 'view?rev=' + encodeURIComponent('<img src=x onerror=1>'))).text()
    assert.doesNotMatch(bad, /<img/)
  })
})

test('ary refuses to render an oversized range', async () => {
  const { dir } = repo()
  // One fast-import stream: 201 commits on top of main.
  const stream = Array.from({ length: 201 }, (_, i) =>
    `commit refs/heads/big\ncommitter T <t@e> ${1700000000 + i} +0000\ndata 1\nx\n${i ? '' : 'from refs/heads/main\n'}\n`).join('')
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream })
  await withServer(dir, async (url) => {
    const r = await fetch(url + 'view?rev=main..big')
    assert.equal(r.status, 422)
    assert.match(await r.text(), /201 commits/)
  })
})

test('ary reports a busy port and a bad one', async () => {
  const { dir } = repo()
  await withServer(dir, async (_url, port) => {
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      const c = spawn(process.execPath, [BIN, 'ary', '--no-open', '--port', String(port)], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      c.stderr.on('data', (d) => { err += d })
      c.on('exit', (code) => resolve({ code, err }))
    })
    assert.equal(r.code, 1)
    assert.match(r.err, /in use/)
  })
  // Not a port: text, empty (which Number() reads as 0), negative, too big.
  for (const port of ['x', '', ' ', '-1', '65536', '8080x']) {
    const bad = spawn(process.execPath, [BIN, 'ary', '--no-open', '--port', port], { cwd: dir, stdio: 'ignore' })
    assert.equal(await new Promise((resolve) => bad.on('exit', resolve)), 1, `--port "${port}"`)
  }
})

// The published package runs the compiled dist/, which must hold the assets the
// server reads from beside itself. Build a copy of the project and serve from it.
test('the built package serves the ary page', async () => {
  const root = join(import.meta.dirname, '..')
  const copy = tmp('ary-build-')
  for (const f of ['scripts', 'src', 'package.json', 'tsconfig.json', 'tsconfig.build.json']) cpSync(join(root, f), join(copy, f), { recursive: true })
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'))
  execFileSync(process.execPath, [join(copy, 'scripts', 'build.mjs')], { cwd: copy, stdio: 'pipe' })

  const { dir } = repo()
  const cli = pathToFileURL(join(copy, 'dist', 'cli.js')).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { main } from ${JSON.stringify(cli)}; process.exitCode = await main(['ary', '--no-open'])`], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.split('\n')[0]) })
      child.on('exit', (code) => reject(new Error(`exited with ${code}: ${err}`)))
    })
    assert.match(await (await fetch(url)).text(), /<script src="\/ary\.js">/)
    assert.match(await (await fetch(url + 'ary.js')).text(), /function picker/)
    assert.ok((await (await fetch(url + 'ary.css')).text()).includes('.combo'))
    const view = await fetch(url + 'view?rev=HEAD')
    assert.equal(view.status, 200, 'the HTML view needs its own assets too')
    assert.match(await view.text(), /id="gloss-data"/)
  } finally {
    child.kill()
  }
})

test('a revision that looks like an option is a bad revision, not a flag', () => {
  const { dir, sha } = repo()
  const before = process.cwd()
  process.chdir(dir)
  try {
    assert.equal(resolveCommit('HEAD'), sha[2])
    assert.equal(resolveCommit('feature~1'), sha[1])
    for (const rev of ['--abbrev-ref', '--short=4', '--git-dir', '-q', '--help']) {
      assert.throws(() => resolveCommit(rev), GitError, rev)
    }
  } finally {
    process.chdir(before)
  }
})
