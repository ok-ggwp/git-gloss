import { parseArgs } from 'node:util'
import { commitDiff, resolveCommit, snapshotWorkingTree } from '../git.ts'
import { parseDiff } from '../diff.ts'
import { colorDiff, hunkLabel, page, style } from '../render.ts'
import { bodyLines, changedCount } from '../selection.ts'

export const usage = 'hunks [<commit> | wip] [--stat] [--json]   list a commit\'s hunks (or snapshot uncommitted work with wip), numbering changed lines'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { stat: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  // `hunks wip` takes a fresh snapshot of uncommitted work; other commands
  // then use that snapshot, so a gloss is checked against the hunks shown here.
  let sha: string
  if (positionals[0] === 'wip') {
    const snap = snapshotWorkingTree()
    sha = snap.sha
    if (snap.excluded.length) {
      console.error(`note: left out untracked files that look like secrets: ${snap.excluded.join(', ')}` +
        ' (stage them with git add to include them)')
    }
  } else {
    sha = resolveCommit(positionals[0] ?? 'HEAD')
  }
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
