import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, spawn } from './run.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { within } from './timing.ts'
import { findingClashes, findingRefs, labelFindings, refOf } from '../src/findings.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string, env?: Record<string, string>) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function repo() {
  const dir = tmp('batch-')
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

function review(dir: string, rev: string, findings = 'Two problems.\nVERDICT: ISSUES'): string {
  const sha0 = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  const had = new Set(spawnSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha0], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).id))
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  const r = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'claude', target: rev, findings, stamp }))
  assert.equal(r.code, 0, r.err)
  const sha = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  return noteLines(dir, sha).map((l) => JSON.parse(l)).find((r) => r.review === 1 && !had.has(r.id)).id
}

const noteLines = (dir: string, sha: string) =>
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)


const REPORT = ['# Findings', '', '1. Races', '', '- first problem with the lock ordering', '- second problem: ' + 'x'.repeat(200), '', '2. Wording', '', '- **bold** nit', '', 'VERDICT: ISSUES'].join('\n')

function setup(findings = REPORT) {
  const r = repo()
  r.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  r.g('commit', '-qam', 'stop')
  assert.equal(gloss(r.dir, ['add'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  const id = review(r.dir, 'HEAD', findings)
  const file = join(r.dir, 'd.json')
  const notesCount = () => Number(r.g('rev-list', '--count', 'refs/notes/gloss-reviews'))
  const decisions = (sha = 'HEAD') => noteLines(r.dir, r.g('rev-parse', sha)).map((l) => JSON.parse(l)).filter((d) => d.decision === 1)
  const batch = (obj: unknown, ...extra: string[]) => {
    writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj))
    return gloss(r.dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', file, ...extra])
  }
  // The refs/notes tip, to prove a refused batch wrote nothing.
  const tip = () => r.g('rev-parse', 'refs/notes/gloss-reviews')
  return { ...r, id, file, notesCount, decisions, batch, tip }
}

const e = (finding: string, outcome = 'fixed', note?: string) => ({ finding, outcome, ...(note !== undefined ? { note } : {}) })

test('--decide-template lists every ref with the finding text cut to 80 characters', () => {
  const { dir, id } = setup()
  const r = gloss(dir, ['reviews', 'HEAD', '--decide-template', id])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  const t = JSON.parse(r.out)
  assert.equal(t.review, id)
  assert.equal(t.complete, false)
  assert.deepEqual(t.decisions.map((d: any) => d.finding.split(' ')[0]), ['1.1', '1.2', '2.1'])
  assert.deepEqual(t.decisions.map((d: any) => [d.outcome, d.note]), Array(3).fill(['', '']))
  assert.equal(t.decisions[0].finding, '1.1 first problem with the lock ordering')
  assert.equal(t.decisions[1].finding, '1.2 second problem: ' + 'x'.repeat(64))
  assert.equal(t.decisions[2].finding, '2.1 **bold** nit')
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide-template', 'nope']).err, /no review nope on HEAD/)
})

test('the template has no escapes from the report', () => {
  const { dir, id } = setup('- \x1b]52;c;ZXZpbA==\x07bad ‮evil​ text\nVERDICT: ISSUES')
  const r = gloss(dir, ['reviews', 'HEAD', '--decide-template', id])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /\\u001b|\\u202e|\\u200b|\x1b|‮|​/)
  assert.match(JSON.parse(r.out).decisions[0].finding, /^1: +bad +evil +text$/)
})

test('a filled-in template round-trips: every record is written, in one write, and reads back', () => {
  const { dir, id, batch, decisions, notesCount } = setup()
  const t = JSON.parse(gloss(dir, ['reviews', 'HEAD', '--decide-template', id]).out)
  t.decisions.forEach((d: any, i: number) => { d.outcome = ['rejected', 'accepted', 'fixed'][i]; if (i === 0) d.note = 'not a bug' })
  t.complete = true
  const before = notesCount()
  const r = batch(t, '--by', 'Arb')
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim(), 'recorded 3 decisions on 1 commit and marked the review complete')
  // Observable: the notes ref gained exactly one commit for 3 decisions and the marker.
  assert.equal(notesCount(), before + 1)
  const ds = decisions()
  assert.equal(ds.length, 4)
  assert.ok(ds.every((d: any) => d.by === 'Arb' && d.review === id))
  assert.equal(ds.find((d: any) => d.finding?.startsWith('1.1 ')).note, 'not a bug')
  assert.equal(ds.find((d: any) => d.complete).complete, true)
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /decisions on this review: 1 fixed, 1 rejected, 1 accepted · complete/)
  assert.match(out, /rejected: 1.1 first problem with the lock ordering — not a bug/)
})

