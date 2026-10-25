import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from './run.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.ts'
import { browse, chromium, dumpDom, press, skipBrowse, sleep } from './browser.ts'
import { Annotation, noteFormat } from '../src/schema.ts'
import { combineAttention } from '../src/attention.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function repo() {
  const dir = tmp('attn-test-')
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const write = (file: string, lines: string[]) => writeFileSync(join(dir, file), lines.join('\n') + '\n')
  const commit = (msg: string, groups?: object[], attention?: object) => {
    g('add', '-A')
    g('commit', '-qm', msg)
    if (groups) {
      const r = gloss(dir, ['add'], JSON.stringify({ task: msg, groups, ...(attention ? { attention } : {}) }))
      assert.equal(r.code, 0, r.err)
    }
    return g('rev-parse', 'HEAD')
  }
  write('app.js', ['function main() {', '  run()', '}'])
  write('util.js', ['export const a = 1'])
  commit('base')
  return { dir, g, write, commit }
}

const group = (id: string, hunks: string[], extra: object = {}) =>
  ({ id, hunks, intent: `${id} intent`, necessity: 'required', serves: 'task', removal_impact: `no ${id}`, ...extra })

const noteOf = (dir: string, rev = 'HEAD') => JSON.parse(execFileSync('git', ['notes', '--ref', 'gloss', 'show', rev], { cwd: dir, encoding: 'utf8' }))

// Two hunks (one per file), glossed with impact and attention.
function rated() {
  const r = repo()
  r.write('app.js', ['function main() {', '  run()', '  log()', '}'])
  r.write('util.js', ['export const a = 2'])
  r.commit('change both', [
    group('quiet', ['h1'], { impact: 'local', necessity: 'mechanical' }),
    group('risky', ['h2'], { impact: 'sensitive', impact_reason: 'writes to the device' }),
  ], { level: 'careful', focus: ['risky', 'quiet'], reasons: ['device write'] })
  return r
}

const base = { task: 't', groups: [group('a', ['h1'])] }

test('the schema accepts impact and attention and rejects bad values', () => {
  const ok = (extra: object) => Annotation.safeParse({ ...base, ...extra }).success
  assert.ok(ok({}))
  assert.ok(ok({ groups: [group('a', ['h1'], { impact: 'contract', impact_reason: 'public API' })] }))
  assert.ok(ok({ attention: { level: 'must-read', focus: ['a'], reasons: ['x'], override_reason: 'y' } }))
  assert.ok(!ok({ groups: [group('a', ['h1'], { impact: 'huge' })] }), 'bad impact')
  assert.ok(!ok({ groups: [group('a', ['h1'], { impact_reason: 'x'.repeat(121) })] }), 'long reason')
  assert.ok(!ok({ attention: { level: 'urgent' } }), 'bad level')
  assert.ok(!ok({ attention: { level: 'look', focus: ['a', 'b', 'c', 'd'] } }), 'more than 3 focus groups')
  assert.ok(!ok({ attention: { level: 'look', focus: [] } }), 'empty focus')
})

test('add refuses a focus group that does not exist, or is repeated', () => {
  const { dir, write, g } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  g('add', '-A'); g('commit', '-qm', 'x')
  const add = (attention: object) => gloss(dir, ['add', '--dry-run'], JSON.stringify({ task: 't', groups: [group('a', ['h1'])], attention }))
  let r = add({ level: 'look', focus: ['nope'] })
  assert.equal(r.code, 1)
  assert.match(r.err, /attention\.focus names unknown group "nope"/)
  r = add({ level: 'look', focus: ['a', 'a'] })
  assert.match(r.err, /lists a group twice/)
  r = add({ level: 'look', focus: ['a', 'b', 'c', 'd'] })
  assert.match(r.err, /schema/)
  assert.equal(add({ level: 'look', focus: ['a'] }).code, 0)
})

