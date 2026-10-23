import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseDiff } from '../src/diff.ts'
import { matchGlob } from '../src/glob.ts'
import { mergeConfig, RepoConfig } from '../src/config.ts'
import { analyze, pathClasses } from '../src/signals.ts'
import { analyzeGroups, groupInputsFor, ratingProblems } from '../src/floor.ts'
import type { Annotation } from '../src/schema.ts'

const BIN = join(import.meta.dirname, '..', 'bin', 'git-gloss.js')

function gloss(cwd: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, input, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

function repo(files: Record<string, string> = { 'app.js': 'run()\n', 'util.js': 'export const a = 1\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'signals-test-'))
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim()
  g('init', '-q', '-b', 'main')
  g('config', 'user.email', 't@example.com')
  g('config', 'user.name', 'Test')
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text)
  }
  const commit = (msg: string) => { g('add', '-A'); g('commit', '-qm', msg); return g('rev-parse', 'HEAD') }
  for (const [f, t] of Object.entries(files)) write(f, t)
  commit('base')
  return { dir, g, write, commit, config: (c: object) => write('.gloss/config.json', JSON.stringify(c)) }
}

const group = (id: string, hunks: string[], extra: object = {}) =>
  ({ id, hunks, intent: `${id} intent`, necessity: 'required', serves: 'task', removal_impact: `no ${id}`, ...extra })

// A unified diff of one file: each hunk is lines prefixed " ", "+" or "-".
function fileDiff(file: string, hunks: string[][]): string {
  return `diff --git a/${file} b/${file}\nindex 111..222 100644\n--- a/${file}\n+++ b/${file}\n` + hunks.map((lines, i) => {
    const old = lines.filter((l) => l[0] !== '+').length, now = lines.filter((l) => l[0] !== '-').length
    return `@@ -${1 + 100 * i},${old} +${1 + 100 * i},${now} @@\n${lines.join('\n')}\n`
  }).join('')
}
const hunksOf = (...diffs: string[]) => parseDiff(diffs.join(''))
const defaults = mergeConfig(undefined)
const sensitiveDevice = { regex: '\\bdevice\\.write\\(', name: 'device write' }
const withConfig = (c: object) => mergeConfig(RepoConfig.parse(c))
const ann = (groups: object[], extra: object = {}) => ({ version: 1, task: 't', groups, ...extra }) as unknown as Annotation

test('glob matcher: **, *, ?, braces, and bare names matching at any depth', () => {
  assert.ok(matchGlob('**/auth/**', 'src/auth/login.ts'))
  assert.ok(matchGlob('**/auth/**', 'auth/login.ts'))
  assert.ok(!matchGlob('**/auth/**', 'src/author/login.ts'))
  assert.ok(matchGlob('**/*.{spec,test}.*', 'a/b/x.test.ts') && matchGlob('**/*.{spec,test}.*', 'x.spec.js'))
  assert.ok(!matchGlob('**/*.{spec,test}.*', 'x.ts'))
  assert.ok(matchGlob('src/*.ts', 'src/a.ts') && !matchGlob('src/*.ts', 'src/x/a.ts'), '* does not cross a slash')
  assert.ok(matchGlob('a?c', 'abc') && !matchGlob('a?c', 'a/c'))
  assert.ok(matchGlob('Jenkinsfile', 'ci/Jenkinsfile'), 'no slash: any depth')
  assert.ok(!matchGlob('.github/workflows/**', 'sub/.github/workflows/ci.yml'), 'with a slash: anchored')
  assert.ok(matchGlob('**/openapi*.{yml,yaml,json}', 'api/openapi.v2.json'))
  assert.ok(matchGlob('x/{a,b/{c,d}}.ts', 'x/b/d.ts') && !matchGlob('x/{a,b/{c,d}}.ts', 'x/b.ts'), 'nested braces')
  assert.ok(matchGlob('a.b', 'a.b') && !matchGlob('a.b', 'axb'), 'dots are literal')
})

test('path classes from the built-in globs', () => {
  const c = (f: string) => pathClasses(defaults, f)
  assert.deepEqual(c('src/auth/login.ts'), ['sensitive'])
  assert.deepEqual(c('src/app.ts'), [])
  assert.deepEqual(c('src/app.test.ts'), ['test'])
  assert.deepEqual(c('docs/guide.txt'), ['docs'])
  assert.ok(c('package.json').includes('contract') && c('package.json').includes('manifest'))
  assert.ok(c('.github/workflows/ci.yml').includes('contract'))
  assert.deepEqual(c('src/__snapshots__/a.snap'), ['generated'])
  assert.deepEqual(c('db/migrations/001.sql'), ['sensitive'])
})

test('pattern hits come from changed lines only: a context line holding "password" never hits', () => {
  const [h] = hunksOf(fileDiff('src/login.ts', [[
    ' const password = read()', ' check(password)', '-run(1)', '+run(2)', ' // password stays', ' done()',
  ]]))
  const s = analyze([h], defaults).hunks[0]
  assert.deepEqual(s.hits, [], 'only context lines mention the secret')
  assert.equal(s.floor, 'module')

  const [h2] = hunksOf(fileDiff('src/login.ts', [[' a', '-const password = 1', '+const password = 2', ' b']]))
  const s2 = analyze([h2], defaults).hunks[0]
  assert.deepEqual(s2.hits.map((x) => [x.sign, x.line, x.class, x.damped]), [['-', 1, 'sensitive', false], ['+', 2, 'sensitive', false]], 'added and removed lines both hit')
  assert.equal(s2.floor, 'sensitive')

  // The @@ header can carry a function name; it is not matched either.
  const [h3] = hunksOf('diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@ function password() {\n-a\n+b\n c\n')
  assert.deepEqual(analyze([h3], defaults).hunks[0].hits, [])
})

