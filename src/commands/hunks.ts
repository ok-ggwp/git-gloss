import { parseArgs } from 'node:util'
import { commitDiff, resolveCommit } from '../git.ts'
import { parseDiff } from '../diff.ts'
import { colorDiff, hunkLabel } from '../render.ts'

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
  for (const h of hunks) {
    console.log(hunkLabel(h))
    if (!values.stat) console.log(colorDiff(h.text, '  ') + '\n')
  }
  return 0
}
