import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync, spawn } from './run.ts'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { within } from './timing.ts'
import { item, plantLegacy, report, type TestItem } from './block.ts'

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

function review(dir: string, rev: string, items: TestItem[] = ITEMS): string {
  const sha0 = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  const had = new Set(spawnSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha0], { cwd: dir, encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l).id))
  const stamp = JSON.parse(gloss(dir, ['reviews', '--stamp', rev]).out)
  const r = gloss(dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'claude', target: rev, findings: report('Problems.', items), stamp }))
  assert.equal(r.code, 0, r.err)
  const sha = execFileSync('git', ['rev-parse', rev === 'wip' ? 'refs/worktree/gloss/wip' : rev], { cwd: dir, encoding: 'utf8' }).trim()
  return noteLines(dir, sha).map((l) => JSON.parse(l)).find((r) => r.review === 1 && !had.has(r.id)).id
}

const noteLines = (dir: string, sha: string) =>
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8' }).split('\n').filter(Boolean)


const ITEMS = [
  item('f1', { title: 'first problem with the lock ordering', severity: 'major' }),
  item('f2', { title: 'second problem: ' + 'x'.repeat(200 - 'second problem: '.length), kind: 'mismatch' }),
  item('f3', { title: '**bold** nit', severity: 'nit', kind: 'simplification' }),
]
const many = (n: number): TestItem[] => Array.from({ length: n }, (_, i) => item(`f${i + 1}`))

function setup(items: TestItem[] = ITEMS) {
  const r = repo()
  r.write('app.js', ['function main() {', '  run()', '  stop()', '}'])
  r.g('commit', '-qam', 'stop')
  assert.equal(gloss(r.dir, ['add'], JSON.stringify({ task: 'stop', groups: [group('stop', ['h1'])] })).code, 0)
  const id = review(r.dir, 'HEAD', items)
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

test('--decide-template lists every item by id, in the reviewer\'s order, with severity, kind and title', () => {
  const { dir, id } = setup()
  const r = gloss(dir, ['reviews', 'HEAD', '--decide-template', id])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  const t = JSON.parse(r.out)
  assert.equal(t.review, id)
  assert.equal(t.complete, false)
  assert.deepEqual(t.decisions.map((d: any) => d.finding), ['f1', 'f2', 'f3'])
  assert.deepEqual(t.decisions.map((d: any) => [d.severity, d.kind]), [['major', 'defect'], ['minor', 'mismatch'], ['nit', 'simplification']])
  assert.deepEqual(t.decisions.map((d: any) => [d.outcome, d.note]), Array(3).fill(['', '']))
  assert.equal(t.decisions[0].title, 'first problem with the lock ordering')
  assert.equal(t.decisions[2].title, '**bold** nit')
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide-template', 'nope']).err, /no review nope on HEAD/)
})

test('the order of the items is the reviewer\'s, not sorted: template and table agree', () => {
  const { dir, id } = setup([item('f10'), item('f2'), item('f1')])
  const t = JSON.parse(gloss(dir, ['reviews', 'HEAD', '--decide-template', id]).out)
  assert.deepEqual(t.decisions.map((d: any) => d.finding), ['f10', 'f2', 'f1'])
  const rows = gloss(dir, ['reviews']).out.split('\n').filter((l) => /^ +f\d+ +minor/.test(l)).map((l) => l.trim().split(' ')[0])
  assert.deepEqual(rows, ['f10', 'f2', 'f1'])
})

test('the template has no escapes from the report', () => {
  const { dir, id } = setup([item('f1', { title: '\x1b]52;c;ZXZpbA==\x07bad ‮evil​ text' })])
  const r = gloss(dir, ['reviews', 'HEAD', '--decide-template', id])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out, /\\u001b|\\u202e|\\u200b|\x1b|‮|​/)
  assert.match(JSON.parse(r.out).decisions[0].title, /^bad +evil +text$/)
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
  assert.equal(ds.find((d: any) => d.finding === 'f1').note, 'not a bug')
  assert.deepEqual(Object.keys(ds.find((d: any) => d.finding === 'f1')).sort(), ['at', 'by', 'decision', 'finding', 'note', 'outcome', 'review'], 'the template\'s severity, kind and title are not stored')
  assert.equal(ds.find((d: any) => d.complete).complete, true)
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /3 findings: 1 fixed, 1 rejected, 1 accepted · marked complete/)
  assert.match(out, /f1: not a bug/)
  assert.match(out, /f1 +major +defect +read +rejected +first problem/)
})

