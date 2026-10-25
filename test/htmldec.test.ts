import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { browse, skipBrowse } from './browser.ts'
import { buildPageData } from '../src/html/data.ts'

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

function review(dir: string, rev: string, stage: string, findings: string): string {
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  const r = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage, agent: 'claude', target: rev, findings, stamp }))
  assert.equal(r.code, 0, r.err)
  const sha = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  const lines = execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  return lines.filter((l) => l.review === 1 && l.stage === stage).at(-1).id
}

const decide = (dir: string, target: string, id: string, ...rest: string[]) => {
  const r = gloss(dir, ['reviews', target, '--decide', id, ...rest])
  assert.equal(r.code, 0, r.err)
}

test('page data: each review entry carries its id, its decisions, whether it is complete, and the summary', () => {
  const { dir, sha } = glossed()
  const bugs = review(dir, 'HEAD', 'bugs', 'Two problems.\nVERDICT: ISSUES')
  review(dir, 'HEAD', 'honesty', 'All fine.\nVERDICT: CLEAN')
  review(dir, 'HEAD', 'improve', 'Some thoughts.\nVERDICT: ISSUES')
  decide(dir, 'HEAD', bugs, '--finding', 'one', '--outcome', 'fixed', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--finding', 'two', '--outcome', 'rejected', '--note', 'not real', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--complete')
  const stages = Object.fromEntries(data(dir, sha).commits[0].reviews.map((r) => [r.stage, r.entries[0]])) as Record<string, any>
  assert.equal(stages.bugs.id, bugs)
  assert.equal(stages.bugs.complete, true)
  assert.equal(stages.bugs.summary, '1 fixed, 1 rejected · complete')
  assert.deepEqual(stages.bugs.decisions.map((d: any) => [d.outcome, d.finding, d.note, d.by]), [['fixed', 'one', undefined, 'Arb'], ['rejected', 'two', 'not real', 'Arb']])
  assert.match(stages.bugs.decisions[0].at, /^\d{4}-/)
  assert.equal(stages.honesty.decisions, undefined, 'a clean review with none shows nothing')
  assert.equal(stages.honesty.summary, undefined)
  assert.deepEqual(stages.improve.decisions, [])
  assert.equal(stages.improve.complete, false)
  assert.match(stages.improve.summary, /^none yet$/)
})

// 205 decisions on one issues review, f0 the oldest, f204 the newest.
function manyDecisions() {
  const { dir, sha } = glossed()
  const id = review(dir, 'HEAD', 'bugs', 'Many.\nVERDICT: ISSUES')
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
})

test('page data: a clean review with decisions says it is clean, so the rail can stay quiet', () => {
  const { dir, sha } = glossed()
  const id = review(dir, 'HEAD', 'honesty', 'Fine.\nVERDICT: CLEAN')
  decide(dir, 'HEAD', id, '--finding', 'x', '--outcome', 'accepted')
  const e = data(dir, sha).commits[0].reviews[0].entries[0] as any
  assert.equal(e.verdict, 'clean')
  assert.equal(e.decisionCount, 1)
})

test('with over 200 decisions the pane says it shows the latest 200 of N, and the rail counts all of them', { skip: skipBrowse }, async () => {
  const { dir } = manyDecisions()
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    assert.match(String(await evaluate(`document.querySelector('.rvrow .rvtxt').textContent`)), / · 205 decided$/)
    await evaluate(`document.querySelector('.rvrow').click()`)
    assert.equal(await evaluate(`document.querySelectorAll('.decisions .drow').length`), 200)
    assert.equal(await evaluate(`document.querySelector('.decisions .dhidden').textContent`), 'showing the latest 200 of 205')
    assert.match(String(await evaluate(`document.querySelector('.decisions .dsum').textContent`)), /^205 decided/)
  })
})

test('a complete marker with no decisions shows "complete" in the rail and "none · complete" in the pane', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  const id = review(dir, 'HEAD', 'bugs', 'One.\nVERDICT: ISSUES')
  decide(dir, 'HEAD', id, '--complete')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    assert.match(String(await evaluate(`document.querySelector('.rvrow .rvtxt').textContent`)), / · complete$/)
    await evaluate(`document.querySelector('.rvrow').click()`)
    assert.equal(await evaluate(`document.querySelector('.decisions .dsum').textContent`), 'none · complete')
  })
})

