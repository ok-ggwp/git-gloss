import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { browse, skipBrowse } from './browser.ts'
import { item, plantLegacy, withBlock, type TestItem } from './block.ts'
import { within } from './timing.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function repo() {
  const dir = tmp('reviews-test-')
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
function review(dir: string, rev: string, stage = 'honesty', findings = 'Looks accurate.', items: TestItem[] = []) {
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  const r = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage, agent: 'claude', mode: 'direct', target: rev, findings: withBlock(findings, items), stamp }))
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
  const origin = tmp('reviews-origin-')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const a = repo()
  a.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  a.commit('stop', [group('stop', ['h1'])])
  a.g('remote', 'add', 'origin', origin)
  a.g('push', '-q', '-u', 'origin', 'main')
  assert.equal(gloss(a.dir, ['init']).code, 0)
  a.g('fetch', '-q', 'origin')
  assert.equal(gloss(a.dir, ['sync']).code, 0)

  const b = tmp('reviews-b-')
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



test('in a real browser, a review opens in the main pane on click and its findings stay text', { skip: skipBrowse }, async () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop', [group('stop', ['h1'])])
  review(dir, 'HEAD', 'honesty', 'Accurate. <img src=x onerror="document.title=1"><b>not bold</b>')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    const rail = "document.querySelector('.rail').textContent"
    assert.match(String(await evaluate("document.querySelector('.rvrow').textContent")), /^honesty.*current/)
    assert.doesNotMatch(String(await evaluate(rail)), /Accurate/, 'no findings in the rail')
    assert.equal(await evaluate("document.querySelectorAll('.rail details').length"), 0)
    await evaluate("document.querySelector('.rvrow').click()")
    assert.equal(await evaluate('location.hash'), '#reviews-honesty')
    assert.match(String(await evaluate("document.querySelector('main .md').textContent")), /<b>not bold<\/b>/)
    assert.equal(await evaluate("document.querySelectorAll('main .md b, main .md img').length"), 0)
    assert.notEqual(await evaluate('document.title'), '1')
    await evaluate("[...document.querySelectorAll('main .btn')].find((b) => b.textContent.includes('Back')).click()")
    assert.equal(await evaluate("location.hash"), '#overview', 'Back returns to the previous selection')
  })
})

const REPORT = [
  '## Verification run', '',
  '- `npm test`: **verified**, 12/12 pass', '  - nested *point* here', '- second item', '',
  '1. first step', '2. second step', '',
  '### Detail', 'a*b*c stays as it is, see [the docs](https://example.com/x).', '',
  '```', 'const x = "**not bold**"', '```', '',
  '<img src=x onerror=alert(1)> </script><script>document.title="pwned"</script>', '',
  'VERDICT: ISSUES',
].join('\n')

test('in a real browser, findings render as markdown without raw syntax or markup', { skip: skipBrowse }, async () => {
  const { dir, g, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop', [group('stop', ['h1'])])
  // An unterminated fence swallows the block, so --record refuses such a report; an old record can still have one.
  plantLegacy(dir, g('rev-parse', 'HEAD'), { stage: 'honesty', findings: 'An older review with an `unterminated fence\n```\nnever closed' })
  review(dir, 'HEAD', 'honesty', REPORT)
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    await evaluate("document.querySelector('.rvrow').click()")
    const q = (sel: string) => evaluate(`document.querySelectorAll('main ${sel}').length`)
    assert.ok(Number(await q('.md h4')) >= 1 && Number(await q('.md h5')) >= 1, 'headings')
    assert.ok(Number(await q('.md li')) >= 5 && Number(await q('.md ol li')) === 2, 'lists: bullets and a numbered list')
    assert.ok(Number(await q('.md ul ul li')) === 1, 'nesting by indentation')
    assert.ok(Number(await q('.md strong')) >= 1 && Number(await q('.md em')) === 1 && Number(await q('.md code')) >= 2)
    const text = String(await evaluate("document.querySelector('main .entry:not(.old) .md').textContent"))
    assert.doesNotMatch(text.replace(/const x = "\*\*not bold\*\*"/, ''), /##|\*\*|`/, 'no raw markdown syntax outside the code block')
    assert.match(text, /a\*b\*c stays as it is, see the docs \(https:\/\/example\.com\/x\)/, 'a * inside a word stays; links are text')
    assert.equal(await q('.md a'), 0, 'review text never makes links')
    assert.match(text, /<img src=x onerror=alert\(1\)> <\/script>/, 'markup stays text')
    assert.equal(await q('.md img, .md script'), 0)
    assert.equal(await evaluate("document.title.includes('pwned')"), false)
    assert.match(String(await evaluate("document.querySelector('main .entry:not(.old) .chip').textContent")), /issues found/)
    // The older review is folded, and an unterminated fence swallows the rest as code instead of throwing.
    assert.equal(await q('details.old'), 1)
    assert.match(String(await evaluate("document.querySelector('details.old .md pre').textContent")), /never closed/)
    assert.equal(await q('.findings'), 0, 'no inner scroll boxes')
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
  const { spawn } = await import('./run.ts')
  await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise<void>((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'reviews', '--record'], { cwd: dir, stdio: ['pipe', 'ignore', 'pipe'] })
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`record ${i} exited ${code}`))))
    p.stdin.end(JSON.stringify({ stage: `s${i}`, agent: 'claude', target: 'HEAD', findings: withBlock(`review ${i}`), stamp }))
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
  const bad = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'x', target: 'HEAD', findings: withBlock('f'), stamp: { ...stamp, ['0'.repeat(40)]: { lines: [], groups: [] } } }))
  assert.match(bad.err, /isn't a commit here/)
  assert.doesNotMatch(gloss(dir, ['reviews']).out, /── bugs by x/, 'nothing was recorded')
  const [sha, seen] = Object.entries(stamp)[0] as [string, { lines: string[]; groups: string[] }]
  const forged = { review: 1, id: 'f', at: '2099-01-01T00:00:00Z', stage: 'bugs', agent: 'x', target: 'HEAD', findings: 'f', verdict: 'maybe', ...seen }
  g('notes', '--ref', 'refs/notes/gloss-reviews', 'append', '-m', JSON.stringify(forged), sha)
  assert.doesNotMatch(gloss(dir, ['show']).out, /reviewed \(x/)
})

