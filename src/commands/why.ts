import { parseArgs } from 'node:util'
import { blameLine, commitSubject } from '../git.ts'
import { loadGloss } from '../loader.ts'
import { servesOf, type Group } from '../schema.ts'
import { groupHeader, style } from '../render.ts'
import { bodyLines } from '../selection.ts'

export const usage = 'why <file>:<line> [--rev <commit>] [--json]   explain why a line exists'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { rev: { type: 'string' }, json: { type: 'boolean' } },
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

  const gloss = loadGloss(blame.commit)
  const subject = gloss?.subject ?? commitSubject(blame.commit)
  // Blame reports the line's position in the commit that introduced it, which
  // is the new side of that commit's diff.
  // Within that hunk, the line is one of its added lines; a group owns it if it
  // claims the whole hunk or that line's changed-line number.
  const groups = (gloss?.groups ?? [])
    .filter((g) => g.hunks.some(({ current: h, lines }) => {
      if (!h || h.file !== blame.origFile || blame.origLine < h.newStart || blame.origLine >= h.newStart + h.newLines) return false
      if (!lines) return true
      const idx = bodyLines(h).find((l) => l.kind === 'add' && l.newNo === blame.origLine)?.idx
      return idx !== undefined && idx !== null && lines.has(idx)
    }))
    .map((g) => g.group)

  // Every group this one serves, directly or through others, nearest first,
  // so the reader sees how it connects to the task. `add` rejects cycles; the
  // seen set guards glosses written before it did.
  const byId = new Map(gloss?.note.annotation.groups.map((g) => [g.id, g]) ?? [])
  const chain = (g: Group): Group[] => {
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

  if (values.json) {
    console.log(JSON.stringify({
      file, line: Number(lineStr),
      commit: blame.commit, subject,
      origFile: blame.origFile, origLine: blame.origLine,
      task: gloss?.note.annotation.task ?? null,
      stale: gloss?.stale ?? false,
      groups: groups.map((g) => ({ ...g, serves_chain: chain(g).map((c) => c.id) })),
      risks: gloss?.note.annotation.risks ?? [],
    }, null, 2))
    return 0
  }

  const out = [`${style('yellow', blame.commit.slice(0, 10))} ${subject}`]
  if (!gloss) {
    out.push(style('dim', 'no gloss for this commit'))
  } else {
    out.push(`${style('dim', 'task:')} ${gloss.note.annotation.task}`)
    for (const w of gloss.warnings) out.push(style(['bold', 'red'], `⚠ ${w}`))
    out.push('')
    if (!groups.length) out.push(style('dim', `line ${blame.origLine} of ${blame.origFile} is not in an annotated hunk`))
    for (const g of groups) {
      out.push(...groupHeader(g))
      for (const parent of chain(g)) out.push(`  ${style('dim', '↳ which serves:')} ${parent.intent} ${style('dim', `(${parent.id})`)}`)
    }
  }
  console.log(out.join('\n'))
  return 0
}