test('a bare array is accepted, with keys in any order and an empty note', () => {
  const { dir, id, file } = setup()
  writeFileSync(file, '[{"outcome":"accepted","note":"","finding":"1.1 a"},{"note":"n","finding":"2.1 b","outcome":"fixed"}]')
  const r = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', file])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim(), 'recorded 2 decisions on 1 commit')
  assert.match(gloss(dir, ['reviews']).out, /decisions on this review: 2 decided · not marked complete/)
})

test('one bad entry writes nothing: bad outcome, empty outcome, overlong note, empty finding', () => {
  const { dir, id, batch, tip, notesCount } = setup()
  const tip0 = tip(), n0 = notesCount()
  const cases: [unknown[], RegExp][] = [
    [[e('1.1 a'), e('1.2 b', 'ignored')], /entry 2 .*outcome must be one of/],
    [[e('1.1 a'), e('1.2 b', ''), e('2.1 c')], /entry 2 \("1\.2 b"\) has an empty outcome/],
    [[e('1.1 a'), e('1.2 b', 'fixed', 'n'.repeat(2001))], /entry 2 .*note is too long/],
    [[e('1.1 a'), e('  ')], /entry 2 /],
    [[e('1.1 a'), e(' 1.1 a ', 'rejected')], /entry 2 \(" ?1\.1 a ?"\) repeats entry 1/],
    [[e('1.1 a'), 'x'], /entry 2 is not an object/],
    [[e('1.1 a'), { outcome: 'fixed' }], /entry 2 has no "finding"/],
    [[e('1.1 a'), { finding: 'b', outcome: 'fixed', note: 5 }], /entry 2 .*"note" must be a string/],
    [[e('1.1 a', 'fixed', 'n'.repeat(1990)), e('a\x01'.repeat(995), 'fixed', '\x01'.repeat(1990))], /entry 2 .*too long to record/],
  ]
  for (const [entries, re] of cases) {
    const r = batch(entries)
    assert.equal(r.code, 1, JSON.stringify(entries).slice(0, 80))
    assert.match(r.err, re)
    assert.doesNotMatch(r.err, /\n\s+at /)
    assert.equal(tip(), tip0)
  }
  assert.equal(notesCount(), n0)
  assert.equal(gloss(dir, ['reviews']).out.includes('decided'), false)
})

test('stdin "-" is read, and a wrapper with complete:true adds the marker', () => {
  const { dir, id, decisions, notesCount } = setup()
  const n0 = notesCount()
  const r = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', '-'], JSON.stringify({ complete: true, decisions: [e('1.1 a')] }))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim(), 'recorded 1 decision on 1 commit and marked the review complete')
  assert.equal(notesCount(), n0 + 1)
  assert.equal(decisions().length, 2)
  assert.match(gloss(dir, ['reviews']).out, /1 fixed · complete/)
})

test('an unknown ref warns on stderr and is still recorded', () => {
  const { batch, decisions } = setup()
  const r = batch([e('1.1 a'), e('9.9 ghost', 'rejected')])
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /no finding 9\.9 \(entry 2;/)
  assert.doesNotMatch(r.err, /1\.1/)
  assert.equal(decisions().length, 2)
})

test('--decide-file and --decide-template refuse single-call flags, and need their companions', () => {
  const { dir, id, file } = setup()
  writeFileSync(file, '[]')
  for (const extra of [['--finding', 'x'], ['--outcome', 'fixed'], ['--note', 'x'], ['--stamp'], ['--record'], ['--complete']]) {
    assert.match(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', file, ...extra]).err, /--decide-file cannot be combined with --/)
    assert.match(gloss(dir, ['reviews', 'HEAD', '--decide-template', id, ...extra]).err, /--decide-template cannot be combined with --/)
  }
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide-file', file]).err, /goes with --decide/)
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide-file', file, '--decide-template', id, '--decide', id]).err, /cannot be combined/)
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', join(dir, 'missing.json')]).err, /can't read .*ENOENT/)
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide', 'nope', '--decide-file', file]).err, /no decisions in the file/)
})