test('in a real browser, a #reviews-<stage> link lands on that stage, also at load', { skip: skipBrowse }, async () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  commit('stop', [group('stop', ['h1'])])
  // The report is folded under its findings table, so the length comes from many findings.
  const long = (n: number) => Array.from({ length: n }, (_, i) => item(`f${i}`, { title: 'A finding with a title long enough to take a line of its own on a narrow screen. '.repeat(2) }))
  review(dir, 'HEAD', 'honesty', 'Fine.\n\n' + 'A long paragraph of findings. '.repeat(80), long(60))
  review(dir, 'HEAD', 'bugs', 'No defects.\n\n' + 'Another long paragraph. '.repeat(120), long(60))
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}#reviews-bugs`, async (evaluate) => {
    assert.ok(Math.abs(Number(await evaluate("document.getElementById('rv-bugs').getBoundingClientRect().top"))) < 5, 'the bugs section is at the top')
  })
})

// ---- structured findings: the gloss-findings block ----

const record = (dir: string, rev: string, findings: string, stage = 'bugs') => {
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  return gloss(dir, ['reviews', '--record'], JSON.stringify({ stage, agent: 'claude', target: rev, findings, stamp }))
}
const tipOf = (g: (...a: string[]) => string) => { try { return g('rev-parse', 'refs/notes/gloss-reviews') } catch { return 'none' } }

function glossedStop() {
  const r = repo()
  r.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  r.commit('stop', [group('stop', ['h1'])])
  return r
}

test('--record stores the validated items with the record', () => {
  const { dir, g } = glossedStop()
  const text = withBlock('Prose.\n\nVERDICT: ISSUES', [item('f1', { where: 'app.js:3', detail: 'because', title: 'esc\x1b[31m' }), item('f2', { severity: 'nit', basis: 'verified' })])
  const r = record(dir, 'HEAD', text)
  assert.equal(r.code, 0, r.err)
  const rec = JSON.parse(g('notes', '--ref', 'gloss-reviews', 'show', 'HEAD').split('\n')[0])
  assert.equal(rec.verdict, 'issues')
  assert.equal(rec.findings, text, 'the report is kept as written')
  assert.deepEqual(rec.items.map((i: any) => i.id), ['f1', 'f2'])
  assert.equal(rec.items[0].title, 'esc', 'the escape sequence is stripped')
  assert.equal(rec.items[0].where, 'app.js:3')
})

test('--record refuses a report with no usable block: non-zero, every problem on stderr, nothing written', () => {
  const { dir, g } = glossedStop()
  const tip0 = tipOf(g)
  const cases: [string, string, RegExp[]][] = [
    ['no block', 'Looks fine.\n\nVERDICT: CLEAN', [/no gloss-findings block/]],
    ['the legacy format', '## 1. Mismatches\n- f.ts:1 wrong\n- g.ts:2 wrong\n\nVERDICT: ISSUES', [/no gloss-findings block/]],
    ['malformed JSON', '```gloss-findings\n[{"id": "f1",]\n```\nVERDICT: ISSUES', [/not valid JSON/]],
    ['several problems', '```gloss-findings\n[{"id":"a b","kind":"x","severity":"huge","basis":"guess","title":""},{"id":"f2","kind":"defect","severity":"minor","basis":"read","title":"t"},{"id":"f2","kind":"defect","severity":"minor","basis":"read","title":"t"}]\n```\nVERDICT: ISSUES', [/item 1 .*"id"/, /item 1.*"kind" must be one of/, /item 1.*"severity"/, /item 1.*"basis"/, /item 1.*"title"/, /item 3 \("f2"\): "id" repeats item 2/]],
    ['a block in an example fence only', '````\n```gloss-findings\n[]\n```\n````\nVERDICT: CLEAN', [/no gloss-findings block/]],
    ['an unclosed fence', 'text\n```gloss-findings\n[]\nVERDICT: CLEAN', [/not closed/]],
    ['too many items', `\`\`\`gloss-findings\n[${Array(201).fill('{}').join(',')}]\n\`\`\`\n`, [/has 201 items; at most 200/]],
  ]
  for (const [name, text, res] of cases) {
    const r = record(dir, 'HEAD', text)
    assert.equal(r.code, 1, name)
    for (const re of res) assert.match(r.err, re, name)
    assert.match(r.err, /nothing was recorded/, name)
    assert.match(r.err, /Put one fenced block at the end of the report/, `${name}: the spec is in the message`)
    assert.doesNotMatch(r.err, /\n\s+at /, name)
    assert.equal(r.out, '', name)
    assert.equal(tipOf(g), tip0, `${name}: nothing was written`)
  }
})

