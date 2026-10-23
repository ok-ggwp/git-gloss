import { parseArgs } from 'node:util'
import { commitDiff, dropWipNote, readNote, resolveCommit, snapshotWorkingTree, WIP_NOTES_REF, writeNote } from '../git.ts'
import { carryGloss } from '../carry.ts'
import { copyReviews } from '../reviews.ts'
import { location, parseDiff } from '../diff.ts'
import { noteFormat } from '../schema.ts'
import { colorDiff, hunkLabel, page, style } from '../render.ts'
import { bodyLines, changedCount } from '../selection.ts'
import { loadConfig } from '../config.ts'
import { withSignals } from '../floor.ts'
import { analyze } from '../signals.ts'
import { summaryLines } from './signals.ts'

export const usage = 'hunks [<commit> | wip] [--stat] [--json]   list a commit\'s hunks (or snapshot uncommitted work with wip), numbering changed lines'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { stat: { type: 'boolean' }, json: { type: 'boolean' } },
  })
  // `hunks wip` takes a fresh snapshot of uncommitted work; other commands
  // then use that snapshot, so a gloss is checked against the hunks shown here.
  const snap = positionals[0] === 'wip' ? snapshotWorkingTree() : null
  const sha = snap ? snap.sha : resolveCommit(positionals[0] ?? 'HEAD')
  const hunks = parseDiff(commitDiff(sha))
  if (snap) {
    if (snap.excluded.length) {
      console.error(`note: left out untracked files that look like secrets: ${snap.excluded.join(', ')}` +
        ' (stage them with git add to include them)')
    }
    // A new snapshot replaces the old one. Keep the old gloss for the hunks
    // whose changes are unchanged, so groups not yet committed or edited
    // aren't lost; only the latest snapshot is glossed and adopted.
    const old = snap.replaced ? readNote(snap.replaced) : null
    if (snap.replaced && old) {
      const carried = carryGloss(old, hunks)
      if (carried.annotation) {
        writeNote(sha, {
          gloss: noteFormat(carried.annotation), commit: sha, created_at: new Date().toISOString(),
          annotation: carried.annotation, hunks: hunks.map(location), carried_from: snap.replaced,
        }, WIP_NOTES_REF)
        console.error(`note: kept the gloss of ${carried.kept} of ${carried.total} groups whose changes are unchanged` +
          (carried.gaps.length ? '; gloss the rest (see git gloss show wip) and run git gloss add wip again' : ''))
      }
      // Groups whose changes were edited or committed don't carry over; name
      // them, since their text is discarded with the old snapshot's gloss.
      if (carried.dropped.length) console.error(`note: not kept (their changes were edited or committed): ${carried.dropped.join(', ')}`)
      // Reviews of the old snapshot come along; their fingerprints say what
      // of the new one they still cover.
      copyReviews([snap.replaced], sha)
      dropWipNote(snap.replaced)
    }
  }

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
  // What the diff itself says about attention, for the author to read before glossing.
  const summary = withSignals(() => summaryLines(analyze(hunks, loadConfig())))
  const signals = summary ? ['', ...summary] : []
  page([hunks.map((h) => hunkLabel(h) + style('dim', `  (${changedCount(h)} changed)`) + (values.stat ? '' : '\n' + numbered(h) + '\n')).join('\n'), ...signals].join('\n'))
  return 0
}
