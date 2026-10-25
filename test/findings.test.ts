import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { browse, skipBrowse, waitFor } from './browser.ts'
import { within } from './timing.ts'
import { buildPageData } from '../src/html/data.ts'
import { findingClashes, findingRefs, findingTexts, labelFindings, orderDecisions, refOf } from '../src/findings.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')
const lines = (...l: string[]) => l.join('\n')

test('labelFindings: numbered and unnumbered headings, any list shape, give section.item refs', () => {
  const out = labelFindings(lines(
    '### 1. Mismatches', '- a', '- b', '### Misgraded necessity', '* c', '### 3. Removal', '5. d', '6. e', 'VERDICT: ISSUES'))
  assert.equal(out, lines(
    '### 1. Mismatches', '- **[1.1]** a', '- **[1.2]** b', '### Misgraded necessity', '- **[2.1]** c', '### 3. Removal', '- **[3.1]** d', '- **[3.2]** e', 'VERDICT: ISSUES'))
})

test('labelFindings: numbered lists restarting at 1 in every section are told apart', () => {
  const out = labelFindings(lines('## Bugs', '1. x', '2. y', '## Nits', '1. z', '1) w'))
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 9)), ['- **[1.1]', '- **[1.2]', '- **[2.1]', '- **[2.2]'])
})

test('labelFindings: a leading title heading takes no number', () => {
  const out = labelFindings(lines('# Review of X', '', '## 1. Mismatches', '- a', '## Misgraded necessity', '- b', '## 3. Removal', '- c'))
  assert.match(out, /\[1\.1\]\*\* a/)
  assert.match(out, /\[2\.1\]\*\* b/)
  assert.match(out, /\[3\.1\]\*\* c/)
  // An unnumbered report whose first heading has items: that heading is section 1.
  assert.match(labelFindings(lines('## A', '- a', '## B', '- b')), /\[1\.1\][^]*\[2\.1\]/)
  // Title then unnumbered sections.
  assert.match(labelFindings(lines('# Title', '## A', '- a', '## B', '- b')), /\[1\.1\][^]*\[2\.1\]/)
})

test('labelFindings: items before any heading are labelled by position alone', () => {
  assert.equal(labelFindings(lines('- a', '- b', '## H', '- c')), lines('- **[1]** a', '- **[2]** b', '## H', '- **[1.1]** c'))
})

test('labelFindings: sub-items, wrapped lines, rules and empty items are untouched', () => {
  const src = lines('## 1. A', '- a', '  wrapped', '  - sub', '    1. subsub', '---', '* * *', '-', '- b')
  assert.equal(labelFindings(src), lines('## 1. A', '- **[1.1]** a', '  wrapped', '  - sub', '    1. subsub', '---', '* * *', '-', '- **[1.2]** b'))
})

test('labelFindings: fenced code is passed through, and an unclosed fence runs to the end', () => {
  const src = lines('## 1. A', '```', '- not', '# a heading', '```', '- yes', '~~~', '- no')
  assert.equal(labelFindings(src), lines('## 1. A', '```', '- not', '# a heading', '```', '- **[1.1]** yes', '~~~', '- no'))
})