test('--record: hostile blocks are refused quickly (10 MB, 100,000 items), and never reach the ref', () => {
  const { dir, g } = glossedStop()
  const tip0 = tipOf(g)
  const cases: [string, string, RegExp][] = [
    ['10 MB block', `\`\`\`gloss-findings\n[{"id":"f1","detail":"${'x'.repeat(10 * 1024 * 1024)}"}]\n\`\`\`\n`, /too long/],
    ['100k items', `\`\`\`gloss-findings\n[${Array(100_000).fill('{}').join(',')}]\n\`\`\`\n`, /too long/],
    ['80k items under the size cap', `\`\`\`gloss-findings\n[${Array(80_000).fill('{}').join(',')}]\n\`\`\`\n`, /at most 200/],
    ['escape sequences in ids', withBlock('x', [item('f\x1b]52;c;AAAA\x07'), item('f‮2')]), /"id" must be/],
    ['__proto__ twice', '```gloss-findings\n[{"id":"__proto__","kind":"defect","severity":"minor","basis":"read","title":"a"},{"id":"__proto__","kind":"defect","severity":"minor","basis":"read","title":"a"}]\n```\n', /repeats item 1/],
    ['deep nesting', '```gloss-findings\n' + '['.repeat(100_000) + ']'.repeat(100_000) + '\n```\n', /not valid JSON|is not an object/],
  ]
  for (const [name, text, re] of cases) {
    const t0 = performance.now()
    const r = record(dir, 'HEAD', text)
    within(name, performance.now() - t0, 8000)
    assert.equal(r.code, 1, name)
    assert.match(r.err, re, name)
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/.test(r.err), `${name}: no control characters in the message`)
    assert.ok(r.err.length < 20_000, `${name}: the message stays short`)
    assert.equal(tipOf(g), tip0, name)
  }
})

test('the last gloss-findings fence counts; an example in a longer fence does not; VERDICT rules are as before', () => {
  const { dir, g } = glossedStop()
  const two = `${withBlock('first.', [item('a1')])}\nsecond:\n\`\`\`gloss-findings\n${JSON.stringify([item('b1')])}\n\`\`\`\n\nVERDICT: ISSUES\n`
  assert.equal(record(dir, 'HEAD', two).code, 0)
  const example = '````markdown\n```gloss-findings\n[{"id":"x1","kind":"defect","severity":"major","basis":"read","title":"example"}]\n```\n````\n'
  assert.equal(record(dir, 'HEAD', example + withBlock('real.\n\nVERDICT: CLEAN', []), 'honesty').code, 0)
  const recs = g('notes', '--ref', 'gloss-reviews', 'show', 'HEAD').split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(recs.find((r) => r.stage === 'bugs').items.map((i: any) => i.id), ['b1'])
  assert.deepEqual(recs.find((r) => r.stage === 'honesty').items, [])
  assert.equal(recs.find((r) => r.stage === 'honesty').verdict, 'clean')
  // a report with a block but no VERDICT line records with no verdict, as before
  assert.equal(record(dir, 'HEAD', '```gloss-findings\n[]\n```\n', 'improve').code, 0)
  const improve = g('notes', '--ref', 'gloss-reviews', 'show', 'HEAD').split('\n').map((l) => JSON.parse(l)).find((r: any) => r.stage === 'improve')
  assert.equal(improve.verdict, undefined)
})

test('records written before items existed are legacy: listed, shown raw, verdict counted, nothing to decide', () => {
  const { dir, g } = glossedStop()
  const sha = g('rev-parse', 'HEAD')
  const seen = JSON.parse(gloss(dir, ['reviews', '--stamp', 'HEAD']).out)[sha]
  const id = plantLegacy(dir, sha, { findings: 'Old.\n- a\n- b\n\nVERDICT: ISSUES', ...seen })
  const out = gloss(dir, ['reviews']).out
  assert.match(out, new RegExp(`id ${id}`))
  assert.match(out, /- a\n/)
  assert.match(out, /recorded without structured findings/)
  assert.doesNotMatch(out, /findings: \d/)
  assert.match(gloss(dir, ['show']).out, /bugs: defects found/)
  // and a new review next to it works as usual
  assert.equal(record(dir, 'HEAD', withBlock('New.\n\nVERDICT: ISSUES', [item('f1')])).code, 0)
  const both = gloss(dir, ['reviews']).out
  assert.match(both, /1 finding: 1 open/)
  assert.match(both, /recorded without structured findings/)
})

