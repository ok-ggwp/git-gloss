import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { item, plantLegacy, report, type TestItem } from './block.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function repo() {
  const dir = tmp('decisions-test-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const write = (file: string, lines: string[]) => writeFileSync(join(dir, file), lines.join('\n') + '\n')
  write('app.js', ['function main() {', '  run()', '}'])
  g('add', '-A')
  g('commit', '-qm', 'base')
  return { dir, g, write }
}

const group = (id: string, hunks: string[]) =>
  ({ id, hunks, intent: `${id} intent`, necessity: 'required', serves: 'task', removal_impact: `no ${id}` })

function review(dir: string, rev: string, items: TestItem[] = [item('f1', { severity: 'major' }), item('f2', { kind: 'mismatch', title: 'Rework: wip rule claim' })]): string {
  const sha0 = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  const had = new Set(spawnSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha0], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).id))
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  const r = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'claude', target: rev, findings: report('Two problems.', items), stamp }))
  assert.equal(r.code, 0, r.err)
  const sha = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  return noteLines(dir, sha).map((l) => JSON.parse(l)).find((r) => r.review === 1 && !had.has(r.id)).id
}

const noteLines = (dir: string, sha: string) =>
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)

const decide = (dir: string, target: string, id: string, ...rest: string[]) => gloss(dir, ['reviews', target, '--decide', id, ...rest])

function withReview() {
  const r = repo()
  r.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  r.g('commit', '-qam', 'stop')
  assert.equal(gloss(r.dir, ['add'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  const id = review(r.dir, 'HEAD')
  return { ...r, id, sha: r.g('rev-parse', 'HEAD') }
}

test('reviews prints each review id, so an arbiter can pass it to --decide', () => {
  const { dir, id } = withReview()
  assert.match(gloss(dir, ['reviews']).out, new RegExp(`, id ${id}`))
})

test('a decision round-trips: --decide by item id, then reviews and show count what is open; --complete closes the review', () => {
  const { dir, id } = withReview()
  let out = gloss(dir, ['reviews']).out
  assert.match(out, /2 findings: 2 open/)
  assert.match(out, /id +severity +kind +basis +status +title/)
  assert.match(out, /f1 +major +defect +read +open +title of f1/)
  assert.match(gloss(dir, ['show']).out, /2 open findings/)
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed').code, 0)
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f2', '--outcome', 'follow-up', '--note', 'next release', '--by', 'Arb').code, 0)
  out = gloss(dir, ['reviews']).out
  assert.match(out, /2 findings: 1 fixed, 1 follow-up\n/)
  assert.match(out, /f1 +major +defect +read +fixed +title of f1/)
  assert.match(out, /f2: next release \(Arb, /)
  assert.match(gloss(dir, ['show']).out, /no open findings/)
  assert.equal(decide(dir, 'HEAD', id, '--complete').code, 0)
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 1 fixed, 1 follow-up · marked complete/)
  // the latest decision for an id is the status
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'rejected', '--by', 'Arb').code, 0)
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 1 follow-up, 1 rejected/)
})

