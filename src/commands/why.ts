import { parseArgs } from 'node:util'
import { blameRange, commitSubject, lineHistory, type BlameResult } from '../git.ts'
import { loadGloss, type LoadedGloss } from '../loader.ts'
import { servesOf, type Group } from '../schema.ts'
import { field, groupHeader, style } from '../render.ts'
import { bodyLines, formatRanges } from '../selection.ts'

export const usage = 'why <file>:<line>[-<end>] [--history] [--rev <commit>] [--json]   explain why code exists'

// One commit's explanation of some lines: its gloss and the groups that own them.
type Step = {
  commit: string
  subject: string
  file: string
  gloss: LoadedGloss | null
  groups: Group[]
}

// Glosses are loaded at most once per commit, however many lines or steps
// refer to it; each load diffs the commit.
const glossCache = new Map<string, LoadedGloss | null>()
function glossFor(commit: string): LoadedGloss | null {
  if (!glossCache.has(commit)) glossCache.set(commit, loadGloss(commit))
  return glossCache.get(commit)!
}

// Groups in a gloss that own `line` of `file` on the new side of the commit's
// diff: they claim the whole hunk, or that line's changed-line number.
function groupsForLine(gloss: LoadedGloss | null, file: string, line: number): Group[] {
  return (gloss?.groups ?? [])
    .filter((g) => g.hunks.some(({ current: h, lines }) => {
      if (!h || h.file !== file || line < h.newStart || line >= h.newStart + h.newLines) return false
      if (!lines) return true
      const idx = bodyLines(h).find((l) => l.kind === 'add' && l.newNo === line)?.idx
      return idx !== undefined && idx !== null && lines.has(idx)
    }))
    .map((g) => g.group)
}

function step(commit: string, file: string, lines: number[]): Step {
  const gloss = glossFor(commit)
  const groups = [...new Map(lines.flatMap((l) => groupsForLine(gloss, file, l)).map((g) => [g.id, g])).values()]
  return { commit, subject: gloss?.subject ?? commitSubject(commit), file, gloss, groups }
}

// A change whose only explanation is mechanical (rename, reformat) says
// nothing about why the code exists, so it is looked through.
const mechanicalOnly = (s: Step) => s.groups.length > 0 && s.groups.every((g) => g.necessity === 'mechanical')

// Every group a group serves, directly or through others, nearest first.
// `add` rejects cycles; the seen set guards glosses written before it did.
function chain(gloss: LoadedGloss | null, g: Group): Group[] {
  const byId = new Map(gloss?.note.annotation.groups.map((x) => [x.id, x]) ?? [])
  const seen = new Set([g.id])
  const out: Group[] = []
  const queue = servesOf(g)
  while (queue.length) {
    const next = byId.get(queue.shift()!)
    if (!next || seen.has(next.id)) continue
    seen.add(next.id)
    out.push(next)
    queue.push(...servesOf(next))
  }
  return out
}

// The lines of the query one commit explains, plus what came before it: with
// --history every older change, otherwise older changes only while the ones
// shown are mechanical, stopping at the first real explanation.
type Explanation = { lines: number[]; latest: Step; before: Step[]; note: string | null }

function explain(blamed: BlameResult[], history: boolean): Explanation {
  const { commit, origFile } = blamed[0]
  const orig = blamed.map((b) => b.origLine)
  const latest = step(commit, origFile, orig)
  const lines = blamed.map((b) => b.line)
  if (!history && !mechanicalOnly(latest)) return { lines, latest, before: [], note: null }

  // git log -L walks back from this commit over the lines' span in it.
  const start = Math.min(...orig), end = Math.max(...orig)
  const trail = lineHistory(origFile, start, end, commit) ?? []
  // Normally the trail starts at the blamed commit. If they disagree (blame
  // can skip commits, e.g. with blame.ignoreRevsFile), keep the trail's older
  // commits anyway and say so rather than drop them.
  const at = trail.findIndex((t) => t.commit === commit)
  const older = at >= 0 ? trail.slice(at + 1) : trail
  const note = trail.length && at !== 0 ? 'git log -L traced these lines from a different commit than blame named; the history may be incomplete' : null

  const before: Step[] = []
  for (const t of older) {
    if (!history && !mechanicalOnly(before.at(-1) ?? latest)) break
    before.push(step(t.commit, t.file, t.lines))
  }
  return { lines, latest, before, note }
}

