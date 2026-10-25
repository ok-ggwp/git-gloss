import { parseArgs } from 'node:util'
import { commitDiff, git, GitError, gitTry, GlossError, noteSizeProblem, NOTES_REF, parseNote, resolveCommit, WIP_NOTES_REF, WIP_REF, rethrowTimeout, writeNote } from '../git.ts'
import { plain } from '../plain.ts'
import { location, parseDiff } from '../diff.ts'
import { loadGlossOf } from '../loader.ts'
import { carriedErrors } from '../validate.ts'
import { mergeGlosses } from '../merge.ts'
import { noteFormat } from '../schema.ts'
import { refLabel } from '../selection.ts'

export const usage = 'versions [<commit> | wip] [--show <n> | --restore <n>]   every gloss a commit has had (replaced, carried, merged), newest first; wip: every gloss of uncommitted work, including dropped groups'

type Version = { object: string; blob: string | null; at: string; how: string }

// Every change to the notes in `ref`, newest first: a note's history is the
// notes ref's history, so a replaced or removed gloss is still there. Merges
// are skipped; each side's own commits carry the versions they brought.
function history(ref: string, only?: string): Version[] {
  if (!gitTry(['rev-parse', '-q', '--verify', ref])) return []
  const out: Version[] = []
  // One notes commit's changes, per object. When git reorganises the notes
  // tree (ab/cdef… directories once there are many notes), each note shows
  // as removed from one path and added at another; that pair is one entry,
  // and none at all if the gloss itself didn't change.
  let at = '', how = '', changes = new Map<string, { removed?: string; added?: string }>()
  const flush = () => {
    for (const [object, c] of changes) {
      if (c.removed && c.added && c.removed === c.added) continue
      out.push({ object, blob: c.added ?? null, at, how })
    }
    changes = new Map()
  }
  for (const line of git(['log', '--no-merges', '--raw', '--no-abbrev', '--no-renames', '--format=%x00%cI%x00%s', ref, '--']).split('\n')) {
    if (line.startsWith('\0')) { flush(); [, at, how] = line.split('\0'); continue }
    const m = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) (\w)\t(.+)$/.exec(line)
    if (!m) continue
    // Notes are stored under the object's id, possibly split into directories.
    const object = m[4].replaceAll('/', '')
    if (only && object !== only) continue
    const c = changes.get(object) ?? {}
    if (m[3] === 'D') c.removed = m[1]
    else { c.added = m[2]; if (m[3] === 'M') c.removed = m[1] }
    changes.set(object, c)
  }
  flush()
  return out
}

// How many group ids the listing names for one version.
const MAX_LISTED = 20

// Everything a version of the history prints comes from a note that may have been
// pushed by anyone: it is size-checked before it is read, cleaned, and bounded.
function summary(blob: string): string {
  const size = Number(gitTry(['cat-file', '-s', blob]))
  const big = noteSizeProblem(size)
  if (big) return `(not read: ${big})`
  try {
    const note = JSON.parse(git(['cat-file', 'blob', blob]))
    const a = note.annotation
    const from = Array.isArray(note.sources) ? `carried from ${note.sources.slice(0, 5).map((s: unknown) => plain(String(s)).slice(0, 7)).join(', ')}; ` : ''
    const ids = a.groups.slice(0, MAX_LISTED).map((g: { id: unknown }) => plain(String(g.id)).slice(0, 40))
    const n = a.groups.length
    return `${from}${n} group${n === 1 ? '' : 's'}: ${ids.join(', ')}${n > MAX_LISTED ? `, and ${n - MAX_LISTED} more` : ''}\n       task: ${JSON.stringify(plain(String(a.task)).slice(0, 200))}`
  } catch (err) {
    rethrowTimeout(err)
    return '(not a readable gloss: joined notes from a squash, or not JSON)'
  }
}