test('the single-finding call still works', () => {
  const { dir, id, decisions } = setup()
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', '1.1', '--outcome', 'fixed']).code, 0)
  assert.equal(decisions().length, 1)
})

test('hostile input files: each is refused with a message, no stack trace, and nothing is written', () => {
  const { dir, id, batch, tip, file } = setup()
  const tip0 = tip()
  const MiB = 1024 * 1024
  const bigNote = JSON.stringify([e('1.1 a', 'fixed', 'n'.repeat(2 * MiB))])
  const cases: [string, string | unknown, RegExp][] = [
    ['600 entries', Array.from({ length: 600 }, (_, i) => e(`1.1 f${i}`)), /600 entries; at most 500/],
    ['over 1 MiB', JSON.stringify([e('1.1 a', 'fixed', 'x')]) + ' '.repeat(MiB), /over 1 MiB/],
    ['huge single note', bigNote, /over 1 MiB/],
    ['malformed', '[{"finding": "a", ', /not valid JSON/],
    ['empty file', '', /not valid JSON/],
    ['nested 100000 deep', '['.repeat(100000) + ']'.repeat(100000), /not valid JSON|entry 1 is not an object/],
    ['nested objects', '{"decisions":'.repeat(50000) + '1' + '}'.repeat(50000), /not valid JSON|needs a "decisions" array/],
    ['a number', '42', /expected an array/],
    ['null', 'null', /expected an array/],
    ['a string', '"x"', /expected an array/],
    ['object without decisions', '{"a":1}', /needs a "decisions" array/],
    ['complete not a boolean', '{"complete":"yes","decisions":[]}', /"complete" must be true or false/],
    ['other review', JSON.stringify({ review: 'other', decisions: [e('1.1 a')] }), /for review other, not /],
    ['proto key entry', '[{"__proto__":{"outcome":"fixed"},"constructor":{"finding":"x"}}]', /entry 1 has no "finding"/],
    ['proto wrapper', '{"__proto__":{"decisions":[{"finding":"a","outcome":"fixed"}]}}', /needs a "decisions" array/],
  ]
  for (const [name, input, re] of cases) {
    const r = batch(input as any)
    assert.equal(r.code, 1, name)
    assert.match(r.err, re, name)
    assert.doesNotMatch(r.err, /\n\s+at |node:internal|RangeError/, name)
    assert.equal(tip(), tip0, name)
  }
  // The same over stdin, and a source that never ends.
  const big = JSON.stringify([e('1.1 a', 'fixed', 'x')]) + ' '.repeat(MiB)
  const s = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', '-'], big)
  assert.equal(s.code, 1)
  assert.match(s.err, /over 1 MiB/)
  const z = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', '/dev/zero'])
  assert.equal(z.code, 1)
  assert.match(z.err, /over 1 MiB/)
  assert.equal(tip(), tip0)
})

test('proto and unknown keys are inert next to a valid entry', () => {
  const { batch, decisions } = setup()
  const r = batch('[{"finding":"1.1 a","outcome":"fixed","__proto__":{"complete":true,"outcome":"x"},"constructor":"c","extra":{"a":1}}]')
  assert.equal(r.code, 0, r.err)
  const ds = decisions()
  assert.equal(ds.length, 1)
  assert.deepEqual(Object.keys(ds[0]).sort(), ['at', 'by', 'decision', 'finding', 'outcome', 'review'])
  assert.equal(({} as any).outcome, undefined)
})

test('escape sequences and bidi in finding and note never reach the terminal', () => {
  const { dir, id, batch } = setup()
  const r = batch([e('1.1 \x1b]52;c;ZXZpbA==\x07evil ‮txt​', 'rejected', 'why \x1b[2Jnote ⁦x')])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out + r.err, /\x1b|‮|​|⁦/)
  const out = gloss(dir, ['reviews']).out
  assert.doesNotMatch(out, /\x1b|‮|​|⁦|\x07/)
  assert.match(out, /rejected: 1\.1 +evil +txt/)
  // A finding of only invisible characters is refused, nothing written.
  const bad = batch([e('1.1 a'), e('​‮')])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /entry 2 /)
})

