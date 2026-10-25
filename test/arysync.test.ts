import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { execFileSync, spawn, spawnSync } from './run.ts'
import { waitFor } from './browser.ts'
import { tmp } from './tmp.ts'
import { within } from './timing.ts'

// `git gloss ary` must never let git block its event loop: a page is built in a
// child process (its own process group), so a hung git costs one request, not the server.
const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')
const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim()
const alive = (pid: number) => {
  try { return !/^\d+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')) } catch { return false }
}
const goneNow = (pids: number[]) => pids.length > 0 && !pids.some(alive)
const reap = (pids: number[]) => { for (const p of pids) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } } }

// A repo (main, and feature with two commits) and a fake `git` first on PATH: it logs every call,
// and while the file `hang` exists it hangs on `for-each-ref` (the first call of a page),
// recording its pid and that of a sleeping child of its own, then waits.
function fixture(extra?: (dir: string, g: (...a: string[]) => string) => void) {
  const dir = tmp('arysync-')
  const g = (...a: string[]) => execFileSync(realGit, a, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const commit = (msg: string, text: string) => { writeFileSync(join(dir, 'app.js'), text + '\n'); g('add', '-A'); g('commit', '-qm', msg) }
  commit('base', 'a')
  g('checkout', '-q', '-b', 'feature')
  commit('one', 'b')
  commit('two', 'c')
  extra?.(dir, g)
  const fake = join(dir, 'fakebin')
  mkdirSync(fake)
  const log = join(dir, 'calls.log')
  const pids = join(dir, 'pids')
  const hang = join(dir, 'hang')
  writeFileSync(join(fake, 'git'), `#!/bin/sh
echo "$*" >> '${log}'
if [ -e '${hang}' ]; then case " $* " in *" for-each-ref "*)
  echo $$ >> '${pids}'; sleep 60 & echo $! >> '${pids}'; wait ;;
esac; fi
exec '${realGit}' "$@"
`)
  chmodSync(join(fake, 'git'), 0o755)
  const list = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])
  return {
    dir, hang, g,
    env: { ...process.env, PATH: `${fake}:${process.env.PATH}` } as Record<string, string>,
    pids: () => list(pids).map(Number),
    calls: () => list(log).length,
    forEachRefCalls: () => list(log).filter((l) => l.includes('for-each-ref')).length,
  }
}
type Fx = ReturnType<typeof fixture>

// Runs `git gloss ary` in the fixture for the duration of fn; the fixture's git children are reaped at the end.
async function serve(fx: Fx, env: Record<string, string>, fn: (url: string, port: number, child: ReturnType<typeof spawn>) => Promise<void>) {
  const child = spawn(process.execPath, [BIN, 'ary', '--no-open'], { cwd: fx.dir, env: { ...fx.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let out = ''
      child.stdout!.on('data', (d) => { out += d; if (out.includes('\n')) resolve(out.split('\n')[0]) })
      child.on('exit', (code) => reject(new Error(`exited with ${code} before listening`)))
    })
    await fn(url, Number(new URL(url).port), child)
  } finally {
    child.kill('SIGKILL')
    reap(fx.pids())
  }
}
const quiet = (p: Promise<unknown>) => { p.catch(() => {}) }
// raw request: fetch will not set Host
const rawStatus = (port: number, host: string) => new Promise<number>((resolve, reject) => {
  request({ host: '127.0.0.1', port, path: '/', headers: { host } }, (r) => { r.resume(); resolve(r.statusCode!) }).on('error', reject).end()
})
const hungCount = (fx: Fx, n: number) => waitFor(async () => fx.pids().length >= n, `${n} hung git processes`, 15_000)

test('a page stuck in a hung git does not block any other request', async () => {
  const fx = fixture()
  writeFileSync(fx.hang, '')
  // the limit is long for the 8 s the old synchronous server would stay blocked
  await serve(fx, { GIT_GLOSS_GIT_TIMEOUT: '8000' }, async (url, port) => {
    const ac = new AbortController()
    quiet(fetch(url + '?rev=HEAD', { signal: ac.signal }))
    await hungCount(fx, 2)
    rmSync(fx.hang)
    const t0 = performance.now()
    assert.equal((await fetch(url + 'nowhere')).status, 404)
    assert.equal(await rawStatus(port, `evil.example:${port}`), 403)
    assert.equal((await fetch(url, { method: 'POST' })).status, 405)
    assert.equal((await fetch(url + '?rev=--x')).status, 400)
    const page = await fetch(url + '?rev=HEAD')
    assert.equal(page.status, 200, 'a second page, on the fast path, is built meanwhile')
    assert.match(await page.text(), /id="gloss-data"/)
    within('requests answered while a git hangs', performance.now() - t0, 4000) // the old server stayed blocked for the 8 s limit; a loaded machine needs more than 1 s
    ac.abort()
  })
})