test('a bare array is accepted, with keys in any order and an empty note', () => {
  const { dir, id, file } = setup()
  writeFileSync(file, '[{"outcome":"accepted","note":"","finding":"f1"},{"note":"n","finding":"f3","outcome":"fixed"}]')
  const r = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', file])
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim(), 'recorded 2 decisions on 1 commit')
  assert.match(gloss(dir, ['reviews']).out, /3 findings: 1 open, 1 fixed, 1 accepted/)
})

test('one bad entry writes nothing: unknown id, duplicate id, bad outcome, empty outcome, overlong note, empty finding', () => {
  const { dir, batch, tip, notesCount } = setup()
  const tip0 = tip(), n0 = notesCount()
  const cases: [unknown[], RegExp][] = [
    [[e('f1'), e('f9')], /entry 2 \("f9"\): the review has no finding "f9" \(its findings: f1, f2, f3\)/],
    [[e('f1'), e('f2', 'ignored')], /entry 2 .*outcome must be one of/],
    [[e('f1'), e('f2', ''), e('f3')], /entry 2 \("f2"\) has an empty outcome/],
    [[e('f1'), e('f2', 'fixed', 'n'.repeat(2001))], /entry 2 .*note is too long/],
    [[e('f1'), e('  ')], /entry 2 /],
    [[e('f1'), e(' f1 ', 'rejected')], /entry 2 \(" ?f1 ?"\) repeats entry 1/],
    [[e('f1'), e('f1', 'rejected')], /entry 2 \("f1"\) repeats entry 1/],
    [[e('f1'), 'x'], /entry 2 is not an object/],
    [[e('f1'), { outcome: 'fixed' }], /entry 2 has no "finding"/],
    [[e('f1'), { finding: 'f2', outcome: 'fixed', note: 5 }], /entry 2 .*"note" must be a string/],
    [[e('1.1 first problem')], /no finding "1\.1 first problem"/],
  ]
  for (const [entries, re] of cases) {
    const r = batch(entries)
    assert.equal(r.code, 1, JSON.stringify(entries).slice(0, 80))
    assert.match(r.err, re)
    assert.doesNotMatch(r.err, /\n\s+at /)
    assert.equal(tip(), tip0)
  }
  assert.equal(notesCount(), n0)
  assert.match(gloss(dir, ['reviews']).out, /3 findings: 3 open/)
})

test('stdin "-" is read, and a wrapper with complete:true adds the marker', () => {
  const { dir, id, decisions, notesCount } = setup()
  const n0 = notesCount()
  const r = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', '-'], JSON.stringify({ complete: true, decisions: [e('f1')] }))
  assert.equal(r.code, 0, r.err)
  assert.equal(r.out.trim(), 'recorded 1 decision on 1 commit and marked the review complete')
  assert.equal(notesCount(), n0 + 1)
  assert.equal(decisions().length, 2)
  assert.match(gloss(dir, ['reviews']).out, /3 findings: 2 open, 1 fixed · marked complete/)
})

test('an empty decision list with complete:true marks a review with no findings complete; a legacy review refuses everything', () => {
  const { dir, id, g } = setup([])
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', '-'], '{"complete":true,"decisions":[]}').code, 0)
  assert.match(gloss(dir, ['reviews']).out, /0 findings · marked complete/)
  const old = plantLegacy(dir, g('rev-parse', 'HEAD'))
  const r = gloss(dir, ['reviews', 'HEAD', '--decide', old, '--decide-file', '-'], '{"complete":true,"decisions":[]}')
  assert.equal(r.code, 1)
  assert.match(r.err, /without structured findings/)
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
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', file]).err, /no decisions in the file/)
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide', 'nope', '--decide-file', file]).err, /no review nope on HEAD/)
})