test('a record whose items are not whole is skipped, not read as a legacy review', () => {
  const { dir, g } = glossedStop()
  const sha = g('rev-parse', 'HEAD')
  const good = plantLegacy(dir, sha, { id: 'with-items', items: [item('f1')] })
  assert.match(gloss(dir, ['reviews']).out, /with-items/)
  for (const [id, items] of [['bad-enum', [item('f1', { severity: 'huge' })]], ['not-array', { f1: 1 }], ['dup', [item('f1'), item('f1')]], ['too-many', Array.from({ length: 201 }, (_, i) => item(`f${i}`))], ['proto', [{ id: 'x', kind: 'defect', severity: 'minor', basis: 'read', title: 't', __proto__: { a: 1 } }, 5]]] as [string, unknown][]) {
    plantLegacy(dir, sha, { id, items })
    const r = gloss(dir, ['reviews'])
    assert.doesNotMatch(r.out, new RegExp(`id ${id}\\b`), id)
    assert.match(r.err, /warning: skipped \d+ review records? on .*items that are not valid/, id)
  }
  // --open cannot prove completeness then: it says so too (the exit code is the findings')
  const open = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.match(open.err, /warning: skipped \d+ review records?/)
  assert.ok(good)
})

test('reviews --open: exit 1 and the open findings listed until every one of the current reviews is decided', () => {
  const { dir } = glossedStop()
  // no reviews at all: nothing is open
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 0)
  const rec = record(dir, 'HEAD', withBlock('Two.\n\nVERDICT: ISSUES', [item('f1', { severity: 'major', title: 'null deref' }), item('f2', { title: 'naming' })]))
  assert.equal(rec.code, 0, rec.err)
  const id = /id ([0-9a-f-]{36})/.exec(gloss(dir, ['reviews']).out)![1]
  const open = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.equal(open.code, 1)
  assert.match(open.out, /f1 +major +defect +read +open +null deref/)
  assert.match(open.out, /f2 .*naming/)
  assert.match(open.out, /2 open findings/)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'fixed']).code, 0)
  const one = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.equal(one.code, 1)
  assert.doesNotMatch(one.out, /null deref/)
  assert.match(one.out, /1 open finding\n/)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f2', '--outcome', 'rejected']).code, 0)
  const none = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.equal(none.code, 0)
  assert.match(none.out, /no open findings/)
  // --open takes no companions
  for (const extra of [['--record'], ['--stamp'], ['--decide', id], ['--finding', 'f1']]) assert.match(gloss(dir, ['reviews', 'HEAD', '--open', ...extra]).err, /--open cannot be combined/)
})

test('reviews --open: every item of every structured review counts, once; a stale review is labelled, never dropped', () => {
  const { dir, g, write, commit } = repo()
  assert.equal(gloss(dir, ['init']).code, 0)
  g('checkout', '-qb', 'feat')
  write('a.js', ['a'])
  commit('a', [group('a', ['h1'])])
  write('b.js', ['b'])
  commit('b', [group('b', ['h1'])])
  assert.equal(record(dir, 'HEAD~1', withBlock('x\nVERDICT: ISSUES', [item('f1')]), 'bugs').code, 0)
  assert.equal(record(dir, 'HEAD', withBlock('y\nVERDICT: ISSUES', [item('g1')]), 'bugs').code, 0)
  const open = gloss(dir, ['reviews', 'main..feat', '--open'])
  assert.equal(open.code, 1)
  assert.match(open.out, /2 open findings\n/)
  // changing b's code makes its review stale: its findings still count, and are said to be stale
  write('b.js', ['b', 'b2'])
  g('commit', '-qa', '--amend', '--no-edit')
  const after = gloss(dir, ['reviews', 'main..feat', '--open'])
  assert.equal(after.code, 1)
  assert.match(after.out, /1 open on stale reviews: bugs g1 \(code changed since; decide them or re-review\)/)
  assert.match(after.out, /2 open findings \(1 on stale reviews\)\n/)
  assert.match(gloss(dir, ['show']).out, /1 open finding \(1 on a stale review\)/)
  // a clean re-run does not clear them
  assert.equal(record(dir, 'HEAD', withBlock('ok\nVERDICT: CLEAN', []), 'bugs').code, 0)
  assert.equal(record(dir, 'HEAD~1', withBlock('ok\nVERDICT: CLEAN', []), 'bugs').code, 0)
  assert.match(gloss(dir, ['reviews', 'main..feat', '--open']).out, /2 open findings/)
  // only decisions open the gate (the stale review's included)
  for (const [rev, f] of [['HEAD~1', 'f1'], ['HEAD', 'g1']] as const) {
    for (const m of gloss(dir, ['reviews', rev]).out.matchAll(/id ([0-9a-f-]{36})/g)) {
      gloss(dir, ['reviews', rev, '--decide', m[1], '--finding', f, '--outcome', 'accepted'])
    }
  }
  assert.equal(gloss(dir, ['reviews', 'main..feat', '--open']).code, 0)
})

