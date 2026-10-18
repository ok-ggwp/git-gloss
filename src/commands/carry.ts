import { parseArgs } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { commitDiff, git, GlossError, readNote, resolveCommit, resolveCommits, writeNote } from '../git.ts'
import { matchHunks } from '../loader.ts'
import { findOrigins } from '../origins.ts'
import { location, parseDiff } from '../diff.ts'
import { mergeGlosses, type Source } from '../merge.ts'
import { noteFormat } from '../schema.ts'
import { refLabel } from '../selection.ts'
import { carriedErrors } from '../validate.ts'

export const usage = 'carry <source>... [--to <commit>] [--force] | carry --find [--squash] [<commit>...]   gloss a commit from the glosses of the commits its changes came from (a squash, cherry-pick or rebase); --find works out which commits those are'

// The target's current gloss: none, one written by hand, one carried, or one
// that can't be read (such as the joined notes a squash leaves). Carrying may
// replace all but a hand-written one without --force.
export function targetState(sha: string): 'none' | 'glossed' | 'carried' | 'broken' {
  try {
    const note = readNote(sha)
    // A carried gloss is a starting point that a better one may replace, as add allows.
    return note ? (note.sources || note.carried_from ? 'carried' : 'glossed') : 'none'
  } catch (err) {
    if (err instanceof GlossError) return 'broken'
    throw err
  }
}

export type CarryResult = { written: boolean; message: string }

// Gloss `target` from the glosses of `sources`. Sources without a readable
// gloss are skipped. Writes nothing if no source explains any of its changes.
export function carry(sourceShas: string[], target: string): CarryResult {
  const short = target.slice(0, 7)
  const sources: Source[] = []
  // Sources whose gloss can't be read are named, so their lines aren't
  // mistaken for changes nobody glossed.
  const unreadable: string[] = []
  for (const sha of sourceShas) {
    if (sha === target) continue
    let note
    try { note = readNote(sha) } catch (err) {
      if (!(err instanceof GlossError)) throw err
      unreadable.push(`${sha.slice(0, 7)} (${err.message.replace(/^the gloss on \S+ /, '')})`)
      continue
    }
    if (note) sources.push({ sha, note, hunks: parseDiff(commitDiff(sha)) })
  }
  const skipped = unreadable.length ? `\n  skipped sources whose gloss can't be read: ${unreadable.join('; ')}` : ''
  if (!sources.length) return { written: false, message: `nothing to carry onto ${short}: none of the sources has a readable gloss${skipped}` }
  const current = parseDiff(commitDiff(target))
  const merged = mergeGlosses(sources, current)
  const stale = merged.stale.length ? `\n  skipped glossed hunks that no longer match their commit's diff: ${merged.stale.join(', ')}` : ''
  if (!merged.annotation) return { written: false, message: `nothing to carry onto ${short}: none of its changes match the sources' glossed changes${skipped}${stale}` }

  // Changes no source explains are reported below, not errors.
  const errors = carriedErrors(merged.annotation, current)
  if (errors.length) throw new GlossError(`the carried gloss doesn't fit ${short}:\n${errors.map((e) => `  ✖ ${e}`).join('\n')}`)
  writeNote(target, {
    gloss: noteFormat(merged.annotation),
    commit: target,
    created_at: new Date().toISOString(),
    annotation: merged.annotation,
    hunks: current.map(location),
    sources: merged.used,
  })
  const lines = [`carried ${merged.annotation.groups.length} group${merged.annotation.groups.length === 1 ? '' : 's'} from ` +
    `${merged.used.map((s) => s.slice(0, 7)).join(', ')} onto ${short}`]
  if (merged.dropped.length) lines.push(`  groups with no change left in ${short}: ${merged.dropped.join(', ')}`)
  if (skipped) lines.push(skipped.slice(1))
  if (stale) lines.push(stale.slice(1))
  if (merged.gaps.length) {
    lines.push(`  not explained by the sources (edited while combining, never glossed${skipped || stale ? ', or in a skipped source' : ''}): ${merged.gaps.map((u) => refLabel(u.hunk.id, u.lines)).join(', ')}`,
      `  gloss them with: git gloss add ${short} -f <annotation including them>`)
  }
  return { written: true, message: lines.join('\n') }
}

// Whether a commit's gloss was written for different changes than the
// commit now has (it was copied onto a rewritten commit whose diff changed).
function isStale(sha: string): boolean {
  const note = readNote(sha)
  if (!note) return false
  return [...matchHunks(note.hunks, parseDiff(commitDiff(sha))).values()].some((r) => r.status !== 'ok')
}

// For the post-rewrite hook: git gives "<old> <new>" lines for an amend or a
// rebase. A commit made from several (squash, fixup) is glossed from all of
// them, replacing the joined notes notes.rewriteRef leaves; a commit made from
// one keeps its copied gloss unless the rewrite changed its diff, in which
// case it is glossed line by line from the original.
function rewritten(kind: string, input: string): string[] {
  // During a rebase, each squash step also reports an amend of a temporary
  // commit; the rebase's own report at the end covers them all.
  const rebasing = ['rebase-merge', 'rebase-apply'].some((d) => existsSync(git(['rev-parse', '--git-path', d]).trim()))
  if (kind === 'amend' && rebasing) return []
  const from = new Map<string, string[]>()
  for (const line of input.split('\n')) {
    const [old, now] = line.trim().split(/\s+/)
    if (!old || !now) continue
    from.set(now, [...(from.get(now) ?? []), old])
  }
  const out: string[] = []
  for (const [now, olds] of from) {
    if (olds.length === 1 && ['glossed', 'carried'].includes(targetState(now)) && !isStale(now)) continue
    const res = carry(olds, now)
    if (res.written) out.push(res.message)
  }
  return out
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      force: { type: 'boolean' },
      find: { type: 'boolean' },
      squash: { type: 'boolean' },
      rewritten: { type: 'string' },
      quiet: { type: 'boolean' },
    },
  })
  // Hooks print only what they carried, prefixed so it's clear where it came from.
  const report = (msgs: string[]) => { for (const m of msgs) console.log(values.quiet ? `git-gloss: ${m}` : m) }
  if (values.rewritten) {
    report(rewritten(values.rewritten, readFileSync(0, 'utf8')))
    return 0
  }
  if (values.find) {
    const out: string[] = []
    for (const target of (positionals.length ? positionals : ['HEAD']).map((p) => resolveCommit(p))) {
      if (targetState(target) === 'glossed' && !values.force) {
        if (!values.quiet) out.push(`${target.slice(0, 7)} already has a gloss`)
        continue
      }
      const origins = findOrigins(target, { squash: values.squash })
      if (!origins) {
        if (!values.quiet) out.push(`found no glossed commits that ${target.slice(0, 7)}'s changes came from` + (values.squash ? '' : ' (add --squash to look for a squashed branch)'))
        continue
      }
      const res = carry(origins, target)
      if (res.written || !values.quiet) out.push(res.message)
    }
    report(out)
    return 0
  }
  if (!positionals.length) throw new GlossError('name the commits the changes came from, e.g. git gloss carry main..feature --to HEAD')
  const target = resolveCommit(values.to ?? 'HEAD')
  const state = targetState(target)
  if (state === 'glossed' && !values.force) {
    throw new GlossError(`${target.slice(0, 7)} already has a gloss; pass --force to replace it (the old one stays in the notes history)`)
  }
  const sources = positionals.flatMap((p) => resolveCommits(p).shas)
  const res = carry(sources, target)
  console.log(res.message)
  return res.written ? 0 : 1
}
