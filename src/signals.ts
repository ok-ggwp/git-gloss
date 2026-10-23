import { basename } from 'node:path'
import type { Hunk } from './diff.ts'
import { bodyLines } from './selection.ts'
import type { AttentionLevel, Impact } from './schema.ts'
import { attentionForImpact, impactRank, maxAttention, maxImpact } from './attention.ts'
import { PATH_CLASSES, PATTERN_CLASSES, type Config, type PathClass, type PatternClass } from './config.ts'
import { globToRegExp } from './glob.ts'

// Computed signals: what the diff itself says about how much attention it
// deserves, from path globs and line patterns in the config (no knowledge of
// any language or tool). All of it is computed on read, never stored in a note.

export type PatternHit = {
  class: PatternClass
  name: string
  // The hit's changed-line number in the hunk (as `hunks` numbers them), and
  // whether the line was added or removed.
  line: number
  sign: '+' | '-'
  text: string
  // Test, docs and lockfile paths damp hits: still reported, never raise the floor.
  damped: boolean
}

export type HunkSignals = {
  id: string
  file: string
  oldFile: string | null
  classes: PathClass[]
  hits: PatternHit[]
  // The floor from the path alone, and with pattern hits (all of them).
  pathFloor: Impact
  pathWhy: string[]
  floor: Impact
  // The signals that set the floor, e.g. "path: sensitive", "pattern: device write".
  why: string[]
  // Tests, docs, generated files and lockfiles: changes that don't change behaviour themselves (a manifest edit is not inert).
  inert: boolean
  test: boolean
}

export type Bump = {
  name: string
  from: string | null
  to: string | null
  kind: 'bump' | 'added' | 'removed'
  // A bump of a package that no manifest change in this diff names.
  unrelated: boolean
}

export type DependencyChange = {
  file: string
  kind: 'lockfile' | 'manifest'
  // Only for package-lock.json and pnpm-lock.yaml; other files give no detail.
  format: string | null
  bumps: Bump[]
}

export type FileSignals = {
  file: string
  classes: PathClass[]
  hunks: string[]
  added: number
  removed: number
  floor: Impact
  why: string[]
}

export type Stats = {
  files: number
  hunks: number
  added: number
  removed: number
  testFiles: number
  testHunks: number
  testHunkShare: number
}

export type ChangeSignals = {
  stats: Stats
  hunks: HunkSignals[]
  files: FileSignals[]
  dependencies: DependencyChange[]
  floor: { impact: Impact; attention: AttentionLevel; reasons: string[] }
}

const compiled = new WeakMap<Config, Record<PathClass, RegExp[]>>()
function pathMatchers(cfg: Config): Record<PathClass, RegExp[]> {
  let m = compiled.get(cfg)
  if (!m) {
    m = {} as Record<PathClass, RegExp[]>
    for (const c of PATH_CLASSES) m[c] = cfg.paths[c].map(globToRegExp)
    compiled.set(cfg, m)
  }
  return m
}

export function pathClasses(cfg: Config, ...files: (string | null)[]): PathClass[] {
  const m = pathMatchers(cfg)
  const out = new Set<PathClass>()
  for (const f of files) {
    if (!f) continue
    for (const c of PATH_CLASSES) if (m[c].some((re) => re.test(f))) out.add(c)
  }
  // Dependency files are interfaces whatever the globs say.
  if ((out.has('lockfile') || out.has('manifest')) && !out.has('sensitive')) out.add('contract')
  return PATH_CLASSES.filter((c) => out.has(c))
}

// The floor from the path alone, and what set it.
//  - lockfile: at least contract, even if generated.
//  - test, docs, generated or manifest-in-test: capped at local (the cap wins over path classes like sensitive).
//  - otherwise the highest of sensitive > contract > shared, else module.
function pathFloor(classes: PathClass[]): { floor: Impact; why: string[] } {
  const has = (c: PathClass) => classes.includes(c)
  const top = (['sensitive', 'contract', 'shared'] as const).find(has)
  if (has('lockfile')) return has('sensitive') ? { floor: 'sensitive', why: ['path: sensitive', 'lockfile'] } : { floor: 'contract', why: ['lockfile'] }
  if (has('test') || has('docs') || has('generated')) return { floor: 'local', why: [] }
  if (top) return { floor: top, why: [`path: ${top}${has('manifest') ? ' (manifest)' : ''}`] }
  return { floor: 'module', why: [] }
}

