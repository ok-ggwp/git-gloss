import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, spawn } from './run.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { findingRefs, refOf } from '../src/findings.ts'

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
  assert.deepEqual(t.decisions.map((d: any) => d.finding.split(' ')[0]), ['1:', '1.1', '1.2', '2:', '2.1'])
  assert.equal(t.decisions[0].finding, '1: Races')
  assert.equal(t.decisions[3].finding, '2: Wording')
  assert.deepEqual(t.decisions.map((d: any) => [d.outcome, d.note]), Array(5).fill(['', '']))
  assert.equal(t.decisions[1].finding, '1.1 first problem with the lock ordering')
  assert.equal(t.decisions[2].finding, '1.2 second problem: ' + 'x'.repeat(64))
  assert.equal(t.decisions[4].finding, '2.1 **bold** nit')
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
  t.decisions.forEach((d: any, i: number) => { d.outcome = ['fixed', 'rejected', 'accepted', 'follow-up', 'fixed'][i]; if (i === 1) d.note = 'not a bug' })
  t.complete = true
  const before = notesCount()
  const r = batch(t, '--by', 'Arb')
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim(), 'recorded 5 decisions on 1 commit and marked the review complete')
  // Observable: the notes ref gained exactly one commit for 5 decisions and the marker.
  assert.equal(notesCount(), before + 1)
  const ds = decisions()
  assert.equal(ds.length, 6)
  assert.ok(ds.every((d: any) => d.by === 'Arb' && d.review === id))
  assert.equal(ds.find((d: any) => d.finding?.startsWith('1.1 ')).note, 'not a bug')
  assert.equal(ds.find((d: any) => d.complete).complete, true)
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /decisions on this review: 2 fixed, 1 follow-up, 1 rejected, 1 accepted · complete/)
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

test('every template row is recognised as its report ref: ref order, and a bogus ref warns', () => {
  const many = Array.from({ length: 12 }, (_, i) => `- zeta ${i + 1}`).join('\n')
  const reports = [
    REPORT,
    many + '\nVERDICT: ISSUES',
    '# Review\n\n3. Removal\n\n4. Wording\n\n- a nit\n\nVERDICT: ISSUES',
    '## A\n\n- one\n- two\n\n## B\n\n' + Array.from({ length: 11 }, (_, i) => `- b${i + 1}`).join('\n') + '\n\nVERDICT: ISSUES',
  ]
  for (const report of reports) {
    const { dir, id, batch } = setup(report)
    const t = JSON.parse(gloss(dir, ['reviews', 'HEAD', '--decide-template', id]).out)
    const refs = [...findingRefs(report)]
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
    const num = (x: string) => x.split('.').map(Number)
    const sorted = [...refs, '99'].sort((a, b) => num(a)[0] - num(b)[0] || (num(a)[1] ?? -1) - (num(b)[1] ?? -1))
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
