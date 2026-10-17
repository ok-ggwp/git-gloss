import { parseArgs } from 'node:util'
import { blameLine, commitSubject, readNote } from '../git.ts'
import type { Group } from '../schema.ts'
import { groupHeader, style } from '../render.ts'

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

  const note = readNote(blame.commit)
  const subject = commitSubject(blame.commit)
  const hunk = note?.hunks.find(
    (h) => h.file === blame.origFile && blame.origLine >= h.newStart && blame.origLine < h.newStart + h.newLines,
  )
  const groups = note && hunk ? note.annotation.groups.filter((g) => g.hunks.includes(hunk.id)) : []

  // Follow `serves` links up to the task so the reader sees the whole chain.
  const byId = new Map(note?.annotation.groups.map((g) => [g.id, g]) ?? [])
  const chain = (g: Group): Group[] => {
    const seen = new Set<string>()
    const out: Group[] = []
    let cur = byId.get(g.serves)
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.push(cur); cur = byId.get(cur.serves) }
    return out
  }

  if (values.json) {
    console.log(JSON.stringify({
      file, line: Number(lineStr),
      commit: blame.commit, subject,
      origFile: blame.origFile, origLine: blame.origLine,
      task: note?.annotation.task ?? null,
      groups: groups.map((g) => ({ ...g, serves_chain: chain(g).map((c) => c.id) })),
      risks: note?.annotation.risks ?? [],
    }, null, 2))
    return 0
  }

  const out = [`${style('yellow', blame.commit.slice(0, 10))} ${subject}`]
  if (!note) {
    out.push(style('dim', 'no gloss for this commit'))
  } else {
    out.push(`${style('dim', 'task:')} ${note.annotation.task}`, '')
    if (!groups.length) out.push(style('dim', `line ${blame.origLine} of ${blame.origFile} is not in an annotated hunk`))
    for (const g of groups) {
      out.push(...groupHeader(g))
      for (const parent of chain(g)) out.push(`  ${style('dim', '↳ which serves:')} ${parent.intent} ${style('dim', `(${parent.id})`)}`)
    }
  }
  console.log(out.join('\n'))
  return 0
}
