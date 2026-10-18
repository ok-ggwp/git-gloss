import { parseArgs } from 'node:util'
import { blameLine, commitSubject, lineHistory } from '../git.ts'
import { loadGloss, type LoadedGloss } from '../loader.ts'
import { servesOf, type Group } from '../schema.ts'
import { groupHeader, style } from '../render.ts'
import { bodyLines } from '../selection.ts'

export const usage = 'why <file>:<line> [--history] [--rev <commit>] [--json]   explain why a line exists'

// One commit that changed the line, with the gloss groups that own it there.
type Step = {
  commit: string
  subject: string
  file: string
  line: number | null
  gloss: LoadedGloss | null
  groups: Group[]
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
  const gloss = loadGloss(commit)
  const groups = [...new Map(lines.flatMap((l) => groupsForLine(gloss, file, l)).map((g) => [g.id, g])).values()]
  return { commit, subject: gloss?.subject ?? commitSubject(commit), file, line: lines[0] ?? null, gloss, groups }
}

// A change whose only explanation is mechanical (rename, reformat) says
// nothing about why the line exists, so the default view looks past it.
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

const groupJson = (s: Step) => s.groups.map((g) => ({
  ...g, serves: servesOf(g), serves_chain: chain(s.gloss, g).map((c) => c.id),
}))

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { rev: { type: 'string' }, json: { type: 'boolean' }, history: { type: 'boolean' } },
  })
  const m = /^(.+):(\d+)$/.exec(positionals[0] ?? '')
  if (!m) {
    console.error('usage: git gloss ' + usage)
    return 2
  }
  const [, file, lineStr] = m
  const blame = blameLine(file, Number(lineStr), values.rev)

  if (/^0+$/.test(blame.commit)) {
    console.log(`${file}:${lineStr} is not committed yet`)
    return 0
  }

  // Blame names the last commit that changed the line and its number there;
  // the history continues back from that commit. If git can't trace it, the
  // blamed commit alone is the history.
  const trail = lineHistory(blame.origFile, blame.origLine, blame.commit)
  const older = trail?.length && trail[0].commit === blame.commit ? trail.slice(1) : []
  // The latest step comes from blame, which is exact; older ones from the trail.
  const steps = [step(blame.commit, blame.origFile, [blame.origLine]), ...older.map((t) => step(t.commit, t.file, t.lines))]

  // Default view: the latest change, plus older ones while each shown change
  // is only mechanical. --history shows every change.
  let shown = 1
  while (shown < steps.length && mechanicalOnly(steps[shown - 1])) shown++
  const visible = values.history ? steps : steps.slice(0, shown)
  const latest = steps[0]

  if (values.json) {
    console.log(JSON.stringify({
      file, line: Number(lineStr),
      commit: latest.commit, subject: latest.subject,
      origFile: blame.origFile, origLine: blame.origLine,
      task: latest.gloss?.note.annotation.task ?? null,
      stale: latest.gloss?.stale ?? false,
      // serves is always a list here, whichever form the gloss used.
      groups: groupJson(latest),
      risks: latest.gloss?.note.annotation.risks ?? [],
      // Every commit that changed the line, newest first; the default text
      // view shows the first `shown` (it looks past mechanical-only changes).
      history: steps.map((s) => ({
        commit: s.commit, subject: s.subject, file: s.file, line: s.line,
        glossed: s.gloss !== null,
        task: s.gloss?.note.annotation.task ?? null,
        stale: s.gloss?.stale ?? false,
        groups: groupJson(s),
      })),
      shown,
    }, null, 2))
    return 0
  }

  const out: string[] = []
  visible.forEach((s, i) => {
    if (i > 0) {
      out.push('', style('dim', mechanicalOnly(visible[i - 1])
        ? '↓ that change was mechanical; before it, the line came from:'
        : '↓ before that:'), '')
    }
    const where = i > 0 || s.file !== file ? style('dim', `  (${s.file}${s.line ? `:${s.line}` : ''} then)`) : ''
    out.push(`${style('yellow', s.commit.slice(0, 10))} ${s.subject}${where}`)
    if (!s.gloss) {
      out.push(style('dim', 'no gloss for this commit'))
      return
    }
    out.push(`${style('dim', 'task:')} ${s.gloss.note.annotation.task}`)
    for (const w of s.gloss.warnings) out.push(style(['bold', 'red'], `⚠ ${w}`))
    out.push('')
    if (!s.groups.length) out.push(style('dim', `line ${s.line ?? '?'} of ${s.file} is not in an annotated hunk`))
    for (const g of s.groups) {
      out.push(...groupHeader(g))
      for (const parent of chain(s.gloss, g)) out.push(`  ${style('dim', '↳ which serves:')} ${parent.intent} ${style('dim', `(${parent.id})`)}`)
    }
  })
  const hidden = steps.length - visible.length
  if (hidden > 0) {
    out.push('', style('dim', `${hidden} earlier commit${hidden === 1 ? '' : 's'} changed this line: git gloss why ${file}:${lineStr} --history`))
  }
  console.log(out.join('\n'))
  return 0
}