test('labelFindings: running it twice changes nothing more', () => {
  for (const src of [lines('# T', '## 1. A', '1. x', '- y', '## B', '- z'), lines('- a', '## B', '3. q', '- r'), '- **[9.9]** stale label\n## A\n- k']) {
    const once = labelFindings(src)
    assert.equal(labelFindings(once), once)
  }
  assert.match(labelFindings('## A\n- **[9.9]** stale'), /^## A\n- \*\*\[1\.1\]\*\* stale$/)
})

test('labelFindings: text with no headings or items is unchanged; a numbered heading with no list keeps its number as its ref', () => {
  const plain = 'Looks fine to me.\n\nNothing to report.\nVERDICT: CLEAN'
  assert.equal(labelFindings(plain), plain)
  const h = '## 4. A lone finding\nit is bad'
  assert.equal(labelFindings(h), h)
  assert.ok(findingRefs(h).has('4'))
  assert.ok(findingRefs('## A\n- x\n- y').has('1.2'))
})

test('numbers that merely start a heading or a decision are not refs', () => {
  const refs = (src: string) => labelFindings(src).split('\n').flatMap((l) => /^- \*\*\[([\d.]+)\]/.exec(l)?.[1] ?? [])
  assert.deepEqual(refs(lines('## 2024 results', '- a', '## Other', '- b')), ['1.1', '2.1'])
  assert.deepEqual(refs(lines('## 10 files changed', '- a')), ['1.1'])
  assert.deepEqual(refs(lines('## 3. Removal', '- a')), ['3.1'])
  const ok: [string, string | null][] = [['1.2 wording nit', '1.2'], ['1.2: wording nit', '1.2'], ['3) x', '3'], ['3: x', '3'], ['3. x', '3'], ['12.10', '12.10'],
    ['2024 migration', null], ['3 files need changes', null], ['3', null], ['1.2345 x', null], ['1.2x', null], ['free', null]]
  for (const [f, want] of ok) assert.equal(refOf(f), want, f)
})

test('orderDecisions: by ref in natural numeric order, refless ones after in the order given', () => {
  let t = 0
  const d = (finding: string) => ({ finding, at: String(++t).padStart(3, '0') })
  assert.deepEqual(orderDecisions([d('free'), d('1.10 b'), d('2.1 c'), d('1.2 a'), d('also free'), d('3: h'), d('1.2: x')]).map((x) => x.finding),
    ['1.2 a', '1.2: x', '1.10 b', '2.1 c', '3: h', 'free', 'also free'])
})

// Real reviewer reports (untrusted text, kept as plain files). The expected refs were
// checked by eye against each file: the section numbers are the report's own.
const FIXTURES: [string, string[][]][] = [
  ['tm-honesty', [['1.1','**Test names still say "f'],
    ['1.2','**The TODO drops the Revi'],
    ['1.3','**Evidence for "between l'],
    ['2.1','`budgets` (required) and '],
    ['2.2','`wait-for` is labelled su'],
    ['2.3','`drop-hostile-timing` (in'],
    ['2.4','`todo` (supporting) is do'],
    ['4.1','In `signals.test.ts`, the'],
    ['4.2','`waitFor` has a `probe` t'],
    ['5.1','**`waitFor` swallows ever'],
    ['5.2','**The `wait-for` behaviou'],
    ['5.3','**Ratio test under load ('],
    ['5.4','**Catastrophic-regex guar']]],
  ['hd-honesty', [['1.1','**Group:** `rail`, with `'],
    ['1.2','**Evidence:** I recorded '],
    ['1.3','**Why it matters:** The r'],
    ['2.1','**Group:** `ol-start`, la'],
    ['2.2','**Evidence:** The change '],
    ['2.3','**Impact:** It is a real '],
    ['3.1','**`ol-start`** (with its '],
    ['4.1','`pageReviews` filters all'],
    ['4.2','The `MAX_PAGE_DECISIONS` '],
    ['5.1','**Timing-based tests (ver'],
    ['5.2','**Extra git work per comm'],
    ['5.3','**No visual check (not do'],
    ['5.4','**Sort coupling (read):**']]],
  ['iw-honesty', [['1.1','**`test` group, `more tha'],
    ['1.2','**Skill not updated (read'],
    ['5.1','**Noise pushing filler ra'],
    ['5.2','**Hidden when other error']]],
  ['tm-bugs', [['1.1','The assert is `msBig <= 3'],
    ['1.2','A quadratic scan would re'],
    ['1.3','On a faster machine, wher'],
    ['1.4','A tighter factor (about 2'],
    ['1.5','**`waitFor`:** errors fro'],
    ['1.6','**`until` in `ary.test.ts'],
    ['1.7','**Removed wall-time check']]],

]
for (const [name, expected] of FIXTURES) {
  test(`labelFindings on the real report ${name}: refs match the report's own sections`, () => {
    const text = readFileSync(join(import.meta.dirname, 'fixtures', 'reports', `${name}.txt`), 'utf8')
    const got = labelFindings(text).split('\n').flatMap((l) => { const m = /^- \*\*\[([\d.]+)\]\*\* (.*)$/.exec(l); return m ? [[m[1], m[2].slice(0, 25)]] : [] })
    assert.deepEqual(got, expected)
    assert.equal(labelFindings(labelFindings(text)), labelFindings(text))
  })
}

test('labelFindings: bold-only lines are section headings, numbered or not', () => {
  const out = labelFindings(lines('**1. Mismatches**', '- a', '**Other:**', '- b', '__4. Late__', '- c', '**bold** and more', '- d'))
  assert.deepEqual(out.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(0, 9)), ['- **[1.1]', '- **[2.1]', '- **[4.1]', '- **[4.2]'])
})