test('test and docs paths damp pattern hits: reported, but not in the floor', () => {
  const body = [[' a', '+const password = 2', ' b']]
  const hs = hunksOf(fileDiff('src/login.test.ts', body), fileDiff('docs/login.md', body), fileDiff('src/login.ts', body))
  const s = analyze(hs, defaults).hunks
  assert.equal(s[0].hits.length, 1); assert.equal(s[0].hits[0].damped, true); assert.equal(s[0].floor, 'local')
  assert.equal(s[1].hits[0].damped, true); assert.equal(s[1].floor, 'local')
  assert.equal(s[2].hits[0].damped, false); assert.equal(s[2].floor, 'sensitive')
  // A test under a sensitive path stays capped; docs and tests cap at local.
  assert.equal(analyze(hunksOf(fileDiff('src/auth/x.test.ts', [['-a', '+b']])), defaults).hunks[0].floor, 'local')
})

test('a generated file is capped at local unless a pattern says otherwise', () => {
  const s = analyze(hunksOf(fileDiff('src/__snapshots__/a.snap', [['-a', '+b']]), fileDiff('src/__snapshots__/b.snap', [['-a', '+const password = 1']])), defaults).hunks
  assert.equal(s[0].floor, 'local')
  assert.equal(s[1].floor, 'sensitive', 'a pattern hit still counts in generated code')
})

const npmLock = (entries: Record<string, string>) => JSON.stringify({
  name: 'app', lockfileVersion: 3,
  packages: { '': { name: 'app', version: '1.0.0' }, ...Object.fromEntries(Object.entries(entries).map(([k, v]) => [`node_modules/${k}`, { version: v, resolved: `https://r.example/${k}/-/${k.split('/').pop()}-${v}.tgz`, integrity: 'sha512-x' }])) },
}, null, 2) + '\n'

test('package-lock.json: version bumps are parsed, and one no manifest names is flagged', () => {
  const dir = repo({ 'package.json': '{\n  "name": "app",\n  "version": "1.0.0"\n}\n', 'package-lock.json': npmLock({ 'some-pkg': '7.1.0', '@s/other': '2.0.0' }) })
  dir.write('package.json', '{\n  "name": "app",\n  "version": "1.0.0",\n  "devDependencies": {\n    "report-tool": "^1.0.0"\n  }\n}\n')
  dir.write('package-lock.json', npmLock({ 'some-pkg': '7.1.2', '@s/other': '2.0.0', 'report-tool': '1.0.0' }))
  dir.commit('add report-tool')
  const r = gloss(dir.dir, ['signals', 'HEAD', '--json'])
  assert.equal(r.code, 0, r.err)
  const sig = JSON.parse(r.out)
  const lock = sig.dependencies.find((d: { file: string }) => d.file === 'package-lock.json')
  assert.equal(lock.format, 'package-lock.json')
  assert.deepEqual(lock.bumps.filter((b: { kind: string }) => b.kind === 'bump'), [{ name: 'some-pkg', from: '7.1.0', to: '7.1.2', kind: 'bump', unrelated: true }])
  assert.ok(lock.bumps.some((b: { name: string; kind: string }) => b.name === 'report-tool' && b.kind === 'added'))
  assert.equal(sig.floor.impact, 'contract')
  assert.equal(sig.floor.attention, 'careful')
  assert.match(sig.floor.reasons.join('\n'), /package-lock\.json.*transitive bump: some-pkg 7\.1\.0 -> 7\.1\.2/)
  assert.ok(sig.dependencies.find((d: { file: string }) => d.file === 'package.json').kind === 'manifest')
})

test('package-lock.json: a bump whose key line is out of context is found by its resolved URL', () => {
  const hs = hunksOf(fileDiff('package-lock.json', [[
    '-      "version": "3.0.0",', '+      "version": "3.0.1",',
    '-      "resolved": "https://r.example/@s/pkg/-/pkg-3.0.0.tgz",', '+      "resolved": "https://r.example/@s/pkg/-/pkg-3.0.1.tgz",',
  ]]))
  const d = analyze(hs, defaults).dependencies[0]
  assert.deepEqual(d.bumps.map((b) => [b.name, b.from, b.to]), [['@s/pkg', '3.0.0', '3.0.1']])
})

