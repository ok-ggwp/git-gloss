import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFindingsBlock, checkItems, MAX_ITEMS } from '../src/findings-block.ts'
import { within } from './timing.ts'
import { item, report } from './block.ts'

const ok = (r: ReturnType<typeof parseFindingsBlock>) => { assert.ok('items' in r, 'problems' in r ? r.problems.join('; ') : ''); return r.items }
const bad = (r: ReturnType<typeof parseFindingsBlock>) => { assert.ok('problems' in r, 'expected problems'); return r.problems.join('\n') }

test('a report ending with a valid block gives its items, sanitised', () => {
  const items = ok(parseFindingsBlock(report('Prose.', [item('f1', { where: 'a.ts:1', detail: 'why', title: 'bad\x1b[31m thing' }), item('f2', { severity: 'nit', kind: 'unproven', basis: 'verified' })])))
  assert.deepEqual(items.map((i) => i.id), ['f1', 'f2'])
  assert.equal(items[0].title, 'bad thing')
  assert.ok(!items[0].title.includes('\x1b'))
  assert.equal(items[0].where, 'a.ts:1')
  assert.equal(items[1].kind, 'unproven')
})

test('an empty array is a valid clean review', () => {
  assert.deepEqual(ok(parseFindingsBlock(report('Nothing found.', []))), [])
})

test('a missing block is refused, and says what to add', () => {
  const p = bad(parseFindingsBlock('Looks fine.\n\nVERDICT: CLEAN\n'))
  assert.match(p, /no gloss-findings block/)
})

test('a report in the legacy format (a list, no block) is refused', () => {
  bad(parseFindingsBlock('## 1. Mismatches\n- f.ts:1 wrong\n- g.ts:2 wrong\n\nVERDICT: ISSUES\n'))
})

test('the last gloss-findings fence counts: two blocks, the second wins', () => {
  const r = `${report('first', [item('a1')], null)}\nsecond:\n\`\`\`gloss-findings\n[{"id":"b1","kind":"defect","severity":"major","basis":"verified","title":"t"}]\n\`\`\`\nVERDICT: ISSUES\n`
  assert.deepEqual(ok(parseFindingsBlock(r)).map((i) => i.id), ['b1'])
})

test('an example inside a longer or other fence earlier in the report does not count', () => {
  const example = '````markdown\nWrite:\n```gloss-findings\n[{"id":"x1","kind":"defect","severity":"major","basis":"read","title":"example"}]\n```\n````\n'
  // the real block (empty) is last: the example is not it
  assert.deepEqual(ok(parseFindingsBlock(`${example}\n${report('real', [])}`)), [])
  // an example is the only block: it is inside another fence, so nothing counts
  assert.match(bad(parseFindingsBlock(`${example}\nVERDICT: CLEAN`)), /no gloss-findings block/)
  // inside a tilde fence
  const tilde = '~~~\n```gloss-findings\n[]\n```\n~~~\n'
  assert.match(bad(parseFindingsBlock(tilde)), /no gloss-findings block/)
})

test('an unclosed fence, or an indented one, is not a block', () => {
  assert.match(bad(parseFindingsBlock('```gloss-findings\n[]\n')), /not closed/)
  assert.match(bad(parseFindingsBlock('    ```gloss-findings\n    []\n    ```\n')), /no gloss-findings block/)
})

test('a fence longer than three backticks, and trailing spaces after the name, work', () => {
  assert.deepEqual(ok(parseFindingsBlock('````gloss-findings  \n[]\n````\n')), [])
  // a shorter inner run does not close it
  assert.match(bad(parseFindingsBlock('````gloss-findings\n[]\n```\nmore\n')), /not closed/)
})

test('malformed JSON is refused with the parser message, not a crash', () => {
  assert.match(bad(parseFindingsBlock('```gloss-findings\n[{"id": "f1",]\n```\n')), /not valid JSON/)
  assert.match(bad(parseFindingsBlock('```gloss-findings\n\n```\n')), /not valid JSON|empty/)
  assert.match(bad(parseFindingsBlock('```gloss-findings\n{"id":"f1"}\n```\n')), /must be a JSON array/)
})