test('a job over the time limit gets a 504 page, and its git process group is killed', async () => {
  const fx = fixture()
  writeFileSync(fx.hang, '')
  await serve(fx, { GIT_GLOSS_ARY_TIMEOUT: '4000', GIT_GLOSS_GIT_TIMEOUT: '60000' }, async (url) => {
    const t0 = performance.now()
    const r = await fetch(url + '?rev=HEAD')
    within('504 answered', performance.now() - t0, 12000)
    assert.equal(r.status, 504)
    assert.match(await r.text(), /took longer than 4 s/)
    const pids = fx.pids()
    assert.ok(pids.length >= 2, 'the fake git and its sleep never started')
    await waitFor(async () => goneNow(pids), 'the hung git group to be gone', 10_000)
    // the server is fine afterwards (a build may still take over the 4 s limit on a loaded machine: retry)
    rmSync(fx.hang)
    await waitFor(async () => (await fetch(url + '?rev=HEAD')).status === 200, 'a page built after the hang is gone', 15_000)
  })
})

test('one git over its own limit is still a 422 with the git message', async () => {
  const fx = fixture()
  writeFileSync(fx.hang, '')
  await serve(fx, { GIT_GLOSS_GIT_TIMEOUT: '1500' }, async (url) => {
    const r = await fetch(url + '?rev=HEAD')
    assert.equal(r.status, 422)
    assert.match(await r.text(), /git for-each-ref .* timed out after 1\.5 s/)
    await waitFor(async () => goneNow(fx.pids()), 'the timed-out git to be gone', 10_000)
  })
})

test('at most GIT_GLOSS_ARY_JOBS pages are built at once; more get an immediate 503 with Retry-After', async () => {
  const fx = fixture()
  writeFileSync(fx.hang, '')
  await serve(fx, { GIT_GLOSS_ARY_JOBS: '2', GIT_GLOSS_GIT_TIMEOUT: '60000', GIT_GLOSS_ARY_TIMEOUT: '60000' }, async (url) => {
    const a = new AbortController()
    const b = new AbortController()
    quiet(fetch(url + '?rev=HEAD', { signal: a.signal }))
    quiet(fetch(url + '?rev=feature', { signal: b.signal }))
    await hungCount(fx, 4)
    const before = fx.forEachRefCalls()
    const t0 = performance.now()
    const third = await fetch(url + '?rev=main')
    within('503 answered', performance.now() - t0, 1000)
    assert.equal(third.status, 503)
    assert.equal(third.headers.get('retry-after'), '1')
    await third.text()
    assert.equal(fx.forEachRefCalls(), before, 'no third build was started')
    assert.equal((await fetch(url + 'nowhere')).status, 404, 'not-page requests are not counted')
    // a finished (here: abandoned) job frees its slot
    rmSync(fx.hang)
    a.abort()
    await waitFor(async () => (await fetch(url + '?rev=main')).status === 200, 'a free slot after a client left', 15_000)
    b.abort()
  })
})

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  test(`${sig} of \`git gloss ary\` kills its running git children`, async () => {
    const fx = fixture()
    writeFileSync(fx.hang, '')
    await serve(fx, { GIT_GLOSS_GIT_TIMEOUT: '60000', GIT_GLOSS_ARY_TIMEOUT: '60000' }, async (url, _port, child) => {
      quiet(fetch(url + '?rev=HEAD'))
      await hungCount(fx, 2)
      const pids = fx.pids()
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
      child.kill(sig)
      await exited
      await waitFor(async () => goneNow(pids), 'the children to be gone', 10_000)
    })
  })
}