test('pnpm-lock.yaml: version bumps, scoped packages and peer suffixes are parsed', () => {
  const hs = hunksOf(fileDiff('pnpm-lock.yaml', [[
    ' packages:', ' ',
    '-  some-pkg@7.1.0:', '-    resolution: {integrity: sha512-a}',
    '+  some-pkg@7.1.2:', '+    resolution: {integrity: sha512-b}',
    ' ',
    "-  '@scope/lib@1.0.0':", "+  '@scope/lib@1.1.0':",
    ' snapshots:',
    '-  some-pkg@7.1.0(peer@1.0.0):', '+  some-pkg@7.1.2(peer@1.0.0):',
    '+  brand-new@0.1.0:',
  ]]))
  const sig = analyze(hs, defaults)
  const d = sig.dependencies[0]
  assert.equal(d.format, 'pnpm-lock.yaml')
  assert.deepEqual(d.bumps.map((b) => [b.name, b.kind, b.from, b.to]).sort(), [
    ['@scope/lib', 'bump', '1.0.0', '1.1.0'], ['brand-new', 'added', null, '0.1.0'], ['some-pkg', 'bump', '7.1.0', '7.1.2'],
  ])
  assert.equal(sig.hunks[0].floor, 'contract')
})

test('other lockfiles are contract with no version detail', () => {
  const sig = analyze(hunksOf(fileDiff('Cargo.lock', [['-version = "1.0.0"', '+version = "1.0.1"']])), defaults)
  assert.equal(sig.hunks[0].floor, 'contract')
  assert.deepEqual(sig.dependencies.map((d) => [d.file, d.kind, d.format, d.bumps.length]), [['Cargo.lock', 'lockfile', null, 0]])
})

test('a lockfile is at least contract even when generated, and its pattern hits are damped', () => {
  const sig = analyze(hunksOf(fileDiff('yarn.lock', [['+"secret-lib@^1.0.0":', '+  version "1.0.0"']])), defaults)
  assert.equal(sig.hunks[0].floor, 'contract', 'a `secret` in a package name is not sensitive')
  assert.equal(sig.hunks[0].hits[0].damped, true)
})

test('stats: files, hunks, lines, test files and the share of hunks in tests', () => {
  const sig = analyze(hunksOf(fileDiff('a.ts', [['-x', '+y', '+z'], ['-q']]), fileDiff('a.test.ts', [['+t']]), fileDiff('b.test.ts', [['+t']])), defaults)
  assert.deepEqual(sig.stats, { files: 3, hunks: 4, added: 4, removed: 2, testFiles: 2, testHunks: 2, testHunkShare: 0.5 })
})

test('config: repo entries extend the defaults; "extends": false replaces a class', () => {
  const extended = withConfig({ paths: { sensitive: ['src/devices/**'], shared: ['libs/**'] }, patterns: { sensitive: [sensitiveDevice] } })
  assert.deepEqual(pathClasses(extended, 'src/devices/g.ts'), ['sensitive'])
  assert.deepEqual(pathClasses(extended, 'src/auth/g.ts'), ['sensitive'], 'defaults still apply')
  assert.deepEqual(pathClasses(extended, 'libs/x.ts'), ['shared'])
  assert.equal(extended.patterns.sensitive.length, 4)
  const replaced = withConfig({ paths: { sensitive: { extends: false, globs: ['src/devices/**'] } }, patterns: { sensitive: { extends: false, regexes: [sensitiveDevice] } } })
  assert.deepEqual(pathClasses(replaced, 'src/auth/g.ts'), [], 'default sensitive globs are gone')
  assert.deepEqual(pathClasses(replaced, 'src/devices/g.ts'), ['sensitive'])
  assert.deepEqual(replaced.patterns.sensitive.map((p) => p.name), ['device write'])
  assert.deepEqual(pathClasses(replaced, 'x.test.ts'), ['test'], 'other classes keep their defaults')
})

test('floor: path classes and configured patterns decide the hunk and the change', () => {
  const cfg = withConfig({ paths: { shared: ['libs/**'] }, patterns: { sensitive: [sensitiveDevice], contract: [{ regex: 'emit\\(', name: 'event' }] } })
  const s = analyze(hunksOf(
    fileDiff('src/a.ts', [['-a', '+b']]), fileDiff('libs/x.ts', [['-a', '+b']]), fileDiff('src/b.ts', [['+emit(1)']]),
    fileDiff('src/c.ts', [[' x', '+device.write(1)']]), fileDiff('README.md', [['+text']]),
  ), cfg)
  assert.deepEqual(s.hunks.map((h) => h.floor), ['module', 'shared', 'contract', 'sensitive', 'local'])
  assert.equal(s.floor.impact, 'sensitive')
  assert.equal(s.floor.attention, 'must-read')
  assert.match(s.floor.reasons[0], /sensitive: src\/c\.ts \(pattern: device write\)/)
})

// Derivation: groups over a synthetic change.
function derive(diffs: string[], groups: object[], cfg = defaults, attention?: object) {
  const hunks = hunksOf(...diffs)
  const a = ann(groups, attention ? { attention } : {})
  return analyzeGroups(hunks, groupInputsFor(a, hunks), cfg)
}
const code = (f = 'src/a.ts') => fileDiff(f, [['-a', '+b']])
const test_ = (f = 'src/a.test.ts') => fileDiff(f, [['+t']])

