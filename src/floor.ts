import type { Hunk } from './diff.ts'
import { ConfigError, loadConfig, type Config } from './config.ts'
import type { LoadedGloss } from './loader.ts'
import { attentionForImpact, attentionRank, impactRank, maxAttention, maxImpact, raise } from './attention.ts'
import { servesOf, type Annotation, type AttentionLevel, type Group, type Impact } from './schema.ts'
import { analyze, CONFIG_EDIT_NOTE, partFloor, timedOutNotes, type ChangeSignals, type HunkSignals } from './signals.ts'
import { changedCount, selections } from './selection.ts'

// What a group claims of the diff: whole hunks, or some of a hunk's changed lines.
export type GroupPart = { hunk: Hunk; lines: Set<number> | null }
export type GroupInput = { group: Group; parts: GroupPart[] }

export type GroupFloor = {
  // Highest floor of the group's parts: path classes of its hunks, and pattern
  // hits on the changed lines it claims (never the lines of other groups).
  floor: Impact
  // Where the floor comes from, e.g. "src/a.ts: pattern: device write".
  why: string[]
  // Not all of its hunks are tests, docs, generated files or lockfiles, and
  // its necessity is not "mechanical".
  behaviour: boolean
  // Every hunk it claims is a test-class file.
  testsOnly: boolean
  // Some group made only of test hunks serves it (directly or through groups it serves).
  tested: boolean
}

export type Derived = { level: AttentionLevel; reasons: string[] }

export type Analysis = {
  signals: ChangeSignals
  groups: Map<string, GroupFloor>
  // The computed floor for the change's attention.
  floor: AttentionLevel
  // The attention to show when the gloss declares none.
  derived: Derived
  // Timed-out patterns that count toward the floor (see timedOutNotes).
  timedOut: string[]
}

// The groups of a loaded gloss with their current hunks (a hunk that is gone is skipped).
export function groupInputs(gloss: LoadedGloss): GroupInput[] {
  return gloss.groups.map((g) => ({
    group: g.group,
    parts: g.hunks.flatMap((h) => (h.current ? [{ hunk: h.current, lines: h.lines }] : [])),
  }))
}

// The groups of an annotation over hunks of the diff (as `add` has them).
export function groupInputsFor(a: Annotation, hunks: Hunk[]): GroupInput[] {
  const byId = new Map(hunks.map((h) => [h.id, h]))
  return a.groups.map((group) => ({
    group,
    parts: [...selections(group.hunks, (id) => { const h = byId.get(id); return h && changedCount(h) })]
      .flatMap(([id, lines]) => { const hunk = byId.get(id); return hunk ? [{ hunk, lines }] : [] }),
  }))
}