test('labelFindings: a plain `1. Title` line is a heading only when it is short, spaced and followed by a bullet', () => {
  const refs = (src: string) => labelFindings(src).split('\n').flatMap((l) => /^- \*\*\[([\d.]+)\]/.exec(l)?.[1] ?? [])
  assert.deepEqual(refs(lines('1. Mismatches', '', '- a', '', '2) Removal', '', '- b')), ['1.1', '2.1'])
  // no blank line after it: an item with sub-items, not a title
  assert.deepEqual(refs(lines('## A', '', '1. Race in the cache', '- evidence: lines 4-9', '- fix: lock it')), ['1.1', '1.2', '1.3'])
  assert.deepEqual(refs(lines('1. Race in the cache', '- evidence', '- fix')), ['1', '2', '3'])
  // an ordinary numbered finding sentence, even with a bullet after it, is an item
  assert.deepEqual(refs(lines('## A', '1. The test is slow and should be fixed.', '- evidence', '2. Another one')), ['1.1', '1.2', '1.3'])
  // consecutive numbered items, a wrapped item, and a title-looking item without a blank before it
  assert.deepEqual(refs(lines('1. Mismatches', '2. Removal')), ['1', '2'])
  assert.deepEqual(refs(lines('## A', '1. Short', '  wrapped on', '- b')), ['1.1', '1.2'])
  assert.deepEqual(refs(lines('## A', '- x', '1. Short', '- b')), ['1.1', '1.2', '1.3'])
  // numbering restarted per section by the source
  assert.deepEqual(refs(lines('## 1. A', '1. x', '2. y', '## 2. B', '1. z')), ['1.1', '1.2', '2.1'])
})

test('hostile input: 50,000 items, many headings and a 200 KB line are labelled in bounded time', () => {
  const src = lines(
    Array.from({ length: 50000 }, () => '- a').join('\n'),
    Array.from({ length: 3000 }, (_, i) => '#'.repeat(1 + (i % 6)) + ' h').join('\n'),
    'x'.repeat(200_000), '- ' + '-'.repeat(200_000), '1. ' + '9'.repeat(200_000), '#' + '#'.repeat(100_000))
  const t = performance.now()
  const out = labelFindings(src)
  within('labelFindings hostile', performance.now() - t, 30000)
  assert.ok(out.length > src.length && out.length < src.length + 50000 * 12 + 3000 * 12 + 100, `output length ${out.length}`)
  assert.equal(labelFindings(out), out)
})