test('every problem is listed, naming the item', () => {
  const p = bad(parseFindingsBlock(report('x', [
    { id: 'f1', kind: 'nope', severity: 'huge', basis: 'guess', title: 't' },
    { id: 'bad id', kind: 'defect', severity: 'minor', basis: 'read', title: 't' },
    { id: 'f3', kind: 'defect', severity: 'minor', basis: 'read' },
    { id: 'f3', kind: 'defect', severity: 'minor', basis: 'read', title: 'dup' },
  ])))
  assert.match(p, /item 1 \("f1"\).*kind/s)
  assert.match(p, /severity/)
  assert.match(p, /basis/)
  assert.match(p, /item 2.*id/)
  assert.match(p, /item 3 \("f3"\).*title/)
  assert.match(p, /item 4 \("f3"\).*repeats item 3/)
})

test('non-objects and wrong types are problems', () => {
  const p = bad(parseFindingsBlock('```gloss-findings\n[1, null, [], "s", {"id": 5, "kind": "defect", "severity": "minor", "basis": "read", "title": {}}]\n```\n'))
  assert.match(p, /item 1 is not an object/)
  assert.match(p, /item 2 is not an object/)
  assert.match(p, /item 3 is not an object/)
  assert.match(p, /item 4 is not an object/)
  assert.match(p, /item 5/)
})

test('string lengths are capped: title 200, where 200, detail 500', () => {
  const t = (over: object) => parseFindingsBlock(report('x', [item('f1', over as never)]))
  ok(t({ title: 'x'.repeat(200), where: 'w'.repeat(200), detail: 'd'.repeat(500) }))
  assert.match(bad(t({ title: 'x'.repeat(201) })), /title/)
  assert.match(bad(t({ where: 'w'.repeat(201) })), /where/)
  assert.match(bad(t({ detail: 'd'.repeat(501) })), /detail/)
  assert.match(bad(t({ title: '   ' })), /title/)
  assert.match(bad(t({ title: '\x1b[2J' })), /title/)
  assert.match(bad(t({ id: 'x'.repeat(33) })), /id/)
})

test('ids: __proto__ and constructor are plain ids, and nothing is polluted', () => {
  const items = ok(parseFindingsBlock('```gloss-findings\n[{"id":"__proto__","kind":"defect","severity":"minor","basis":"read","title":"a"},{"id":"constructor","kind":"defect","severity":"minor","basis":"read","title":"b","__proto__":{"polluted":1}},{"id":"toString","kind":"defect","severity":"minor","basis":"read","title":"c","constructor":"x"}]\n```\n'))
  assert.deepEqual(items.map((i) => i.id), ['__proto__', 'constructor', 'toString'])
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.equal(Object.getPrototypeOf(items[0]), Object.prototype)
  assert.deepEqual(Object.keys(items[1]).sort(), ['basis', 'id', 'kind', 'severity', 'title'])
  // a duplicate of such an id is still a duplicate
  assert.match(bad(parseFindingsBlock('```gloss-findings\n[{"id":"__proto__","kind":"defect","severity":"minor","basis":"read","title":"a"},{"id":"__proto__","kind":"defect","severity":"minor","basis":"read","title":"a"}]\n```\n')), /repeats item 1/)
})

test('ids with escape sequences, bidi marks, newlines or look-alikes are refused', () => {
  for (const id of ['f\x1b[31m1', 'f‮1', 'f​1', 'f\n1', 'f 1', 'ｆ1', 'f1\u0000', '', 'é']) {
    assert.match(bad(parseFindingsBlock(report('x', [item(id)]))), /id/, JSON.stringify(id))
  }
  // the message never carries the raw escape
  assert.ok(!bad(parseFindingsBlock(report('x', [item('f\x1b]52;c;AAAA\x07')]))).includes('\x1b'))
})

test('item count: 200 fit, 201 do not, and 100,000 are refused quickly', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => item(`f${i}`, { title: 't' }))
  assert.equal(ok(parseFindingsBlock(report('x', many(MAX_ITEMS)))).length, MAX_ITEMS)
  assert.match(bad(parseFindingsBlock(report('x', many(MAX_ITEMS + 1)))), /at most 200/)
  const block = (n: number, one: string) => `\`\`\`gloss-findings\n[${Array(n).fill(one).join(',')}]\n\`\`\`\n`
  // 80,000 small objects fit the text cap and are refused by count; 100,000 are refused by size
  for (const [n, why] of [[80_000, /at most 200/], [100_000, /too long/]] as const) {
    const t0 = performance.now()
    const p = bad(parseFindingsBlock(block(n, '{}')))
    within(`${n} items`, performance.now() - t0, 1500)
    assert.match(p, why)
    assert.ok(p.length < 5000, 'the message stays short')
  }
})