// Group floors, and the derivation of the attention for when the author declares none:
//
//   start from the highest group impact (declared, else the group's floor):
//     local skim, module look, shared and contract careful, sensitive must-read;
//   raise it ONE step (capped at must-read), however many of these apply:
//     - a behaviour-changing group no test-only group serves (see GroupFloor);
//     - a speculative or defensive group that is not made only of test hunks;
//     - more than attention.largeChangeFiles files changed;
//   never below the change's floor (which is the highest hunk floor, and at
//   least careful for a large change).
export function analyzeGroups(hunks: Hunk[], groups: GroupInput[], cfg: Config): Analysis {
  const signals = analyze(hunks, cfg)
  const sigOf = new Map<string, HunkSignals>(signals.hunks.map((s) => [s.id, s]))

  const floors = new Map<string, GroupFloor>()
  for (const { group, parts } of groups) {
    let floor: Impact = 'local'
    const found: { floor: Impact; why: string[] }[] = []
    for (const { hunk, lines } of parts) {
      const s = sigOf.get(hunk.id)
      if (!s) continue
      const p = partFloor(s, lines)
      floor = maxImpact(floor, p.floor)
      found.push({ floor: p.floor, why: p.why.map((w) => `${hunk.file}: ${w}`) })
    }
    const sigs = parts.map((p) => sigOf.get(p.hunk.id)).filter((s): s is HunkSignals => !!s)
    floors.set(group.id, {
      floor,
      why: [...new Set(found.filter((f) => f.floor === floor).flatMap((f) => f.why))].slice(0, 3),
      behaviour: group.necessity !== 'mechanical' && sigs.some((s) => !s.inert),
      testsOnly: sigs.length > 0 && sigs.every((s) => s.test),
      tested: false,
    })
  }

  // A test-only group serves what it names, and what those groups serve in turn.
  const byId = new Map(groups.map((g) => [g.group.id, g.group]))
  for (const { group } of groups) {
    if (!floors.get(group.id)!.testsOnly) continue
    const seen = new Set<string>()
    const queue = servesOf(group).filter((t) => t !== 'task')
    while (queue.length) {
      const id = queue.shift()!
      if (seen.has(id)) continue
      seen.add(id)
      const f = floors.get(id)
      if (f) f.tested = true
      const g = byId.get(id)
      if (g) queue.push(...servesOf(g).filter((t) => t !== 'task'))
    }
  }

  // Derivation.
  let top: { impact: Impact | undefined; id: string; declared: boolean } = { impact: undefined, id: '', declared: false }
  for (const { group } of groups) {
    const impact = group.impact ?? floors.get(group.id)!.floor
    if (impactRank(impact) > impactRank(top.impact)) top = { impact, id: group.id, declared: !!group.impact }
  }
  const reasons: string[] = []
  let level = top.impact ? attentionForImpact(top.impact) : signals.floor.attention
  if (top.impact) reasons.push(`highest group impact: ${top.impact} (${top.id}, ${top.declared ? 'declared' : 'from the diff'})`)
  const raises: string[] = []
  const untested = groups.filter((g) => floors.get(g.group.id)!.behaviour && !floors.get(g.group.id)!.tested).map((g) => g.group.id)
  if (untested.length) raises.push(`behaviour change without a test serving it: ${untested.join(', ')}`)
  const hedged = groups.filter((g) => (g.group.necessity === 'speculative' || g.group.necessity === 'defensive') && !floors.get(g.group.id)!.testsOnly)
  if (hedged.length) raises.push(`speculative or defensive code: ${hedged.map((g) => g.group.id).join(', ')}`)
  if (signals.stats.files > cfg.attention.largeChangeFiles) raises.push(`${signals.stats.files} files changed (more than ${cfg.attention.largeChangeFiles})`)
  if (raises.length) { level = raise(level); reasons.push(...raises.map((r) => `raised one step: ${r}`)) }
  if (attentionRank(signals.floor.attention) > attentionRank(level)) {
    level = maxAttention(level, signals.floor.attention)
    reasons.push(`floor ${signals.floor.attention}: ${signals.floor.reasons[0] ?? signals.floor.impact}`)
  }
  return { signals, groups: floors, floor: signals.floor.attention, derived: { level, reasons }, timedOut: timedOutNotes(signals.hunks) }
}

export const analyzeGloss = (gloss: LoadedGloss, cfg: Config): Analysis =>
  analyzeGroups(gloss.hunks, groupInputs(gloss), cfg)

// ---- checks on `add` ----

export type RatingProblems = {
  // A group's declared impact is below its floor.
  warnings: string[]
  // The declared attention is below the floor with no override_reason.
  underrated: string | null
}

// The rating checks as data: `add` words them as warnings and errors, `lint` reports them by code.
export type RatingIssues = {
  configEdit: boolean
  // A declared impact below the group's floor (a floor of plain module or below is no signal).
  belowFloor: { id: string; impact: Impact; floor: Impact; why: string[] }[]
  // No impact on a group that should have one: every group except a mechanical one on plain source.
  unrated: { id: string; floor: Impact; why: string[]; signal: boolean }[]
  // The declared attention is below the floor with no override_reason.
  attention: { level: AttentionLevel; floor: AttentionLevel; why: string } | null
}