test('a note is format 4 only when it uses the new fields', () => {
  const a = (extra: object, g: object = {}) => Annotation.parse({ task: 't', groups: [group('a', ['h1'], g)], ...extra })
  assert.equal(noteFormat(a({})), 1)
  assert.equal(noteFormat(a({}, { hunks: ['h1:1-2'] })), 2)
  assert.equal(noteFormat(a({}, { serves: ['x', 'y'] })), 3)
  assert.equal(noteFormat(a({}, { impact: 'local' })), 4)
  assert.equal(noteFormat(a({}, { impact_reason: 'r' })), 4)
  assert.equal(noteFormat(a({ attention: { level: 'skim' } })), 4)

  const { dir, write, g } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  write('util.js', ['export const a = 2'])
  g('add', '-A'); g('commit', '-qm', 'x')
  const plain = JSON.stringify({ task: 't', groups: [group('a', ['h1']), group('b', ['h2'])] })
  assert.equal(gloss(dir, ['add'], plain).code, 0)
  assert.equal(noteOf(dir).gloss, 1)
  const fmt3 = JSON.stringify({ task: 't', groups: [group('a', ['h1']), group('b', ['h2'], { serves: 'task' }), group('s', ['h2'], { necessity: 'supporting', serves: ['a', 'b'] })] })
  assert.equal(gloss(dir, ['add', '--force'], fmt3).code, 0)
  assert.equal(noteOf(dir).gloss, 3, 'an existing format-3 gloss still writes as 3')
  const withImpact = JSON.stringify({ task: 't', groups: [group('a', ['h1'], { impact: 'module' }), group('b', ['h2'])] })
  assert.equal(gloss(dir, ['add', '--force'], withImpact).code, 0)
  assert.equal(noteOf(dir).gloss, 4)
})

test('a glossed commit without attention shows a derived attention', () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  write('util.js', ['export const a = 2'])
  commit('plain', [group('a', ['h1', 'h2'])])
  const r = gloss(dir, ['show'])
  assert.match(r.out, /attention: CAREFUL \(derived\) · floor: look/)
  assert.doesNotMatch(r.out, /\[(local|module|shared|contract|sensitive)\]/)
  assert.match(r.out, /^ {2}required {2,}a {2}/m, 'rows have no impact column')
})

test('show leads with the attention, badges groups, and --sort / --only take impact', () => {
  const { dir } = rated()
  let r = gloss(dir, ['show'])
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /attention: CAREFUL \(declared\) · floor: look · focus: risky, quiet/)
  assert.match(r.out, /• device write/)
  const rows = r.out.split('\n').filter((l) => /^ {2}(required|mechanical) /.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 3))
  assert.deepEqual(rows, [['required', '[sensitive]', 'risky'], ['mechanical', '[local]', 'quiet']])

  r = gloss(dir, ['show', '--sort', 'impact'])
  const order = r.out.split('\n').filter((l) => /^ {2}(required|mechanical) /.test(l)).map((l) => l.trim().split(/\s+/)[2])
  assert.deepEqual(order, ['risky', 'quiet'])
  assert.equal(gloss(dir, ['show', '--sort', 'size']).code, 2)

  r = gloss(dir, ['show', '--only', 'local'])
  assert.match(r.out, /^ {2}mechanical .*quiet/m); assert.doesNotMatch(r.out, /^ {2}required/m)
  r = gloss(dir, ['show', '--only', 'sensitive,contract'])
  assert.match(r.out, /^ {2}required .*risky/m); assert.doesNotMatch(r.out, /^ {2}mechanical/m)
  r = gloss(dir, ['show', '--only', 'required,sensitive'])
  assert.match(r.out, /^ {2}required .*risky/m); assert.doesNotMatch(r.out, /^ {2}mechanical/m)
  r = gloss(dir, ['show', '--only', 'mechanical,sensitive'])
  assert.equal(r.code, 1, 'no group is both')
  r = gloss(dir, ['show', '--only', 'huge'])
  assert.equal(r.code, 2)
  assert.match(r.err, /unknown necessity or impact huge/)

  r = gloss(dir, ['show', '-g', 'risky'])
  assert.match(r.out, /\[required\] \[sensitive\] risky intent/)
  assert.match(r.out, /impact: writes to the device/)
})

