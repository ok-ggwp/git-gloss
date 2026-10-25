import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from './run.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { within } from './timing.ts'
import { MAX_NOTE_BYTES } from '../src/schema.ts'

// More of the untrusted-input audit (TODO.md): hostile notes through ranges,
// the size cap, adopt, carry, versions, and the html page.

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8', maxBuffer: 1 << 30 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const group = (id: string, hunks = ['h1']) => ({ id, hunks, intent: `${id} intent`, necessity: 'required', serves: 'task', removal_impact: `no ${id}` })
const annotation = (task = 't') => JSON.stringify({ task, groups: [group('g')] })

// A repo with `n` commits after the base, each rewriting app.js and glossed with `add`.
function repo(n = 1) {
  const dir = tmp('hardnotes-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.js'), 'a\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  const shas: string[] = []
  for (let i = 0; i < n; i++) {
    writeFileSync(join(dir, 'app.js'), `v${i}\n`)
    g('add', '-A')
    g('commit', '-qm', `change ${i}`)
    const r = gloss(dir, ['add'], annotation(`task ${i}`))
    assert.equal(r.code, 0, r.err)
    shas.push(g('rev-parse', 'HEAD'))
  }
  return { dir, g, shas }
}

// Writes a note straight into a notes ref, as a remote could have pushed it.
function put(g: (...a: string[]) => string, ref: string, sha: string, text: string) {
  const file = join(tmp('plant-'), 'note')
  writeFileSync(file, text)
  g('notes', '--ref', ref, 'add', '-f', '-F', file, sha)
}