test('the template cuts at 80 code points, never inside an emoji', () => {
  const { dir, id } = setup('- ' + 'a'.repeat(78) + '\u{1F600}\u{1F600} tail\nVERDICT: ISSUES')
  const r = gloss(dir, ['reviews', 'HEAD', '--decide-template', id])
  assert.equal(r.code, 0, r.err)
  const f: string = JSON.parse(r.out).decisions[0].finding
  assert.equal(f, '1: ' + 'a'.repeat(78) + '\u{1F600}\u{1F600}')
  assert.doesNotMatch(f, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
})

const hasPython = spawnSync('python3', ['-I', '-c', '0']).status === 0
test('stdin that is a non-blocking pipe fed slowly is waited for, not refused', { skip: hasPython ? false : 'python3 is not available (it sets O_NONBLOCK on stdin before exec)' }, async () => {
  const { dir, id, decisions } = setup()
  // O_NONBLOCK sits on the pipe's open file description, so it survives the exec.
  const py = 'import os,fcntl,sys\nfcntl.fcntl(0,fcntl.F_SETFL,fcntl.fcntl(0,fcntl.F_GETFL)|os.O_NONBLOCK)\nos.execv(sys.argv[1],sys.argv[1:])'
  const child = spawn('python3', ['-I', '-c', py, process.execPath, BIN, 'reviews', 'HEAD', '--decide', id, '--decide-file', '-'], { cwd: dir })
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const done = new Promise<number | null>((res) => child.on('close', res))
  const json = JSON.stringify([e('1.1 a')])
  for (const part of [json.slice(0, 5), json.slice(5)]) {
    child.stdin.write(part)
    await new Promise((r) => setTimeout(r, 400))
  }
  child.stdin.end()
  assert.equal(await done, 0, err)
  assert.match(out, /recorded 1 decision on 1 commit/)
  assert.equal(decisions().length, 1)
})

// Natural ref order: section, repeat (1/2), item; `1/2.1` is section 1, repeat 2, item 1.
const refParts = (r: string) => { const [sec, item = '-1'] = r.split('.'); const [n, rep = '1'] = sec.split('/'); return [Number(n), Number(rep), Number(item)] }
const byRef = (a: string, b: string) => { const x = refParts(a), y = refParts(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2] }

test('every template row is recognised as its report ref: ref order, and a bogus ref warns', () => {
  const many = Array.from({ length: 12 }, (_, i) => `- zeta ${i + 1}`).join('\n')
  // Each report with the refs of its numbered headings that have no list (the rest are the printed [ref] labels).
  const reports: [string, string[]][] = [
    [REPORT, []],
    ['## 1. A\n\n- a\n\n## 2. Empty\n\n## 3. B\n\n- b\n\nVERDICT: ISSUES', ['2']],
    [many + '\nVERDICT: ISSUES', []],
    ['# Review\n\n3. Removal\n\n4. Wording\n\n- a nit\n\nVERDICT: ISSUES', []],
    ['## A\n\n- one\n- two\n\n## B\n\n' + Array.from({ length: 11 }, (_, i) => `- b${i + 1}`).join('\n') + '\n\nVERDICT: ISSUES', []],
  ]
  for (const [report, headings] of reports) {
    const { dir, id, batch } = setup(report)
    const t = JSON.parse(gloss(dir, ['reviews', 'HEAD', '--decide-template', id]).out)
    // The rows are the printed labels plus the list-less headings; a heading with items is no row.
    const printed = labelFindings(report).split('\n').filter((l) => l.startsWith('- **[')).map((l) => l.slice(5, l.indexOf(']**')))
    const refs = [...printed, ...headings].sort(byRef)
    assert.deepEqual([...t.decisions.map((d: any) => refOf(d.finding))].sort(), [...refs].sort())
    assert.ok(refs.length > 0)
    assert.deepEqual(t.decisions.map((d: any) => refOf(d.finding)), refs)
    t.decisions.forEach((d: any) => { d.outcome = 'accepted' })
    t.decisions.push(e('99: bogus', 'rejected'))
    const r = batch(t)
    assert.equal(r.code, 0, r.err)
    // Only the bogus ref is unknown, and it is named once.
    assert.equal(r.err.match(/has no finding/g)?.length, 1, r.err)
    assert.match(r.err, /no finding 99 \(entry \d+;/)
    // `reviews` lists the decisions in ref order (1.2 before 1.10), the bogus ref last.
    const listed = gloss(dir, ['reviews']).out.split('\n').filter((l) => /^ {4}(accepted|rejected): /.test(l)).map((l) => refOf(l.replace(/^ +\w+: /, '')))
    const sorted = [...refs, '99'].sort(byRef)
    assert.deepEqual(listed, sorted)
  }
})

test('a range: every commit holding the review gets the decisions in one write of its own', () => {
  const r = repo()
  for (const f of ['one', 'two']) {
    r.write('app.js', ['function main() {', '  run()', `  ${f}()`, '}'])
    r.g('commit', '-qam', f)
  }
  const range = 'HEAD~2..HEAD'
  const stamp = JSON.parse(gloss(r.dir, ['reviews', '--stamp', range]).out)
  assert.equal(Object.keys(stamp).length, 2)
  const rec = gloss(r.dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'claude', target: range, findings: '- p\n- q\nVERDICT: ISSUES', stamp }))
  assert.equal(rec.code, 0, rec.err)
  const shas = Object.keys(stamp)
  const id = JSON.parse(noteLines(r.dir, shas[0])[0]).id
  const before = Number(r.g('rev-list', '--count', 'refs/notes/gloss-reviews'))
  const out = gloss(r.dir, ['reviews', range, '--decide', id, '--decide-file', '-'], JSON.stringify({ complete: true, decisions: [e('1: a'), e('2: b', 'rejected')] }))
  assert.equal(out.code, 0, out.err)
  assert.equal(out.out.trim(), 'recorded 2 decisions on 2 commits and marked the review complete')
  // 3 records per commit, written as one notes commit per commit: 2 in all, not 6.
  assert.equal(Number(r.g('rev-list', '--count', 'refs/notes/gloss-reviews')), before + 2)
  for (const sha of shas) assert.equal(noteLines(r.dir, sha).filter((l) => JSON.parse(l).decision === 1).length, 3)
})