test('html shows the attention banner, focus links and impact badges', () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  assert.equal(gloss(dir, ['html', '-o', out]).code, 0)
  const html = readFileSync(out, 'utf8')
  const page = JSON.parse(/<script type="application\/json" id="gloss-data">(.*?)<\/script>/s.exec(html)![1])
  const c = page.commits[0]
  assert.deepEqual(c.attention, { level: 'careful', focus: ['risky', 'quiet'], reasons: ['device write'] })
  assert.deepEqual(c.groups.map((g: { id: string; impact: string }) => [g.id, g.impact]), [['risky', 'sensitive'], ['quiet', 'local']])
  assert.equal(c.groups[0].impact_reason, 'writes to the device')
  assert.deepEqual(page.impact.map((i: { name: string }) => i.name), ['local', 'module', 'shared', 'contract', 'sensitive'])
  assert.deepEqual(c.order, ['risky', 'quiet'], 'focus groups first')
})


test('the rendered page shows the attention card, focus links and impact', { skip: !chromium && 'no Chromium found' }, () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  const dom = dumpDom(`file://${out}`)
  assert.match(dom, /<span>CAREFUL<\/span>/)
  assert.match(dom, /Look here first/)
  assert.match(dom, /sensitive impact/)
  assert.match(dom, /writes to the device/)
  assert.match(dom, /device write/, 'attention reasons')
})

test('html data marks a gloss without attention as unrated', () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  write('util.js', ['export const a = 2'])
  commit('plain', [group('a', ['h1', 'h2'])])
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  const html = readFileSync(out, 'utf8')
  const page = JSON.parse(/<script type="application\/json" id="gloss-data">(.*?)<\/script>/s.exec(html)![1])
  assert.equal(page.commits[0].attention, null)
  assert.equal(page.commits[0].groups[0].impact, undefined)
})

test('combineAttention takes the highest level, ranks focus by impact, and unions reasons', () => {
  const groups = [group('a', []), group('b', [], { impact: 'contract' }), group('c', [], { impact: 'sensitive' }), group('d', [], { impact: 'contract' })] as never[]
  const merged = combineAttention(
    [{ level: 'look', focus: ['a', 'b'], reasons: ['r1'] }, { level: 'must-read', focus: ['c', 'd', 'b'], reasons: ['r1', 'r2'] }],
    (_, id) => id, groups)!
  assert.equal(merged.level, 'must-read')
  assert.deepEqual(merged.focus, ['c', 'b', 'd'], 'highest impact first, ties in order, deduplicated, at most 3')
  assert.deepEqual(merged.reasons, ['r1', 'r2'])
  const renamed = combineAttention([{ level: 'skim', focus: ['b'] }], (_, id) => (id === 'b' ? undefined : id), groups)!
  assert.equal(renamed.focus, undefined, 'a focus group that is gone is dropped')
})

test('squashing takes the highest attention, ranks focus by impact and maps renamed groups', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  log()', '}'])
  commit('one', [group('logging', ['h1'], { impact: 'module' })], { level: 'look', focus: ['logging'], reasons: ['new log'] })
  write('util.js', ['export const a = 2'])
  commit('two', [group('logging', ['h1'], { impact: 'sensitive', impact_reason: 'device write' })], { level: 'must-read', focus: ['logging'], reasons: ['device'] })
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')

  const r = gloss(dir, ['carry', 'main~1..feat'])
  assert.equal(r.code, 0, r.err)
  const note = noteOf(dir)
  assert.equal(note.gloss, 4)
  const ids = note.annotation.groups.map((x: { id: string }) => x.id)
  assert.deepEqual(ids, ['logging-1', 'logging-2'], 'clashing ids are renamed')
  assert.equal(note.annotation.attention.level, 'must-read')
  assert.deepEqual(note.annotation.attention.focus, ['logging-2', 'logging-1'], 'most impactful first, ids follow the renames')
  assert.deepEqual(note.annotation.attention.reasons, ['new log', 'device'])
  assert.deepEqual(note.annotation.groups.map((x: { impact: string }) => x.impact), ['module', 'sensitive'])
  assert.equal(gloss(dir, ['show']).code, 0)
})

