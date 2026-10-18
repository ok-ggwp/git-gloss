import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'reviews-test-'))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const write = (file: string, lines: string[]) => writeFileSync(join(dir, file), lines.join('\n') + '\n')
  const commit = (msg: string, groups?: object[]) => {
    g('add', '-A')
    g('commit', '-qm', msg)
    if (groups) assert.equal(gloss(dir, ['add'], JSON.stringify({ task: msg, groups })).code, 0)
    return g('rev-parse', 'HEAD')
  }
  write('app.js', ['function main() {', '  run()', '}'])
  commit('base')
  return { dir, g, write, commit }
}

const group = (id: string, hunks: string[], intent = `${id} intent`) =>
  ({ id, hunks, intent, necessity: 'required', serves: 'task', removal_impact: `no ${id}` })

// What git-gud does: stamp what the reviewer will see, review, record.
function review(dir: string, rev: string, stage = 'honesty', findings = 'Looks accurate.') {
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  const r = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage, agent: 'claude', mode: 'direct', target: rev, findings, stamp }))
  assert.equal(r.code, 0, r.err)
  return r.out
}

test('a recorded review shows on the commit until its gloss or code changes', () => {
  const { dir, g, write, commit } = repo()
  // init makes glosses and reviews follow amends.
  assert.equal(gloss(dir, ['init']).code, 0)
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('add stop', [group('stop', ['h1'])])
  assert.match(gloss(dir, ['show']).out, /reviews: none recorded/)
  assert.match(review(dir, 'HEAD'), /recorded the honesty review on 1 commit/)
  assert.match(gloss(dir, ['show']).out, /reviews: honesty: reviewed \(claude, \d{4}-\d\d-\d\d\)/)

  // A re-gloss that changes what a group claims is no longer the reviewed gloss.
  assert.equal(gloss(dir, ['add', '--force'], JSON.stringify({ task: 'add stop', groups: [group('stop', ['h1'], 'Something else entirely')] })).code, 0)
  assert.match(gloss(dir, ['show']).out, /honesty: gloss changed since review/)

  // Changed code is no longer the reviewed code, whatever the gloss says.
  write('app.js', ['function main() {', '  run()', '  stop()', '  more()', '}'])
  g('commit', '-qa', '--amend', '--no-edit')
  assert.match(gloss(dir, ['show']).out, /honesty: code changed since review/)

  const list = gloss(dir, ['reviews']).out
  assert.match(list, /── honesty by claude \(direct\)/)
  assert.match(list, /Looks accurate\./)
})

test('a range counts the commits whose gloss was honesty-reviewed', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('a.js', ['a'])
  commit('a', [group('a', ['h1'])])
  write('b.js', ['b'])
  commit('b', [group('b', ['h1'])])
  review(dir, 'HEAD~1')
  review(dir, 'HEAD', 'bugs')
  assert.match(gloss(dir, ['show', 'main..feat']).out, /2 commits, 2 glossed, 1 honesty-reviewed/)
  review(dir, 'main..feat')
  assert.match(gloss(dir, ['show', 'main..feat']).out, /2 commits, 2 glossed, 2 honesty-reviewed/)
})

test('a review of uncommitted work follows its gloss onto the commit', () => {
  const { dir, g, write } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(dir, ['hunks', 'wip'])
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  review(dir, 'wip')
  g('commit', '-qam', 'stop')
  assert.equal(gloss(dir, ['adopt']).code, 0)
  assert.match(gloss(dir, ['show']).out, /honesty: reviewed/)
})

test('a squash is covered by its commits\' reviews together', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const one = commit('one', [group('one', ['h1'])])
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  const two = commit('two', [group('two', ['h1'])])
  review(dir, one)
  review(dir, two)
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')
  assert.equal(gloss(dir, ['carry', 'main~1..feat']).code, 0)
  assert.match(gloss(dir, ['show']).out, /honesty: reviewed \(claude, [^)]*2 reviews\)/)
})

test('sync shares reviews, keeping both sides\'; fetching works before anyone has pushed one', () => {
  const origin = mkdtempSync(join(tmpdir(), 'reviews-origin-'))
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const a = repo()
  a.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  a.commit('stop', [group('stop', ['h1'])])
  a.g('remote', 'add', 'origin', origin)
  a.g('push', '-q', '-u', 'origin', 'main')
  assert.equal(gloss(a.dir, ['init']).code, 0)
  a.g('fetch', '-q', 'origin')
  assert.equal(gloss(a.dir, ['sync']).code, 0)

  const b = mkdtempSync(join(tmpdir(), 'reviews-b-'))
  execFileSync('git', ['clone', '-q', origin, b])
  execFileSync('git', ['config', 'user.email', 'b@example.com'], { cwd: b })
  execFileSync('git', ['config', 'user.name', 'B'], { cwd: b })
  assert.equal(gloss(b, ['sync']).code, 0)

  review(a.dir, 'HEAD', 'honesty', 'A says the gloss is accurate.')
  review(b, 'HEAD', 'bugs', 'B found no bugs.')
  assert.match(gloss(a.dir, ['sync']).out, /reviews: fetched 0, pushed 1/)
  assert.match(gloss(b, ['sync']).out, /reviews: fetched 1, pushed 1/)
  assert.equal(gloss(a.dir, ['sync']).code, 0)
  for (const dir of [a.dir, b]) {
    const out = gloss(dir, ['reviews']).out
    assert.match(out, /A says the gloss is accurate\./)
    assert.match(out, /B found no bugs\./)
  }
})

