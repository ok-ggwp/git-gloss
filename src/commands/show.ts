import { parseArgs } from 'node:util'
import { resolveCommit } from '../git.ts'
import { loadGloss } from '../loader.ts'
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
  const gloss = loadGloss(sha)
  if (!gloss) {
    console.error(`${sha.slice(0, 10)} has no gloss (annotate it with \`git gloss add\`)`)
    return 1
  }

  const only = values.only?.split(',').map((s) => s.trim()) as Necessity[] | undefined
  const unknown = only?.filter((n) => !NECESSITY.includes(n))
  if (unknown?.length) {
    console.error(`error: unknown necessity ${unknown.join(', ')}; expected ${NECESSITY.join(', ')}`)
    return 2
  }

  const a = gloss.note.annotation
  const out: string[] = [
    `${style('yellow', sha.slice(0, 10))} ${gloss.subject}`,
    `${style('dim', 'task:')} ${a.task}`,
  ]
  if (a.summary) out.push(`${style('dim', 'summary:')} ${a.summary}`)
  for (const w of gloss.warnings) out.push(style(['bold', 'red'], `⚠ ${w}`))

  const tally = NECESSITY.map((n) => [n, a.groups.filter((g) => g.necessity === n).length] as const)
    .filter(([, c]) => c > 0)
    .map(([n, c]) => `${necessityTag(n)} ${c}`)
  out.push(`${style('dim', 'groups:')} ${tally.join('  ')}`, '')

  for (const { group, hunks } of gloss.groups) {
    if (only && !only.includes(group.necessity)) continue
    out.push(...groupHeader(group))
    if (!values['no-diff']) {
      for (const h of hunks) {
        if (!h.current) { out.push('', style('red', `  ${h.id}: no longer in this commit's diff`)); continue }
        if (h.status === 'changed') out.push('', style('red', `  ${h.id}: content changed since it was glossed`))
        out.push('', '  ' + hunkLabel(h.current), colorDiff(h.current.text, '    '))
      }
    }
    out.push('')
  }

  if (gloss.unannotated.length && !only) {
    out.push(style(['bold', 'red'], '■ Unannotated hunks'))
    for (const h of gloss.unannotated) out.push('  ' + hunkLabel(h))
  }

  out.push(...noteFooter(gloss.note))
  console.log(out.join('\n'))
  return 0
}