test('carrying a wip gloss keeps the attention and drops focus groups left behind', () => {
  const { dir, write, g } = repo()
  write('app.js', ['function main() {', '  run()', '  log()', '}'])
  write('util.js', ['export const a = 2'])
  assert.equal(gloss(dir, ['hunks', 'wip']).code, 0)
  assert.equal(gloss(dir, ['add', 'wip'], JSON.stringify({
    task: 't', groups: [group('x', ['h1'], { impact: 'contract', impact_reason: 'api' }), group('y', ['h2'], { impact: 'local' })],
    attention: { level: 'careful', focus: ['y', 'x'] },
  })).code, 0)
  g('checkout', '-q', 'app.js')
  const r = gloss(dir, ['hunks', 'wip'])
  assert.equal(r.code, 0, r.err)
  const show = gloss(dir, ['show', 'wip'])
  assert.match(show.out, /attention: CAREFUL \(declared\) · floor: look · focus: y\n/)
  assert.doesNotMatch(show.out, /\bx\b.*intent/)
})

test('combineAttention keeps an override_reason only from parts at the combined level', () => {
  const groups = [group('a', [])] as never[]
  const merged = combineAttention(
    [{ level: 'skim', override_reason: 'mostly renames' }, { level: 'must-read' }], (_, id) => id, groups)!
  assert.equal(merged.level, 'must-read')
  assert.equal(merged.override_reason, undefined, 'a lower level was discarded, and so is its excuse')
  const both = combineAttention(
    [{ level: 'look', override_reason: 'x' }, { level: 'look', override_reason: 'y' }, { level: 'skim', override_reason: 'z' }], (_, id) => id, groups)!
  assert.equal(both.override_reason, 'x; y')
})

test('squashing a rated commit with an unrated one stores no attention, and shows a derived one', () => {
  const { dir, g, write, commit } = repo()
  g('checkout', '-qb', 'feat')
  write('app.js', ['function main() {', '  run()', '  log()', '}'])
  commit('one', [group('logging', ['h1'], { impact: 'local' })], { level: 'look', focus: ['logging'] })
  write('util.js', ['export const a = 2'])
  commit('two', [group('logic', ['h1'])])
  g('checkout', '-q', 'main')
  g('merge', '-q', '--squash', 'feat')
  commit('squashed')

  const r = gloss(dir, ['carry', 'main~1..feat'])
  assert.equal(r.code, 0, r.err)
  assert.equal(noteOf(dir).annotation.attention, undefined, 'an unrated source makes the combined gloss unrated')
  assert.match(gloss(dir, ['show']).out, /attention: [A-Z-]+ \(derived\)/, 'computed on read from the diff')
})


test('in a real browser, Previous/Next and the mark-read label follow the filter and position', { skip: skipBrowse }, async () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  await browse(`file://${out}#g-risky`, async (evaluate) => {
    const nav = "[...document.querySelectorAll('.nav .btn')].map((b) => b.disabled + ':' + b.textContent).join('|')"
    const click = (label: string) => evaluate(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent.startsWith('${label}')).click()`)
    // risky is first; under "Contract and above" it is the only group, so nothing follows it.
    await click('Contract and above')
    assert.match(String(await evaluate(nav)), /^false:Previous\|true:Next\|false:Mark as read$/)
    await click('All')
    assert.match(String(await evaluate(nav)), /^false:Previous\|false:Next\|false:Mark as read and go to next$/, 'Next is available again')
    await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }))")
    assert.match(String(await evaluate(nav)), /^false:Previous\|true:Next\|false:Mark as read$/, 'on the last group')
  })
})

test('in a real browser, the primary button stays readable on hover in light and dark', { skip: skipBrowse }, async () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  // WCAG contrast of the button's text colour over its background, as computed after the hover.
  const contrast = `(() => {
    const b = document.querySelector('.btn.primary'), cs = getComputedStyle(b)
    const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number)
    const lum = (c) => { const [r, g, bl] = rgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl }
    const a = lum(cs.color), c = lum(cs.backgroundColor)
    return (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05)
  })()`
  for (const scheme of ['light', 'dark'] as const) {
    await browse(`file://${out}#g-risky`, async (evaluate, send) => {
      const r = (await evaluate("(() => { const b = document.querySelector('.btn.primary'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()")) as number[]
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r[0], y: r[1] })
      await new Promise((res) => setTimeout(res, 200))
      assert.equal(await evaluate("document.querySelector('.btn.primary').matches(':hover')"), true, 'the pointer is over the button')
      const ratio = Number(await evaluate(contrast))
      assert.ok(ratio >= 4.5, `${scheme}: contrast ${ratio.toFixed(2)} on hover`)
    }, { scheme })
  }
})