test('derivation: start from the highest group impact, then one step for each kind of risk, capped', () => {
  const tested = [group('feat', ['h1']), group('t', ['h2'], { necessity: 'supporting', serves: 'feat' })]
  assert.equal(derive([code(), test_()], tested).derived.level, 'look', 'module, tested')
  assert.equal(derive([code(), test_()], [group('feat', ['h1'], { impact: 'contract' }), tested[1]]).derived.level, 'careful', 'declared contract')
  assert.equal(derive([code(), test_()], [group('feat', ['h1'], { impact: 'local' }), tested[1]]).derived.level, 'look', 'declared local, but the floor of source code is look')
  assert.equal(derive([fileDiff('docs/a.md', [['+x']])], [group('d', ['h1'], { impact: 'local' })]).derived.level, 'skim')
  // Untested behaviour change: one step.
  const untested = derive([code()], [group('feat', ['h1'])]).derived
  assert.equal(untested.level, 'careful')
  assert.match(untested.reasons.join('\n'), /behaviour change without a test serving it: feat/)
  // Several raising rules still raise one step only.
  const hedged = derive([code(), code('src/b.ts')], [group('a', ['h1'], { necessity: 'speculative' }), group('b', ['h2'], { necessity: 'defensive' })]).derived
  assert.equal(hedged.level, 'careful', 'look + one step, not two')
  // Cap at must-read.
  assert.equal(derive([code()], [group('feat', ['h1'], { impact: 'sensitive' })]).derived.level, 'must-read')
  assert.equal(derive([code()], [group('feat', ['h1'], { impact: 'contract' })]).derived.level, 'must-read', 'careful + untested')
})

test('derivation: what counts as behaviour-changing and as served by tests', () => {
  const lvl = (diffs: string[], groups: object[]) => derive(diffs, groups).derived.level
  // Mechanical groups, and groups of only tests or docs, are not behaviour-changing.
  assert.equal(lvl([code()], [group('m', ['h1'], { necessity: 'mechanical' })]), 'look')
  assert.equal(lvl([test_()], [group('t', ['h1'])]), 'skim')
  // A test group that serves "task" does not serve the group; one that names it does, even through a chain.
  assert.equal(lvl([code(), test_()], [group('a', ['h1']), group('t', ['h2'], { necessity: 'supporting', serves: 'task' })]), 'careful')
  assert.equal(lvl([code(), code('src/b.ts'), test_()], [
    group('a', ['h1']), group('helper', ['h2'], { necessity: 'supporting', serves: 'a' }), group('t', ['h3'], { necessity: 'supporting', serves: 'helper' }),
  ]), 'look', 'tests serve the helper, which serves a')
  // A group that mixes code and tests is not a test group.
  assert.equal(lvl([code(), test_()], [group('a', ['h1']), group('mixed', ['h1', 'h2'], { necessity: 'supporting', serves: 'a' })]), 'careful')
  // Speculative or defensive code outside tests; inside tests it does not count.
  assert.equal(lvl([test_()], [group('t', ['h1'], { necessity: 'speculative' })]), 'skim')
  assert.equal(lvl([code(), test_()], [group('s', ['h1'], { necessity: 'speculative', serves: 'task' }), group('t', ['h2'], { necessity: 'supporting', serves: 's' })]), 'careful')
})

test('derivation: more than largeChangeFiles files raises a step, and never below the floor', () => {
  const many = Array.from({ length: 4 }, (_, i) => code(`src/f${i}.ts`))
  const groups = [group('all', ['h1', 'h2', 'h3', 'h4']), group('t', ['h5'], { necessity: 'supporting', serves: 'all' })]
  const diffs = [...many, test_()]
  assert.equal(derive(diffs, groups).derived.level, 'look')
  const cfg = withConfig({ attention: { largeChangeFiles: 3 } })
  const big = derive(diffs, groups, cfg)
  assert.equal(big.derived.level, 'careful')
  assert.equal(big.floor, 'careful', 'a large change is at least careful')
  assert.match(big.derived.reasons.join('\n'), /5 files changed \(more than 3\)/)
  // Declared impact lower than the diff says: the floor wins.
  const device = withConfig({ patterns: { sensitive: [sensitiveDevice] } })
  const low = derive([fileDiff('src/g.ts', [['+device.write(1)']]), test_()], [group('g', ['h1'], { impact: 'local' }), group('t', ['h2'], { necessity: 'supporting', serves: 'g' })], device)
  assert.equal(low.derived.level, 'must-read')
  assert.match(low.derived.reasons.join('\n'), /floor must-read/)
})

test('group floors use the changed lines a group claims, not the whole hunk', () => {
  const cfg = withConfig({ patterns: { sensitive: [sensitiveDevice] } })
  const hunks = hunksOf(fileDiff('src/new.ts', [['+const a = 1', '+device.write(a)', '+const b = 2']]))
  const a = ann([group('hw', ['h1:2']), group('rest', ['h1:1,3'])])
  const an = analyzeGroups(hunks, groupInputsFor(a, hunks), cfg)
  assert.equal(an.groups.get('hw')!.floor, 'sensitive')
  assert.equal(an.groups.get('rest')!.floor, 'module')
  assert.equal(an.floor, 'must-read')
})