// ---- through the CLI and the page data ----

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function glossed() {
  const dir = tmp('refs-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.js'), 'function main() {\n  run()\n}\n')
  g('add', '-A'); g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'app.js'), 'function main() {\n  run()\n  stop()\n}\n')
  g('commit', '-qam', 'stop')
  const grp = { id: 'stop', hunks: ['h1'], intent: 'i', necessity: 'required', serves: 'task', removal_impact: 'no stop' }
  assert.equal(gloss(dir, ['add'], JSON.stringify({ task: 'stop', groups: [grp] })).code, 0)
  return { dir, sha: g('rev-parse', 'HEAD'), g }
}

function review(dir: string, findings: string): string {
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', 'HEAD']).out)
  assert.equal(gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'claude', target: 'HEAD', findings, stamp })).code, 0)
  const m = /, id (\S+)/.exec(gloss(dir, ['reviews']).out)
  return m![1]
}

const REPORT = '## 1. Mismatches\n- first\n- second\n## Other\n1. third\nVERDICT: ISSUES'

test('the page data and `reviews` carry the labels; the stored report stays raw', () => {
  const { dir, sha, g } = glossed()
  review(dir, REPORT)
  process.chdir(dir)
  const e = buildPageData([sha]).commits[0].reviews[0].entries[0]
  assert.match(e.findings, /- \*\*\[1\.2\]\*\* second/)
  assert.match(e.findings, /- \*\*\[2\.1\]\*\* third/)
  assert.match(gloss(dir, ['reviews']).out, /- \*\*\[1\.1\]\*\* first/)
  assert.ok(g('notes', '--ref', 'gloss-reviews', 'show', sha).includes(JSON.stringify(REPORT).slice(1, -1)), 'stored raw')
})

test('--decide warns, never refuses, for a ref the report lacks; free text and present refs are quiet', () => {
  const { dir } = glossed()
  const id = review(dir, REPORT)
  const d = (finding: string) => gloss(dir, ['reviews', '--decide', id, '--finding', finding, '--outcome', 'fixed'])
  const missing = d('7.3 gone')
  assert.equal(missing.code, 0)
  assert.match(missing.err, /no finding 7\.3/)
  assert.equal(d('1.2 wording nit').err, '')
  assert.equal(d('some free text').err, '')
})

test('decisions are listed in finding order in `reviews`: 1.2 before 1.10, refless last', () => {
  const { dir } = glossed()
  const id = review(dir, REPORT)
  for (const f of ['free text', '1.10 late', '2.1 c', '1.2 early']) assert.equal(gloss(dir, ['reviews', '--decide', id, '--finding', f, '--outcome', 'fixed']).code, 0)
  const out = gloss(dir, ['reviews']).out
  const pos = ['1.2 early', '1.10 late', '2.1 c', 'free text'].map((f) => out.indexOf(`fixed: ${f}`))
  assert.ok(pos.every((p) => p > 0) && pos.every((p, i) => !i || p > pos[i - 1]), pos.join(','))
  process.chdir(dir)
  const e = buildPageData([execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]).commits[0].reviews[0].entries[0] as any
  assert.deepEqual(e.decisions.map((x: any) => x.finding), ['1.2 early', '1.10 late', '2.1 c', 'free text'])
})

test('in a real browser, a hostile finding is text and keeps its bold label', { skip: skipBrowse }, async () => {
  const { dir } = glossed()
  review(dir, '## 1. A\n- </script><img src=x onerror=window.__pwned=1> [x](javascript:window.__pwned=2)\n- second\nVERDICT: ISSUES')
  const out = join(dir, 'page.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    await evaluate(`document.querySelector('.rvrow').click()`)
    const f = JSON.parse(await waitFor(async () => String(await evaluate(`JSON.stringify({
      pwned: window.__pwned === undefined ? null : window.__pwned,
      made: [...document.querySelectorAll('img, iframe, object, embed, form')].map((e) => e.tagName),
      strong: [...document.querySelectorAll('.md li strong')].map((e) => e.textContent),
      first: (document.querySelector('.md li') || {}).textContent || '',
      links: document.querySelectorAll('.md a').length,
    })`)).replace(/^$/, ''), 'the findings render'))
    assert.equal(f.pwned, null)
    assert.deepEqual(f.made, [])
    assert.deepEqual(f.strong.slice(0, 2), ['[1.1]', '[1.2]'])
    assert.ok(f.first.startsWith('[1.1] </script><img src=x onerror=window.__pwned=1>'), f.first)
    assert.equal(f.links, 0)
  })
})

