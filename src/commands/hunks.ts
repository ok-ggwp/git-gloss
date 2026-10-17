import { parseArgs } from 'node:util'
import { commitDiff, resolveCommit } from '../git.ts'
import { parseDiff } from '../diff.ts'
import { colorDiff, hunkLabel, page, style } from '../render.ts'
import { bodyLines, changedCount } from '../selection.ts'

export const usage = 'hunks [<commit>] [--stat] [--json]   list a commit\'s hunks, numbering changed lines for h3:2-5 references'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { stat: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')
  const hunks = parseDiff(commitDiff(sha))

  if (values.json) {
    console.log(JSON.stringify(hunks.map((h) => ({ ...h, changed: changedCount(h) })), null, 2))
    return 0
  }
  // Changed lines are numbered for references like h3:2-5; context lines are not.
  const numbered = (h: (typeof hunks)[number]) => {
    const [header] = h.text.split('\n')
    const body = bodyLines(h)
    if (body.every((l) => l.kind === 'meta')) return colorDiff(h.text, '       ')
    return [colorDiff(header, '       '), ...body.map((l) =>
      style('dim', (l.idx === null ? '' : String(l.idx)).padStart(5)) + '  ' + colorDiff(l.raw))].join('\n')
  }
  page(hunks.map((h) => hunkLabel(h) + style('dim', `  (${changedCount(h)} changed)`) + (values.stat ? '' : '\n' + numbered(h) + '\n')).join('\n'))
  return 0
}