test('ratingProblems: group impact below its floor warns naming the signal; attention below it is an error unless explained', () => {
  const cfg = withConfig({ patterns: { sensitive: [sensitiveDevice] } })
  const hunks = hunksOf(fileDiff('src/g.ts', [['+device.write(1)']]))
  const check = (extra: object, g: object = {}) => {
    const a = ann([group('hw', ['h1'], g)], extra)
    return ratingProblems(a, analyzeGroups(hunks, groupInputsFor(a, hunks), cfg))
  }
  const warned = check({}, { impact: 'module' })
  assert.equal(warned.warnings.length, 1)
  assert.match(warned.warnings[0], /group "hw".*"module".*"sensitive".*src\/g\.ts: pattern: device write/)
  assert.equal(check({}).underrated, null, 'nothing declared is allowed')
  assert.match(check({ attention: { level: 'careful' } }).underrated!, /"careful" is below the computed floor "must-read".*device write/)
  assert.equal(check({ attention: { level: 'careful', override_reason: 'wrapper only' } }).underrated, null)
  assert.equal(check({ attention: { level: 'must-read' } }).underrated, null)
  assert.deepEqual(check({}, { impact: 'local' }).warnings.length, 1, 'local is below sensitive')
})

test('config errors name the file and the key; add and signals fail clearly, not with a stack trace', () => {
  const r = repo()
  r.write('app.js', 'run2()\n')
  r.commit('change')
  const cases: [string, string | object, RegExp][] = [
    ['not json', '{ nope', /\.gloss\/config\.json is not valid JSON/],
    ['unknown key', { pahts: {} }, /\.gloss\/config\.json is not a valid git-gloss config[\s\S]*\(top level\).*"pahts"/],
    ['bad regex', { patterns: { sensitive: ['ok', '(unclosed'] } }, /patterns\.sensitive\.1: invalid regular expression "\(unclosed"/],
    ['bad glob', { paths: { test: ['a/{b'] } }, /paths\.test\.0: invalid glob "a\/\{b": unclosed/],
    ['bad type', { attention: { largeChangeFiles: 'many' } }, /attention\.largeChangeFiles/],
    ['unknown class', { paths: { weird: ['x'] } }, /paths: .*"weird"/],
  ]
  for (const [name, content, re] of cases) {
    r.write('.gloss/config.json', typeof content === 'string' ? content : JSON.stringify(content))
    for (const args of [['signals', 'HEAD'], ['hunks', 'HEAD']]) {
      const out = gloss(r.dir, args)
      if (args[0] === 'signals') { assert.equal(out.code, 1, name); assert.match(out.err, re, name); assert.doesNotMatch(out.err, /\bat .*\.ts:\d+/, 'no stack trace') }
      else { assert.equal(out.code, 0, 'hunks still works'); assert.match(out.err, /warning: signals unavailable/, name) }
    }
    const add = gloss(r.dir, ['add', '--force'], JSON.stringify({ task: 't', groups: [group('a', ['h1'])] }))
    assert.equal(add.code, 1, name)
    assert.match(add.err, re, name)
    assert.doesNotMatch(add.err, /\bat .*\.ts:\d+/)
  }
})

test('git config overrides the scalar settings', () => {
  const r = repo()
  r.write('app.js', 'run2()\n')
  r.write('util.js', 'export const a = 2\n')
  const reasons = () => JSON.parse(gloss(r.dir, ['signals', 'wip', '--json']).out).floor
  assert.equal(reasons().attention, 'look')
  r.config({ attention: { largeChangeFiles: 10 } })
  r.g('config', 'gloss.attention.largeChangeFiles', '1')
  const f = reasons()
  assert.equal(f.attention, 'careful')
  assert.match(f.reasons.join(), /\d files changed \(more than 1\)/, 'git config beats the repo file')
  r.g('config', 'gloss.attention.largeChangeFiles', 'lots')
  assert.match(gloss(r.dir, ['signals', 'wip']).err, /gloss\.attention\.largeChangeFiles must be a positive integer/)
})

// The data of the page `html` wrote.
const pageData = (file: string) => JSON.parse(/<script type="application\/json" id="gloss-data">(.*?)<\/script>/s.exec(readFileSync(file, 'utf8'))![1])

// ---- add: under-rating ----

function lockRepo() {
  const r = repo({ 'package-lock.json': npmLock({ 'some-pkg': '7.1.0' }), 'app.js': 'run()\n' })
  r.write('package-lock.json', npmLock({ 'some-pkg': '7.1.2' }))
  r.write('app.js', 'run2()\n')
  r.commit('bump')
  return r
}
const addArgs = (extra: string[], groups: object[], attention?: object): [string[], string] =>
  [['add', ...extra], JSON.stringify({ task: 't', groups, ...(attention ? { attention } : {}) })]

test('add: a group impact below its floor warns; attention below the floor is an error', () => {
  const { dir } = lockRepo()
  const groups = [group('lock', ['h2'], { necessity: 'mechanical', impact: 'local' }), group('code', ['h1'], { impact: 'module' })]
  let r = gloss(dir, ...addArgs(['--dry-run'], groups))
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /warning: group "lock" is rated impact "local" but its floor is "contract" \(package-lock\.json: lockfile\)/)
  assert.doesNotMatch(r.err, /group "code"/, 'module is the baseline for source code, not a signal')

  r = gloss(dir, ...addArgs(['--dry-run'], groups, { level: 'look', focus: ['code'] }))
  assert.equal(r.code, 1)
  assert.match(r.err, /attention\.level "look" is below the computed floor "careful" \(contract: package-lock\.json.*transitive bump: some-pkg 7\.1\.0 -> 7\.1\.2/)
  assert.match(r.err, /attention\.override_reason/)

  r = gloss(dir, ...addArgs(['--dry-run'], groups, { level: 'look', override_reason: 'the bump is a patch of a dev-only package' }))
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.err, /below the computed floor/)

  r = gloss(dir, ...addArgs(['--dry-run', '--allow-underrate'], groups, { level: 'look' }))
  assert.equal(r.code, 0, r.err)
  assert.match(r.err, /warning: attention\.level "look" is below the computed floor "careful"/)

  r = gloss(dir, ...addArgs([], groups, { level: 'careful', focus: ['lock'] }))
  assert.equal(r.code, 0, r.err)
  assert.doesNotMatch(r.err, /below the computed floor/)
})