test('the HTML view shows each commit\'s reviews, findings as text', () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop', [group('stop', ['h1'])])
  review(dir, 'HEAD', 'honesty', '<script>alert(1)</script> accurate')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  const html = readFileSync(out, 'utf8')
  const data = JSON.parse(/<script type="application\/json" id="gloss-data">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? 'null')
  assert.ok(data, 'the page embeds its data')
  assert.equal(data.commits[0].reviews[0].stage, 'honesty')
  assert.equal(data.commits[0].reviews[0].state, 'seen')
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, 'findings never land in the page as markup')
})

const chromium = ['chromium', 'google-chrome-stable', 'google-chrome'].find((b) => spawnSync('which', [b]).status === 0)

// Drives headless Chromium over the DevTools protocol, so the test can click.
async function browse(url: string, steps: (evaluate: (js: string) => Promise<unknown>) => Promise<void>) {
  const port = 9300 + Math.floor(Math.random() * 600)
  const { spawn } = await import('node:child_process')
  const chrome = spawn(chromium!, ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, 'about:blank'], { stdio: 'ignore' })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  try {
    let targets: { type: string; webSocketDebuggerUrl: string }[] | undefined
    for (let i = 0; i < 100 && !targets; i++) {
      await sleep(100)
      try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() } catch { /* not up yet */ }
    }
    const ws = new WebSocket(targets!.find((t) => t.type === 'page')!.webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r))
    let id = 0
    const pending = new Map<number, (v: any) => void>()
    ws.addEventListener('message', (m) => {
      const d = JSON.parse(String(m.data))
      pending.get(d.id)?.(d.result)
      pending.delete(d.id)
    })
    const send = (method: string, params = {}) => new Promise<any>((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })) })
    await send('Page.enable')
    await send('Page.navigate', { url })
    for (let i = 0; i < 50 && !(await send('Runtime.evaluate', { expression: '!!document.querySelector("main .commit")', returnByValue: true })).result.value; i++) await sleep(100)
    await steps(async (js) => (await send('Runtime.evaluate', { expression: js, returnByValue: true })).result.value)
    ws.close()
  } finally {
    chrome.kill()
  }
}

test('in a real browser, a review opens on click and its findings stay text', { skip: !chromium && 'no Chromium found' }, async () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop', [group('stop', ['h1'])])
  review(dir, 'HEAD', 'honesty', 'Accurate. <img src=x onerror="document.title=1"><b>not bold</b>')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    assert.match(String(await evaluate("document.querySelector('details.review summary').textContent")), /^honesty: reviewed/)
    assert.equal(await evaluate("document.querySelector('details.review').open"), false)
    await evaluate("document.querySelector('details.review summary').click()")
    assert.equal(await evaluate("document.querySelector('details.review').open"), true)
    assert.match(String(await evaluate("document.querySelector('pre.findings').textContent")), /<b>not bold<\/b>/)
    assert.equal(await evaluate("document.querySelectorAll('pre.findings b, pre.findings img').length"), 0)
    assert.notEqual(await evaluate('document.title'), '1')
  })
})

test('the verdict a review ends with is recorded and shown, so reviewed never reads as passed', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('a.js', ['a'])
  commit('a', [group('a', ['h1'])])
  write('b.js', ['b'])
  commit('b', [group('b', ['h1'])])
  review(dir, 'HEAD~1', 'honesty', 'All accurate.\n\nVERDICT: CLEAN')
  review(dir, 'HEAD', 'honesty', 'Group b is graded required but nothing uses it.\n\n**VERDICT: ISSUES**')
  assert.match(gloss(dir, ['show', 'HEAD~1']).out, /honesty: no issues \(claude/)
  assert.match(gloss(dir, ['show', 'HEAD']).out, /honesty: issues found \(claude/)
  assert.match(gloss(dir, ['show', 'main..feat']).out, /2 honesty-reviewed \(1 with issues\)/)
  // The author fixes the gloss and has it reviewed again: the new verdict
  // decides, and the earlier issues stay visible.
  assert.equal(gloss(dir, ['add', '--force'], JSON.stringify({ task: 'b', groups: [{ ...group('b', ['h1']), necessity: 'speculative' }] })).code, 0)
  assert.match(gloss(dir, ['show', 'HEAD']).out, /honesty: gloss changed since review/)
  review(dir, 'HEAD', 'honesty', 'Grading fixed.\nVERDICT: CLEAN')
  assert.match(gloss(dir, ['show', 'HEAD']).out, /honesty: no issues \(claude, [^)]*2 reviews; an earlier review found issues\)/)
  assert.match(gloss(dir, ['show', 'main..feat']).out, /2 honesty-reviewed\n/)
})