test('--decide validates its input and names the review or finding it cannot find', () => {
  const { dir, id } = withReview()
  const bad = decide(dir, 'HEAD', 'nope', '--finding', 'f1', '--outcome', 'fixed')
  assert.equal(bad.code, 1)
  assert.match(bad.err, /no review nope on HEAD/)
  const unknown = decide(dir, 'HEAD', id, '--finding', '1', '--outcome', 'fixed')
  assert.equal(unknown.code, 1)
  assert.match(unknown.err, /no finding "1" \(its findings: f1, f2\)/)
  assert.match(decide(dir, 'HEAD', id, '--finding', 'x'.repeat(2001), '--outcome', 'fixed').err, /no finding/)
  assert.match(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'ignored').err, /--outcome must be one of fixed, follow-up, rejected, accepted/)
  assert.match(decide(dir, 'HEAD', id, '--outcome', 'fixed').err, /--finding/)
  assert.match(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed', '--note', 'n'.repeat(2001)).err, /--note is too long/)
  assert.match(decide(dir, 'HEAD', id, '--complete', '--outcome', 'fixed').err, /takes no/)
  assert.match(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed', '--by', 'b'.repeat(201)).err, /--by is too long/)
  assert.match(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed', '--by', '  ').err, /--by/)
  assert.match(gloss(dir, ['reviews', '--outcome', 'fixed']).err, /goes with --decide/)
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 2 open/)
})

test('a legacy review (no items) is listed, shown raw and counted, but has nothing to decide', () => {
  const { dir, sha } = withReview()
  const old = plantLegacy(dir, sha, { findings: 'Old style.\n- one\n- two\nVERDICT: ISSUES' })
  const out = gloss(dir, ['reviews']).out
  assert.match(out, new RegExp(`id ${old}`))
  assert.match(out, /recorded without structured findings/)
  assert.match(out, /- one/)
  assert.match(gloss(dir, ['show']).out, /bugs: defects found/)
  for (const args of [['--finding', 'f1', '--outcome', 'fixed'], ['--complete']]) {
    const r = decide(dir, 'HEAD', old, ...args)
    assert.equal(r.code, 1)
    assert.match(r.err, /without structured findings/)
  }
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide-template', old]).err, /without structured findings/)
  const open = gloss(dir, ['reviews', 'HEAD', '--open'])
  assert.equal(open.code, 1)
  assert.doesNotMatch(open.out, new RegExp(old), 'the legacy review is not in the open list')
  // a commit with only a legacy review has nothing open
  const only = repo()
  only.write('app.js', ['function main() {', '  run()', '  go()', '}'])
  only.g('commit', '-qam', 'go')
  assert.equal(gloss(only.dir, ['add'], JSON.stringify({ task: 'go', groups: [group('go', ['h1'])] })).code, 0)
  plantLegacy(only.dir, only.g('rev-parse', 'HEAD'))
  assert.equal(gloss(only.dir, ['reviews', 'HEAD', '--open']).code, 0, 'legacy reviews do not count as open')
})

test('identical decisions count once', () => {
  const { dir, id, sha } = withReview()
  // Same line twice (as a merge of two copies of a note produces): one decision.
  const line = JSON.stringify({ decision: 1, review: id, at: '2026-10-24T10:00:00.000Z', by: 'A', finding: 'f1', outcome: 'fixed' })
  const old = noteLines(dir, sha)
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...old, line, line].join('\n') + '\n' })
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 1 open, 1 fixed/)
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f2', '--outcome', 'accepted', '--by', 'A').code, 0)
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 1 fixed, 1 accepted/)
})

test('a decision line is not a review, and decisions without their review on the commit are ignored', () => {
  const { dir, g, id, sha } = withReview()
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed').code, 0)
  // What an older reader sees: every line must fail its whole-record check.
  assert.equal(noteLines(dir, sha).length, 2)
  const out = gloss(dir, ['reviews']).out
  assert.equal(out.match(/── bugs by claude/g)?.length, 1, 'the decision line is not returned as a review')
  assert.match(gloss(dir, ['show']).out, /reviews: bugs: defects found/)
  // A decision for a review that is not on the commit sits in the note but is not counted, shown or copied.
  const stray = JSON.stringify({ decision: 1, review: 'other-id', at: '2026-10-24T10:00:00.000Z', by: 'A', finding: 'ghost', outcome: 'rejected' })
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...noteLines(dir, sha), stray].join('\n') + '\n' })
  assert.doesNotMatch(gloss(dir, ['reviews']).out, /ghost/)
  assert.match(gloss(dir, ['show']).out, /1 open finding\b/)
  g('checkout', '-q', '-b', 'copy', 'HEAD~1')
  g('cherry-pick', sha)
  const copy = g('rev-parse', 'HEAD')
  assert.equal(gloss(dir, ['carry', sha]).code, 0)
  const copied = noteLines(dir, copy)
  assert.ok(copied.some((l) => l.includes('"outcome":"fixed"')), 'the real decision is copied')
  assert.ok(!copied.some((l) => l.includes('ghost')), 'the stray decision is not copied')
})

test('adoption keeps decisions: a wip review arbitrated on wip is decided on the commit', () => {
  const { dir, g, write } = repo()
  write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  gloss(dir, ['hunks', 'wip'])
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  const id = review(dir, 'wip')
  assert.equal(decide(dir, 'wip', id, '--finding', 'f1', '--outcome', 'rejected', '--note', 'not a bug').code, 0)
  assert.equal(decide(dir, 'wip', id, '--complete').code, 0)
  g('commit', '-qam', 'stop')
  assert.equal(gloss(dir, ['adopt']).code, 0)
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /2 findings: 1 open, 1 rejected · marked complete/)
  assert.match(out, /f1: not a bug/)
  assert.match(out, /f2 +minor +mismatch +read +open +Rework: wip rule claim/, 'the items came with the review')
})