const progress = "document.querySelector('.prog span').textContent"

test('in a real browser, read marks last for the tab: reloads and group changes keep them, a fresh tab starts empty, and ticking works with localStorage blocked', { skip: skipBrowse }, async () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  const url = `file://${out}`
  await browse(url, async (evaluate, _send, openTab) => {
    assert.equal(await evaluate(progress), '0 of 2 read')
    await evaluate("document.querySelector('.row .check').click()")
    assert.equal(await evaluate(progress), '1 of 2 read')
    assert.equal(await evaluate("document.querySelectorAll('.row.done').length"), 1)
    await evaluate("document.querySelectorAll('.row .pick')[1].click()")
    assert.equal(await evaluate(progress), '1 of 2 read', 'marks survive switching groups')
    await evaluate('location.reload()')
    await sleep(1000)
    assert.equal(await evaluate(progress), '1 of 2 read', 'a reload in the same tab keeps them')
    assert.equal(await evaluate("document.querySelectorAll('.row.done').length"), 1)
    const fresh = await openTab(url)
    assert.equal(await fresh(progress), '0 of 2 read', 'a fresh tab starts empty')
  })
  await browse(url, async (evaluate) => {
    await evaluate("document.querySelector('.row .check').click()")
    assert.equal(await evaluate(progress), '1 of 2 read', 'ticking works with localStorage blocked')
  }, { flags: ['--disable-local-storage'] })
})

test('in a real browser, keyboard focus stays on the control that was used', { skip: skipBrowse }, async () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  await browse(`file://${out}#g-risky`, async (evaluate, send) => {
    const where = "(() => { const a = document.activeElement; return a.tagName + ':' + (a.closest('.nav') ? 'nav' : a.closest('.chead') ? 'code' : a.closest('.rail') ? 'rail' : 'other') })()"
    // Next, with Enter: the pane changes (to the last group), focus stays in the nav bar.
    await evaluate("[...document.querySelectorAll('.nav .btn')].find((b) => b.textContent === 'Next').focus()")
    await press(send, 'Enter')
    assert.equal(await evaluate('location.hash'), '#g-quiet')
    assert.equal(await evaluate(where), 'BUTTON:nav', 'after Next')
    // Mark as read and go to next, on the last group: nothing follows, focus still stays in the bar.
    await evaluate("document.querySelector('.nav .btn.primary').focus()")
    await press(send, 'Enter')
    assert.equal(await evaluate(where), 'BUTTON:nav', 'after Mark as read')
    // Expand all, by Enter and by the c key.
    await evaluate("[...document.querySelectorAll('.chead button')].find((b) => b.textContent === 'Collapse all hunks').focus()")
    await press(send, 'Enter')
    assert.equal(await evaluate(where), 'BUTTON:code', 'after Collapse all hunks')
    await evaluate("[...document.querySelectorAll('.chead button')].find((b) => b.textContent === 'Expand all hunks').focus()")
    await press(send, 'o')
    assert.equal(await evaluate(where), 'BUTTON:code', 'after the o key')
  })
})