const clip = (s: string) => (s.length > 120 ? s.slice(0, 117) + '...' : s.trim())

export function hunkSignals(h: Hunk, cfg: Config): HunkSignals {
  const classes = pathClasses(cfg, h.file, h.oldFile)
  const { floor: pFloor, why: pWhy } = pathFloor(classes)
  const damped = classes.includes('test') || classes.includes('docs') || classes.includes('lockfile')
  const hits: PatternHit[] = []
  // Only added and removed lines: never context, never the @@ header.
  if (h.text.startsWith('@@') && (h.added || h.removed)) {
    for (const l of bodyLines(h)) {
      if (l.idx === null || l.kind === 'ctx' || l.kind === 'meta') continue
      const text = l.raw.slice(1)
      for (const c of PATTERN_CLASSES) {
        for (const p of cfg.patterns[c]) {
          if (p.re.test(text)) hits.push({ class: c, name: p.name, line: l.idx, sign: l.kind === 'add' ? '+' : '-', text: clip(text), damped })
        }
      }
    }
  }
  const { floor, why } = floorFrom(pFloor, pWhy, hits, null)
  const inert = classes.includes('test') || classes.includes('docs') || classes.includes('generated') || classes.includes('lockfile')
  return { id: h.id, file: h.file, oldFile: h.oldFile, classes, hits, pathFloor: pFloor, pathWhy: pWhy, floor, why, inert, test: classes.includes('test') }
}

// The floor from a path floor and the pattern hits: damped hits never count,
// and with `lines` only hits on those changed lines do. `why` names what set
// it; the path's reasons stand only while the path itself sets the floor.
function floorFrom(pFloor: Impact, pWhy: string[], hits: PatternHit[], lines: Set<number> | null): { floor: Impact; why: string[] } {
  let floor = pFloor
  const live = hits.filter((x) => !x.damped && (!lines || lines.has(x.line)))
  for (const x of live) floor = maxImpact(floor, x.class)
  const names = [...new Set(live.filter((x) => x.class === floor).map((x) => `pattern: ${x.name}`))]
  return { floor, why: floor === pFloor ? [...pWhy, ...names.filter((n) => !pWhy.includes(n))] : names }
}

// The floor of a part of a hunk (a group's lines of it); all of it when null.
export function partFloor(s: HunkSignals, lines: Set<number> | null): { floor: Impact; why: string[] } {
  return lines ? floorFrom(s.pathFloor, s.pathWhy, s.hits, lines) : { floor: s.floor, why: s.why }
}

// ---- dependency changes ----