test('the single-finding call works by id', () => {
  const { dir, id, decisions } = setup()
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'fixed']).code, 0)
  assert.equal(decisions().length, 1)
  assert.equal(decisions()[0].finding, 'f1')
})

test('hostile input files: each is refused with a message, no stack trace, and nothing is written', () => {
  const { dir, id, batch, tip } = setup()
  const tip0 = tip()
  const MiB = 1024 * 1024
  const bigNote = JSON.stringify([e('f1', 'fixed', 'n'.repeat(2 * MiB))])
  const cases: [string, string | unknown, RegExp][] = [
    ['600 entries', Array.from({ length: 600 }, (_, i) => e(`f${i}`)), /600 entries; at most 500/],
    ['over 1 MiB', JSON.stringify([e('f1', 'fixed', 'x')]) + ' '.repeat(MiB), /over 1 MiB/],
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
    ['other review', JSON.stringify({ review: 'other', decisions: [e('f1')] }), /for review other, not /],
    ['proto key entry', '[{"__proto__":{"outcome":"fixed"},"constructor":{"finding":"x"}}]', /entry 1 has no "finding"/],
    ['proto wrapper', '{"__proto__":{"decisions":[{"finding":"f1","outcome":"fixed"}]}}', /needs a "decisions" array/],
    ['an id that is not an item', [e('__proto__')], /no finding "__proto__"/],
    ['constructor as an id', [e('constructor')], /no finding "constructor"/],
  ]
  for (const [name, input, re] of cases) {
    const r = batch(input as any)
    assert.equal(r.code, 1, name)
    assert.match(r.err, re, name)
    assert.doesNotMatch(r.err, /\n\s+at |node:internal|RangeError/, name)
    assert.equal(tip(), tip0, name)
  }
  // The same over stdin, and a source that never ends.
  const big = JSON.stringify([e('f1', 'fixed', 'x')]) + ' '.repeat(MiB)
  const s = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', '-'], big)
  assert.equal(s.code, 1)
  assert.match(s.err, /over 1 MiB/)
  const z = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--decide-file', '/dev/zero'])
  assert.equal(z.code, 1)
  assert.match(z.err, /over 1 MiB/)
  assert.equal(tip(), tip0)
})

test('items whose ids are __proto__, constructor or toString are decided like any other, and pollute nothing', () => {
  const { dir, id, batch, decisions } = setup([item('__proto__'), item('constructor'), item('toString'), item('f1')])
  const r = batch([e('__proto__'), e('constructor', 'rejected', 'n'), e('toString', 'accepted')])
  assert.equal(r.code, 0, r.err)
  assert.deepEqual(decisions().map((d) => d.finding).sort(), ['__proto__', 'constructor', 'toString'])
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /4 findings: 1 open, 1 fixed, 1 rejected, 1 accepted/)
  assert.match(out, /__proto__ +minor +defect +read +fixed/)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 1)
  assert.match(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'fixed']).out, /f1/)
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--open']).code, 0)
})

test('proto and unknown keys are inert next to a valid entry', () => {
  const { batch, decisions } = setup()
  const r = batch('[{"finding":"f1","outcome":"fixed","__proto__":{"complete":true,"outcome":"x"},"constructor":"c","extra":{"a":1}}]')
  assert.equal(r.code, 0, r.err)
  const ds = decisions()
  assert.equal(ds.length, 1)
  assert.deepEqual(Object.keys(ds[0]).sort(), ['at', 'by', 'decision', 'finding', 'outcome', 'review'])
  assert.equal(({} as any).outcome, undefined)
})