const hunkRec = [{ id: 'h1', file: 'app.js', oldFile: 'app.js', oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]
const noteText = (task: string) => JSON.stringify({ gloss: 4, hunks: hunkRec, annotation: { task, groups: [group('g')] } })
const NO_STACK = /RangeError|SyntaxError|TypeError|at .*\.ts:\d+|node:internal/
// Piped output has no colour, so any escape or control byte in it came from the repository.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/
const INVISIBLE = /[‪-‮⁦-⁩​‎‏﻿]/

// 1. A refused gloss in a range
test('a refused gloss in a range is skipped with a warning by show and html; a single commit still fails', () => {
  const { dir, g, shas } = repo(3)
  // 501 groups: over the cap, so the gloss is refused
  put(g, 'refs/notes/gloss', shas[1], JSON.stringify({ gloss: 4, hunks: hunkRec, annotation: { task: 'evil', groups: Array.from({ length: 501 }, (_, i) => ({ ...group(`g${i}`), hunks: ['h1:1'] })) } }))
  const range = `${shas[0]}~1..${shas[2]}`
  const show = gloss(dir, ['show', range])
  assert.equal(show.code, 0, show.err)
  assert.match(show.out, /3 commits, 2 glossed/)
  assert.match(show.out, /task 0|change 0/)
  assert.match(show.out, /change 2/)
  assert.match(show.out, /change 1/, 'the skipped commit is still listed')
  assert.match(show.err, new RegExp(`warning: .*${shas[1].slice(0, 10)}.*(refused|malformed)`))
  assert.doesNotMatch(show.err, NO_STACK)

  const out = join(dir, 'p.html')
  const html = gloss(dir, ['html', range, '-o', out])
  assert.equal(html.code, 0, html.err)
  assert.match(html.err, new RegExp(`warning: .*${shas[1].slice(0, 10)}.*(refused|malformed)`))
  const page = readFileSync(out, 'utf8')
  assert.match(page, /task 0/)
  assert.match(page, /task 2/)
  assert.doesNotMatch(page, /"task":"evil"/)

  // a malformed note is skipped the same way
  put(g, 'refs/notes/gloss', shas[1], 'not json')
  const bad = gloss(dir, ['show', range])
  assert.equal(bad.code, 0, bad.err)
  assert.match(bad.err, /not valid JSON/)

  // a single-commit target reports the refusal as an error
  for (const cmd of ['show', 'html']) {
    const one = gloss(dir, [cmd, shas[1], ...(cmd === 'html' ? ['-o', out] : [])])
    assert.equal(one.code, 1, `${cmd}: ${one.err}`)
    assert.match(one.err, /^error: /)
  }
})

// 2. The total size cap
test('a gloss note over the size cap is refused fast, and does not break other commits', () => {
  const { dir, g, shas } = repo(2)
  const big = (extra: number) => noteText('x'.repeat(MAX_NOTE_BYTES - noteText('').length + extra))
  // git stores the note with a final newline: this one is exactly at the cap
  put(g, 'refs/notes/gloss', shas[0], big(-1))
  assert.equal(Number(g('cat-file', '-s', g('notes', '--ref', 'refs/notes/gloss', 'list', shas[0]))), MAX_NOTE_BYTES)
  const at = gloss(dir, ['show', shas[0]])
  assert.doesNotMatch(at.err, /size limit|too large/, 'a note exactly at the cap is not refused for its size')

  put(g, 'refs/notes/gloss', shas[0], big(0)) // one byte over
  const t = Date.now()
  const over = gloss(dir, ['show', shas[0]])
  const range = gloss(dir, ['show', `${shas[0]}~1..${shas[1]}`])
  const html = gloss(dir, ['html', `${shas[0]}~1..${shas[1]}`, '-o', join(dir, 'p.html')])
  within('over-cap note', Date.now() - t, 20_000)
  assert.equal(over.code, 1)
  assert.match(over.err, /over the size limit of 8 MiB \(MAX_NOTE_BYTES in src\/schema\.ts\)/)
  assert.doesNotMatch(over.err, NO_STACK)
  // the other commit still shows in a range
  assert.equal(range.code, 0, range.err)
  assert.match(range.out, /task 1/)
  assert.match(range.err, /over the size limit/)
  assert.equal(html.code, 0, html.err)
  assert.match(readFileSync(join(dir, 'p.html'), 'utf8'), /task 1/)
  // other commands name the problem as well
  assert.match(gloss(dir, ['lint', shas[0]]).err, /size limit/)

  // writing: add refuses what readers would refuse
  const file = join(tmp('big-'), 'a.json')
  writeFileSync(file, JSON.stringify({ task: 't', groups: [group('g')], risks: ['r'], alternatives: [{ option: 'o', rejected_because: 'x'.repeat(MAX_NOTE_BYTES) }] }))
  const w = gloss(dir, ['add', shas[1], '--force', '-f', file])
  assert.equal(w.code, 1)
  assert.match(w.err, /size limit/)
  assert.doesNotMatch(w.err, NO_STACK)
  assert.match(gloss(dir, ['show', shas[1]]).out, /task 1/, 'the old gloss is kept')
})

// 4. The html page strips invisible and reordering characters
test('the html page strips bidi, zero-width and BOM characters from subjects, authors and gloss text', () => {
  const { dir, g, shas } = repo(1)
  const evil = 'a‮b​c﻿d'
  writeFileSync(join(dir, 'app.js'), 'second\n')
  g('add', '-A')
  g('-c', 'user.name=Mal‮ory​', 'commit', '-qm', `subject ${evil}`)
  const sha = g('rev-parse', 'HEAD')
  const added = gloss(dir, ['add'], JSON.stringify({ task: `task ${evil}`, summary: `sum ${evil}`, groups: [{ ...group('g'), intent: `intent ${evil}`, notes: evil }] }))
  assert.equal(added.code, 0, added.err)
  // a review and a decision from a remote
  const rec = { review: 1, id: 'r1', at: '2026-01-01T00:00:00Z', stage: 'honesty', agent: `ag${evil}`, model: `m${evil}`, target: 'HEAD', lines: [], groups: [], findings: `- finding ${evil}`, verdict: 'issues' }
  const dec = { decision: 1, review: 'r1', at: '2026-01-02T00:00:00Z', by: `by${evil}`, finding: `1 f${evil}`, outcome: 'fixed', note: `note${evil}` }
  put(g, 'refs/notes/gloss-reviews', sha, JSON.stringify(rec) + '\n' + JSON.stringify(dec) + '\n')
  for (const args of [[sha], [`${shas[0]}~1..${sha}`]]) {
    const out = join(dir, 'p.html')
    const r = gloss(dir, ['html', ...args, '-o', out])
    assert.equal(r.code, 0, r.err)
    const page = readFileSync(out, 'utf8')
    assert.doesNotMatch(page, INVISIBLE, `html ${args[0]}: invisible characters reached the page`)
    assert.doesNotMatch(page, /\\u202e|\\u200b|\\ufeff/i, 'nor as JSON escapes')
    for (const word of ['subject a b c d', 'task a b c d', 'intent a b c d', 'finding a b c d', 'notea b c d', 'Mal ory']) {
      assert.ok(page.includes(word), `${word} is on the page`)
    }
  }
})

// 3. adopt, carry and versions against hostile notes
const OVER = 'x'.repeat(MAX_NOTE_BYTES + 1)
const ESC = '\x1b]0;PWNED\x07\x1b]52;c;cHduZWQ=\x07\x1b[2J‮​﻿'
type Variant = { name: string; text: (real: any) => string; readable: boolean }
const VARIANTS: Variant[] = [
  { name: 'huge', text: () => noteText(OVER), readable: false },
  { name: 'malformed', text: () => '{"gloss":4,"hunks":[\x1b]0;PWNED\x07\x1b[2J\u202e', readable: false },
  { name: 'prototype keys', readable: true, text: (real) => JSON.stringify(real)
    // written into the text: an object literal's __proto__ would set a prototype, not a key
    .replace('{"gloss"', '{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},"gloss"')
    .replace('"annotation":{', '"annotation":{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":1}},')
    .replace('"groups":[{', '"groups":[{"__proto__":{"isAdmin":true},"constructor":"polluted",') },
  { name: 'escape sequences', readable: true, text: (real) => JSON.stringify({
    ...real,
    annotation: { ...real.annotation, task: `task${ESC}`, groups: real.annotation.groups.map((x: any) => ({ ...x, id: `g`, intent: `intent${ESC}`, notes: `notes${ESC}` })) },
  }) },
]

const noteOn = (g: (...a: string[]) => string, ref: string, sha: string) => g('notes', '--ref', ref, 'show', sha)
const cleanRun = (name: string, r: { code: number | null; out: string; err: string }, ms: number) => {
  within(name, ms, 30_000)
  assert.ok(r.code === 0 || r.code === 1, `${name} exited ${r.code}: ${r.err.slice(0, 300)}`)
  assert.doesNotMatch(r.err, NO_STACK, `${name} printed a stack trace: ${r.err.slice(0, 300)}`)
  assert.doesNotMatch(r.out + r.err, CONTROL, `${name} printed a control character`)
  assert.doesNotMatch(r.out + r.err, INVISIBLE, `${name} printed an invisible character`)
}
const noPollution = (text: string) => assert.doesNotMatch(text, /polluted|isAdmin|PWNED|\\u001b|[\x00-\x08\x0b-\x1f\x7f‮​﻿]/)

// A wip snapshot glossed, its note then replaced with the hostile one, and the work committed.
function adoptRepo(v: Variant) {
  const dir = tmp('hardnotes-adopt-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.js'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'app.js'), 'b\n')
  assert.equal(gloss(dir, ['hunks', 'wip']).code, 0)
  assert.equal(gloss(dir, ['add', 'wip'], annotation()).code, 0)
  const wip = g('rev-parse', 'refs/worktree/gloss/wip')
  put(g, 'refs/notes/gloss-wip', wip, v.text(JSON.parse(noteOn(g, 'refs/notes/gloss-wip', wip))))
  g('add', '-A'); g('commit', '-qm', 'commit it')
  return { dir, g, sha: g('rev-parse', 'HEAD') }
}