test('an override_reason stays visible in show and html, with the floor and a mismatch flag', () => {
  const { dir } = lockRepo()
  const groups = [group('lock', ['h2'], { necessity: 'mechanical' }), group('code', ['h1'])]
  assert.equal(gloss(dir, ...addArgs([], groups, { level: 'look', override_reason: 'patch of a dev-only package' })).code, 0)
  const show = gloss(dir, ['show']).out
  assert.match(show, /attention: LOOK \(declared\) · floor: careful/)
  assert.match(show, /declared look, below the computed floor careful/)
  assert.match(show, /override: patch of a dev-only package/)
  assert.doesNotMatch(show, /\(no override_reason\)/)
  const out = join(dir, 'v.html')
  gloss(dir, ['html', '-o', out])
  const page = pageData(out)
  assert.deepEqual(page.commits[0].computed.floor, 'careful')
  assert.equal(page.commits[0].computed.below, true)
  const byId = Object.fromEntries(page.commits[0].groups.map((g: { id: string }) => [g.id, g]))
  assert.equal(byId.lock.impact_derived, 'contract', 'the diff puts a group above module: derived badges, like show')
  assert.equal(byId.code.impact_derived, 'module')
  assert.equal(page.commits[0].attention.override_reason, 'patch of a dev-only package')
})

test('back-compat: an old gloss without impact or attention still adds, shows a derived attention and html data', () => {
  const r = repo()
  r.write('app.js', 'run2()\n')
  r.commit('x')
  assert.equal(gloss(r.dir, ['add'], JSON.stringify({ task: 't', groups: [group('a', ['h1'])] })).code, 0)
  const show = gloss(r.dir, ['show'])
  assert.match(show.out, /attention: CAREFUL \(derived\)/)
  assert.doesNotMatch(show.out, /unrated/)
  assert.doesNotMatch(show.out, /\((module|local)\)/, 'no impact column for plain glosses')
  const out = join(r.dir, 'v.html')
  gloss(r.dir, ['html', '-o', out])
  const page = pageData(out)
  assert.equal(page.commits[0].attention, null)
  assert.equal(page.commits[0].computed.derived.level, 'careful')
  assert.equal(page.commits[0].groups[0].impact_derived, undefined, 'a plain gloss gets no derived impact badges, as in show')
})

test('show marks derived impact and attention; unrated remains where signals cannot be computed', () => {
  const r = lockRepo()
  assert.equal(gloss(r.dir, ...addArgs([], [group('lock', ['h2'], { necessity: 'mechanical' }), group('code', ['h1'])])).code, 0)
  const show = gloss(r.dir, ['show']).out
  assert.match(show, /attention: MUST-READ \(derived\) · floor: careful/)
  assert.match(show, /highest group impact: contract \(lock, from the diff\)/)
  assert.match(show, /mechanical +\(contract\) +lock/)
  assert.match(show, /impact in parentheses is derived/)
  // A malformed config: no signals, so unrated.
  r.write('.gloss/config.json', '{ bad')
  const bad = gloss(r.dir, ['show'])
  assert.match(bad.out, /attention: unrated/)
  assert.match(bad.err, /warning: signals unavailable/)
})

test('hunks ends with the signals summary', () => {
  const r = repo({ 'package-lock.json': npmLock({ 'some-pkg': '7.1.0' }), 'src/devices/gauge.ts': 'x()\n', 'app.js': 'run()\n' })
  r.config({ paths: { sensitive: ['src/devices/**'] }, patterns: { sensitive: [sensitiveDevice] } })
  r.write('package-lock.json', npmLock({ 'some-pkg': '7.1.2' }))
  r.write('src/devices/gauge.ts', 'device.write(1)\n')
  r.write('app.js', 'run2()\n')
  const out = gloss(r.dir, ['hunks', 'wip']).out
  const tail = out.slice(out.indexOf('signals:'))
  assert.match(tail, /^signals: floor attention = must-read$/m)
  assert.match(tail, /^ {2}sensitive: src\/devices\/gauge\.ts \(path: sensitive; pattern: device write\)$/m)
  assert.match(tail, /^ {2}contract: {2}package-lock\.json \(lockfile; transitive bump: some-pkg 7\.1\.0 -> 7\.1\.2\)$/m)
  assert.match(tail, /^ {2}stats: 4 files, 4 hunks, \+\d+ -\d+, 0 test files/m)
  assert.doesNotMatch(gloss(r.dir, ['hunks', 'wip', '--json']).out, /signals/, '--json is unchanged')
})