const NPM_KEY = /^\s*"(node_modules\/[^"]+)":\s*\{\s*$/
const NPM_VERSION = /^\s*"version":\s*"([^"]+)"/
const NPM_RESOLVED = /^\s*"resolved":\s*"[^"]*?\/((?:@[^/"]+\/)?[^/"]+)\/-\/[^"]*"/

type Seen = Map<string, { name: string; version: string }>

function parsePackageLock(hunks: Hunk[]): { old: Seen; now: Seen } {
  const old: Seen = new Map(), now: Seen = new Map()
  for (const h of hunks) {
    const lines = bodyLines(h)
    let key: string | null = null
    lines.forEach((l, i) => {
      if (l.kind === 'meta') return
      const body = l.raw.slice(1)
      const k = NPM_KEY.exec(body)
      if (k) { key = k[1]; return }
      const v = NPM_VERSION.exec(body)
      if (!v || l.kind === 'ctx') return
      // The entry's key is usually the line above (context or changed); else
      // the package's name is in the `resolved` URL a few lines below.
      let id = key
      let name = id ? id.slice(id.lastIndexOf('node_modules/') + 'node_modules/'.length) : null
      if (!id) {
        for (const n of lines.slice(i + 1, i + 5)) {
          const r = n.kind === 'meta' ? null : NPM_RESOLVED.exec(n.raw.slice(1))
          if (r) { name = r[1]; id = `?${r[1]}`; break }
        }
      }
      if (!id || !name) return
      ;(l.kind === 'del' ? old : now).set(id, { name, version: v[1] })
    })
  }
  return { old, now }
}

const PNPM_KEY = [
  // packages and snapshots: "/name@1.2.3:", "name@1.2.3(peer@1):", "'@scope/name@1.2.3':"
  /^\s+['"]?\/?(@[^/@\s'"]+\/[^@\s'"]+|[^@\s'"/]+)@(\d[^\s'"(:]*)[^:]*?['"]?:\s*$/,
  // older format: "/name/1.2.3:", "/@scope/name/1.2.3_peer:"
  /^\s+\/(@[^/\s]+\/[^/\s]+|[^/\s@]+)\/(\d[^\s:_]*)[^:]*:\s*$/,
]

function parsePnpmLock(hunks: Hunk[]): { old: Seen; now: Seen } {
  const old: Seen = new Map(), now: Seen = new Map()
  for (const h of hunks) {
    for (const l of bodyLines(h)) {
      if (l.kind !== 'add' && l.kind !== 'del') continue
      const body = l.raw.slice(1)
      for (const re of PNPM_KEY) {
        const m = re.exec(body)
        if (m) { (l.kind === 'del' ? old : now).set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2] }); break }
      }
    }
  }
  return { old, now }
}

// Pair removed and added entries into bumps. By identity (npm: the entry's
// path) when both sides have it; for pnpm, entries are name@version, so a
// name with removed and added versions is a bump of those.
function diffSeen(old: Seen, now: Seen, byName: boolean): Omit<Bump, 'unrelated'>[] {
  const out: Omit<Bump, 'unrelated'>[] = []
  if (!byName) {
    for (const [id, n] of now) {
      const o = old.get(id)
      if (!o) out.push({ name: n.name, from: null, to: n.version, kind: 'added' })
      else if (o.version !== n.version) out.push({ name: n.name, from: o.version, to: n.version, kind: 'bump' })
    }
    for (const [id, o] of old) if (!now.has(id)) out.push({ name: o.name, from: o.version, to: null, kind: 'removed' })
    return out
  }
  const group = (m: Seen) => {
    const g = new Map<string, string[]>()
    for (const e of m.values()) g.set(e.name, [...(g.get(e.name) ?? []), e.version])
    return g
  }
  const o = group(old), n = group(now)
  for (const [name, to] of n) {
    const from = (o.get(name) ?? []).filter((v) => !to.includes(v))
    const added = to.filter((v) => !(o.get(name) ?? []).includes(v))
    if (!o.has(name)) out.push({ name, from: null, to: to.join(', '), kind: 'added' })
    else if (added.length) out.push(from.length ? { name, from: from.join(', '), to: added.join(', '), kind: 'bump' } : { name, from: null, to: added.join(', '), kind: 'added' })
  }
  for (const [name, from] of o) if (!n.has(name)) out.push({ name, from: from.join(', '), to: null, kind: 'removed' })
  return out
}