test('the template has no row for a numbered heading with items, and --decide-file still accepts a row naming one', () => {
  const report = ['# Findings', '', '## 1. Races', '', '- lock ordering', '', '## 2. Empty section', '', '## 3. Wording', '', '- nit', '', 'VERDICT: ISSUES'].join('\n')
  const { dir, id, batch, decisions } = setup(report)
  const t = JSON.parse(gloss(dir, ['reviews', 'HEAD', '--decide-template', id]).out)
  // `1` and `3` have items; `2` has none, so it is a row
  assert.deepEqual(t.decisions.map((d: any) => d.finding.split(' ')[0]), ['1.1', '2:', '3.1'])
  const r = batch([e('1: Races', 'accepted'), e('1.1 lock ordering'), e('3.1 nit', 'rejected', 'ok')])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  assert.equal(decisions().length, 3)
})

const DUP_REPORT = ['## 1. Races', '', '- first problem', '', '## 1. Wording', '', '- second problem', '', 'VERDICT: ISSUES'].join('\n')

test('two headings with the same number: both findings are in the template, in reviews, and decided apart', () => {
  const { dir, id, batch, decisions } = setup(DUP_REPORT)
  const shown = gloss(dir, ['reviews']).out
  assert.match(shown, /\[1\.1\]\*\* first problem/)
  assert.match(shown, /\[1\/2\.1\]\*\* second problem/)
  const t = JSON.parse(gloss(dir, ['reviews', 'HEAD', '--decide-template', id]).out)
  assert.deepEqual(t.decisions.map((d: any) => d.finding), ['1.1 first problem', '1/2.1 second problem'])
  t.decisions[0].outcome = 'fixed'
  t.decisions[1].outcome = 'rejected'
  t.decisions[1].note = 'second is wrong'
  const r = batch(t)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  assert.equal(decisions().length, 2)
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /^ {4}fixed: 1\.1 first problem \(/m)
  assert.match(out, /^ {4}rejected: 1\/2\.1 second problem — second is wrong \(/m)
  // a decision on only the second leaves the first undecided in the listing
  const { dir: d2, id: id2 } = setup(DUP_REPORT)
  assert.equal(gloss(d2, ['reviews', 'HEAD', '--decide', id2, '--finding', '1/2.1 second problem', '--outcome', 'accepted']).code, 0)
  const o2 = gloss(d2, ['reviews']).out
  assert.match(o2, /accepted: 1\/2\.1 second problem/)
  assert.doesNotMatch(o2, /: 1\.1 first/)
  // no warning for either ref, a warning for one the report lacks
  assert.equal(gloss(d2, ['reviews', 'HEAD', '--decide', id2, '--finding', '1.1 x', '--outcome', 'fixed']).err, '')
  assert.match(gloss(d2, ['reviews', 'HEAD', '--decide', id2, '--finding', '1/3.1 x', '--outcome', 'fixed']).err, /no finding 1\/3\.1/)
})

test('the total size one --decide-file writes is capped, with the sizes named; nothing is written', () => {
  const { batch, tip, notesCount, decisions } = setup()
  const tip0 = tip(), n0 = notesCount()
  // Under the 1 MiB input cap, over the 512 KiB write cap: 500 entries with long text.
  const big = Array.from({ length: 500 }, (_, i) => e(`1.1 f${i} ${'a'.repeat(600)}`, 'fixed', 'n'.repeat(600)))
  const r = batch(big)
  assert.equal(r.code, 1)
  assert.match(r.err, /the 500 records come to \d+ KiB as written; at most 512 KiB per file/)
  assert.doesNotMatch(r.err, /\n\s+at /)
  // 500 entries at the per-field maximum are refused too (by whichever cap comes first)
  const max = batch(Array.from({ length: 500 }, (_, i) => e(`1.1 f${i} ${'a'.repeat(1900)}`, 'fixed', 'n'.repeat(2000))))
  assert.equal(max.code, 1)
  assert.match(max.err, /over 1 MiB|at most 512 KiB/)
  assert.equal(tip(), tip0)
  assert.equal(notesCount(), n0)
  // just under the cap is fine
  const ok = batch(Array.from({ length: 100 }, (_, i) => e(`1.1 f${i} ${'a'.repeat(600)}`, 'fixed', 'n'.repeat(600))))
  assert.equal(ok.code, 0, ok.err)
  assert.equal(decisions().length, 100)
})

test('running the same file twice records nothing the second time, and reviews reads the same', () => {
  const { dir, id, batch, decisions, tip } = setup()
  const entries = [e('1.1 a'), e('2.1 b', 'rejected', 'why')]
  const body = { complete: true, decisions: entries }
  const first = batch(body, '--by', 'Arb')
  assert.equal(first.out.trim(), 'recorded 2 decisions on 1 commit and marked the review complete')
  const before = gloss(dir, ['reviews']).out
  const tip1 = tip()
  const second = batch(body, '--by', 'Arb')
  assert.equal(second.code, 0, second.err)
  assert.equal(second.out.trim(), 'recorded 0 decisions on 0 commits (3 already recorded)')
  assert.equal(decisions().length, 3)
  assert.equal(tip(), tip1)
  assert.equal(gloss(dir, ['reviews']).out, before)
  // a changed outcome, note or author is a new decision; an unchanged one is not repeated
  const third = batch({ decisions: [e('1.1 a'), e('2.1 b', 'rejected', 'other why'), e('1.2 c', 'accepted')] }, '--by', 'Arb')
  assert.equal(third.out.trim(), 'recorded 2 decisions on 1 commit (1 already recorded)')
  const byOther = batch({ decisions: [e('1.1 a')] }, '--by', 'Other')
  assert.equal(byOther.out.trim(), 'recorded 1 decision on 1 commit')
  assert.equal(decisions().length, 6)
})

test('a range re-run after one commit was written fills in only the other', () => {
  const r = repo()
  for (const f of ['one', 'two']) {
    r.write('app.js', ['function main() {', '  run()', `  ${f}()`, '}'])
    r.g('commit', '-qam', f)
  }
  const range = 'HEAD~2..HEAD'
  const stamp = JSON.parse(gloss(r.dir, ['reviews', '--stamp', range]).out)
  gloss(r.dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'claude', target: range, findings: '- p\n- q\nVERDICT: ISSUES', stamp }))
  const shas = Object.keys(stamp)
  const id = JSON.parse(noteLines(r.dir, shas[0])[0]).id
  const decide = () => gloss(r.dir, ['reviews', range, '--decide', id, '--decide-file', '-', '--by', 'A'], JSON.stringify({ decisions: [e('1: a'), e('2: b')] }))
  // the first commit already has them (as after a failed write of the second)
  assert.equal(gloss(r.dir, ['reviews', shas[0], '--decide', id, '--decide-file', '-', '--by', 'A'], JSON.stringify({ decisions: [e('1: a'), e('2: b')] })).code, 0)
  const out = decide()
  assert.equal(out.out.trim(), 'recorded 2 decisions on 1 commit (2 already recorded)')
  for (const sha of shas) assert.equal(noteLines(r.dir, sha).filter((l) => JSON.parse(l).decision === 1).length, 2)
  assert.equal(decide().out.trim(), 'recorded 0 decisions on 0 commits (4 already recorded)')
})