test('signals text and json for a commit, a range and wip', () => {
  const r = repo()
  r.write('app.js', 'const password = 1\n')
  const text = gloss(r.dir, ['signals', 'wip'])
  assert.equal(text.code, 0, text.err)
  assert.match(text.out, /floor attention = must-read/)
  assert.match(text.out, /h1 .*sensitive/)
  assert.equal(JSON.parse(gloss(r.dir, ['signals', 'wip', '--json']).out).floor.attention, 'must-read')
  const c = r.commit('pw')
  assert.equal(JSON.parse(gloss(r.dir, ['signals', c.slice(0, 7), '--json']).out).stats.hunks, 1)
  assert.equal(JSON.parse(gloss(r.dir, ['signals', 'main~1..main', '--json']).out).hunks[0].hits[0].name, 'secret or credential')
  assert.equal(gloss(r.dir, ['signals', 'wip']).code, 1, 'no uncommitted changes')
})

// ---- the four calibration fixtures of the design brief (§9) ----

test('fixture: CI chore with a lockfile that also bumps an unrelated package -> careful, both surfaced', () => {
  const r = repo({
    '.nvmrc': '20\n', '.gitignore': 'node_modules\n', 'package.json': '{\n  "name": "app"\n}\n',
    'package-lock.json': npmLock({ 'some-pkg': '7.1.0' }), '.github/workflows/ci.yml': 'steps:\n  - run: test\n',
  })
  r.write('.nvmrc', '22\n')
  r.write('.gitignore', 'node_modules\nreports\n')
  r.write('package.json', '{\n  "name": "app",\n  "devDependencies": {\n    "report-tool": "^1.0.0"\n  }\n}\n')
  r.write('package-lock.json', npmLock({ 'some-pkg': '7.1.2', 'report-tool': '1.0.0', 'report-dep': '2.0.0' }))
  r.write('.github/workflows/ci.yml', 'steps:\n  - run: test\n  - run: publish-results\n')
  r.commit('ci chore')
  const sig = JSON.parse(gloss(r.dir, ['signals', 'HEAD', '--json']).out)
  assert.equal(sig.floor.attention, 'careful')
  assert.deepEqual(sig.files.filter((f: { floor: string }) => f.floor === 'contract').map((f: { file: string }) => f.file).sort(), ['.github/workflows/ci.yml', 'package-lock.json', 'package.json'])
  assert.ok(sig.dependencies.find((d: { file: string }) => d.file === 'package-lock.json').bumps.some((b: { name: string; unrelated: boolean }) => b.name === 'some-pkg' && b.unrelated))
  // Declared look needs an override_reason; careful is fine.
  const groups = [group('chore', ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'].slice(0, sig.stats.hunks), { necessity: 'mechanical' })]
  assert.equal(gloss(r.dir, ...addArgs(['--dry-run'], groups, { level: 'look' })).code, 1)
  assert.equal(gloss(r.dir, ...addArgs(['--dry-run'], groups, { level: 'look', override_reason: 'pins and a dev dependency' })).code, 0)
  assert.equal(gloss(r.dir, ...addArgs(['--dry-run'], groups, { level: 'careful' })).code, 0)
})

test('fixture: bug fixes with a configured device write -> must-read; the untested group is flagged', () => {
  const r = repo({ 'src/shared-lib/service.ts': 'export const f = () => 1\n', 'src/devices/gauge.ts': 'set(x)\n', 'src/ui/label.ts': 'export const t = "Sav"\n', 'src/devices/gauge.test.ts': 'test(1)\n' })
  r.config({ paths: { shared: ['src/shared-lib/**'] }, patterns: { sensitive: [sensitiveDevice] } })
  r.commit('config')
  r.write('src/shared-lib/service.ts', 'export const f = () => 2\n')
  r.write('src/devices/gauge.ts', 'device.write(brightness)\n')
  r.write('src/ui/label.ts', 'export const t = "Save"\n')
  r.write('src/devices/gauge.test.ts', 'test(2)\n')
  r.commit('fixes')
  const sig = JSON.parse(gloss(r.dir, ['signals', 'HEAD', '--json']).out)
  assert.equal(sig.floor.attention, 'must-read')
  const dev = sig.hunks.find((h: { file: string }) => h.file === 'src/devices/gauge.ts')
  assert.equal(dev.floor, 'sensitive')
  assert.deepEqual(dev.hits.map((x: { name: string }) => x.name), ['device write'])
  assert.equal(sig.hunks.find((h: { file: string }) => h.file === 'src/shared-lib/service.ts').floor, 'shared')
  // hunks are listed in path order: devices/gauge.test, devices/gauge, shared-lib, ui
  const ids = Object.fromEntries(sig.hunks.map((h: { file: string; id: string }) => [h.file, h.id]))
  const groups = [
    group('gauge-fix', [ids['src/devices/gauge.ts']]),
    group('service-fix', [ids['src/shared-lib/service.ts']]),
    group('label-fix', [ids['src/ui/label.ts']]),
    group('gauge-test', [ids['src/devices/gauge.test.ts']], { necessity: 'supporting', serves: ['gauge-fix', 'service-fix'] }),
  ]
  assert.equal(gloss(r.dir, ...addArgs([], groups)).code, 0)
  const show = gloss(r.dir, ['show']).out
  assert.match(show, /attention: MUST-READ \(derived\)/)
  assert.match(show, /behaviour change without a test serving it: label-fix\n/, 'only the untested group is flagged')
  assert.match(show, /\[?\(?sensitive\)? +gauge-fix/)
  // careful would be under-rated; must-read passes.
  assert.equal(gloss(r.dir, ...addArgs(['--force'], groups, { level: 'careful' })).code, 1)
  assert.equal(gloss(r.dir, ...addArgs(['--force'], groups, { level: 'must-read', focus: ['gauge-fix'] })).code, 0)
})

test('fixture: a lint gate over many files; a configured event pattern flags the renamed declarations', () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 60; i++) files[`src/c${i}.ts`] = `const a${i} = 1\n`
  files['src/button.ts'] = "events.emit('pressed')\n"
  files['src/menu.ts'] = "events.emit('opened')\n"
  const r = repo(files)
  for (let i = 0; i < 60; i++) r.write(`src/c${i}.ts`, `const a${i} = 1;\n`)
  r.write('src/button.ts', "events.emit('press')\n")
  r.write('src/menu.ts', "events.emit('open')\n")
  r.commit('lint')
  const plain = JSON.parse(gloss(r.dir, ['signals', 'HEAD', '--json']).out)
  assert.equal(plain.stats.files, 62)
  assert.equal(plain.floor.attention, 'careful', 'many files alone make it careful')
  assert.equal(plain.hunks.flatMap((h: { hits: unknown[] }) => h.hits).length, 0, 'nothing flags the renames without a configured pattern')

  r.config({ patterns: { contract: [{ regex: 'events\\.emit\\(', name: 'component event' }] } })
  const sig = JSON.parse(gloss(r.dir, ['signals', 'HEAD', '--json']).out)
  assert.equal(sig.floor.attention, 'careful')
  assert.equal(sig.floor.impact, 'contract')
  const hits = sig.hunks.flatMap((h: { file: string; hits: { sign: string; class: string }[] }) => h.hits.map((x) => [h.file, x.sign, x.class]))
  assert.deepEqual(hits.sort(), [
    ['src/button.ts', '+', 'contract'], ['src/button.ts', '-', 'contract'], ['src/menu.ts', '+', 'contract'], ['src/menu.ts', '-', 'contract'],
  ], 'pattern hits on the removed and added lines of the renamed declarations')
  assert.equal(sig.hunks.filter((h: { floor: string }) => h.floor === 'contract').length, 2, 'the other 60 hunks stay module')
  // Declaring skim is an error; careful is accepted.
  const groups = [group('all', Array.from({ length: 62 }, (_, i) => `h${i + 1}`), { impact: 'contract', impact_reason: 'renames component events' })]
  assert.equal(gloss(r.dir, ...addArgs(['--dry-run'], groups, { level: 'skim' })).code, 1)
  assert.equal(gloss(r.dir, ...addArgs(['--dry-run'], groups, { level: 'careful', focus: ['all'] })).code, 0)
})

test('fixture: docs-only changes (markdown and screenshots) -> skim', () => {
  const r = repo({ 'README.md': '# a\n', 'docs/guide.md': 'x\n', 'docs/shot.png': 'old-binary\n' })
  r.write('README.md', '# b\n')
  r.write('docs/guide.md', 'y\n')
  r.write('docs/shot.png', 'new-binary\n')
  r.commit('docs')
  const sig = JSON.parse(gloss(r.dir, ['signals', 'HEAD', '--json']).out)
  assert.equal(sig.floor.attention, 'skim')
  assert.equal(sig.floor.impact, 'local')
  assert.deepEqual(sig.floor.reasons, [])
  const groups = [group('docs', sig.hunks.map((h: { id: string }) => h.id), { necessity: 'mechanical' })]
  assert.equal(gloss(r.dir, ...addArgs([], groups, { level: 'skim' })).code, 0)
  assert.match(gloss(r.dir, ['show']).out, /attention: SKIM \(declared\) · floor: skim/)
})

test('performance: signals over 800+ hunks finishes within a few seconds', () => {
  const diffs: string[] = []
  for (let f = 0; f < 90; f++) {
    diffs.push(fileDiff(`src/m${f}/file${f}.ts`, Array.from({ length: 10 }, (_, i) => [' ctx', `-const password${i} = 1`, `+const password${i} = 2`, ' // more context', '+const x = 1'])))
  }
  const hunks = hunksOf(...diffs)
  assert.equal(hunks.length, 900)
  const t = performance.now()
  const sig = analyze(hunks, defaults)
  const ms = performance.now() - t
  assert.equal(sig.hunks.length, 900)
  assert.ok(ms < 3000, `analyze took ${Math.round(ms)}ms`)
  console.log(`# analyze of ${hunks.length} hunks: ${Math.round(ms)}ms`)
})

test('a pattern with the g or y flag still hits every changed line', () => {
  const cfg = withConfig({ patterns: { sensitive: [{ regex: 'device\\.write\\(', name: 'device write', flags: 'gi' }, { regex: 'device\\.write\\(', name: 'sticky', flags: 'y' }] } })
  const hs = hunksOf(fileDiff('src/g.ts', [['+device.write(1)', '+device.write(2)', '+device.write(3)']]))
  const hits = analyze(hs, cfg).hunks[0].hits
  assert.equal(hits.filter((x) => x.name === 'device write').length, 3)
  assert.equal(hits.filter((x) => x.name === 'sticky').length, 3, 'y is dropped too, so it matches anywhere in the line')
})