test('in a real browser, each hunk folds on its own and Expand/Collapse all act on the group', { skip: skipBrowse }, async () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run2()', '  log()', '}'])
  write('util.js', ['export const a = 2'])
  commit('change both', [group('both', ['h1', 'h2'])])
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  await browse(`file://${out}#g-both`, async (evaluate, send) => {
    const count = (sel: string) => evaluate(`document.querySelectorAll('${sel}').length`)
    const visible = "[...document.querySelectorAll('.hunk')].map((h) => h.querySelector('.scroll').hidden ? 0 : 1).join('')"
    const expanded = "[...document.querySelectorAll('.htoggle')].map((b) => b.getAttribute('aria-expanded')).join()"
    assert.equal(await count('.hunk-head'), 2)
    assert.equal(await evaluate(visible), '11', 'open by default')
    await evaluate("document.querySelectorAll('.htoggle')[0].click()")
    assert.equal(await evaluate(visible), '01', 'only the clicked hunk folds')
    assert.equal(await evaluate(expanded), 'false,true')
    assert.equal(await evaluate("[...document.querySelectorAll('.hunk-head')].every((h) => h.offsetHeight > 0)"), true, 'every header stays visible')
    // The state outlives a trip to another view and back.
    await evaluate("[...document.querySelectorAll('.rail .pick')].find((b) => b.textContent.startsWith('Overview')).click()")
    await evaluate("document.querySelector('.rail .rows .row .pick').click()")
    assert.equal(await evaluate(visible), '01', 'folded state is kept')
    await evaluate("[...document.querySelectorAll('.chead button')].find((b) => b.textContent === 'Collapse all hunks').click()")
    assert.equal(await evaluate(visible), '00')
    assert.equal(await evaluate("[...document.querySelectorAll('.chead button')].map((b) => b.disabled).join()"), 'false,true')
    await evaluate("[...document.querySelectorAll('.chead button')].find((b) => b.textContent === 'Expand all hunks').click()")
    assert.equal(await evaluate(visible), '11')
    // Keyboard: focus a toggle, press Enter, focus stays on it.
    await evaluate("document.querySelectorAll('.htoggle')[1].focus()")
    await press(send, 'Enter')
    assert.equal(await evaluate(visible), '10')
    assert.equal(await evaluate("document.activeElement === document.querySelectorAll('.htoggle')[1]"), true)
  })
})

test('in a real browser, risks and alternatives have their own page and row, and the overview leads with look-here-first', { skip: skipBrowse }, async () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run2()', '  log()', '}'])
  commit('change')
  const r = gloss(dir, ['add'], JSON.stringify({
    task: 't', groups: [group('a', ['h1'], { impact: 'sensitive', impact_reason: 'writes to the device' })],
    risks: ['first risk', 'second risk'], alternatives: [{ option: 'other way', rejected_because: 'slower' }],
    attention: { level: 'careful', focus: ['a'], reasons: ['why'] },
  }))
  assert.equal(r.code, 0, r.err)
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  const main = "document.querySelector('main').textContent"
  await browse(`file://${out}`, async (evaluate) => {
    assert.equal(await evaluate('location.hash'), '#overview', 'the overview is shown first')
    const overview = String(await evaluate(main))
    assert.doesNotMatch(overview, /first risk|other way/, 'no risks in the overview')
    assert.match(overview, /Look here first[\s\S]*a intent[\s\S]*sensitive impact[\s\S]*writes to the device/)
    assert.match(String(await evaluate("document.querySelector('main .att').textContent")), /CAREFUL/, 'the attention card is on the overview')
    assert.equal(await evaluate("!!document.querySelector('.rail .att')"), false, 'and not in the rail')
    assert.match(String(await evaluate("document.querySelector('.rail .overviewrow').textContent")), /CAREFUL/, 'the rail keeps a small level chip')
    // The risks row sits between the groups and the reviews.
    assert.equal(await evaluate("(() => { const k = [...document.querySelector('.rail').children]; return k.findIndex((e) => e.querySelector('.rows')) < k.findIndex((e) => e.classList.contains('railsec')) && k.findIndex((e) => e.classList.contains('railsec')) < k.findIndex((e) => e.classList.contains('railfoot')) })()"), true)
    assert.match(String(await evaluate("document.querySelector('.railsec').textContent")), /2 risks · 1 alternative/)
    await evaluate("document.querySelector('.focuscard').click()")
    assert.equal(await evaluate('location.hash'), '#g-a', 'a focus card opens the group')
    assert.equal(await evaluate("document.querySelector('main').textContent.includes('first risk')"), false, 'not under the group')
    await evaluate("document.querySelector('.railsec .rvrow').click()")
    assert.equal(await evaluate('location.hash'), '#risks')
    assert.equal(await evaluate("document.getElementById('risks').textContent"), 'Risks the author flagged (2)')
    assert.match(String(await evaluate(main)), /Alternatives the author rejected \(1\)[\s\S]*other way/)
    await evaluate("[...document.querySelectorAll('main .btn')].find((b) => b.textContent.includes('Back')).click()")
    assert.equal(await evaluate('location.hash'), '#g-a', 'Back returns to where the reader was')
    // j/k: overview -> first group, and back.
    await evaluate("document.querySelector('.rail .overviewrow .pick').click()")
    const key = (k: string) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}' }))`)
    await key('k'); assert.equal(await evaluate('location.hash'), '#overview', 'k on the overview stays')
    await key('j'); assert.equal(await evaluate('location.hash'), '#g-a')
    await key('k'); assert.equal(await evaluate('location.hash'), '#overview')
  })
  await browse(`file://${out}#risks`, async (evaluate) => {
    assert.equal(await evaluate("!!document.querySelector('main #risks')"), true, 'the hash opens the risks page')
  })
})