test('reviews --open: a review spans commits, so it is counted once, and a decision made through a narrower target counts for the whole review', () => {
  const r = repo()
  for (const f of ['one', 'two']) {
    r.write('app.js', ['function main() {', '  run()', `  ${f}()`, '}'])
    r.g('commit', '-qam', f)
  }
  const range = 'HEAD~2..HEAD'
  const stamp = JSON.parse(gloss(r.dir, ['reviews', '--stamp', range]).out)
  assert.equal(gloss(r.dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'c', target: range, findings: withBlock('p\nVERDICT: ISSUES', [item('f1'), item('f2')]), stamp })).code, 0)
  const id = /id ([0-9a-f-]{36})/.exec(gloss(r.dir, ['reviews', 'HEAD']).out)![1]
  const open = gloss(r.dir, ['reviews', range, '--open'])
  assert.equal(open.code, 1)
  assert.match(open.out, /2 open findings\n/, 'two items, not two per commit')
  // decided through HEAD alone: the range is still decided as a whole
  assert.equal(gloss(r.dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'fixed']).code, 0)
  assert.match(gloss(r.dir, ['reviews', range, '--open']).out, /1 open finding\n/)
  assert.equal(gloss(r.dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f2', '--outcome', 'rejected']).code, 0)
  assert.equal(gloss(r.dir, ['reviews', range, '--open']).code, 0)
  assert.match(gloss(r.dir, ['reviews', range]).out.split('\n').filter((l) => /^ +f1 /.test(l)).join('\n'), /fixed/)
  assert.doesNotMatch(gloss(r.dir, ['reviews', range]).out, /f1 +minor +defect +read +open/, 'the listing agrees with the gate')
})

test('reviews --open fails closed: a record it had to skip (an enum a newer writer added, an oversize record) makes it exit 1, saying why', () => {
  const { dir, g } = glossedStop()
  const sha = g('rev-parse', 'HEAD')
  assert.equal(record(dir, 'HEAD', withBlock('x\nVERDICT: CLEAN', []), 'bugs').code, 0)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 0)
  plantLegacy(dir, sha, { id: 'newer-writer', items: [item('f1', { kind: 'perf' })] })
  const r = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.equal(r.code, 1)
  assert.match(r.err, /warning: skipped 1 review record/)
  assert.match(r.out, /1 review record could not be read on [0-9a-f]{10} \(malformed, over the size caps or invalid items\); the gate cannot pass on what it could not read/)
  // the other readers still work (and warn)
  assert.equal(gloss(dir, ['reviews']).code, 0)
})

test('reviews --open: a newer legacy record hides nothing; a clean re-run clears nothing', () => {
  const { dir, g } = glossedStop()
  const sha = g('rev-parse', 'HEAD')
  assert.equal(record(dir, 'HEAD', withBlock('x\nVERDICT: ISSUES', [item('f1')])).code, 0)
  const id = /id ([0-9a-f-]{36})/.exec(gloss(dir, ['reviews']).out)![1]
  const seen = JSON.parse(gloss(dir, ['reviews', '--stamp', 'HEAD']).out)[sha]
  plantLegacy(dir, sha, { at: '2099-01-01T00:00:00.000Z', ...seen })
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 1)
  assert.equal(record(dir, 'HEAD', withBlock('ok\nVERDICT: CLEAN', [])).code, 0)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 1)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'follow-up']).code, 0)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 0)
})

test('items survive adopt: a wip review keeps its findings and decisions on the commit', () => {
  const { dir, g, write } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(dir, ['hunks', 'wip'])
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  assert.equal(record(dir, 'wip', withBlock('x\nVERDICT: ISSUES', [item('f1', { title: 'kept' }), item('f2')])).code, 0)
  const id = /id ([0-9a-f-]{36})/.exec(gloss(dir, ['reviews', 'wip']).out)![1]
  assert.equal(gloss(dir, ['reviews', 'wip', '--decide', id, '--finding', 'f1', '--outcome', 'fixed']).code, 0)
  g('commit', '-qam', 'stop')
  assert.equal(gloss(dir, ['adopt']).code, 0)
  const rec = JSON.parse(g('notes', '--ref', 'gloss-reviews', 'show', 'HEAD').split('\n').find((l) => l.includes('"review":1'))!)
  assert.deepEqual(rec.items.map((i: any) => i.id), ['f1', 'f2'])
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /f1 +minor +defect +read +fixed +kept/)
  assert.match(out, /2 findings: 1 open, 1 fixed/)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 1)
})

test('items survive carry: the reviews of a squash bring their findings along', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const one = commit('one', [group('one', ['h1'])])
  assert.equal(record(dir, one, withBlock('x\nVERDICT: ISSUES', [item('f1'), item('f2')])).code, 0)
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')
  assert.equal(gloss(dir, ['carry', 'main~1..feat']).code, 0)
  const rec = JSON.parse(g('notes', '--ref', 'gloss-reviews', 'show', 'HEAD').split('\n').find((l) => l.includes('"review":1'))!)
  assert.deepEqual(rec.items.map((i: any) => i.id), ['f1', 'f2'])
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 2 open/)
})