test('escape sequences and bidi in an id are refused without echoing them; in a note they never reach the terminal', () => {
  const { dir, batch } = setup()
  const bad = batch([e('f1'), e('\x1b]52;c;ZXZpbA==\x07evil ‮txt​', 'rejected')])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /entry 2 /)
  assert.doesNotMatch(bad.out + bad.err, /\x1b|‮|​|\x07/)
  const r = batch([e('f1', 'rejected', 'why \x1b[2Jnote ⁦x')])
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.out + r.err, /\x1b|‮|​|⁦/)
  const out = gloss(dir, ['reviews']).out
  assert.doesNotMatch(out, /\x1b|‮|​|⁦|\x07/)
  assert.match(out, /f1: why +note +x/)
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
  const json = JSON.stringify([e('f1')])
  for (const part of [json.slice(0, 5), json.slice(5)]) {
    child.stdin.write(part)
    await new Promise((r) => setTimeout(r, 400))
  }
  child.stdin.end()
  assert.equal(await done, 0, err)
  assert.match(out, /recorded 1 decision on 1 commit/)
  assert.equal(decisions().length, 1)
})

function twoCommits() {
  const r = repo()
  for (const f of ['one', 'two']) {
    r.write('app.js', ['function main() {', '  run()', `  ${f}()`, '}'])
    r.g('commit', '-qam', f)
  }
  const range = 'HEAD~2..HEAD'
  const stamp = JSON.parse(gloss(r.dir, ['reviews', '--stamp', range]).out)
  assert.equal(Object.keys(stamp).length, 2)
  const rec = gloss(r.dir, ['reviews', '--record'], JSON.stringify({ stage: 'bugs', agent: 'claude', target: range, findings: report('p and q', [item('f1'), item('f2')]), stamp }))
  assert.equal(rec.code, 0, rec.err)
  const shas = Object.keys(stamp)
  const id = JSON.parse(noteLines(r.dir, shas[0])[0]).id
  return { ...r, range, shas, id }
}

test('a range: every commit holding the review gets the decisions in one write of its own', () => {
  const r = twoCommits()
  const before = Number(r.g('rev-list', '--count', 'refs/notes/gloss-reviews'))
  const out = gloss(r.dir, ['reviews', r.range, '--decide', r.id, '--decide-file', '-'], JSON.stringify({ complete: true, decisions: [e('f1'), e('f2', 'rejected')] }))
  assert.equal(out.code, 0, out.err)
  assert.equal(out.out.trim(), 'recorded 2 decisions on 2 commits and marked the review complete')
  // 3 records per commit, written as one notes commit per commit: 2 in all, not 6.
  assert.equal(Number(r.g('rev-list', '--count', 'refs/notes/gloss-reviews')), before + 2)
  for (const sha of r.shas) assert.equal(noteLines(r.dir, sha).filter((l) => JSON.parse(l).decision === 1).length, 3)
})