const DUP = lines('## 1. Races', '- first', '', '## 1. Wording', '- second', '- third', '', '## 1. Again', '- fourth', 'VERDICT: ISSUES')
const labelsOf = (out: string) => out.split('\n').filter((l) => l.startsWith('- **[')).map((l) => l.slice(5, l.indexOf(']**')))

test('a repeated section number gets /N: 1, 1/2, 1/3; the first keeps its bare number', () => {
  const out = labelFindings(DUP)
  assert.deepEqual(labelsOf(out), ['1.1', '1/2.1', '1/2.2', '1/3.1'])
  assert.deepEqual([...findingRefs(DUP)], ['1', '1.1', '1/2', '1/2.1', '1/2.2', '1/3', '1/3.1'])
  // running it on its own output changes nothing, and the template lists the items only
  assert.equal(labelFindings(out), out)
  assert.deepEqual(findingTexts(DUP), [['1.1', 'first'], ['1/2.1', 'second'], ['1/2.2', 'third'], ['1/3.1', 'fourth']])
})

test('an implicit section meeting a numbered one is a repeat only if the first emitted a ref', () => {
  // `## A` is section 1, `## B` section 2, then `2. C` repeats 2, and B emitted 2.1
  const out = labelFindings(lines('## A', '- a', '## B', '- b', '## 2. C', '- c'))
  assert.deepEqual(labelsOf(out), ['1.1', '2.1', '2/2.1'])
  // two numbered headings without items: both stay rows of the template
  assert.deepEqual(findingTexts('## 1. X\n\n## 1. Y\n').map(([r]) => r), ['1', '1/2'])
  // a numbered heading without items emitted `2`, which is not `2.1`: no collision, no repeat
  const early = lines('## 2. Empty', '', '## 1. A', '- a', '## Y', '- y')
  assert.deepEqual(labelsOf(labelFindings(early)), ['1.1', '2.1'])
  assert.deepEqual([...findingRefs(early)], ['2', '1', '1.1', '2.1'])
  // an empty heading before a same-numbered one with items
  assert.deepEqual([...findingRefs(lines('## 1. Empty', '## 1. B', '- b'))], ['1', '1.1'])
  // an unnumbered heading that emitted nothing does not use up its number
  const details = lines('## 1. Races', '- r1', '**Details**', 'some prose', '## 2. Wording', '- w1')
  assert.deepEqual(labelsOf(labelFindings(details)), ['1.1', '2.1'])
  assert.deepEqual([...findingRefs(details)], ['1', '1.1', '2', '2.1'])
})

test('refs are byte-identical to the previous version for reports without a collision', () => {
  const corpus = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'refs-corpus.json'), 'utf8')) as { name: string; text: string; labelled: string; refs: string[] }[]
  assert.ok(corpus.length >= 10)
  for (const c of corpus) {
    assert.equal(labelFindings(c.text), c.labelled, c.name)
    assert.deepEqual([...findingRefs(c.text)], c.refs, c.name)
  }
})

test('items before the first heading keep their rows next to a numbered heading with items', () => {
  const t = lines('- loose problem', '- another', '## 1. Races', '- lock')
  assert.deepEqual(findingTexts(t).map(([r]) => r), ['1', '2', '1.1'])
  assert.deepEqual(labelsOf(labelFindings(t)), ['1', '2', '1.1'])
  // a heading without items next to a loose ref `1` takes a free label instead of being dropped
  const u = lines('- loose', '## 1. Empty', '', 'VERDICT: ISSUES')
  assert.deepEqual(findingTexts(u).map(([r]) => r), ['1', '1/2'])
})