test('items survive a sync round trip, and decisions made on one side arrive on the other', () => {
  const origin = tmp('items-origin-')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  const a = repo()
  a.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  a.commit('stop', [group('stop', ['h1'])])
  a.g('remote', 'add', 'origin', origin)
  a.g('push', '-q', '-u', 'origin', 'main')
  assert.equal(gloss(a.dir, ['init']).code, 0)
  a.g('fetch', '-q', 'origin')
  assert.equal(gloss(a.dir, ['sync']).code, 0)
  const b = tmp('items-b-')
  execFileSync('git', ['clone', '-q', origin, b])
  execFileSync('git', ['config', 'user.email', 'b@example.com'], { cwd: b })
  execFileSync('git', ['config', 'user.name', 'B'], { cwd: b })
  assert.equal(gloss(b, ['sync']).code, 0)
  assert.equal(record(a.dir, 'HEAD', withBlock('x\nVERDICT: ISSUES', [item('f1', { title: 'travels' }), item('f2')])).code, 0)
  const id = /id ([0-9a-f-]{36})/.exec(gloss(a.dir, ['reviews']).out)![1]
  assert.equal(gloss(a.dir, ['sync']).code, 0)
  assert.equal(gloss(b, ['sync']).code, 0)
  const there = gloss(b, ['reviews']).out
  assert.match(there, /f1 +minor +defect +read +open +travels/)
  assert.match(there, /2 findings: 2 open/)
  assert.equal(gloss(b, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'fixed', '--by', 'B']).code, 0)
  assert.equal(gloss(b, ['sync']).code, 0)
  assert.equal(gloss(a.dir, ['sync']).code, 0)
  assert.match(gloss(a.dir, ['reviews']).out, /2 findings: 1 open, 1 fixed/)
})

test('reviews --open: amending one reviewed line does not clear the other findings', () => {
  const { dir, g, write, commit } = repo()
  assert.equal(gloss(dir, ['init']).code, 0)
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  commit('two lines', [group('g', ['h1'])])
  assert.equal(record(dir, 'HEAD', withBlock('x\nVERDICT: ISSUES', [item('f1')])).code, 0)
  const id = /id ([0-9a-f-]{36})/.exec(gloss(dir, ['reviews']).out)![1]
  write('app.js', ['function main() {', '  run()', '  one()', '  three()', '}'])
  g('commit', '-qa', '--amend', '--no-edit')
  assert.match(gloss(dir, ['show']).out, /bugs: code changed since review/)
  const open = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.equal(open.code, 1)
  assert.match(open.out, /1 open on stale reviews: bugs f1/)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'accepted']).code, 0)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 0)
})

test('the stages adversarial and mutate have their own verdict words', () => {
  const { dir } = glossedStop()
  assert.equal(record(dir, 'HEAD', withBlock('x\nVERDICT: CLEAN', []), 'adversarial').code, 0)
  assert.equal(record(dir, 'HEAD', withBlock('y\nVERDICT: ISSUES', [item('f1')]), 'mutate').code, 0)
  const out = gloss(dir, ['show']).out
  assert.match(out, /adversarial: no exploit found/)
  assert.match(out, /mutate: surviving mutations/)
})

const rawNote = (g: (...a: string[]) => string, sha: string, line: string) => {
  const file = join(tmp('raw-'), 'n')
  writeFileSync(file, line + '\n')
  g('notes', '--ref', 'refs/notes/gloss-reviews', 'append', '-F', file, sha)
}

test('reviews --open fails closed for every record it cannot read: unknown verdict, null model, unparsable line; a clean notes ref exits 0', () => {
  const { dir, g } = glossedStop()
  const sha = g('rev-parse', 'HEAD')
  assert.equal(record(dir, 'HEAD', withBlock('x\nVERDICT: CLEAN', []), 'bugs').code, 0)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 0, 'only valid records: exit 0')
  const seen = JSON.parse(gloss(dir, ['reviews', '--stamp', 'HEAD']).out)[sha]
  const bad: [string, object | string][] = [
    ['an unknown verdict value with valid items', { id: 'v1', verdict: 'maybe', items: [item('f1')], ...seen }],
    ['a null model', { id: 'v2', model: null, items: [item('f1')], ...seen }],
    ['a null mode', { id: 'v3', mode: null, items: [item('f1')], ...seen }],
    ['an unparsable line', '{"review":1,"id":"v4",'],
  ]
  for (const [name, rec] of bad) {
    const before = g('rev-parse', 'refs/notes/gloss-reviews')
    if (typeof rec === 'string') rawNote(g, sha, rec)
    else plantLegacy(dir, sha, rec)
    const r = gloss(dir, ['reviews', 'HEAD', '--open'])
    assert.equal(r.code, 1, name)
    assert.match(r.err, /warning: skipped 1 review record/, name)
    assert.match(r.out, new RegExp(`1 review record could not be read on ${sha.slice(0, 10)}`), name)
    g('update-ref', 'refs/notes/gloss-reviews', before)
    assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 0, `${name}: undone`)
  }
})