test('two items of one review are decided apart: a decision on the second leaves the first open', () => {
  const { dir, id } = setup()
  assert.equal(gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f2', '--outcome', 'accepted']).code, 0)
  const out = gloss(dir, ['reviews']).out
  assert.match(out, /f1 +major +defect +read +open/)
  assert.match(out, /f2 +minor +mismatch +read +accepted/)
  assert.match(out, /3 findings: 2 open, 1 accepted/)
})

test('the total size one --decide-file writes is capped by bytes, not UTF-16 units; nothing is written', () => {
  const { batch, tip, notesCount, decisions } = setup(many(200))
  const tip0 = tip(), n0 = notesCount()
  // 200 notes of 1000 CJK characters: 200,000 units (under 512 KiB), 600,000 bytes (over it), under the 1 MiB input cap.
  const rows = Array.from({ length: 200 }, (_, i) => e(`f${i + 1}`, 'fixed', '日'.repeat(1000)))
  const units = rows.reduce((n, r) => n + JSON.stringify(r).length, 0)
  assert.ok(units < 512 * 1024, `fixture is ${units} units`)
  const r = batch(rows)
  assert.equal(r.code, 1)
  assert.match(r.err, /the 200 records come to \d+ KiB as written; at most 512 KiB per file/)
  assert.doesNotMatch(r.err, /\n\s+at /)
  assert.equal(tip(), tip0)
  assert.equal(notesCount(), n0)
  // just under the cap is fine
  const ok = batch(rows.slice(0, 100).map((x) => ({ ...x, note: 'n'.repeat(2000) })))
  assert.equal(ok.code, 0, ok.err)
  assert.equal(decisions().length, 100)
})

test('running the same file twice records nothing the second time, and reviews reads the same', () => {
  const { dir, batch, decisions, tip } = setup()
  const entries = [e('f1'), e('f2', 'rejected', 'why')]
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
  const third = batch({ decisions: [e('f1'), e('f2', 'rejected', 'other why'), e('f3', 'accepted')] }, '--by', 'Arb')
  assert.equal(third.out.trim(), 'recorded 2 decisions on 1 commit (1 already recorded)')
  const byOther = batch({ decisions: [e('f1')] }, '--by', 'Other')
  assert.equal(byOther.out.trim(), 'recorded 1 decision on 1 commit')
  assert.equal(decisions().length, 6)
})

test('a range re-run after one commit was written fills in only the other', () => {
  const r = twoCommits()
  const body = JSON.stringify({ decisions: [e('f1'), e('f2')] })
  const decide = () => gloss(r.dir, ['reviews', r.range, '--decide', r.id, '--decide-file', '-', '--by', 'A'], body)
  // the first commit already has them (as after a failed write of the second)
  assert.equal(gloss(r.dir, ['reviews', r.shas[0], '--decide', r.id, '--decide-file', '-', '--by', 'A'], body).code, 0)
  const out = decide()
  assert.equal(out.out.trim(), 'recorded 2 decisions on 1 commit (2 already recorded)')
  for (const sha of r.shas) assert.equal(noteLines(r.dir, sha).filter((l) => JSON.parse(l).decision === 1).length, 2)
  assert.equal(decide().out.trim(), 'recorded 0 decisions on 0 commits (4 already recorded)')
})

test('a second review on the same commit with the same decision is not skipped as already recorded', () => {
  const { dir, id, batch, decisions } = setup()
  const id2 = review(dir, 'HEAD', [item('f1')])
  assert.notEqual(id2, id)
  assert.equal(batch({ decisions: [e('f1')] }, '--by', 'Arb').out.trim(), 'recorded 1 decision on 1 commit')
  const file = join(dir, 'd2.json')
  writeFileSync(file, JSON.stringify({ decisions: [e('f1')] }))
  const r = gloss(dir, ['reviews', 'HEAD', '--decide', id2, '--decide-file', file, '--by', 'Arb'])
  assert.equal(r.out.trim(), 'recorded 1 decision on 1 commit')
  assert.equal(decisions().length, 2)
})

test('a re-run does not skip a decision that a later one reversed', () => {
  const { dir, id, batch, decisions } = setup()
  const file = { decisions: [e('f1', 'fixed')] }
  assert.equal(batch(file, '--by', 'Arb').out.trim(), 'recorded 1 decision on 1 commit')
  const single = gloss(dir, ['reviews', 'HEAD', '--decide', id, '--finding', 'f1', '--outcome', 'rejected', '--by', 'Arb'])
  assert.equal(single.code, 0, single.err)
  const again = batch(file, '--by', 'Arb')
  assert.equal(again.out.trim(), 'recorded 1 decision on 1 commit')
  assert.deepEqual(decisions().map((d) => d.outcome).sort(), ['fixed', 'fixed', 'rejected'])
  // and now the file's decision is the latest, so another re-run skips it
  assert.equal(batch(file, '--by', 'Arb').out.trim(), 'recorded 0 decisions on 0 commits (1 already recorded)')
  assert.match(gloss(dir, ['reviews']).out, /f1 +major +defect +read +fixed/)
})

test('a 200-item review with a 200-entry --decide-file finishes quickly', () => {
  const { batch, decisions } = setup(many(200))
  const t = performance.now()
  const r = batch(Array.from({ length: 200 }, (_, i) => e(`f${i + 1}`)))
  within('decide-file 200 entries', performance.now() - t, 4000)
  assert.equal(r.code, 0, r.err)
  assert.equal(r.err, '')
  assert.equal(decisions().length, 200)
})
