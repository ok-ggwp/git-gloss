import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { GitError, resolveCommit } from '../src/git.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { browse, skipBrowse, sleep } from './browser.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

// A repo with main, and a feature branch of two commits, the first glossed.
function repo(): { dir: string; sha: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'ary-test-'))
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

const dataOf = (page: string) => JSON.parse(/id="gloss-data">(.*?)<\/script>/s.exec(page)![1])

test('ary serves the desk page itself, with the pickers\' data and no other assets', async () => {
  const { dir, sha } = repo()
  await withServer(dir, async (url) => {
    // No selection: redirected to the canonical URL (the head's default view).
    const bare = await fetch(url, { redirect: 'manual' })
    assert.equal(bare.status, 302)
    assert.equal(bare.headers.get('location'), `/?rev=main..feature&head=feature&base=main`)
    const index = await fetch(url + bare.headers.get('location')!.slice(1))
    assert.equal(index.status, 200)
    assert.match(index.headers.get('content-type')!, /text\/html/)
    assert.equal(index.headers.get('cache-control'), 'no-store')
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff')
    assert.match(index.headers.get('content-security-policy')!, /frame-ancestors 'none'/)
    const html = await index.text()
    // As strict as `html`'s page: no connections, no external files.
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'nonce-[^']+'; script-src 'nonce-[^']+'"/)
    assert.doesNotMatch(html, /connect-src|<script src|<link /)
    const data = dataOf(html)
    assert.equal(data.range, 'main..feature')
    assert.equal(data.commits.length, 2, 'a range shows its unglossed commits too')
    assert.deepEqual(data.ary, { repo: data.ary.repo, branches: ['feature', 'main'], remotes: [], defaultBase: 'main', head: 'feature', base: 'main', rev: 'main..feature', notice: null })
    assert.match(html, /function aryBar/)
    assert.doesNotThrow(() => new Script(/<script nonce="[^"]+">\n(.*?)<\/script>/s.exec(html)![1]))
    // The old shell's routes are gone.
    for (const gone of ['ary.js', 'ary.css', 'view?rev=HEAD', 'api/refs', 'api/log?head=feature']) assert.equal((await fetch(url + gone)).status, 404, gone)

    // Choosing a branch (no rev) shows its range against the given base, or its newest commit.
    const picked = await fetch(url + '?head=feature&base=main', { redirect: 'manual' })
    assert.equal(picked.headers.get('location'), '/?rev=main..feature&head=feature&base=main')
    const main = await fetch(url + '?head=main', { redirect: 'manual' })
    assert.equal(main.status, 302)
    assert.equal(main.headers.get('location'), `/?rev=${sha[0]}&head=main`)
    const single = dataOf(await (await fetch(url + `?rev=${sha[1]}`)).text())
    assert.equal(single.range, null)
    assert.deepEqual([single.commits[0].sha, single.ary.head, single.ary.base], [sha[1], 'feature', 'main'], 'the pickers default to the checked-out branch')

    // A branch that is gone: the usual one is shown, with a notice, not a redirect.
    const gone = dataOf(await (await fetch(url + '?head=deleted&base=main', { redirect: 'manual' })).text())
    assert.equal(gone.ary.head, 'feature')
    assert.match(gone.ary.notice, /“deleted” no longer exists; showing feature/)
    const nobase = dataOf(await (await fetch(url + `?rev=${sha[2]}&head=feature&base=deleted`)).text())
    assert.equal(nobase.ary.base, null)
    assert.match(nobase.ary.notice, /“deleted”, no longer exists; showing the newest commit of feature\./)
    const tip = dataOf(await (await fetch(url + '?head=feature')).text())
    assert.deepEqual([tip.commits.length, tip.commits[0].sha, tip.range, tip.ary.base], [1, sha[2], null, null], 'no base: a one-commit page for the tip')

    // Uncommitted work: the default once snapshotted, never snapshotted by browsing.
    writeFileSync(join(dir, 'app.js'), 'd\n')
    assert.equal((await fetch(url + '?rev=wip')).status, 422)
    assert.equal((await fetch(url, { redirect: 'manual' })).headers.get('location'), `/?rev=main..feature&head=feature&base=main`)
    execFileSync(process.execPath, [BIN, 'hunks', 'wip'], { cwd: dir, stdio: 'pipe' })
    assert.equal((await fetch(url, { redirect: 'manual' })).headers.get('location')?.slice(0, 13), '/?rev=wip&hea')
    const wip = dataOf(await (await fetch(url + '?rev=wip')).text())
    assert.equal(wip.commits[0].sha, execFileSync('git', ['rev-parse', 'refs/worktree/gloss/wip'], { cwd: dir, encoding: 'utf8' }).trim())
  })
})

test('ary refuses what it should', async () => {
  const { dir } = repo()
  await withServer(dir, async (url, port) => {
    for (const q of ['rev=--output=x', 'head=--all', 'base=-x']) assert.equal((await fetch(url + '?' + q)).status, 400, `${q}: an option is not a revision`)
    const none = await fetch(url + '?rev=wip')
    assert.equal(none.status, 422)
    assert.match(await none.text(), /no snapshot/)
    assert.equal((await fetch(url + '?rev=nope')).status, 422)
    assert.equal((await fetch(url + 'nowhere')).status, 404)
    assert.equal((await fetch(url, { method: 'POST' })).status, 405)
    assert.equal((await fetch(url + '?rev=HEAD', { method: 'HEAD' })).status, 200)
    // DNS rebinding: a foreign Host header never reaches git. (fetch won't
    // set Host, so use a raw request.)
    const { request } = await import('node:http')
    const status = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, (r) => { r.resume(); resolve(r.statusCode!) }).on('error', reject).end()
    })
    assert.equal(status, 403)
    // Host names are case-insensitive; a client may send them as typed.
    const upper = await new Promise<number>((resolve, reject) => {
      request({ host: '127.0.0.1', port, path: '/', headers: { host: `LocalHost:${port}` } }, (r) => { r.resume(); resolve(r.statusCode!) }).on('error', reject).end()
    })
    assert.equal(upper, 302, 'the default view')
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
    const bad = await (await fetch(url + '?rev=' + encodeURIComponent('<img src=x onerror=1>'))).text()
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
    const r = await fetch(url + '?rev=main..big')
    assert.equal(r.status, 422)
    assert.match(await r.text(), /201 commits/)
  })
})