test('a 10 MB block is refused quickly, never parsed', () => {
  const t0 = performance.now()
  const p = bad(parseFindingsBlock(`\`\`\`gloss-findings\n[{"id":"f1","detail":"${'x'.repeat(10 * 1024 * 1024)}"}]\n\`\`\`\n`))
  within('10 MB block', performance.now() - t0, 1500)
  assert.match(p, /too long|too large/)
})

test('a report of many fence-like lines is read in linear time', () => {
  const lines = Array.from({ length: 50_000 }, (_, i) => (i % 2 ? '```' : '```gloss-findings')).join('\n')
  const t0 = performance.now()
  parseFindingsBlock(lines)
  within('fence soup', performance.now() - t0, 1500)
})

test('checkItems is the shared validator: it takes any value', () => {
  assert.ok('problems' in checkItems('nope'))
  assert.ok('problems' in checkItems(undefined))
  assert.ok('items' in checkItems([]))
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BLOCK_SPEC, findBlock } from '../src/findings-block.ts'

// The documented spec is the real spec, in an outer fence long enough to render the example inside it.
for (const file of ['README.md', 'skills/gloss/SKILL.md']) {
  test(`the report format in ${file} is BLOCK_SPEC, in a four-backtick fence, and its example parses`, () => {
    const text = readFileSync(join(import.meta.dirname, '..', file), 'utf8')
    const m = /^````\n([^]*?)\n````$/m.exec(text.slice(text.indexOf('Report format')))
    assert.ok(m, 'a four-backtick block holds the spec')
    assert.equal(m[1], BLOCK_SPEC)
    const inner = findBlock(m[1])
    assert.ok('body' in inner, 'the spec holds a gloss-findings block')
    const checked = checkItems(JSON.parse(inner.body))
    assert.ok('items' in checked, 'problems' in checked ? checked.problems.join('; ') : '')
  })
}

test('BLOCK_SPEC is plain text: nothing but printable characters and newlines', () => {
  assert.ok(!/[^\n\x20-\x7e]/.test(BLOCK_SPEC))
})

import { MAX_FINDINGS } from '../src/reviews.ts'

test('the worst-case block the spec text allows fits the block cap and leaves room for prose in the report cap', () => {
  const n = (re: RegExp) => Number(re.exec(BLOCK_SPEC)![1])
  const idLen = n(/id: (\d+) characters/), where = n(/where \(optional, at most (\d+)/), title = n(/title \(at most (\d+)/), detail = n(/detail \(optional, at most (\d+)/), items = n(/At most (\d+) items/)
  const longest = (re: RegExp) => re.exec(BLOCK_SPEC)![1].split(' | ').sort((a, b) => b.length - a.length)[0]
  const kind = longest(/kind: ([a-z| -]+?)\. severity/), severity = longest(/severity: ([a-z| ]+?)\. basis/), basis = longest(/basis: ([a-z| ]+?) \(/)
  const one = (i: number) => ({ id: String(i).padStart(idLen, 'x'), kind, severity, basis, where: 'w'.repeat(where), title: 't'.repeat(title), detail: 'd'.repeat(detail) })
  const block = `\`\`\`gloss-findings\n${JSON.stringify(Array.from({ length: items }, (_, i) => one(i)), null, 2)}\n\`\`\`\n`
  assert.equal(items, MAX_ITEMS)
  assert.ok(block.length <= MAX_FINDINGS - 32 * 1024, `the worst-case block is ${block.length} characters`)
  assert.equal(ok(parseFindingsBlock(block)).length, items)
})

test('BLOCK_SPEC says the caps are measured on the raw report text, and the detail cap is 500 everywhere', () => {
  assert.match(BLOCK_SPEC, /measured on the raw report text/)
  assert.match(BLOCK_SPEC, /detail \(optional, at most 500\)/)
})
