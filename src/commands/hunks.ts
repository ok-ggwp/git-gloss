import { parseArgs } from 'node:util'
import { commitDiff, resolveCommit } from '../git.ts'
import { parseDiff } from '../diff.ts'
import { colorDiff, hunkLabel, page } from '../render.ts'

export const usage = 'hunks [<commit>] [--stat] [--json]   list a commit\'s hunks with the ids annotations refer to'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { stat: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')
  const hunks = parseDiff(commitDiff(sha))

  if (values.json) {
    console.log(JSON.stringify(hunks, null, 2))
    return 0
  }
  page(hunks.map((h) => hunkLabel(h) + (values.stat ? '' : '\n' + colorDiff(h.text, '  ') + '\n')).join('\n'))
  return 0
}