for (const v of VARIANTS) {
  test(`adopt with a hostile wip note: ${v.name}`, () => {
    const { dir, g, sha } = adoptRepo(v)
    const t = Date.now()
    const r = gloss(dir, ['adopt'])
    cleanRun(`adopt ${v.name}`, r, Date.now() - t)
    if (!v.readable) {
      assert.equal(r.code, 1, r.out + r.err)
      assert.match(r.err, /^error: /)
      assert.equal(gloss(dir, ['show', sha]).code, 1, 'nothing was written')
      assert.throws(() => g('notes', '--ref', 'refs/notes/gloss', 'show', sha), /no note found/)
    } else {
      assert.equal(r.code, 0, r.err)
      noPollution(noteOn(g, 'refs/notes/gloss', sha))
      const shown = gloss(dir, ['show', sha, '--full'])
      assert.equal(shown.code, 0, shown.err)
      noPollution(shown.out)
    }
  })
}

// Two branches make the same change; the source's note is hostile, carried onto the other.
function carryRepo(v: Variant) {
  const dir = tmp('hardnotes-carry-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.js'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'base')
  g('checkout', '-qb', 'src')
  writeFileSync(join(dir, 'app.js'), 'b\n'); g('add', '-A'); g('commit', '-qm', 'source')
  const src = g('rev-parse', 'HEAD')
  assert.equal(gloss(dir, ['add'], annotation()).code, 0)
  put(g, 'refs/notes/gloss', src, v.text(JSON.parse(noteOn(g, 'refs/notes/gloss', src))))
  g('checkout', '-qb', 'dst', 'main')
  writeFileSync(join(dir, 'app.js'), 'b\n'); g('add', '-A'); g('commit', '-qm', 'destination')
  return { dir, g, src, dst: g('rev-parse', 'HEAD') }
}