test('closing the server kills running children', async () => {
  const fx = fixture()
  writeFileSync(fx.hang, '')
  const { createAry } = await import('../src/ary/server.ts')
  const saved = { cwd: process.cwd(), path: process.env.PATH, t: process.env.GIT_GLOSS_ARY_TIMEOUT }
  process.chdir(fx.dir)
  process.env.PATH = fx.env.PATH
  process.env.GIT_GLOSS_ARY_TIMEOUT = '60000'
  let port = 0
  const server = createAry(() => port, { execArgv: [] }) // the runner's own flags (--import ./test/guard.ts) are relative to its cwd
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    quiet(fetch(`http://127.0.0.1:${port}/?rev=HEAD`))
    await hungCount(fx, 2)
    const pids = fx.pids()
    await new Promise<void>((resolve) => { server.close(() => resolve()) })
    await waitFor(async () => goneNow(pids), 'the children to be gone', 10_000)
  } finally {
    server.close()
    reap(fx.pids())
    process.chdir(saved.cwd)
    process.env.PATH = saved.path
    if (saved.t === undefined) delete process.env.GIT_GLOSS_ARY_TIMEOUT; else process.env.GIT_GLOSS_ARY_TIMEOUT = saved.t
  }
})

test('a client that disconnects kills its job', async () => {
  const fx = fixture()
  writeFileSync(fx.hang, '')
  await serve(fx, { GIT_GLOSS_GIT_TIMEOUT: '60000', GIT_GLOSS_ARY_TIMEOUT: '60000' }, async (url) => {
    const ac = new AbortController()
    quiet(fetch(url + '?rev=HEAD', { signal: ac.signal }))
    await hungCount(fx, 2)
    const pids = fx.pids()
    ac.abort()
    await waitFor(async () => goneNow(pids), 'the abandoned job\'s git to be gone', 10_000)
    rmSync(fx.hang)
    assert.equal((await fetch(url + '?rev=HEAD')).status, 200, 'the server carries on')
  })
})

test('hostile queries are refused in the main process: no child, no git', async () => {
  const fx = fixture()
  await serve(fx, {}, async (url) => {
    const before = fx.calls()
    const bad = ['rev=' + 'a'.repeat(100_000), 'rev=' + 'a'.repeat(5000), 'rev=a%00b', 'rev=--output=x', 'head=--all', 'base=-x', 'head=' + 'b'.repeat(501)]
    for (const q of bad) {
      const r = await fetch(url + '?' + q)
      // node itself refuses a 100 KB request line (431) before our handler sees it
      assert.ok(r.status === 400 || (r.status === 431 && q.length > 50_000), `${q.slice(0, 40)}: ${r.status}`)
      await r.text()
    }
    assert.equal(fx.calls(), before, 'git ran for a request that should have been refused first')
    assert.equal(fx.pids().length, 0)
    assert.equal((await fetch(url + '?rev=HEAD')).status, 200, 'a good one does start git')
    assert.ok(fx.calls() > before)
  })
})

test('a multi-megabyte page is streamed from the child intact; a page over the output cap is a 502', async () => {
  const fx = fixture((dir, g) => {
    const lines = Array.from({ length: 30_000 }, (_, i) => `line ${i} ${'x'.repeat(90)}`).join('\n')
    writeFileSync(join(dir, 'big.txt'), lines + '\n')
    g('add', '-A'); g('commit', '-qm', 'big')
  })
  const size = (await (async () => {
    const dirNow = process.cwd()
    process.chdir(fx.dir)
    try {
      const { buildDesk, parseQuery } = await import('../src/ary/desk.ts')
      return Buffer.byteLength(buildDesk(parseQuery(new URL('http://localhost/?rev=HEAD'))).body)
    } finally { process.chdir(dirNow) }
  })())
  assert.ok(size > 3_000_000, `the page should be a few MB, is ${size}`)
  await serve(fx, {}, async (url) => {
    const r = await fetch(url + '?rev=HEAD')
    assert.equal(r.status, 200)
    assert.equal(Buffer.byteLength(await r.text()), size, 'every byte arrived')
  })
  await serve(fx, { GIT_GLOSS_ARY_MAX_OUTPUT: '100000' }, async (url) => {
    const r = await fetch(url + '?rev=HEAD')
    assert.equal(r.status, 502)
    assert.match(await r.text(), /more than 100000 bytes/)
  })
})