test('reviews over a range list each decision once, not once per commit holding the review (structured and legacy)', () => {
  const r = twoCommitsForDecisions()
  // structured: decided through the range, so both commits hold the decision
  assert.equal(gloss(r.dir, ['reviews', r.range, '--decide', r.id, '--finding', 'f1', '--outcome', 'fixed', '--note', 'once']).code, 0)
  const sections = (out: string) => out.split(/\n(?=[0-9a-f]{10} )/).filter((x) => /^[0-9a-f]{10} /.test(x))
  for (const sec of sections(gloss(r.dir, ['reviews', r.range]).out)) {
    assert.equal(sec.match(/f1: once/g)?.length, 1)
    assert.match(sec, /2 findings: 1 open, 1 fixed/)
  }
  // a decision naming no finding is listed once too
  for (const sha of r.shas) rawNote(r.g, sha, JSON.stringify({ decision: 1, review: r.id, at: '2026-10-24T10:00:00.000Z', by: 'A', finding: 'old label', outcome: 'rejected' }))
  for (const sec of sections(gloss(r.dir, ['reviews', r.range]).out)) assert.equal(sec.match(/rejected: old label/g)?.length, 1)
  // legacy: the same review and the same decision on both commits
  for (const sha of r.shas) {
    plantLegacy(r.dir, sha, { id: 'legacy-x' })
    rawNote(r.g, sha, JSON.stringify({ decision: 1, review: 'legacy-x', at: '2026-10-24T11:00:00.000Z', by: 'A', finding: '1 first', outcome: 'fixed' }))
  }
  for (const sec of sections(gloss(r.dir, ['reviews', r.range]).out)) {
    assert.equal(sec.match(/fixed: 1 first/g)?.length, 1)
    assert.match(sec, /decisions on this review: 1 decided/)
  }
})

function twoCommitsForDecisions() {
  const r = repo()
  for (const f of ['one', 'two']) {
    r.write('app.js', ['function main() {', '  run()', `  ${f}()`, '}'])
    r.g('commit', '-qam', f)
  }
  const range = 'HEAD~2..HEAD'
  const stamp = JSON.parse(gloss(r.dir, ['reviews', '--stamp', range]).out)
  assert.equal(gloss(r.dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'c', target: range, findings: withBlock('p\nVERDICT: ISSUES', [item('f1'), item('f2')]), stamp })).code, 0)
  const id = /id ([0-9a-f-]{36})/.exec(gloss(r.dir, ['reviews', 'HEAD']).out)![1]
  return { ...r, range, id, shas: Object.keys(stamp) }
}

test('the worst-case report the spec allows is recorded', () => {
  const { dir } = glossedStop()
  const all = Array.from({ length: 200 }, (_, i) => item(`x${String(i).padStart(30, '0')}`, { kind: 'simplification', severity: 'major', basis: 'verified', where: 'w'.repeat(200), title: 't'.repeat(200), detail: 'd'.repeat(500) }))
  const r = record(dir, 'HEAD', withBlock('prose '.repeat(5000) + '\nVERDICT: ISSUES', all))
  assert.equal(r.code, 0, r.err.slice(0, 300))
})

// ---- round 4: nothing the reader cannot read is lost on its way to another commit; staleness is per review ----

