import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { archiveSnapshot, commitDiff, dropWipNote, git, gitTry, GlossError, readNote, resolveCommit, WIP_REF, writeNote } from '../git.ts'
import { carryGloss } from '../carry.ts'
import { location, parseDiff } from '../diff.ts'
import { noteFormat } from '../schema.ts'
import { refLabel } from '../selection.ts'
import { carriedErrors } from '../validate.ts'
import { copyReviews } from '../reviews.ts'

export const usage = 'adopt [<commit>] [--force]   move the gloss of uncommitted work (wip) onto a commit made from it'

// Carry a wip snapshot's gloss onto a real commit made from it (see
// carryGloss): a commit takes the groups whose hunks it contains, so the work
// can be committed in several commits, and its changes the wip gloss doesn't
// cover are reported.
export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    // --quiet-unless-adopted (for the post-commit hook): print nothing when
    // there was nothing to adopt.
    options: { force: { type: 'boolean' }, 'quiet-unless-adopted': { type: 'boolean' } },
  })
  const quiet = values['quiet-unless-adopted']
  const say = (msg: string) => console.log(msg)
  const skip = (msg: string) => { if (!quiet) console.log(msg); return 0 }

  if (positionals[0] === 'wip') {
    throw new GlossError('adopt moves the wip gloss onto a commit made from it; give that commit (default HEAD), not wip')
  }
  const wip = gitTry(['rev-parse', '--verify', '--quiet', WIP_REF])?.trim()
  const wipNote = wip ? readNote(wip) : null
  if (!wip || !wipNote) return skip('nothing to adopt: there is no glossed snapshot of uncommitted work')
  const sha = resolveCommit(positionals[0] ?? 'HEAD')
  if (!values.force && readNote(sha)) {
    if (quiet) return 0 // the commit was glossed directly
    throw new GlossError(`${sha.slice(0, 7)} already has a gloss; pass --force to replace it with the adopted one`)
  }
  // Only commits descended from the snapshot's base can contain its work.
  // During a rebase, the hook stays out: replayed commits' glosses follow them
  // through notes.rewriteRef instead.
  const base = git(['log', '-1', '--format=%P', wip]).trim().split(' ')[0]
  if (base && gitTry(['merge-base', '--is-ancestor', base, sha]) === null) {
    return skip(`nothing to adopt for ${sha.slice(0, 7)}: it isn't built on the commit the wip snapshot was taken from`)
  }
  const rebasing = ['rebase-merge', 'rebase-apply'].some((d) => existsSync(git(['rev-parse', '--git-path', d]).trim()))
  if (quiet && rebasing) return 0

  const current = parseDiff(commitDiff(sha))
  const carried = carryGloss(wipNote, current, parseDiff(commitDiff(wip)))
  if (!carried.annotation) {
    // A glossed hunk split across commits (or edited after glossing) can't be
    // matched; say so even under the hook, since the gloss would otherwise
    // never reach any commit without a word.
    if (carried.partialMatch) {
      console.log(`git-gloss: ${sha.slice(0, 7)} changes glossed code, but no hunk matches the wip gloss exactly ` +
        '(a hunk split across commits, or edited after glossing); gloss this commit with: git gloss add')
      return 0
    }
    return skip(`nothing to adopt for ${sha.slice(0, 7)}: none of its changes are in the wip gloss`)
  }
  const { annotation, gaps } = carried
  const real = carriedErrors(annotation, current)
  if (real.length) throw new GlossError(`the adopted gloss doesn't fit ${sha.slice(0, 7)}:\n${real.map((e) => `  ✖ ${e}`).join('\n')}`)

  writeNote(sha, {
    gloss: noteFormat(annotation),
    commit: sha,
    created_at: new Date().toISOString(),
    annotation,
    hunks: current.map(location),
  })
  // Reviews of the uncommitted work cover the parts of it this commit holds.
  copyReviews([wip], sha)
  // Once nothing uncommitted is left, the snapshot has served its purpose.
  const head = gitTry(['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim()
  const done = head === sha && git(['status', '--porcelain']).trim() === ''
  const left = carried.total - carried.kept
  say(`adopted ${carried.kept} of ${carried.total} wip groups onto ${sha.slice(0, 7)}` +
    (left > 0 && !done ? `; the other ${left} stay in the wip gloss for later commits` : ''))
  if (gaps.length) {
    say(`  not explained by the wip gloss (edited after glossing, or never glossed): ${gaps.map((u) => refLabel(u.hunk.id, u.lines)).join(', ')}`)
    say(`  gloss them with: git gloss add ${sha.slice(0, 7)} --force -f <annotation including them>`)
  }
  if (done) {
    archiveSnapshot(wip)
    dropWipNote(wip)
    git(['update-ref', '-d', WIP_REF])
    say('  all work is committed; cleared the wip snapshot')
  }
  return 0
}