test('the page is byte-identical to the one the synchronous code builds', async () => {
  const fx = fixture()
  const { buildDesk, parseQuery } = await import('../src/ary/desk.ts')
  const { GlossError } = await import('../src/git.ts')
  const nonceOf = (html: string) => /nonce-([^']+)'/.exec(html)?.[1]
  // the nonce and the generation time differ on every build; nothing else may
  const norm = (html: string) => { const n = nonceOf(html); return (n ? html.replaceAll(n, 'NONCE') : html).replace(/"generated":"[^"]+"/, '"generated":"T"') }
  const paths = ['', '?rev=HEAD', '?rev=main..feature&head=feature&base=main', '?head=main', '?head=gone&base=main', '?rev=wip', '?rev=nope']
  await serve(fx, {}, async (url) => {
    for (const p of paths) {
      const served = await fetch(url + p, { redirect: 'manual' })
      const body = await served.text()
      const before = process.cwd()
      process.chdir(fx.dir)
      let want: { status: number; body: string; headers: Record<string, string> }
      try { want = buildDesk(parseQuery(new URL('http://localhost/' + p))) } catch (e) {
        if (!(e instanceof GlossError)) throw e
        assert.equal(served.status, 422, p)
        assert.match(body, new RegExp(e.message.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, '.{1,6}')), p)
        continue
      } finally { process.chdir(before) }
      assert.equal(served.status, want.status, p)
      const [x, y] = [norm(body), norm(want.body)]
      let i = 0
      while (i < x.length && x[i] === y[i]) i++
      assert.ok(x === y, `${p}: body differs at ${i}: served ${JSON.stringify(x.slice(i - 40, i + 60))} vs inline ${JSON.stringify(y.slice(i - 40, i + 60))}`)
      for (const [k, v] of Object.entries(want.headers)) assert.equal(served.headers.get(k), v, `${p}: ${k}`)
    }
  })
})

test('SIGHUP and SIGQUIT of `git gloss ary` kill its running git children', async () => {
  for (const sig of ['SIGHUP', 'SIGQUIT'] as const) {
    const fx = fixture()
    writeFileSync(fx.hang, '')
    await serve(fx, { GIT_GLOSS_GIT_TIMEOUT: '60000', GIT_GLOSS_ARY_TIMEOUT: '60000' }, async (url, _port, child) => {
      quiet(fetch(url + '?rev=HEAD'))
      await hungCount(fx, 2)
      const pids = fx.pids()
      const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()))
      child.kill(sig)
      await exited
      await waitFor(async () => goneNow(pids), `the children to be gone after ${sig}`, 10_000)
    })
  }
})

test('a time limit above what setTimeout can hold means no limit, not an instant 504', async () => {
  const fx = fixture()
  await serve(fx, { GIT_GLOSS_ARY_TIMEOUT: '5000000000' }, async (url) => {
    assert.equal((await fetch(url + '?rev=HEAD')).status, 200)
  })
})

test('a job child that cannot start gets a 500 and gives its slot back', async () => {
  const fx = fixture()
  const { createAry } = await import('../src/ary/server.ts')
  const saved = process.cwd()
  process.chdir(fx.dir)
  let port = 0
  const server = createAry(() => port, { max: 2, execPath: join(fx.dir, 'no-such-node') })
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    // more requests than slots, one after another: a leaked slot would turn the third into a 503
    for (let i = 0; i < 5; i++) assert.equal((await fetch(`http://127.0.0.1:${port}/?rev=HEAD`)).status, 500, `request ${i}`)
  } finally {
    server.close()
    process.chdir(saved)
  }
})

test('the job child gets the parent\'s execArgv', async () => {
  const fx = fixture()
  // a node that records its arguments, then runs the real one
  const shim = join(fx.dir, 'node-shim')
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> '${join(fx.dir, 'args')}'\nexec '${process.execPath}' "$@"\n`)
  chmodSync(shim, 0o755)
  const { createAry } = await import('../src/ary/server.ts')
  const saved = process.cwd()
  process.chdir(fx.dir)
  let port = 0
  const server = createAry(() => port, { execPath: shim, execArgv: ['--no-warnings'] })
  const { childExecArgv } = await import('../src/ary/jobs.ts')
  assert.deepEqual(childExecArgv(['--input-type=module', '-e', 'run()', '--import', './x.ts', '--experimental-strip-types', '--no-warnings', '--max-old-space-size=512']), ['--experimental-strip-types', '--no-warnings', '--max-old-space-size=512'], 'only flags the child needs are passed on, never a parent\'s -e script')
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
    assert.equal((await fetch(`http://127.0.0.1:${port}/?rev=HEAD`)).status, 200)
    assert.match(readFileSync(join(fx.dir, 'args'), 'utf8'), /^--no-warnings .*page-job\.(ts|js) /)
  } finally {
    server.close()
    process.chdir(saved)
  }
})
