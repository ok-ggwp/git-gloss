import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { commitDiff, dropWipNote, git, gitTry, GlossError, readNote, resolveCommit, WIP_REF, writeNote } from '../git.ts'
import { location, parseDiff, type Hunk } from '../diff.ts'
import { noteFormat, servesOf, type Annotation } from '../schema.ts'
import { changedCount, parseRef, refLabel, selections, uncovered, type Claim } from '../selection.ts'
import { validate } from '../validate.ts'

export const usage = 'adopt [<commit>] [--force]   move the gloss of uncommitted work (wip) onto a commit made from it'

// Carry a wip snapshot's gloss onto a real commit. Each stored wip hunk is
// matched to the commit hunk with the same changes (the content hash used to
// follow rebases), so it works when the work was committed in several commits
// or partly edited first: a commit takes the groups whose hunks it contains,
// and its changes that the wip gloss doesn't cover are reported.
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
  const used = new Set<Hunk>()
  const idMap = new Map<string, Hunk>()
  for (const stored of wipNote.hunks) {
    const match = stored.hash ? current.find((h) => !used.has(h) && h.hash === stored.hash && h.file === stored.file) : undefined
    if (match) { used.add(match); idMap.set(stored.id, match) }
  }

  // Keep each group's references to hunks this commit contains, renamed to
  // this commit's ids; line ranges carry over because matched hunks have the
  // same changed lines.
  const a = wipNote.annotation
  const kept = a.groups.flatMap((g) => {
    const hunks = g.hunks.flatMap((ref) => {
      const r = parseRef(ref)
      const h = r && idMap.get(r.hunk)
      return h ? [r.ranges ? `${h.id}:${r.ranges.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(',')}` : h.id] : []
    })
    return hunks.length ? [{ ...g, hunks }] : []
  })
  if (!kept.length) return skip(`nothing to adopt for ${sha.slice(0, 7)}: none of its changes are in the wip gloss`)

  // A group may serve one that went into another commit; point it at the
  // task instead and say so, rather than leave a reference add would reject.
  const keptIds = new Set(kept.map((g) => g.id))
  const groups = kept.map((g) => {
    const targets = servesOf(g)
    const lost = targets.filter((t) => t !== 'task' && !keptIds.has(t))
    if (!lost.length) return g
    const remaining = targets.filter((t) => t === 'task' || keptIds.has(t))
    const note = `(also served ${lost.join(', ')}, glossed with another commit)`
    return {
      ...g,
      serves: remaining.length > 1 ? remaining : remaining[0] ?? 'task',
      notes: g.notes ? `${g.notes} ${note}` : note,
    }
  })
  const annotation: Annotation = { ...a, groups }

  // Changes in the commit the wip gloss doesn't explain (edited after
  // glossing, or never glossed) are left uncovered and reported.
  const claims = groups.flatMap((g) => [...selections(g.hunks, (id) => {
    const h = current.find((c) => c.id === id)
    return h && changedCount(h)
  })].flatMap(([id, lines]): Claim[] => {
    const h = current.find((c) => c.id === id)
    return h ? [{ hunk: h, lines }] : []
  }))
  const gaps = uncovered(current, claims)
  const { errors } = validate(annotation, current)
  // Re-pointing serves can leave a "supporting" group serving the task; that
  // is recorded in its notes, so it isn't an error here.
  const real = errors.filter((e) => !/is "supporting" but serves "task"/.test(e))
  if (real.length) throw new GlossError(`the adopted gloss doesn't fit ${sha.slice(0, 7)}:\n${real.map((e) => `  ✖ ${e}`).join('\n')}`)

  writeNote(sha, {
    gloss: noteFormat(annotation),
    commit: sha,
    created_at: new Date().toISOString(),
    annotation,
    hunks: current.map(location),
  })
  // Once nothing uncommitted is left, the snapshot has served its purpose.
  const head = gitTry(['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim()
  const done = head === sha && git(['status', '--porcelain']).trim() === ''
  const left = a.groups.length - groups.length
  say(`adopted ${groups.length} of ${a.groups.length} wip groups onto ${sha.slice(0, 7)}` +
    (left > 0 && !done ? `; the other ${left} stay in the wip gloss for later commits` : ''))
  if (gaps.length) {
    say(`  not explained by the wip gloss (edited after glossing, or never glossed): ${gaps.map((u) => refLabel(u.hunk.id, u.lines)).join(', ')}`)
    say(`  gloss them with: git gloss add ${sha.slice(0, 7)} --force -f <annotation including them>`)
  }
  if (done) {
    dropWipNote(wip)
    git(['update-ref', '-d', WIP_REF])
    say('  all work is committed; cleared the wip snapshot')
  }
  return 0
}