const stepJson = (s: Step) => ({
  commit: s.commit,
  subject: s.subject,
  file: s.file,
  glossed: s.gloss !== null,
  stale: s.gloss?.stale ?? false,
  task: s.gloss?.note.annotation.task ?? null,
  // serves is always a list here, whichever form the gloss used.
  groups: s.groups.map((g) => ({ ...g, serves: servesOf(g), serves_chain: chain(s.gloss, g).map((c) => c.id) })),
})

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { rev: { type: 'string' }, json: { type: 'boolean' }, history: { type: 'boolean' } },
  })
  const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(positionals[0] ?? '')
  if (!m || (m[3] && Number(m[3]) < Number(m[2]))) {
    console.error('usage: git gloss ' + usage)
    return 2
  }
  const [, file, startStr, endStr] = m
  const start = Number(startStr), end = Number(endStr ?? startStr)

  // One blame for the whole range, then one explanation per commit, in the
  // order its lines first appear.
  const blamed = blameRange(file, start, end, values.rev)
  const uncommitted = blamed.filter((b) => /^0+$/.test(b.commit)).map((b) => b.line)
  const byCommit = new Map<string, BlameResult[]>()
  for (const b of blamed) if (!/^0+$/.test(b.commit)) byCommit.set(b.commit, [...(byCommit.get(b.commit) ?? []), b])
  const explanations = [...byCommit.values()].map((group) => explain(group, !!values.history))

  if (values.json) {
    console.log(JSON.stringify({
      file, start, end,
      explanations: explanations.map((e) => ({
        lines: formatRanges(e.lines),
        ...stepJson(e.latest),
        risks: e.latest.gloss?.note.annotation.risks ?? [],
        alternatives: e.latest.gloss?.note.annotation.alternatives ?? [],
        // Older commits: mechanical changes looked through by default, every
        // change with --history.
        before: e.before.map(stepJson),
        note: e.note,
      })),
      uncommitted: uncommitted.length ? formatRanges(uncommitted) : null,
    }, null, 2))
    return 0
  }

  const out: string[] = []
  const span = start === end ? `${start}` : `${start}-${end}`
  const renderStep = (s: Step, label: string) => {
    out.push(`${label}${style('yellow', s.commit.slice(0, 10))} ${s.subject}`)
    if (!s.gloss) { out.push(style('dim', '  no gloss for this commit')); return }
    out.push(...field('task:', s.gloss.note.annotation.task))
    for (const w of s.gloss.warnings) out.push(style(['bold', 'red'], `  ⚠ ${w}`))
    if (!s.groups.length) out.push(style('dim', '  these lines are not in an annotated hunk'))
    for (const g of s.groups) {
      out.push(...groupHeader(g).map((l) => '  ' + l))
      for (const parent of chain(s.gloss, g)) out.push(`    ${style('dim', '↳ which serves:')} ${parent.intent} ${style('dim', `(${parent.id})`)}`)
    }
  }
  explanations.forEach((e, i) => {
    if (i > 0) out.push('')
    const label = byCommit.size > 1 || start !== end ? style('bold', `lines ${formatRanges(e.lines)}  `) : ''
    renderStep(e.latest, label)
    // Risks and rejected alternatives cover the whole commit, not just these
    // lines, so text output points at them instead of printing them here.
    const a = e.latest.gloss?.note.annotation
    const extras = [a?.risks?.length && `${a.risks.length} risk${a.risks.length === 1 ? '' : 's'}`,
      a?.alternatives?.length && `${a.alternatives.length} rejected alternative${a.alternatives.length === 1 ? '' : 's'}`].filter(Boolean)
    if (extras.length) out.push(style('dim', `  the commit also lists ${extras.join(' and ')}: git gloss show ${e.latest.commit.slice(0, 7)} --full`))
    e.before.forEach((s, j) => {
      const prev = j === 0 ? e.latest : e.before[j - 1]
      out.push(style('dim', mechanicalOnly(prev) ? '  ↓ that change was mechanical; before it:' : '  ↓ before that:'))
      renderStep(s, '  ')
    })
    if (e.note) out.push(style('dim', `  ${e.note}`))
  })
  // Older history is only walked on request, so whether there is any isn't
  // known here; point at it once.
  if (!values.history && explanations.length) {
    out.push('', style('dim', `Earlier changes to these lines: git gloss why ${file}:${span}${values.rev ? ` --rev ${values.rev}` : ''} --history`))
  }
  if (uncommitted.length) out.push('', style('dim', `lines ${formatRanges(uncommitted)} are not committed yet`))
  console.log(out.join('\n'))
  return 0
}