// Where a floor comes from, for messages.
export const whyText = (why: string[]): string => why.join('; ') || 'computed from the diff'

export function ratingIssues(a: Annotation, an: Analysis): RatingIssues {
  const belowFloor: RatingIssues['belowFloor'] = []
  const unrated: RatingIssues['unrated'] = []
  for (const g of a.groups) {
    const f = an.groups.get(g.id)
    if (g.impact) {
      // A floor of plain "module" is the baseline for source files, not a signal
      // to warn about: a private helper may honestly be `local`.
      if (f && impactRank(f.floor) > impactRank('module') && impactRank(g.impact) < impactRank(f.floor)) belowFloor.push({ id: g.id, impact: g.impact, floor: f.floor, why: f.why })
      continue
    }
    // A mechanical group on a floor signal (lockfile, config, CI, sensitive path)
    // is not pure; plain module is the baseline for source files.
    const signal = !!f && impactRank(f.floor) > impactRank('module')
    if (g.necessity === 'mechanical' && !signal) continue
    unrated.push({ id: g.id, floor: f?.floor ?? 'local', why: f?.why ?? [], signal })
  }
  let attention: RatingIssues['attention'] = null
  const att = a.attention
  if (att && attentionRank(att.level) < attentionRank(an.floor) && !att.override_reason) {
    const why = an.signals.floor.reasons.length ? an.signals.floor.reasons.join('; ') : `${an.signals.floor.impact}: ordinary source changes`
    attention = { level: att.level, floor: an.floor, why }
  }
  return { configEdit: an.signals.floor.reasons.includes(CONFIG_EDIT_NOTE), belowFloor, unrated, attention }
}

export function ratingProblems(a: Annotation, an: Analysis): RatingProblems {
  const issues = ratingIssues(a, an)
  const warnings: string[] = []
  if (issues.configEdit) warnings.push(CONFIG_EDIT_NOTE)
  for (const b of issues.belowFloor) {
    warnings.push(`group "${b.id}" is rated impact "${b.impact}" but its floor is "${b.floor}" (${whyText(b.why)}); raise it, or say why in impact_reason`)
  }
  const unrated = issues.unrated.map((u) => `"${u.id}"`)
  const floored = issues.unrated.filter((u) => u.signal).map((u) => `${u.id}: floor ${u.floor}: ${whyText(u.why)}`)
  if (unrated.length) {
    const names = unrated.slice(0, 10).join(', ') + (unrated.length > 10 ? ` and ${unrated.length - 10} more` : '')
    warnings.push(`no impact rated on group ${names}${floored.length ? ` (${floored.join('; ')})` : ''}; rate impact on every group except a mechanical one on plain source (floor module or below), see the gloss skill`)
  }
  const att = issues.attention
  const underrated = att && `attention.level "${att.level}" is below the computed floor "${att.floor}" (${att.why}); raise it, or explain with attention.override_reason`
  return { warnings, underrated }
}

let warned = false

// Run something that needs the signals' config; null when the config is
// malformed (say why once on stderr), so callers fall back to what is declared.
export function withSignals<T>(fn: () => T): T | null {
  try {
    return fn()
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err
    if (!warned) console.error(`warning: signals unavailable: ${err.message}`)
    warned = true
    return null
  }
}

// The analysis of a loaded gloss, or null when the signals cannot be computed.
export const tryAnalyze = (gloss: LoadedGloss): Analysis | null => withSignals(() => analyzeGloss(gloss, loadConfig()))

// Whether a gloss's groups get an impact column (show) or badges (html): some
// group declares an impact, or the diff puts a group's floor above the module
// baseline. Then undeclared groups show their floor as a derived impact.
export const showsImpact = (groups: Group[], an: Analysis | null): boolean =>
  groups.some((g) => g.impact || impactRank(an?.groups.get(g.id)?.floor) > impactRank('module'))