test('a second review on the same commit with the same decision is not skipped as already recorded', () => {
  const { dir, id, batch, decisions } = setup()
  const id2 = review(dir, 'HEAD', 'Other.\n- only problem\nVERDICT: ISSUES')
  assert.notEqual(id2, id)
  assert.equal(batch({ decisions: [e('1 same')] }, '--by', 'Arb').out.trim(), 'recorded 1 decision on 1 commit')
  const file = join(dir, 'd2.json')
  writeFileSync(file, JSON.stringify({ decisions: [e('1 same')] }))
  const r = gloss(dir, ['reviews', 'HEAD', '--decide', id2, '--decide-file', file, '--by', 'Arb'])
  assert.equal(r.out.trim(), 'recorded 1 decision on 1 commit')
  assert.equal(decisions().length, 2)
})

test('the write cap counts bytes, not UTF-16 units: non-ASCII text under the cap in characters but over it in bytes is refused', () => {
  const { batch, tip } = setup()
  const tip0 = tip()
  const rows = Array.from({ length: 200 }, (_, i) => e(`1.1 f${i}`, 'fixed', '日'.repeat(1000)))
  const units = rows.reduce((n, r) => n + JSON.stringify(r).length, 0)
  assert.ok(units < 512 * 1024, `fixture is ${units} units`)
  const r = batch(rows)
  assert.equal(r.code, 1)
  assert.match(r.err, /at most 512 KiB per file/)
  assert.equal(tip(), tip0)
})