test('what a review vouches for: risks, repeated lines, and verdicts only from the report\'s end', () => {
  const { dir, g, write, commit } = repo()
  assert.equal(gloss(dir, ['init']).code, 0)
  write('app.js', ['function main() {', '  run()', '  return null', '}'])
  commit('null')
  const annotation = (risks: string[]) => JSON.stringify({ task: 'null', groups: [group('n', ['h1'])], risks })
  assert.equal(gloss(dir, ['add', '--force'], annotation(['none known'])).code, 0)
  review(dir, 'HEAD', 'honesty', 'Says VERDICT: CLEAN in passing, but:\n\nthe risk list is wrong.\n\nVERDICT: ISSUES')
  assert.match(gloss(dir, ['show']).out, /honesty: issues found/)
  // A later review with no verdict line doesn't clear the issues.
  review(dir, 'HEAD', 'honesty', 'Looked again, mostly fine.')
  assert.match(gloss(dir, ['show']).out, /honesty: issues found/)
  // Changing the gloss's risks is a gloss change.
  assert.equal(gloss(dir, ['add', '--force'], annotation(['writes may be lost on a crash'])).code, 0)
  assert.match(gloss(dir, ['show']).out, /honesty: gloss changed since review/)
  // A second copy of a reviewed line is new code.
  review(dir, 'HEAD', 'bugs', 'No defects.\nVERDICT: CLEAN')
  assert.match(gloss(dir, ['show']).out, /bugs: no defects found/)
  write('app.js', ['function main() {', '  run()', '  return null', '  return null', '}'])
  g('commit', '-qa', '--amend', '--no-edit')
  assert.match(gloss(dir, ['show']).out, /bugs: code changed since review/)
})

test('improve verdicts read as suggestions, and a review before any gloss says so', () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop')
  review(dir, 'HEAD', 'improve', 'Inline the helper.\nVERDICT: ISSUES')
  assert.equal(gloss(dir, ['add'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  assert.match(gloss(dir, ['show']).out, /improve: reviewed before it was glossed/)
  review(dir, 'HEAD', 'improve', 'Inline the helper.\nVERDICT: ISSUES')
  assert.match(gloss(dir, ['show']).out, /improve: suggestions/)
})

test('reviews recorded at the same moment are all kept', async () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop', [group('stop', ['h1'])])
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', 'HEAD']).out)
  const { spawn } = await import('node:child_process')
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'reviews', '--record'], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] })
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`record ${i} exited ${code}`))))
    p.stdin.end(JSON.stringify({ stage: `s${i}`, agent: 'claude', target: 'HEAD', findings: `review ${i}`, stamp }))
  })))
  const out = gloss(dir, ['reviews']).out
  for (let i = 0; i < 8; i++) assert.match(out, new RegExp(`review ${i}\\b`))
})

test('a new snapshot of the work keeps the reviews of the last one', () => {
  const { dir, write } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(dir, ['hunks', 'wip'])
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  review(dir, 'wip', 'bugs', 'Fine.\nVERDICT: CLEAN')
  write('other.js', ['x'])
  gloss(dir, ['hunks', 'wip'])
  assert.match(gloss(dir, ['show', 'wip']).out, /bugs: code changed since review/)
})

test('a binary or mode-only change counts as new code; bad records are skipped, not trusted', () => {
  const { dir, g, write, commit } = repo()
  assert.equal(gloss(dir, ['init']).code, 0)
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop', [group('stop', ['h1'])])
  review(dir, 'HEAD', 'bugs', 'Fine.\nVERDICT: CLEAN')
  assert.match(gloss(dir, ['show']).out, /bugs: no defects found/)
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
  g('add', 'blob.bin')
  g('commit', '-q', '--amend', '--no-edit')
  assert.match(gloss(dir, ['show']).out, /bugs: code changed since review/)

  // A record with an unknown verdict, or a stamp naming no real commit, is refused or ignored.
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', 'HEAD']).out)
  const bad = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'x', target: 'HEAD', findings: 'f', stamp: { ...stamp, ['0'.repeat(40)]: { lines: [], groups: [] } } }))
  assert.match(bad.err, /isn't a commit here/)
  assert.doesNotMatch(gloss(dir, ['reviews']).out, /── bugs by x/, 'nothing was recorded')
  const [sha, seen] = Object.entries(stamp)[0] as [string, { lines: string[]; groups: string[] }]
  const forged = { review: 1, id: 'f', at: '2099-01-01T00:00:00Z', stage: 'bugs', agent: 'x', target: 'HEAD', findings: 'f', verdict: 'maybe', ...seen }
  g('notes', '--ref', 'refs/notes/gloss-reviews', 'append', '-m', JSON.stringify(forged), sha)
  assert.doesNotMatch(gloss(dir, ['show']).out, /reviewed \(x/)
})