test('refOf recognises N-th occurrence refs and rejects prose that looks like a suffix', () => {
  const ok: [string, string | null][] = [['1/2.1 text', '1/2.1'], ['1/12.12: x', '1/12.12'], ['2/999.3', '2/999.3'], ['1/2: heading', '1/2'], ['1/2) x', '1/2'], ['1/2. x', '1/2'], ['1/2', null]]
  for (const [f, want] of ok) assert.equal(refOf(f), want, f)
  for (const f of ['1/2 cup of tea', '1/1.1 x', '1/0.1 x', '1/1000.1 x', '1/2/3.1 x', '1/a.1 x', '2nd: x', '1st) call', '2fa: bypass', '3d: render', '2a) option', '1b.1 text', '3d printing', '1/2.12345 x', '1234/2.1', '/2.1', '1/.1']) assert.equal(refOf(f), null, f)
  assert.equal(refOf('1.2 wording nit'), '1.2')
  assert.equal(refOf('3: x'), '3')
  assert.equal(refOf('1 wording nit'), null)
})

test('a label of the repeat form written before is dropped, not stacked', () => {
  const text = lines('## 1. A', '- **[1/2.9]** looks like a label', '- 1b.2 is text', '## 2. B', '- b')
  assert.match(labelFindings(text), /\[1\.1\]\*\* looks like a label/)
  const once = labelFindings(DUP)
  assert.equal(labelFindings(once), once)
})

test('orderDecisions: 1 < 1.1 < 1.10 < 1/2 < 1/2.1 < 1/10 < 2', () => {
  const d = (finding: string, at: string) => ({ finding, at })
  const out = orderDecisions([d('2.1 x', '1'), d('1/10.1 x', '2'), d('1/2.1 x', '3'), d('1/2: x', '4'), d('1.10 x', '5'), d('1.1 x', '6'), d('1: x', '7'), d('free text', '8')])
  assert.deepEqual(out.map((x) => refOf(x.finding)), ['1', '1.1', '1.10', '1/2', '1/2.1', '1/10.1', '2.1', null])
})

test('hostile: thousands of repeated headings stay bounded and every item keeps its own label', () => {
  const N = 3000
  const many = Array.from({ length: N }, () => '## 1. S\n- i').join('\n')
  const t0 = Date.now()
  const printed = labelsOf(labelFindings(many))
  assert.ok(Date.now() - t0 < 3000)
  // 999 distinct labels; past that the label stays 1/999 and the items keep counting on
  assert.equal(printed.length, N)
  assert.equal(new Set(printed).size, N)
  assert.equal(printed[0], '1.1')
  assert.equal(printed[1], '1/2.1')
  assert.equal(printed[998], '1/999.1')
  assert.equal(printed[999], '1/999.2')
  assert.equal(printed[N - 1], `1/999.${N - 998}`)
  // (item numbers over 999 are not refs a decision can name; that limit is older than this)
  assert.ok(printed.slice(0, 1997).every((r) => refOf(r) === r))
  // the template has a row for every item
  assert.equal(findingTexts(many).length, N)
  // a heading without items past the cap has no row of its own (its ref is taken); nothing else is lost
  const empties = Array.from({ length: 1005 }, () => '## 1. S').join('\n\n')
  assert.equal(findingTexts(empties).length, 999)
  assert.equal(refOf('1' + 'b'.repeat(200000) + '.1 x'), null)
  assert.equal(refOf('1/2' + ' '.repeat(100000) + '.1'), null)
  assert.equal(refOf('1/' + '2'.repeat(100000) + '.1'), null)
})