test('in a real browser, a gloss without a focus has no look-here-first section, and none without risks has no row', { skip: skipBrowse }, async () => {
  const nofocus = repo()
  nofocus.write('app.js', ['function main() {', '  run2()', '}'])
  nofocus.commit('x', [group('a', ['h1'])], { level: 'look', reasons: ['r'] })
  const out = join(nofocus.dir, 'view.html')
  gloss(nofocus.dir, ['html', '-o', out])
  await browse(`file://${out}`, async (evaluate) => {
    assert.equal(await evaluate("document.querySelector('main').textContent.includes('Look here first')"), false)
    assert.equal(await evaluate("!!document.querySelector('.railsec')"), false, 'no risks row')
  })
})

test('in a real browser, a range lists commits newest first, hottest first by default, and j/k step across them', { skip: skipBrowse }, async () => {
  const { dir, write, commit } = repo()
  const c = (name: string, level: string) => {
    write('app.js', ['function main() {', `  run${name}()`, '}'])
    commit(name, [group('g', ['h1'])], { level, focus: ['g'], reasons: ['r'] })
  }
  c('c1', 'careful')
  c('c2', 'must-read')
  c('c3', 'careful')
  const out = join(dir, 'range.html')
  assert.equal(gloss(dir, ['html', 'HEAD~3..HEAD', '-o', out]).code, 0)
  await browse(`file://${out}`, async (evaluate) => {
    const rail = "[...document.querySelectorAll('.crow .csubject')].map((e) => e.textContent).join()"
    const title = "document.querySelector('main h1').textContent"
    assert.equal(await evaluate(rail), 'c2,c3,c1', 'hottest first, ties newest first')
    assert.equal(await evaluate(title), 'c2', 'the hottest commit is selected')
    await evaluate("[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'History order').click()")
    assert.equal(await evaluate(rail), 'c3,c2,c1', 'history order is newest first')
    await evaluate("[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Hottest first').click()")
    const key = (k: string) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}' }))`)
    await key('j'); assert.equal(await evaluate(title), 'c3')
    await key('j'); assert.equal(await evaluate(title), 'c1')
    await key('j'); assert.equal(await evaluate(title), 'c1', 'stops at the end')
    await key('k'); assert.equal(await evaluate(title), 'c3')
  })
})