test('a record this version cannot read is carried raw by adopt, carry and a wip re-snapshot, so --open still fails on the target', () => {
  const planted = (g: (...a: string[]) => string, sha: string) => rawNote(g, sha, JSON.stringify({ review: 1, id: 'newer', at: '2026-01-01T00:00:00.000Z', stage: 'bugs', agent: 'newer', target: 'HEAD', lines: [], groups: [], findings: 'x', items: [item('f1', { kind: 'perf' })] }))
  // adopt
  const a = repo()
  a.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(a.dir, ['hunks', 'wip'])
  assert.equal(gloss(a.dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  planted(a.g, a.g('rev-parse', 'refs/worktree/gloss/wip'))
  assert.equal(gloss(a.dir, ['reviews', 'wip', '--open']).code, 1, 'the source fails closed')
  a.g('commit', '-qam', 'stop')
  assert.equal(gloss(a.dir, ['adopt']).code, 0)
  const adopted = gloss(a.dir, ['reviews', 'HEAD', '--open'])
  assert.equal(adopted.code, 1, 'adopt lost the record it could not read')
  assert.match(adopted.out, /could not be read/)
  // carry
  const c = repo()
  c.g('checkout', '-qb', 'feat')
  c.write('app.js', ['function main() {', '  run()', '  one()', '}'])
  const one = c.commit('one', [group('one', ['h1'])])
  planted(c.g, one)
  c.g('checkout', '-q', 'main')
  c.g('merge', '-q', '--squash', 'feat')
  c.commit('squashed')
  assert.equal(gloss(c.dir, ['carry', 'main~1..feat']).code, 0)
  assert.equal(gloss(c.dir, ['reviews', 'HEAD', '--open']).code, 1, 'carry lost the record it could not read')
  // a wip re-snapshot
  const h = repo()
  h.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(h.dir, ['hunks', 'wip'])
  assert.equal(gloss(h.dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  planted(h.g, h.g('rev-parse', 'refs/worktree/gloss/wip'))
  h.write('other.js', ['x'])
  gloss(h.dir, ['hunks', 'wip'])
  assert.equal(gloss(h.dir, ['reviews', 'wip', '--open']).code, 1, 'the re-snapshot lost the record it could not read')
})

test('copying reviews still leaves stray and over-cap decision lines behind, and keeps valid decisions', () => {
  const a = repo()
  a.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(a.dir, ['hunks', 'wip'])
  assert.equal(gloss(a.dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  assert.equal(record(a.dir, 'wip', withBlock('x\nVERDICT: ISSUES', [item('f1')])).code, 0)
  const wipSha = a.g('rev-parse', 'refs/worktree/gloss/wip')
  const id = /id ([0-9a-f-]{36})/.exec(gloss(a.dir, ['reviews', 'wip']).out)![1]
  assert.equal(gloss(a.dir, ['reviews', 'wip', '--decide', id, '--finding', 'f1', '--outcome', 'fixed']).code, 0)
  rawNote(a.g, wipSha, JSON.stringify({ decision: 1, review: 'other', at: '2026-01-01T00:00:00Z', by: 'a', finding: 'ghost', outcome: 'fixed' }))
  a.g('commit', '-qam', 'stop')
  assert.equal(gloss(a.dir, ['adopt']).code, 0)
  const lines = a.g('notes', '--ref', 'gloss-reviews', 'show', 'HEAD')
  assert.ok(!lines.includes('ghost'))
  assert.ok(lines.includes('"outcome":"fixed"'))
  assert.equal(gloss(a.dir, ['reviews', 'HEAD', '--open']).code, 0)
})

test('staleness is per review: a newer clean review of the stage does not remove the label from an older review\'s open findings', () => {
  const { dir, g, write, commit } = repo()
  assert.equal(gloss(dir, ['init']).code, 0)
  write('app.js', ['function main() {', '  run()', '  one()', '  two()', '}'])
  commit('two lines', [group('g', ['h1'])])
  assert.equal(record(dir, 'HEAD', withBlock('x\nVERDICT: ISSUES', [item('f1')])).code, 0)
  write('app.js', ['function main() {', '  run()', '  one()', '  three()', '}'])
  g('commit', '-qa', '--amend', '--no-edit')
  assert.equal(record(dir, 'HEAD', withBlock('ok\nVERDICT: CLEAN', [])).code, 0)
  assert.match(gloss(dir, ['show']).out, /bugs: no defects found/, 'the stage is current again')
  const open = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.equal(open.code, 1)
  assert.match(open.out, /1 open on stale reviews: bugs f1/)
  assert.match(open.out, /1 open finding \(1 on stale reviews\)/)
  assert.match(gloss(dir, ['show']).out, /1 open finding \(1 on a stale review\)/)
  const html = join(dir, 'p.html')
  assert.equal(gloss(dir, ['html', '-o', html]).code, 0)
  const data = JSON.parse(/<script type="application\/json" id="gloss-data">([\s\S]*?)<\/script>/.exec(readFileSync(html, 'utf8'))![1])
  const entries = data.commits[0].reviews[0].entries as { stale?: boolean; items?: unknown[] }[]
  assert.deepEqual(entries.map((e) => [Boolean(e.items?.length), e.stale === true]).sort(), [[false, false], [true, true]])
  assert.equal(data.commits[0].reviews[0].openStale, 1)
})

// ---- round 5 ----

test('a long malformed decision-looking line is copied raw by adopt, so the gate stays shut on the new commit', () => {
  const a = repo()
  a.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(a.dir, ['hunks', 'wip'])
  assert.equal(gloss(a.dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  rawNote(a.g, a.g('rev-parse', 'refs/worktree/gloss/wip'), '{"decision":1,"review":"x","finding":"' + 'x'.repeat(20_000))
  assert.equal(gloss(a.dir, ['reviews', 'wip', '--open']).code, 1, 'the source fails closed')
  a.g('commit', '-qam', 'stop')
  assert.equal(gloss(a.dir, ['adopt']).code, 0)
  assert.equal(gloss(a.dir, ['reviews', 'HEAD', '--open']).code, 1, 'adopt dropped the line the gate had counted')
})

test('--record: a report over the size cap says the report including its block is too long, and that escapes count', () => {
  const { dir, g } = glossedStop()
  const tip0 = tipOf(g)
  // spec-compliant (200 items, every string within its cap) but escape-heavy: each control character is six characters of JSON
  const items = Array.from({ length: 200 }, (_, i) => item(`f${i}`, { detail: '\u0001'.repeat(500), where: '\u0001'.repeat(200), title: '\u0001x'.repeat(100) }))
  const r = record(dir, 'HEAD', withBlock('x\nVERDICT: ISSUES', items))
  assert.equal(r.code, 1)
  assert.match(r.err, /the report, including its gloss-findings block, is too long \(\d+ characters; readers skip reports over 256 KiB, measured on the raw text, so JSON escapes count\)/)
  assert.doesNotMatch(r.err, /shorten the report;/)
  assert.equal(tipOf(g), tip0)
})