test('hostile text: __proto__, SQL-like and long digit refs are plain text', () => {
  for (const f of ['__proto__', '1/2.1; DROP', '9'.repeat(100) + '.1 x', '1/2.1\u0000', 'constructor.1 x']) assert.equal(refOf(f), null, f)
  const t = lines('## 1. __proto__', '- constructor', '## 1. toString', '- y')
  assert.deepEqual(labelsOf(labelFindings(t)), ['1.1', '1/2.1'])
})

test('a heading numbered 0 keeps its own ref, with or without items', () => {
  assert.deepEqual([...findingRefs(lines('## 0. Intro', '- a', '## 2. B', '- b'))], ['0', '1.1', '2', '2.1'])
  // its items fall in section 1; a later `## 1.` then collides with them and is the repeat
  const t = lines('## 0. Intro', '- a', '## 1. B', '- b')
  assert.deepEqual([...findingRefs(t)], ['0', '1.1', '1/2', '1/2.1'])
  assert.deepEqual(labelsOf(labelFindings(t)), ['1.1', '1/2.1'])
  // a heading with items is no template row, whatever its number
  assert.deepEqual(findingTexts(t).map(([r]) => r), ['1.1', '1/2.1'])
  assert.deepEqual(findingTexts(lines('## 0. Intro', '', '## 2. B', '- b')).map(([r]) => r), ['0', '2.1'])
})

test('a heading that lost its ref is a clash only when it would have been a row', () => {
  assert.deepEqual(findingClashes(lines('## 1. Empty', '## 1. B', '- b')), [])
  assert.deepEqual(findingClashes(Array.from({ length: 1002 }, () => '## 1. S').join('\n\n')), ['1/999'])
  // headings numbered 0 with items past the cap lose only a ref no row needs
  assert.deepEqual(findingClashes('## 0. S\n- i\n'.repeat(1002)), [])
})

test('hostile: a 250 KB report of repeated sections labels in well under a second', () => {
  const big = '## 1.\n- i\n'.repeat(22000)
  assert.ok(big.length < 256 * 1024)
  let t = performance.now()
  const out = labelFindings(big)
  within('labelFindings 22000 repeats', performance.now() - t, 1000)
  assert.equal(out.split('\n').filter((l) => l.startsWith('- **[')).length, 22000)
  t = performance.now()
  assert.equal(findingTexts(big).length, 22000)
  assert.equal(findingRefs(big).size, 22000 + 999)
  within('findingTexts+refs 22000 repeats', performance.now() - t, 1000)
})

// Property: whenever the previous version's refs were all distinct, the refs are unchanged.
test('generated reports whose old refs were distinct keep their refs exactly', async () => {
  const old = await import('./fixtures/findings-v0.6.ts')
  let seed = 12345
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n }
  let compared = 0
  for (let i = 0; i < 600; i++) {
    const parts: string[] = []
    const heads: number[] = []
    let loose = 0, sawHeading = false, items = 0
    for (let k = 1 + rnd(8); k > 0; k--) {
      const c = rnd(6)
      if (c === 0) { const n = rnd(5); heads.push(n); sawHeading = true; parts.push(`## ${n}. H`) }
      else if (c === 1) { sawHeading = true; parts.push('## Plain') }
      else if (c === 2) { sawHeading = true; parts.push('**Details**') }
      else if (c === 3) parts.push('some prose')
      else { if (!sawHeading) loose++; items++; parts.push('- item') }
    }
    const text = parts.join('\n\n') + '\nVERDICT: ISSUES'
    const o = old.labelFindings(text)
    const printed = o.split('\n').filter((l) => l.startsWith('- **[')).map((l) => l.slice(5, l.indexOf(']**')))
    const distinct = new Set(printed).size === printed.length && new Set(heads).size === heads.length && !heads.some((n) => n >= 1 && n <= loose)
    if (!distinct) continue
    compared++
    assert.equal(labelFindings(text), o, text)
    assert.deepEqual([...findingRefs(text)], [...old.findingRefs(text)], text)
  }
  assert.ok(compared > 100, `only ${compared} comparable reports`)
})