test('carry brings decisions along with the reviews of a squash', () => {
  const { dir, g, write } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  one()', '}'])
  g('commit', '-qam', 'one')
  assert.equal(gloss(dir, ['add'], JSON.stringify({ task: 'one', groups: [group('one', ['h1'])] })).code, 0)
  const id = review(dir, 'HEAD')
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f2', '--outcome', 'accepted').code, 0)
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  g('commit', '-qm', 'squashed')
  assert.equal(gloss(dir, ['carry', 'main~1..feat']).code, 0)
  assert.match(gloss(dir, ['reviews']).out, /f2 +minor +mismatch +read +accepted +Rework/)
})

test('hostile decisions: escapes and control characters never reach the terminal, junk lines are skipped', () => {
  const { dir, id, sha } = withReview()
  const hostile = JSON.stringify({
    decision: 1, review: id, at: '2026-10-24T10:00:00.000Z', by: 'evil\x1b[2J',
    finding: 'f1', outcome: 'fixed', note: 'n\x1b]8;;http://evil\x1b\\link\x1b[?25l\r\nFAKE LINE\x1bc\u202etxt',
  })
  // a decision naming no item is not shown at all
  const stray = JSON.stringify({ decision: 1, review: id, at: '2026-10-24T10:00:00.000Z', by: 'b', finding: 'f\x1b]0;pwned\x07inding\x1b[31m red\x00\x08\x7f\u009b31m‮txt', outcome: 'fixed' })
  const junk = '{"decision":1,"review":"' + id + '","finding":"' + 'A'.repeat(10 * 1024 * 1024) + '"}'
  const old = noteLines(dir, sha)
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...old, hostile, stray, junk].join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 })
  for (const args of [['reviews'], ['show']]) {
    const r = gloss(dir, args)
    assert.equal(r.code, 0, r.err)
    assert.doesNotMatch(r.out, /[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/, `${args[0]} output has a control character`)
    assert.ok(r.out.length < 100_000)
  }
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /f1 +major +defect +read +fixed/)
  assert.match(out, /2 findings: 1 open, 1 fixed/)
  assert.doesNotMatch(out, /pwned/)
})

test('a legacy review shows its decisions as stored text, cleaned', () => {
  const { dir, sha } = withReview()
  const old = plantLegacy(dir, sha)
  const hostile = JSON.stringify({ decision: 1, review: old, at: '2026-10-24T10:00:00.000Z', by: 'e\x1b[2J', finding: '1.2 f\x1b]0;pwned\x07inding\x1b[31m red\x00\u009b31m‮txt', outcome: 'fixed', note: 'n\x1bc' })
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...noteLines(dir, sha), hostile].join('\n') + '\n' })
  const r = gloss(dir, ['reviews'])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /[\x00-\x08\x0b-\x1f\x7f-\x9f‮]/)
  assert.match(r.out, /fixed: 1\.2 finding/)
  assert.match(r.out, /decisions on this review: 1 decided/)
})

test('show counts the open findings of current reviews: a clean review has none, a legacy one none to decide', () => {
  const { dir, id } = withReview()
  assert.match(gloss(dir, ['show']).out, /2 open findings/)
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed').code, 0)
  assert.match(gloss(dir, ['show']).out, /1 open finding\b/)
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f2', '--outcome', 'fixed').code, 0)
  assert.match(gloss(dir, ['show']).out, /no open findings/)
  // A newer clean review of the same stage does not clear the older one's findings: they stay open until decided.
  const again = repo()
  again.write('app.js', ['function main() {', '  run()', '  go()', '}'])
  again.g('commit', '-qam', 'go')
  assert.equal(gloss(again.dir, ['add'], JSON.stringify({ task: 'go', groups: [group('go', ['h1'])] })).code, 0)
  review(again.dir, 'HEAD')
  assert.match(gloss(again.dir, ['show']).out, /2 open findings/)
  review(again.dir, 'HEAD', [])
  assert.match(gloss(again.dir, ['show']).out, /2 open findings/)
  // Only a clean review: no findings part at all.
  const r2 = repo()
  r2.write('app.js', ['function main() {', '  run()', '  go()', '}'])
  r2.g('commit', '-qam', 'go')
  assert.equal(gloss(r2.dir, ['add'], JSON.stringify({ task: 'go', groups: [group('go', ['h1'])] })).code, 0)
  review(r2.dir, 'HEAD', [])
  const out = gloss(r2.dir, ['show']).out
  assert.match(out, /reviews: bugs: /)
  assert.doesNotMatch(out, /open finding/)
})

