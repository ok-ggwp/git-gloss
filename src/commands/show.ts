import { parseArgs } from 'node:util'
import { commitDiff, commitSubject, readNote, resolveCommit } from '../git.ts'
import { parseDiff } from '../diff.ts'
import { NECESSITY, type Necessity } from '../schema.ts'
import { colorDiff, groupHeader, hunkLabel, necessityTag, noteFooter, style } from '../render.ts'

export const usage = 'show [<commit>] [--only <necessity,...>] [--no-diff]   show the diff grouped by intent'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { only: { type: 'string' }, 'no-diff': { type: 'boolean' } },
  })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')
  const note = readNote(sha)
  if (!note) {
    console.error(`${sha.slice(0, 10)} has no gloss (annotate it with \`git gloss add\`)`)
    return 1
  }

  const only = values.only?.split(',').map((s) => s.trim()) as Necessity[] | undefined
  const unknown = only?.filter((n) => !NECESSITY.includes(n))
  if (unknown?.length) {
    console.error(`error: unknown necessity ${unknown.join(', ')}; expected ${NECESSITY.join(', ')}`)
    return 2
  }

  const hunks = new Map(parseDiff(commitDiff(sha)).map((h) => [h.id, h]))
  const a = note.annotation
  const out: string[] = [
    `${style('yellow', sha.slice(0, 10))} ${commitSubject(sha)}`,
    `${style('dim', 'task:')} ${a.task}`,
  ]
  if (a.summary) out.push(`${style('dim', 'summary:')} ${a.summary}`)

  const tally = NECESSITY.map((n) => [n, a.groups.filter((g) => g.necessity === n).length] as const)
    .filter(([, c]) => c > 0)
    .map(([n, c]) => `${necessityTag(n)} ${c}`)
  out.push(`${style('dim', 'groups:')} ${tally.join('  ')}`, '')

  for (const g of a.groups) {
    if (only && !only.includes(g.necessity)) continue
    out.push(...groupHeader(g))
    if (!values['no-diff']) {
      for (const id of g.hunks) {
        const h = hunks.get(id)
        if (!h) { out.push(style('red', `  (hunk ${id} not found in current diff)`)); continue }
        out.push('', '  ' + hunkLabel(h), colorDiff(h.text, '    '))
      }
    }
    out.push('')
  }

  const covered = new Set(a.groups.flatMap((g) => g.hunks))
  const uncovered = [...hunks.values()].filter((h) => !covered.has(h.id))
  if (uncovered.length && !only) {
    out.push(style(['bold', 'red'], '■ Unannotated hunks'))
    for (const h of uncovered) out.push('  ' + hunkLabel(h))
  }

  out.push(...noteFooter(note))
  console.log(out.join('\n'))
  return 0
}