test('the Reviews pane shows decisions with chips, and the rail row says how far they are', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  const bugs = review(dir, 'HEAD', 'bugs', 'Two problems.\nVERDICT: ISSUES')
  review(dir, 'HEAD', 'improve', 'Thoughts.\nVERDICT: ISSUES')
  review(dir, 'HEAD', 'honesty', 'Fine.\nVERDICT: CLEAN')
  decide(dir, 'HEAD', bugs, '--finding', 'null check', '--outcome', 'fixed', '--note', 'in 1a2b', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--finding', 'naming', '--outcome', 'follow-up', '--by', 'Arb')
  decide(dir, 'HEAD', bugs, '--complete')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    const rows = JSON.parse(String(await evaluate(`JSON.stringify([...document.querySelectorAll('.rvrow')].map((b) => [b.querySelector('.rvstage').textContent, b.querySelector('.rvtxt').textContent]))`)))
    const by = Object.fromEntries(rows)
    assert.match(by.bugs, / · complete$/)
    assert.match(by.improve, / · undecided$/)
    assert.doesNotMatch(by.honesty, /decided/)
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
    assert.match(text, /null check.*— in 1a2b.*Arb/)
  })
})

test('decisions made on wip appear on the page after adopt', () => {
  const { dir, g, write } = repo()
  write(['function main() {', '  run()', '  stop()', '}'])
  gloss(dir, ['hunks', 'wip'])
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  const id = review(dir, 'wip', 'bugs', 'One.\nVERDICT: ISSUES')
  decide(dir, 'wip', id, '--finding', 'x', '--outcome', 'accepted', '--by', 'Arb')
  g('commit', '-qam', 'stop')
  assert.equal(gloss(dir, ['adopt']).code, 0)
  const e = data(dir, g('rev-parse', 'HEAD')).commits[0].reviews[0].entries[0] as any
  assert.equal(e.id, id)
  assert.deepEqual(e.decisions.map((d: any) => [d.outcome, d.finding]), [['accepted', 'x']])
  assert.equal(e.summary, '1 decided · not marked complete')
})

test('in a real browser, hostile decision text stays text', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  const id = review(dir, 'HEAD', 'bugs', 'Problem.\nVERDICT: ISSUES')
  const bomb = '</script><img src=x onerror=window.__pwned=1>'
  const md = '[click](javascript:window.__pwned=2) **bold** `code` <b>x</b>'
  decide(dir, 'HEAD', id, '--finding', bomb, '--outcome', 'fixed', '--note', md + ' ' + bomb, '--by', bomb)
  decide(dir, 'HEAD', id, '--finding', '__proto__', '--outcome', 'rejected', '--note', 'n'.repeat(2000), '--by', 'constructor')
  decide(dir, 'HEAD', id, '--finding', 'constructor', '--outcome', 'accepted', '--by', 'a')
  decide(dir, 'HEAD', id, '--finding', md, '--outcome', 'follow-up', '--by', 'a')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    await evaluate(`document.querySelector('.rvrow').click()`)
    const f = JSON.parse(String(await evaluate(`JSON.stringify({
      pwned: window.__pwned === undefined ? null : window.__pwned,
      img: !!document.querySelector('img'),
      made: [...document.querySelectorAll('img, svg, iframe, object, embed, form, input, base, b')].map((e) => e.tagName),
      links: [...document.querySelectorAll('.decisions a')].length,
      handlers: [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].filter((a) => /^on/i.test(a.name)).map((a) => a.name)),
      rows: [...document.querySelectorAll('.decisions .drow')].map((r) => r.textContent),
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
    assert.ok(all.includes(`${bomb}`), 'finding shown literally')
    assert.ok(all.includes(md), 'markdown-looking text shown literally')
    assert.ok(all.includes('__proto__') && all.includes('constructor'))
    assert.ok(all.includes('n'.repeat(2000)), 'the long note is shown whole')
  })
})

test('a numbered list in a report keeps its own numbers, so decisions can name findings by them', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  review(dir, 'HEAD', 'bugs', '### A\n1. x\n2. y\n### B\n5. z\n6. w\n### C\n99999999999. huge\n- bullet\n  3. nested\nVERDICT: ISSUES')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    await evaluate(`document.querySelector('.rvrow').click()`)
    const f = JSON.parse(String(await evaluate(`JSON.stringify([...document.querySelectorAll('.md ol')].map((o) => ({ start: o.start, attr: o.getAttribute('start'), items: o.children.length })))`)))
    assert.deepEqual(f.map((o: any) => o.start), [1, 5, 1, 3])
    assert.equal(f[1].attr, '5')
    assert.equal(f[2].attr, null, 'a huge number is ignored')
    assert.equal(f[3].attr, '3', 'nested lists too')
    // the rendered numbers: first marker of the second list is 5, its second 6
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.md ol')[1].children].map((li, i) => document.querySelectorAll('.md ol')[1].start + i)`), [5, 6])
  })
})