test('hostile review records: escapes in agent, stage and the rest never reach the terminal', () => {
  const { dir, sha } = withReview()
  const evil = JSON.stringify({
    review: 1, id: 'evil-id', at: '2026-10-24T10:00:00.000Z\x1b[2J', stage: 'st\x1b]0;pwned\x07age', agent: 'x\x1b]0;pwned\x07y',
    model: 'm\x1b[31m', mode: 'mo\x9bde', target: 't\x1bc', lines: [], groups: [], findings: 'body\x1b[2J\nVERDICT: ISSUES',
  })
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...noteLines(dir, sha), evil].join('\n') + '\n' })
  for (const args of [['reviews'], ['show']]) {
    const r = gloss(dir, args)
    assert.equal(r.code, 0, r.err)
    assert.doesNotMatch(r.out, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/, `${args[0]} output has a control character`)
  }
  assert.match(gloss(dir, ['reviews']).out, /── stage by xy/)
  assert.doesNotMatch(gloss(dir, ['reviews', 'HEAD', '--decide', 'nope', '--complete']).err, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
  // A record whose items carry escapes is not whole: skipped, not shown cleaned.
  const bad = JSON.stringify({ ...JSON.parse(evil), id: 'evil-items', items: [{ id: 'f\x1b[2J1', kind: 'defect', severity: 'minor', basis: 'read', title: 't' }] })
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...noteLines(dir, sha), bad].join('\n') + '\n' })
  assert.doesNotMatch(gloss(dir, ['reviews']).out, /evil-items/)
})

test('the longest decision the writer accepts is within the reader\'s cap and is read back', () => {
  const { dir, id, sha } = withReview()
  // Control characters are written as 6-byte escapes: a 2000-character note and a 200-character name still fit the 16 KiB line.
  const r = decide(dir, 'HEAD', id, '--finding', 'f1', '--outcome', 'fixed', '--note', '\x01'.repeat(2000), '--by', '\x01'.repeat(200))
  assert.equal(r.code, 0, r.err)
  assert.ok(noteLines(dir, sha).some((l) => l.includes('"decision":1') && l.length > 12_000))
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 1 open, 1 fixed/)
})

const INVISIBLE = ['\u200e', '\u200f', '\u061c', '\u200b', '\u180e', '\u2060', '\u2061', '\u2062', '\u2063', '\u2064', '\ufeff', '\u{e0041}', '\u{e007f}', '\u{e0000}']
const INVISIBLE_RE = /[\u200b\u200e\u200f\u180e\u061c\u2060-\u2064\ufeff\u{e0000}-\u{e007f}]/u

test('bidi marks and zero-width characters never reach terminal output (decision text, commit subject); ZWJ and ZWNJ text passes unchanged', async () => {
  const { plain } = await import('../src/plain.ts')
  for (const c of INVISIBLE) assert.doesNotMatch(plain(`a${c}b`), INVISIBLE_RE, `U+${c.codePointAt(0)!.toString(16)} survives plain()`)
  assert.equal(plain('a‎b', true), 'a b')
  assert.equal(plain('a­b'), 'a­b', 'soft hyphen is kept')
  const keep = ['\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645']
  for (const k of keep) assert.equal(plain(k), k, 'ZWJ and ZWNJ stay')
  const { dir, g, id, sha } = withReview()
  const bad = INVISIBLE.join('x')
  const hostile = JSON.stringify({ decision: 1, review: id, at: '2026-10-24T10:00:00.000Z', by: 'b' + bad, finding: 'f1', outcome: 'fixed', note: 'n' + bad })
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...noteLines(dir, sha), hostile].join('\n') + '\n' })
  g('commit', '-q', '--amend', '--no-edit', '-m', 'subj' + bad)
  g('notes', '--ref', 'gloss-reviews', 'copy', '-f', sha, g('rev-parse', 'HEAD'))
  for (const args of [['reviews'], ['show']]) {
    const r = gloss(dir, args)
    if (args[0] === 'reviews') assert.equal(r.code, 0, r.err)
    assert.doesNotMatch(r.out + r.err, INVISIBLE_RE, `${args[0]} output has an invisible character`)
  }
  assert.match(gloss(dir, ['reviews']).out, /f1: n/)
})

const decisionNote = (id: string, extra: object) => JSON.stringify({ decision: 1, review: id, at: '2026-10-24T10:00:00.000Z', by: 'A', ...extra })
const setNote = (dir: string, sha: string, lines: string[]) =>
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: lines.join('\n') + '\n', maxBuffer: 64 * 1024 * 1024 })

test('a complete marker carries no finding, outcome or note: the reader skips one that does, the writer refuses it, a plain one counts', async () => {
  const { isValidDecision } = await import('../src/reviews.ts')
  assert.equal(isValidDecision({ complete: true, note: 'x' }), false)
  assert.equal(isValidDecision({ complete: true, finding: 'x' }), false)
  assert.equal(isValidDecision({ complete: true }), true)
  const { dir, id, sha } = withReview()
  setNote(dir, sha, [...noteLines(dir, sha), decisionNote(id, { complete: true, note: 'x' })])
  assert.doesNotMatch(gloss(dir, ['reviews']).out, /marked complete/)
  assert.match(decide(dir, 'HEAD', id, '--complete', '--note', 'x').err, /takes no/)
  assert.equal(decide(dir, 'HEAD', id, '--complete').code, 0)
  assert.match(gloss(dir, ['reviews']).out, /marked complete/)
})