test('choosing a branch far ahead of its base shows its newest commit, not an error page', async () => {
  const { dir } = repo()
  const stream = Array.from({ length: 201 }, (_, i) =>
    `commit refs/heads/big\ncommitter T <t@e> ${1700000000 + i} +0000\ndata 1\nx\n${i ? '' : 'from refs/heads/main\n'}\n`).join('')
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream })
  const tip = execFileSync('git', ['rev-parse', 'big'], { cwd: dir, encoding: 'utf8' }).trim()
  await withServer(dir, async (url) => {
    const r = await fetch(url + '?head=big&base=main')
    assert.equal(r.status, 200, 'followed the redirect to a page')
    assert.equal(new URL(r.url).searchParams.get('rev'), tip)
    const data = dataOf(await r.text())
    assert.deepEqual([data.commits.length, data.commits[0].sha, data.ary.head, data.ary.base], [1, tip, 'big', 'main'], 'the pickers stay')
    assert.equal((await fetch(url + '?rev=main..big')).status, 422, 'an explicit oversized range is still refused')
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
  const copy = mkdtempSync(join(tmpdir(), 'ary-build-'))
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
    const page = await fetch(url + '?rev=HEAD')
    assert.equal(page.status, 200)
    const html = await page.text()
    assert.match(html, /id="gloss-data"/)
    assert.match(html, /function picker/, 'the picker script is in the page')
    assert.ok(html.includes('.combo-panel'), 'and its styles')
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

// Polls the page until the expression holds (a navigation in between is fine).
async function until(evaluate: (js: string) => Promise<unknown>, js: string, what: string) {
  for (let i = 0; i < 60; i++) {
    if (await evaluate(`(() => { try { return !!(${js}) } catch (e) { return false } })()`)) return
    await sleep(100)
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('in a browser, the desk is the whole page and picking a branch loads that branch', { skip: skipBrowse }, async () => {
  const { dir, sha } = repo()
  await withServer(dir, async (url) => {
    await browse(url + '?rev=main..feature&head=feature&base=main', async (evaluate) => {
      assert.equal(await evaluate("document.querySelectorAll('header.top').length"), 1, 'one top bar')
      assert.equal(await evaluate("document.querySelectorAll('iframe, aside.side').length"), 0, 'no frame, no second sidebar')
      assert.equal(await evaluate("document.querySelectorAll('aside.rail').length"), 1, 'one rail')
      const buttons = "[...document.querySelectorAll('header.top .combo-btn')].map(b => b.textContent)"
      assert.deepEqual(await evaluate(buttons), ['feature', 'main'])
      assert.equal(await evaluate("document.querySelector('header.top .ary-rev input').value"), 'main..feature')

      // Open the Branch picker, search, pick "main" with the keyboard.
      await evaluate("document.querySelector('header.top .combo-btn').click()")
      await evaluate("(() => { const i = document.querySelector('.combo-panel:not([hidden]) input'); i.value = 'ma'; i.dispatchEvent(new Event('input')) })()")
      assert.equal(await evaluate("[...document.querySelectorAll('.combo-panel:not([hidden]) .combo-item')].map(b => b.textContent).join()"), 'main', 'the search narrows the list')
      await evaluate("document.querySelector('.combo-panel:not([hidden]) .combo-item').click()")
      await until(evaluate, "location.search.includes('head=main')", 'the page for main')
      await until(evaluate, "document.querySelector('header.top .combo-btn')?.textContent === 'main'", 'the picker showing main')
      assert.equal(await evaluate("document.querySelectorAll('header.top').length"), 1, 'still one top bar')
      assert.equal(await evaluate("document.querySelector('header.top .sha').textContent"), sha[0].slice(0, 7), 'main shows its newest commit')
      assert.equal(await evaluate("document.querySelectorAll('header.top .combo-btn')[1].textContent"), '(none: just the newest commit)', 'main is compared with nothing')

      // The revision box loads whatever is typed.
      await evaluate(`(() => { const i = document.querySelector('.ary-rev input'); i.value = ${JSON.stringify(sha[1])}; i.form.requestSubmit() })()`)
      await until(evaluate, `location.search.includes('rev=${sha[1]}')`, 'the typed revision')
      await until(evaluate, `document.querySelector('header.top .sha')?.textContent === ${JSON.stringify(sha[1].slice(0, 7))}`, 'its page')
    })
  })
})

test('hostile branch names, revs and bases never run or break the page', { skip: skipBrowse }, async () => {
  const { dir } = repo()
  const payload = 'x</script><img/src=x/onerror=window.PWNED=1>'
  execFileSync('git', ['branch', payload, 'feature'], { cwd: dir })
  const q = encodeURIComponent(payload)
  // The only </script that may appear is the page's own two.
  const closers = (html: string) => (html.match(/<\/script/gi) ?? []).length
  await withServer(dir, async (url) => {
    for (const path of [`?rev=main..feature&head=${q}&base=main`, `?head=feature&base=${q}&rev=HEAD`, `?head=${q}&base=${q}`, `?rev=${q}`, `?rev=${q}&head=${q}&base=${q}`]) {
      const r = await fetch(url + path, { redirect: 'manual' })
      const html = await r.text()
      assert.doesNotMatch(html, /<img/i, `${path}: no markup from the data`)
      if (r.status === 200) assert.equal(closers(html), 2, `${path}: no </script from data`)
      else assert.ok(r.status === 302 || r.status === 422, `${path}: ${r.status}`)
    }
    // A real branch with that name: the picker lists it literally.
    await browse(url + `?rev=feature&head=${q}&base=main`, async (evaluate) => {
      assert.equal(await evaluate("document.querySelector('header.top .combo-btn').textContent"), payload, 'the picker shows the literal text')
      await evaluate("document.querySelector('header.top .combo-btn').click()")
      assert.ok(await evaluate(`[...document.querySelectorAll('.combo-panel:not([hidden]) .combo-item')].some(b => b.textContent === ${JSON.stringify(payload)})`), 'and so does the list')
      assert.equal(await evaluate("document.querySelectorAll('img').length"), 0, 'no element was made from it')
      assert.equal(await evaluate("typeof window.PWNED"), 'undefined', 'no handler ran')
    })
    // A gone branch of that name: the notice shows it literally.
    await browse(url + `?rev=feature&head=${q}gone&base=${q}gone`, async (evaluate) => {
      assert.equal(await evaluate("document.querySelector('.ary-notice').textContent.includes(" + JSON.stringify(payload + 'gone') + ")"), true, 'the notice shows the literal text')
      assert.equal(await evaluate("document.querySelectorAll('img').length"), 0)
      assert.equal(await evaluate("typeof window.PWNED"), 'undefined')
      assert.equal(await evaluate("document.querySelectorAll('header.top').length"), 1, 'the page is intact')
    })
  })
})

test('in a browser, the rail fits under a sticky top bar on wide screens (ary and html pages)', { skip: skipBrowse }, async () => {
  const { dir, sha } = repo()
  const out = join(dir, 'view.html')
  execFileSync(process.execPath, [BIN, 'html', 'main..feature', '-o', out], { cwd: dir, stdio: 'pipe' })
  const check = async (evaluate: (js: string) => Promise<unknown>, send: (m: string, p?: object) => Promise<any>, what: string) => {
    await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 300, deviceScaleFactor: 1, mobile: false })
    for (const y of [0, 400]) {
      await evaluate(`window.scrollTo(0, ${y})`)
      await sleep(100)
      assert.equal(await evaluate("document.querySelector('header.top').getBoundingClientRect().top"), 0, `${what}: top bar at the top (scroll ${y})`)
      assert.equal(await evaluate('document.querySelector(".rail").getBoundingClientRect().bottom <= innerHeight'), true, `${what}: the whole rail is reachable (scroll ${y})`)
    }
  }
  await withServer(dir, async (url) => {
    await browse(url + '?rev=main..feature&head=feature&base=main', (evaluate, send) => check(evaluate, send, 'ary range'))
    await browse(url + `?rev=${sha[2]}&head=feature&base=main`, (evaluate, send) => check(evaluate, send, 'ary commit'))
  })
  await browse(`file://${out}`, (evaluate, send) => check(evaluate, send, 'html range'))
})