const when = (iso: string) => plain(iso).slice(0, 16).replace('T', ' ')

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { show: { type: 'string' }, restore: { type: 'string' } } })
  const wip = positionals[0] === 'wip'
  const ref = wip ? WIP_NOTES_REF : NOTES_REF
  const sha = wip ? null : resolveCommit(positionals[0] ?? 'HEAD')
  const versions = history(ref, sha ?? undefined)
  const label = sha ? sha.slice(0, 7) : 'uncommitted work'
  if (!versions.length) {
    console.log(`no glosses recorded for ${label}`)
    return 0
  }

  const pick = (arg: string, flag: string) => {
    const n = Number(arg)
    const v = versions[n - 1]
    if (!Number.isInteger(n) || !v) throw new GlossError(`${flag} takes a version number from 1 to ${versions.length}`)
    if (!v.blob) throw new GlossError(`version ${n} records the gloss being removed; pick a version with a gloss`)
    return { n, v: v as Version & { blob: string } }
  }
  if (values.show !== undefined) {
    // Cleaned like everything else printed (control characters, escape sequences, bidi and
    // zero-width characters become spaces), so not byte-identical to the stored blob.
    process.stdout.write(plain(git(['cat-file', 'blob', pick(values.show, '--show').v.blob]), true))
    return 0
  }
  if (values.restore !== undefined) {
    const { n, v } = pick(values.restore, '--restore')
    // Only a gloss that readers accept is brought back (a restore must not plant what they refuse).
    const text = git(['cat-file', 'blob', v.blob])
    let note
    try { note = parseNote(text, `version ${n}`) } catch (err) {
      if (!(err instanceof GlossError) || err instanceof GitError) throw err
      throw new GlossError(`${err.message.replace(/; (replace it|re-gloss it|upgrade).*$/, '')}, so it is not restored (read it with --show ${n})`)
    }
    // What readers refuse for the commit it would go on (too many claimed lines).
    const checkOn = (target: string) => {
      try { loadGlossOf(target, note) } catch (err) {
        if (!(err instanceof GlossError) || err instanceof GitError) throw err
        throw new GlossError(`version ${n} would be refused on ${target.slice(0, 7)}: ${err.message.replace(/^the gloss on \S+ is refused: /, '')} (not restored; read it with --show ${n})`)
      }
    }
    if (!wip) {
      checkOn(sha!)
      git(['notes', '--ref', ref, 'add', '-f', '-C', v.blob, sha!])
      console.log(`restored version ${n} as the gloss of ${label}`)
      return 0
    }
    // A wip version was written for the snapshot of its time. Carry it onto
    // the current snapshot line by line, as `carry` does, so it describes the
    // work as it is now; copy it as is only if that old snapshot is gone.
    const onto = gitTry(['rev-parse', '-q', '--verify', WIP_REF])?.trim()
    if (!onto) throw new GlossError('there is no snapshot of uncommitted work to restore onto; run git gloss hunks wip first')
    if (v.object === onto || gitTry(['cat-file', '-e', `${v.object}^{commit}`]) === null) {
      checkOn(onto)
      git(['notes', '--ref', ref, 'add', '-f', '-C', v.blob, onto])
      console.log(`restored version ${n} onto the wip snapshot ${onto.slice(0, 7)}` +
        (v.object === onto ? '' : `; its snapshot ${v.object.slice(0, 7)} is gone, so hunk references may not match: check with git gloss show wip`))
      return 0
    }
    const current = parseDiff(commitDiff(onto))
    const merged = mergeGlosses([{ sha: v.object, note, hunks: parseDiff(commitDiff(v.object)) }], current)
    if (merged.annotation) {
      const errors = carriedErrors(merged.annotation, current)
      if (errors.length) throw new GlossError(`version ${n} doesn't fit the uncommitted work: ${errors.join('; ')} (not restored)`)
    }
    if (!merged.annotation) throw new GlossError(`none of version ${n}'s glossed changes are in the uncommitted work any more; read it with --show ${n}`)
    writeNote(onto, {
      gloss: noteFormat(merged.annotation), commit: onto, created_at: new Date().toISOString(),
      annotation: merged.annotation, hunks: current.map(location), carried_from: v.object,
    }, WIP_NOTES_REF)
    console.log(`restored ${merged.annotation.groups.length} group${merged.annotation.groups.length === 1 ? '' : 's'} of version ${n} onto the wip snapshot ${onto.slice(0, 7)}` +
      (merged.dropped.length ? `\n  not restored (their changes are no longer in the work): ${merged.dropped.map((d) => d.split(':')[1]).join(', ')}` : '') +
      (merged.gaps.length ? `\n  changes it doesn't explain: ${merged.gaps.map((u) => refLabel(u.hunk.id, u.lines)).join(', ')}` : ''))
    return 0
  }

  console.log(`glosses of ${label}, newest first:`)
  versions.forEach((v, i) => {
    const head = `${String(i + 1).padStart(3)}  ${when(v.at)}  ${plain(v.how)}${wip ? `  (snapshot ${v.object.slice(0, 7)})` : ''}`
    console.log(`${head}${i === 0 && v.blob && !wip ? '  [current]' : ''}`)
    console.log(`       ${v.blob ? summary(v.blob) : 'removed'}`)
  })
  const arg = positionals[0] ?? 'HEAD'
  console.log(`\nread one: git gloss versions ${arg} --show <n>   bring one back: git gloss versions ${arg} --restore <n>`)
  return 0
}