test('a re-run does not skip a decision that a later one reversed', () => {
  const { dir, id, batch, decisions } = setup()
  const file = { decisions: [e('1.1 a', 'fixed')] }
  assert.equal(batch(file, '--by', 'Arb').out.trim(), 'recorded 1 decision on 1 commit')
  const single = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', '1.1 a', '--outcome', 'rejected', '--by', 'Arb'])
  assert.equal(single.code, 0, single.err)
  const again = batch(file, '--by', 'Arb')
  assert.equal(again.out.trim(), 'recorded 1 decision on 1 commit')
  assert.deepEqual(decisions().map((d) => d.outcome).sort(), ['fixed', 'fixed', 'rejected'])
  // and now the file's decision is the latest, so another re-run skips it
  assert.equal(batch(file, '--by', 'Arb').out.trim(), 'recorded 0 decisions on 0 commits (1 already recorded)')
  assert.match(gloss(dir, ['reviews']).out, /fixed: 1\.1 a/)
})

test('--decide-template: no warning when no row is lost; the clash list names the refs lost past the cap', () => {
  // a heading numbered 1 with items, after a loose item 1: every finding still has a row
  const clash = setup(['- loose problem', '- another', '## 1. Races', '- lock', 'VERDICT: ISSUES'].join('\n'))
  const r = gloss(clash.dir, ['reviews', 'HEAD', '--decide-template', clash.id])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  assert.deepEqual(JSON.parse(r.out).decisions.map((d: any) => refOf(d.finding)), ['1', '2', '1.1'])
  // past 999 repeats of one number, the heading rows without items beyond the cap are lost
  // (the command then refuses the template for its size, so this is checked on the scan)
  assert.deepEqual(findingClashes(Array.from({ length: 1002 }, () => '## 1. S').join('\n\n')), ['1/999'])
  // a report without a clash prints nothing
  const fine = setup()
  assert.equal(gloss(fine.dir, ['reviews', 'HEAD', '--decide-template', fine.id]).err, '')
})

test('a 500-entry --decide-file against a report of 20000 repeated sections finishes quickly', () => {
  const report = '## 1.\n- i\n'.repeat(20000) + 'VERDICT: ISSUES'
  const { batch } = setup(report)
  const t = performance.now()
  const r = batch(Array.from({ length: 500 }, (_, i) => e(`${i === 0 ? '1' : `1/${i + 1}`}.1 f${i}`)))
  within('decide-file 500 entries', performance.now() - t, 4000)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
})