test('in a real browser, Next/Previous skip to the nearest visible group when the filter hides the current one', { skip: skipBrowse }, async () => {
  const { dir, write, commit } = repo()
  write('app.js', ['function main() {', '  run2()', '}'])
  write('third.js', ['export const t = 1'])
  write('util.js', ['export const a = 2'])
  commit('three', [
    group('top', ['h1'], { impact: 'sensitive', impact_reason: 'writes to the device' }),
    group('mid', ['h2'], { impact: 'module' }),
    group('low', ['h3'], { impact: 'local' }),
  ])
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  await browse(`file://${out}`, async (evaluate) => {
    const nav = "[...document.querySelectorAll('.nav .btn')].slice(0, 2).map((b) => b.disabled).join()"
    const click = (label: string) => evaluate(`[...document.querySelectorAll('.seg button')].find((b) => b.textContent.startsWith('${label}')).click()`)
    await evaluate("[...document.querySelectorAll('.rail .rows .pick')].find((b) => b.textContent.includes('mid')).click()")
    assert.equal(await evaluate('location.hash'), '#g-mid')
    await click('Local only') // hides "mid": before it is "top" (hidden), after it "low"
    assert.equal(await evaluate(nav), 'false,false', 'Previous (the overview, nothing visible before); Next: low')
    await click('Contract and above') // shows only "top", which is before "mid"
    assert.equal(await evaluate(nav), 'false,true', 'Previous: top; nothing visible after')
    await click('Local only')
    await evaluate("document.querySelectorAll('.nav .btn')[0].click()")
    assert.equal(await evaluate('location.hash'), '#overview', 'with nothing visible before it, Previous goes to the overview, not to another group')
  })
})

test('in a real browser, read marks work in memory when sessionStorage throws', { skip: skipBrowse }, async () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  const block = ['localStorage', 'sessionStorage'].map((n) =>
    `Object.defineProperty(window, '${n}', { get() { throw new DOMException('blocked', 'SecurityError') } })`).join(';')
  await browse(`file://${out}`, async (evaluate) => {
    assert.equal(await evaluate("(() => { try { window.sessionStorage; return 'reachable' } catch (e) { return 'blocked' } })()"), 'blocked', 'the stub is in place')
    assert.equal(await evaluate("document.querySelectorAll('.rail .rows .row').length"), 2, 'the page rendered')
    await evaluate("document.querySelector('.row .check').click()")
    assert.equal(await evaluate(progress), '1 of 2 read')
    assert.equal(await evaluate("document.querySelectorAll('.row.done').length"), 1)
    await evaluate("document.querySelectorAll('.row .pick')[1].click()")
    assert.equal(await evaluate(progress), '1 of 2 read', 'the mark survives switching groups')
    assert.equal(await evaluate("document.querySelectorAll('.row.done').length"), 1)
  }, { initScript: block })
})

test('in a real browser, scrolling the rail to its end does not scroll the page', { skip: skipBrowse }, async () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  await browse(`file://${out}#g-risky`, async (evaluate, send) => {
    // A wide but short window: the rail is its own scroll container and the page is taller than the window.
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 220, deviceScaleFactor: 1, mobile: false })
    await sleep(300)
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.rail')).overflowY"), 'auto')
    assert.ok(Number(await evaluate("document.querySelector('.rail').scrollHeight - document.querySelector('.rail').clientHeight")) > 50, 'the rail can scroll')
    assert.ok(Number(await evaluate("document.documentElement.scrollHeight - innerHeight")) > 50, 'so can the page')
    for (let i = 0; i < 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 100, y: 120, deltaX: 0, deltaY: 200 })
      await sleep(120)
    }
    assert.ok(Number(await evaluate("document.querySelector('.rail').scrollTop")) > 0, 'the rail scrolled')
    assert.equal(await evaluate("document.querySelector('.rail').scrollTop + document.querySelector('.rail').clientHeight >= document.querySelector('.rail').scrollHeight - 1"), true, 'to its end')
    assert.equal(await evaluate('window.scrollY'), 0, 'the page did not move')
  })
})

test('in a real browser, a card that opens another pane moves focus to that pane\'s heading', { skip: skipBrowse }, async () => {
  const { dir } = rated()
  const out = join(dir, 'view.html')
  gloss(dir, ['html', '-o', out])
  await browse(`file://${out}`, async (evaluate, send) => {
    await evaluate("document.querySelector('.focuscard').focus()")
    await press(send, 'Enter')
    assert.equal(await evaluate('location.hash'), '#g-risky')
    assert.equal(await evaluate("document.activeElement === document.querySelector('main h1')"), true, 'focus is on the new heading, not on <body>')
  })
})
