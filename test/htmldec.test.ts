import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { browse, skipBrowse } from './browser.ts'
import { buildPageData } from '../src/html/data.ts'
import { item, withBlock, type TestItem } from './block.ts'

// The page data reads the repository in the working directory.
const data = (dir: string, sha: string) => { process.chdir(dir); return buildPageData([sha]) }

// Decision records in the html Reviews view (page data and DOM).

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const group = (id: string, hunks: string[]) =>
  ({ id, hunks, intent: `${id} intent`, necessity: 'required', serves: 'task', removal_impact: `no ${id}` })

// A repo with one glossed commit `stop` on top of base.
function repo() {
  const dir = tmp('htmldec-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const write = (lines: string[]) => writeFileSync(join(dir, 'app.js'), lines.join('\n') + '\n')
  write(['function main() {', '  run()', '}'])
  g('add', '-A')
  g('commit', '-qm', 'base')
  return { dir, g, write }
}

function glossed() {
  const r = repo()
  r.write(['function main() {', '  run()', '  stop()', '}'])
  r.g('commit', '-qam', 'stop')
  assert.equal(gloss(r.dir, ['add'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  return { ...r, sha: r.g('rev-parse', 'HEAD') }
}

function review(dir: string, rev: string, stage: string, findings: string, items: TestItem[] = []): string {
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  const r = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage, agent: 'claude', target: rev, findings: withBlock(findings, items), stamp }))
  assert.equal(r.code, 0, r.err)
  const sha = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  const lines = execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return lines.filter((l) => l.review === 1 && l.stage === stage).at(-1).id
}

const decide = (dir: string, target: string, id: string, ...rest: string[]) => {
  const r = gloss(dir, ['reviews', target, '--decide', id, ...rest])
  assert.equal(r.code, 0, r.err)
}

test('page data: each review entry carries its id, its items with status, its decisions, whether it is complete, and the summary', () => {
  const { dir, sha } = glossed()
  const bugs = review(dir, 'HEAD', 'bugs', 'Two problems.\nVERDICT: ISSUES', [item('one', { severity: 'major' }), item('two', { kind: 'mismatch', where: 'a.js:2' })])
  review(dir, 'HEAD', 'honesty', 'All fine.\nVERDICT: CLEAN')
  review(dir, 'HEAD', 'improve', 'Some thoughts.\nVERDICT: ISSUES', [item('i1', { kind: 'simplification' })])
  decide(dir, 'HEAD', bugs, '--finding', 'two', '--outcome', 'rejected', '--note', 'not real', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--finding', 'one', '--outcome', 'fixed', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--complete')
  const c = data(dir, sha).commits[0]
  const stages = Object.fromEntries(c.reviews.map((r) => [r.stage, r.entries[0]])) as Record<string, any>
  assert.equal(stages.bugs.id, bugs)
  assert.equal(stages.bugs.complete, true)
  assert.equal(stages.bugs.summary, '1 fixed, 1 rejected · complete')
  assert.deepEqual(stages.bugs.items.map((i: any) => [i.id, i.severity, i.kind, i.basis, i.status, i.where, i.note]), [
    ['one', 'major', 'defect', 'read', 'fixed', undefined, undefined], ['two', 'minor', 'mismatch', 'read', 'rejected', 'a.js:2', 'not real']])
  // decisions are listed in the order of the items, whatever order they were made in
  assert.deepEqual(stages.bugs.decisions.map((d: any) => [d.outcome, d.finding, d.note, d.by]), [['fixed', 'one', undefined, 'Arb'], ['rejected', 'two', 'not real', 'Arb']])
  assert.match(stages.bugs.decisions[0].at, /^\d{4}-/)
  assert.equal(stages.honesty.decisions, undefined, 'a clean review with none shows nothing')
  assert.equal(stages.honesty.summary, undefined)
  assert.deepEqual(stages.honesty.items, [])
  assert.deepEqual(stages.improve.decisions, [])
  assert.equal(stages.improve.complete, false)
  assert.deepEqual(stages.improve.items.map((i: any) => i.status), ['open'])
  assert.match(stages.improve.summary, /^none yet$/)
  // open counts: per stage and for the commit
  assert.deepEqual(Object.fromEntries(c.reviews.map((r) => [r.stage, r.open])), { bugs: 0, honesty: 0, improve: 1 })
  assert.equal(c.openFindings, 1)
})

// 205 decisions on one issues review of 200 items, f0 the oldest, f204 the newest (the last five name no item).
function manyDecisions() {
  const { dir, sha } = glossed()
  const id = review(dir, 'HEAD', 'bugs', 'Many.\nVERDICT: ISSUES', Array.from({ length: 200 }, (_, i) => item(`f${i}`)))
  const lines = Array.from({ length: 205 }, (_, i) => JSON.stringify({ decision: 1, review: id, at: `2026-01-01T${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, by: 'a', finding: `f${i}`, outcome: 'fixed' }))
  const f = join(tmp('plant-'), 'd.txt')
  writeFileSync(f, lines.join('\n'))
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'append', '-F', f, sha], { cwd: dir })
  return { dir, sha }
}

test('page data: over 200 decisions, the newest 200 are kept (oldest first) and the total is carried', () => {
  const { dir, sha } = manyDecisions()
  const e = data(dir, sha).commits[0].reviews[0].entries[0] as any
  assert.equal(e.decisions.length, 200)
  assert.equal(e.decisions[0].finding, 'f5', 'the 5 oldest are the hidden ones')
  assert.equal(e.decisions[199].finding, 'f204')
  assert.equal(e.decisionCount, 205)
  assert.equal(e.verdict, 'issues')
  assert.match(e.summary, /^205 decided/)
  assert.equal(e.items.length, 200)
  assert.ok(e.items.every((i: any) => i.status === 'fixed'))
})

test('page data: a clean review with decisions says it is clean, so the rail can stay quiet', () => {
  const { dir, sha } = glossed()
  const id = review(dir, 'HEAD', 'honesty', 'Fine.\nVERDICT: CLEAN')
  // --decide refuses a finding a clean review does not have, so the line is planted
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'append', '-m', JSON.stringify({ decision: 1, review: id, at: '2026-01-01T00:00:00Z', by: 'a', finding: 'x', outcome: 'accepted' }), sha], { cwd: dir })
  const e = data(dir, sha).commits[0].reviews[0].entries[0] as any
  assert.equal(e.verdict, 'clean')
  assert.equal(e.decisionCount, 1)
})

test('with over 200 decisions the pane says it shows the latest 200 of N, and the rail says every finding is decided', { skip: skipBrowse }, async () => {
  const { dir } = manyDecisions()
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    assert.match(String(await evaluate(`document.querySelector('.rvrow .rvtxt').textContent`)), / · all decided$/)
    await evaluate(`document.querySelector('.rvrow').click()`)
    assert.equal(await evaluate(`document.querySelectorAll('.decisions .drow').length`), 200)
    assert.equal(await evaluate(`document.querySelector('.decisions .dhidden').textContent`), 'showing the latest 200 of 205')
    assert.match(String(await evaluate(`document.querySelector('.decisions .dsum').textContent`)), /^205 decided/)
  })
})

test('an open finding shows in the rail; a complete marker with no decisions shows "none · complete" in the pane', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  const id = review(dir, 'HEAD', 'bugs', 'One.\nVERDICT: ISSUES', [item('only')])
  decide(dir, 'HEAD', id, '--complete')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    assert.match(String(await evaluate(`document.querySelector('.rvrow .rvtxt').textContent`)), / · 1 open$/)
    await evaluate(`document.querySelector('.rvrow').click()`)
    assert.equal(await evaluate(`document.querySelector('.decisions .dsum').textContent`), 'none · complete')
  })
})

test('the Reviews pane shows decisions with chips, and the rail row says how far they are', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  const bugs = review(dir, 'HEAD', 'bugs', 'Two problems.\nVERDICT: ISSUES', [item('null-check', { severity: 'major' }), item('naming', { severity: 'nit' })])
  review(dir, 'HEAD', 'improve', 'Thoughts.\nVERDICT: ISSUES', [item('i1')])
  review(dir, 'HEAD', 'honesty', 'Fine.\nVERDICT: CLEAN')
  decide(dir, 'HEAD', bugs, '--finding', 'null-check', '--outcome', 'fixed', '--note', 'in 1a2b', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--finding', 'naming', '--outcome', 'follow-up', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--complete')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    const rows = JSON.parse(String(await evaluate(`JSON.stringify([...document.querySelectorAll('.rvrow')].map((b) => [b.querySelector('.rvstage').textContent, b.querySelector('.rvtxt').textContent]))`)))
    const by = Object.fromEntries(rows)
    assert.match(by.bugs, / · all decided$/)
    assert.match(by.improve, / · 1 open$/)
    assert.doesNotMatch(by.honesty, /decided|open/)
    await evaluate(`document.querySelector('.rvrow').click()`)
    const facts = JSON.parse(String(await evaluate(`JSON.stringify({
      blocks: [...document.querySelectorAll('.decisions')].map((b) => b.textContent),
      chips: [...document.querySelectorAll('.decisions .chip')].map((c) => c.textContent),
      sums: [...document.querySelectorAll('.decisions .dsum')].map((c) => c.textContent),
    })`)))
    assert.deepEqual(facts.chips.sort(), ['fixed', 'follow-up'])
    assert.ok(facts.sums.includes('1 fixed, 1 follow-up · complete'), facts.sums.join('|'))
    assert.ok(facts.sums.includes('none yet'))
    assert.equal(facts.blocks.length, 2, 'the clean review has no block')
    const text = facts.blocks.join('\n')
    assert.match(text, /null-check.*— in 1a2b.*Arb/)
    // the findings list: severity, kind, basis and status as text, and the raw report behind a disclosure
    const items = JSON.parse(String(await evaluate(`JSON.stringify({
      rows: [...document.querySelectorAll('.items .irow')].map((r) => r.textContent),
      reports: [...document.querySelectorAll('details.rawreport')].map((d) => [d.open, d.querySelector('summary').textContent, d.querySelector('.md') !== null]),
    })`)))
    assert.equal(items.rows.length, 3)
    assert.match(items.rows.find((r: string) => r.includes('null-check')), /fixed.*null-check.*major.*defect.*read.*title of null-check/)
    assert.match(items.rows.find((r: string) => r.includes('naming')), /follow-up.*naming.*nit/)
    assert.match(items.rows.find((r: string) => r.includes('i1')), /open.*i1/)
    assert.equal(items.reports.length, 3, 'every review keeps its raw report under a disclosure')
    assert.ok(items.reports.every(([open, label, has]: [boolean, string, boolean]) => open === false && label === 'Report' && has))
  })
})

test('decisions made on wip appear on the page after adopt', () => {
  const { dir, g, write } = repo()
  write(['function main() {', '  run()', '  stop()', '}'])
  gloss(dir, ['hunks', 'wip'])
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  const id = review(dir, 'wip', 'bugs', 'One.\nVERDICT: ISSUES', [item('x')])
  decide(dir, 'wip', id, '--finding', 'x', '--outcome', 'accepted', '--by', 'Arb')
  g('commit', '-qam', 'stop')
  assert.equal(gloss(dir, ['adopt']).code, 0)
  const e = data(dir, g('rev-parse', 'HEAD')).commits[0].reviews[0].entries[0] as any
  assert.equal(e.id, id)
  assert.deepEqual(e.decisions.map((d: any) => [d.outcome, d.finding]), [['accepted', 'x']])
  assert.equal(e.summary, '1 decided · not marked complete')
  assert.deepEqual(e.items.map((i: any) => [i.id, i.status]), [['x', 'accepted']], 'the items came with the review')
  assert.equal(data(dir, g('rev-parse', 'HEAD')).commits[0].openFindings, 0)
})

test('in a real browser, hostile decision and finding text stays text', { skip: skipBrowse }, async () => {
  const { dir, sha } = glossed()
  const bomb = '</script><img src=x onerror=window.__pwned=1>'
  const md = '[click](javascript:window.__pwned=2) **bold** `code` <b>x</b>'
  const id = review(dir, 'HEAD', 'bugs', 'Problem.\nVERDICT: ISSUES', [item('f1', { title: bomb, where: md }), item('__proto__'), item('constructor', { title: md })])
  decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed', '--note', md + ' ' + bomb, '--by', bomb)
  decide(dir, 'HEAD', id, '--finding', '__proto__', '--outcome', 'rejected', '--note', 'n'.repeat(2000), '--by', 'constructor')
  decide(dir, 'HEAD', id, '--finding', 'constructor', '--outcome', 'accepted', '--by', 'a')
  // decision lines that name no item (as an older or hostile writer left them) still show as text
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'append', '-m', JSON.stringify({ decision: 1, review: id, at: '2026-01-01T00:00:00Z', by: 'a', finding: md + bomb, outcome: 'follow-up' }), sha], { cwd: dir })
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    await evaluate(`document.querySelector('.rvrow').click()`)
    const f = JSON.parse(String(await evaluate(`JSON.stringify({
      pwned: window.__pwned === undefined ? null : window.__pwned,
      img: !!document.querySelector('img'),
      made: [...document.querySelectorAll('img, svg, iframe, object, embed, form, input, base, b')].map((e) => e.tagName),
      links: [...document.querySelectorAll('.decisions a, .items a')].length,
      handlers: [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name)),
      rows: [...document.querySelectorAll('.decisions .drow')].map((r) => r.textContent),
      items: [...document.querySelectorAll('.items .irow')].map((r) => r.textContent),
      scripts: document.scripts.length,
    })`)))
    assert.equal(f.pwned, null, 'a handler ran')
    assert.equal(f.img, false)
    assert.deepEqual(f.made, [])
    assert.equal(f.links, 0)
    assert.deepEqual(f.handlers, [])
    assert.equal(f.scripts, 2)
    assert.equal(f.rows.length, 4)
    const all = f.rows.join('\n')
    assert.ok(all.includes(md), 'markdown-looking text shown literally')
    assert.ok(all.includes('__proto__') && all.includes('constructor'))
    assert.ok(all.includes('n'.repeat(2000)), 'the long note is shown whole')
    assert.equal(f.items.length, 3)
    assert.ok(f.items[0].includes(bomb) && f.items[0].includes(md), 'item title and where shown literally')
    assert.ok(f.items[1].includes('__proto__') && f.items[1].includes('rejected'))
  })
})

test('a list nested in a report still starts at its own number, and a huge number is ignored', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  review(dir, 'HEAD', 'bugs', '### A\n1. x\n2. y\n### B\n5. z\n- bullet\n  3. nested\n  4. more\n99999999999. huge\nVERDICT: ISSUES', [item('a')])
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    await evaluate(`document.querySelector('.rvrow').click()`)
    const f = JSON.parse(String(await evaluate(`JSON.stringify([...document.querySelectorAll('.md ol')].map((o) => ({ start: o.start, attr: o.getAttribute('start'), items: o.children.length })))`)))
    assert.deepEqual(f.map((o: any) => [o.start, o.attr]), [[1, null], [5, '5'], [3, '3'], [1, null]])
  })
})

test('in a range, each commit row says how many findings are open', { skip: skipBrowse }, async () => {
  const { dir, g, write } = repo()
  g('checkout', '-qb', 'feat')
  for (const f of ['one', 'two']) {
    write(['function main() {', '  run()', `  ${f}()`, '}'])
    g('commit', '-qam', f)
    assert.equal(gloss(dir, ['add'], JSON.stringify({ task: f, groups: [group(f, ['h1'])] })).code, 0)
  }
  review(dir, 'HEAD~1', 'bugs', 'One.\nVERDICT: ISSUES', [item('a'), item('b')])
  review(dir, 'HEAD', 'bugs', 'Fine.\nVERDICT: CLEAN')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', 'main..feat', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    const rows = JSON.parse(String(await evaluate(`JSON.stringify([...document.querySelectorAll('.crow')].map((r) => [r.querySelector('.csubject').textContent, r.querySelector('.cmeta').textContent]))`)))
    const by = Object.fromEntries(rows) as Record<string, string>
    assert.match(by.one, /2 open findings/)
    assert.doesNotMatch(by.two, /open finding/)
  })
})

test('a stale stage with open findings is never "all decided": page data and the rail say N open (code changed)', { skip: skipBrowse }, async () => {
  const { dir, g, sha } = glossed()
  const f = join(dir, 'x')
  // a review whose stamp matches no current line: the stage is stale (code changed since review)
  const rec = { review: 1, id: 'stale-1', at: '2026-01-01T00:00:00.000Z', stage: 'bugs', agent: 'old', target: 'HEAD', lines: [], groups: [], findings: withBlock('x\nVERDICT: ISSUES', [item('f1'), item('f2')]), verdict: 'issues', items: [item('f1'), item('f2')] }
  writeFileSync(f, JSON.stringify(rec))
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', f, sha], { cwd: dir })
  decide(dir, 'HEAD', 'stale-1', '--finding', 'f1', '--outcome', 'fixed')
  const c = data(dir, sha).commits[0]
  assert.equal(c.reviews[0].state, 'code-changed')
  assert.equal(c.reviews[0].open, 1)
  assert.equal(c.openFindings, 1)
  assert.ok(g)
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    const t = String(await evaluate(`document.querySelector('.rvrow .rvtxt').textContent`))
    assert.match(t, / · 1 open \(1 on stale reviews\)$/)
    assert.doesNotMatch(t, /all decided/)
  })
  decide(dir, 'HEAD', 'stale-1', '--finding', 'f2', '--outcome', 'fixed')
  assert.equal(data(dir, sha).commits[0].openFindings, 0)
})

test('the rail says "undecided (legacy)" for a legacy review under a newer structured clean one, and still shows structured open counts', { skip: skipBrowse }, async () => {
  const { dir, sha } = glossed()
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', 'HEAD']).out)[sha]
  const legacy = { review: 1, id: 'old-1', at: '2026-01-01T00:00:00.000Z', stage: 'bugs', agent: 'old', target: 'HEAD', ...stamp, findings: 'Old.\n- a\nVERDICT: ISSUES', verdict: 'issues' }
  const f = join(tmp('plant-'), 'n')
  writeFileSync(f, JSON.stringify(legacy) + '\n')
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', f, sha], { cwd: dir })
  review(dir, 'HEAD', 'bugs', 'Fine.\nVERDICT: CLEAN')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    assert.match(String(await evaluate(`document.querySelector('.rvrow .rvtxt').textContent`)), / · undecided \(legacy\)$/)
  })
})

test('the pane marks a stale review even when a newer clean review makes the stage current', { skip: skipBrowse }, async () => {
  const { dir, sha } = glossed()
  const old = { review: 1, id: 'stale-2', at: '2026-01-01T00:00:00.000Z', stage: 'bugs', agent: 'old', target: 'HEAD', lines: ['0000000000000000'], groups: [], findings: withBlock('x\nVERDICT: ISSUES', [item('f1')]), verdict: 'issues', items: [item('f1')] }
  const f = join(tmp('plant-'), 'n')
  writeFileSync(f, JSON.stringify(old) + '\n')
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', f, sha], { cwd: dir })
  review(dir, 'HEAD', 'bugs', 'Fine.\nVERDICT: CLEAN')
  const c = data(dir, sha).commits[0]
  assert.equal(c.reviews[0].state, 'seen', 'the stage itself is current')
  assert.equal(c.reviews[0].openStale, 1)
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    assert.match(String(await evaluate(`document.querySelector('.rvrow .rvtxt').textContent`)), / · 1 open \(1 on stale reviews\)$/)
    await evaluate(`document.querySelector('.rvrow').click()`)
    assert.deepEqual(JSON.parse(String(await evaluate(`JSON.stringify([...document.querySelectorAll('.ehead')].map((h) => [...h.querySelectorAll('.chip')].some((c) => c.textContent === 'stale review')))`))), [false, true])
  })
})