test('a decision line is read whatever its key order', () => {
  const { dir, id, sha } = withReview()
  const line = JSON.stringify({ review: id, by: 'A', outcome: 'fixed', finding: 'f2', at: '2026-10-24T10:00:00.000Z', decision: 1 })
  setNote(dir, sha, [...noteLines(dir, sha), line])
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 1 open, 1 fixed/)
})

test('over-cap lines: huge junk is skipped fast and silently, an over-cap decision line is silent, an over-cap review line still warns', async () => {
  const { within } = await import('./timing.ts')
  const { dir, id, sha } = withReview()
  const junk = '{"decision":1,"review":"' + id + '","finding":"' + 'A'.repeat(10 * 1024 * 1024) + '"}'
  const reordered = '{"review":"' + id + '","decision":1,"finding":"' + 'A'.repeat(10 * 1024 * 1024) + '"}'
  const longReview = '{"review":1,"id":"x","findings":"' + 'B'.repeat(9 * 1024 * 1024) + '"}'
  const base = noteLines(dir, sha)
  setNote(dir, sha, [...base, junk, reordered])
  const t0 = Date.now()
  const r = gloss(dir, ['show'])
  within('junk decision lines', Date.now() - t0, 5000)
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.err, /warning/)
  setNote(dir, sha, [...base, longReview])
  assert.match(gloss(dir, ['show']).err, /warning: skipped 1 review record/)
})

test('a whitespace-only finding is refused by the writer and skipped by the reader', () => {
  const { dir, id, sha } = withReview()
  assert.equal(decide(dir, 'HEAD', id, '--finding', '   ', '--outcome', 'fixed').code, 1)
  setNote(dir, sha, [...noteLines(dir, sha), decisionNote(id, { finding: '   ', outcome: 'fixed' })])
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 2 open/)
})

test('a finding of only invisible characters is refused by the writer and skipped by the reader; an id with an invisible character is not the id', () => {
  const { dir, id, sha } = withReview()
  assert.equal(decide(dir, 'HEAD', id, '--finding', '‎', '--outcome', 'fixed').code, 1)
  setNote(dir, sha, [...noteLines(dir, sha), decisionNote(id, { finding: '​‎', outcome: 'fixed' })])
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 2 open/)
  // an id with an invisible character is not the id
  assert.equal(decide(dir, 'HEAD', id, '--finding', 'f1‎', '--outcome', 'fixed').code, 1)
  assert.equal(decide(dir, 'HEAD', id, '--finding', ' f1 ', '--outcome', 'fixed').code, 0)
  assert.match(gloss(dir, ['reviews']).out, /2 findings: 1 open, 1 fixed/)
})

test('decisions that name no finding of a structured review are shown, as stored text, under their own heading', () => {
  const { dir, id, sha } = withReview()
  setNote(dir, sha, [...noteLines(dir, sha), decisionNote(id, { finding: '1.2 old label\x1b[2J', outcome: 'rejected', note: 'from before' }), decisionNote(id, { finding: 'f1', outcome: 'fixed' })])
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /decisions naming no finding:\n +rejected: 1\.2 old label +— from before/)
  assert.match(out, /2 findings: 1 open, 1 fixed/, 'they are not counted')
  assert.doesNotMatch(out, /\x1b/)
  assert.doesNotMatch(gloss(withReview().dir, ['reviews']).out, /naming no finding/, 'no heading when there are none')
})

test('a legacy review lists its decisions in the order they were made', () => {
  const { dir, sha } = withReview()
  const old = plantLegacy(dir, sha)
  setNote(dir, sha, [...noteLines(dir, sha),
    decisionNote(old, { finding: '2 second', outcome: 'fixed', at: '2026-10-24T12:00:00.000Z' }),
    decisionNote(old, { finding: '1 first', outcome: 'fixed', at: '2026-10-24T11:00:00.000Z' }),
    decisionNote(old, { finding: '10 third', outcome: 'fixed', at: '2026-10-24T13:00:00.000Z' })])
  const out = gloss(dir, ['reviews']).out
  assert.ok(out.indexOf('1 first') < out.indexOf('2 second') && out.indexOf('2 second') < out.indexOf('10 third'), out)
})