const MANIFEST_DEP = /^\s*"([^"]+)"\s*:\s*"(?:[~^<>=*]|\d|npm:|workspace:|file:|link:|git|https?:|latest|catalog:)[^"]*"/

// Names a package.json change adds, removes or edits (by its changed lines).
function manifestNames(hunks: Hunk[]): Set<string> {
  const names = new Set<string>()
  for (const h of hunks) {
    for (const l of bodyLines(h)) {
      if (l.kind !== 'add' && l.kind !== 'del') continue
      const m = MANIFEST_DEP.exec(l.raw.slice(1))
      if (m) names.add(m[1])
    }
  }
  return names
}

function dependencyChanges(hs: Hunk[], sigs: HunkSignals[]): DependencyChange[] {
  const byFile = new Map<string, { kind: 'lockfile' | 'manifest'; hunks: Hunk[] }>()
  hs.forEach((h, i) => {
    const c = sigs[i].classes
    const kind = c.includes('lockfile') ? 'lockfile' : c.includes('manifest') && !sigs[i].inert ? 'manifest' : null
    if (!kind) return
    const e = byFile.get(h.file) ?? { kind, hunks: [] }
    e.hunks.push(h)
    byFile.set(h.file, e)
  })
  const names = new Set<string>()
  for (const [file, e] of byFile) if (e.kind === 'manifest' && basename(file) === 'package.json') for (const n of manifestNames(e.hunks)) names.add(n)
  return [...byFile].map(([file, e]): DependencyChange => {
    const base = basename(file)
    const format = e.kind === 'lockfile' && base === 'package-lock.json' ? 'package-lock.json'
      : e.kind === 'lockfile' && base === 'pnpm-lock.yaml' ? 'pnpm-lock.yaml' : null
    if (!format) return { file, kind: e.kind, format: null, bumps: [] }
    const { old, now } = format === 'package-lock.json' ? parsePackageLock(e.hunks) : parsePnpmLock(e.hunks)
    const bumps = diffSeen(old, now, format === 'pnpm-lock.yaml').map((b) => ({ ...b, unrelated: b.kind === 'bump' && !names.has(b.name) }))
    return { file, kind: e.kind, format, bumps }
  })
}

// ---- the whole change ----

export function analyze(hunks: Hunk[], cfg: Config): ChangeSignals {
  const sigs = hunks.map((h) => hunkSignals(h, cfg))
  const deps = dependencyChanges(hunks, sigs)

  const files = new Map<string, FileSignals>()
  hunks.forEach((h, i) => {
    const s = sigs[i]
    const f = files.get(h.file) ?? { file: h.file, classes: [], hunks: [], added: 0, removed: 0, floor: s.floor, why: [] as string[] }
    const first = !f.hunks.length
    f.classes = PATH_CLASSES.filter((c) => f.classes.includes(c) || s.classes.includes(c))
    f.hunks.push(h.id)
    f.added += h.added
    f.removed += h.removed
    if (first || s.floor === f.floor) f.why = [...new Set([...f.why, ...s.why])]
    else if (impactRank(s.floor) > impactRank(f.floor)) { f.floor = s.floor; f.why = [...s.why] }
    files.set(h.file, f)
  })
  const fileList = [...files.values()]

  const testHunks = sigs.filter((s) => s.test).length
  const stats: Stats = {
    files: fileList.length,
    hunks: hunks.length,
    added: hunks.reduce((n, h) => n + h.added, 0),
    removed: hunks.reduce((n, h) => n + h.removed, 0),
    testFiles: fileList.filter((f) => f.classes.includes('test')).length,
    testHunks,
    testHunkShare: hunks.length ? Math.round((testHunks / hunks.length) * 100) / 100 : 0,
  }

  // Dependency bumps that no manifest change explains are worth naming where
  // the lockfile is reported.
  for (const d of deps) {
    const f = files.get(d.file)
    if (!f) continue
    for (const b of d.bumps.filter((x) => x.unrelated).slice(0, 3)) f.why.push(`transitive bump: ${b.name} ${b.from} -> ${b.to}`)
  }

  // The floor: the highest hunk floor decides the attention floor (local skim,
  // module look, shared and contract careful, sensitive must-read). A change
  // of more than largeChangeFiles files is at least careful. The "raise one
  // step" rules of the derivation are not part of the floor: they depend on
  // the gloss, and the floor must be the same whoever writes it.
  const impact = sigs.reduce<Impact>((m, s) => maxImpact(m, s.floor), 'local')
  let attention = attentionForImpact(impact)
  const reasons = fileList.filter((f) => f.floor === impact && impact !== 'module' && impact !== 'local')
    .slice(0, 5).map((f) => `${impact}: ${f.file}${f.why.length ? ` (${f.why.join('; ')})` : ''}`)
  if (stats.files > cfg.attention.largeChangeFiles) {
    attention = maxAttention(attention, 'careful')
    reasons.push(`${stats.files} files changed (more than ${cfg.attention.largeChangeFiles})`)
  }
  return { stats, hunks: sigs, files: fileList, dependencies: deps, floor: { impact, attention, reasons } }
}