for (const v of VARIANTS) {
  for (const mode of ['explicit', 'find']) {
    test(`carry (${mode}) from a hostile note: ${v.name}`, () => {
      const { dir, g, src, dst } = carryRepo(v)
      const t = Date.now()
      const r = mode === 'explicit' ? gloss(dir, ['carry', src, '--to', dst]) : gloss(dir, ['carry', '--find', '--squash', dst])
      cleanRun(`carry ${mode} ${v.name}`, r, Date.now() - t)
      if (!v.readable) {
        assert.throws(() => g('notes', '--ref', 'refs/notes/gloss', 'show', dst), /no note found/, 'nothing was written')
        if (mode === 'explicit') assert.equal(r.code, 1)
      } else {
        assert.equal(r.code, 0, r.err)
        noPollution(noteOn(g, 'refs/notes/gloss', dst))
      }
    })
  }
}

// The history of a commit's note holds the hostile version; list, show and restore it.
function versionsRepo(v: Variant, wip: boolean) {
  const dir = tmp('hardnotes-versions-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'app.js'), 'a\n'); g('add', '-A'); g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'app.js'), 'b\n')
  let sha: string, ref: string
  if (wip) {
    assert.equal(gloss(dir, ['hunks', 'wip']).code, 0)
    assert.equal(gloss(dir, ['add', 'wip'], annotation()).code, 0)
    sha = g('rev-parse', 'refs/worktree/gloss/wip'); ref = 'refs/notes/gloss-wip'
  } else {
    g('add', '-A'); g('commit', '-qm', 'change')
    assert.equal(gloss(dir, ['add'], annotation()).code, 0)
    sha = g('rev-parse', 'HEAD'); ref = 'refs/notes/gloss'
  }
  put(g, ref, sha, v.text(JSON.parse(noteOn(g, ref, sha))))
  // the notes commit's own subject is hostile text too
  const tip = g('rev-parse', ref)
  const evil = g('commit-tree', `${tip}^{tree}`, '-p', `${tip}~1`, '-m', `evil${ESC}`)
  g('update-ref', ref, evil)
  return { dir, g, sha, ref }
}

for (const v of VARIANTS) {
  for (const wip of [false, true]) {
    test(`versions ${wip ? 'wip ' : ''}with a hostile note in the history: ${v.name}`, () => {
      const { dir, g, sha, ref } = versionsRepo(v, wip)
      const target = wip ? 'wip' : sha
      const t = Date.now()
      const list = gloss(dir, ['versions', target])
      cleanRun(`versions ${v.name}`, list, Date.now() - t)
      assert.equal(list.code, 0, list.err)
      assert.ok(list.out.length < 20_000, `listing is ${list.out.length} bytes`)
      noPollution(list.out)
      if (v.name === 'huge') assert.match(list.out, /not read: .*size limit/, 'a huge version is not read for its summary')
      const show = gloss(dir, ['versions', target, '--show', '1'])
      cleanRun(`versions --show ${v.name}`, show, Date.now() - t)
      // the raw gloss: JSON-escaped text stays as written, but nothing a terminal would act on gets through
      const before = g('rev-parse', ref)
      const restore = gloss(dir, ['versions', target, '--restore', '1'])
      cleanRun(`versions --restore ${v.name}`, restore, Date.now() - t)
      if (!v.readable) {
        assert.equal(restore.code, 1, restore.out + restore.err)
        assert.match(restore.err, /^error: /)
        assert.equal(g('rev-parse', ref), before, 'the notes ref did not move')
      } else {
        assert.equal(restore.code, 0, restore.err)
        const shown = gloss(dir, ['show', target, '--full'])
        assert.equal(shown.code, 0, shown.err)
        noPollution(shown.out)
      }
    })
  }
}

// ---- review follow-ups ----

// A gloss refused by the claims check (not by size or shape): 100 groups each claiming a whole 6,000-line hunk.
function claimsRepo() {
  const dir = tmp('hardnotes-claims-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'Test')
  writeFileSync(join(dir, 'f.txt'), Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n') + '\n'); g('add', '-A'); g('commit', '-qm', 'base')
  writeFileSync(join(dir, 'f.txt'), Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n') + '\n'); g('add', '-A'); g('commit', '-qm', 'rewrite')
  const sha = g('rev-parse', 'HEAD')
  assert.equal(gloss(dir, ['add'], annotation()).code, 0)
  const good = JSON.parse(noteOn(g, 'refs/notes/gloss', sha))
  const bad = { ...good, annotation: { ...good.annotation, groups: Array.from({ length: 100 }, (_, i) => group(`g${i}`)) } }
  return { dir, g, sha, good, bad }
}

test('versions --restore refuses a gloss that readers refuse for its claims, and leaves the notes alone', () => {
  const { dir, g, sha, bad } = claimsRepo()
  put(g, 'refs/notes/gloss', sha, JSON.stringify(bad))
  assert.equal(gloss(dir, ['show', sha]).code, 1, 'readers refuse it')
  // put the good one back as the current gloss, then try to restore the bad version (1 = newest = the good one now)
  put(g, 'refs/notes/gloss', sha, JSON.stringify({ ...bad, annotation: { ...bad.annotation, groups: [group('g')] } }))
  const before = g('rev-parse', 'refs/notes/gloss')
  const r = gloss(dir, ['versions', sha, '--restore', '2'])
  assert.equal(r.code, 1, r.out + r.err)
  assert.match(r.err, /^error: .*claim/)
  assert.doesNotMatch(r.err, NO_STACK)
  assert.equal(g('rev-parse', 'refs/notes/gloss'), before)
  assert.equal(gloss(dir, ['show', sha]).code, 0)
})

test('a refused gloss in a range is marked on the html page, with its reason as clean text', () => {
  const { dir, g, shas } = repo(3)
  put(g, 'refs/notes/gloss', shas[1], 'not json \x1b]0;x\x07‮')
  const out = join(dir, 'p.html')
  assert.equal(gloss(dir, ['html', `${shas[0]}~1..${shas[2]}`, '-o', out]).code, 0)
  const page = readFileSync(out, 'utf8')
  const data = JSON.parse(/<script type="application\/json" id="gloss-data">(.*?)<\/script>/s.exec(page)![1].replace(/\\u003c/g, '<'))
  assert.equal(data.commits[1].glossed, false)
  assert.match(data.commits[1].glossRefused, /not valid JSON/)
  assert.doesNotMatch(data.commits[1].glossRefused, CONTROL)
  assert.doesNotMatch(data.commits[1].glossRefused, INVISIBLE)
  assert.equal(data.commits[0].glossRefused, undefined)
  assert.equal(data.commits[2].glossRefused, undefined)
  // the client shows it where it says "No gloss"
  assert.match(readFileSync(join(import.meta.dirname, '..', 'src', 'html', 'client.js'), 'utf8'), /glossRefused/)
})

test('review of a range and why skip a refused gloss with a warning; a single commit still errors', () => {
  const { dir, g, shas } = repo(3)
  put(g, 'refs/notes/gloss', shas[2], 'not json')
  const range = `${shas[0]}~1..${shas[2]}`
  const r = gloss(dir, ['review', range, '--material'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /warning: .*not valid JSON/)
  assert.match(r.out, /gloss was refused/)
  assert.match(r.out, /task 0/)
  assert.doesNotMatch(r.err, NO_STACK)
  const one = gloss(dir, ['review', shas[2], '--material'])
  assert.equal(one.code, 1)
  assert.match(one.err, /^error: /)
  // lint takes one commit only: still an error, not a stack trace
  assert.match(gloss(dir, ['lint', range]).err, /^error: /)
  const why = gloss(dir, ['why', 'app.js:1'])
  assert.equal(why.code, 0, why.err)
  assert.match(why.err, /warning: .*not valid JSON/)
  assert.doesNotMatch(why.err, NO_STACK)
})

test('add reads a gloss of about 7 MiB from a pipe, also from a slow writer', async () => {
  const { dir, shas } = repo(1)
  const text = JSON.stringify({ task: 'x'.repeat(7 * 1024 * 1024), groups: [group('g')] })
  assert.equal(gloss(dir, ['add', shas[0], '--force'], text).code, 0)
  // a writer that pauses between chunks leaves the pipe empty for a moment, which readFileSync(0) fails on (EAGAIN)
  const child = spawn(process.execPath, [BIN, 'add', shas[0], '--force'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''
  child.stderr.on('data', (d) => { err += d })
  const done = new Promise<number | null>((res) => child.on('close', res))
  for (let i = 0; i < text.length; i += 1 << 20) {
    child.stdin.write(text.slice(i, i + (1 << 20)))
    await new Promise((r) => setTimeout(r, 60))
  }
  child.stdin.end()
  assert.equal(await done, 0, err.slice(0, 300))
})
