import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { commitDiff, readNote, resolveCommit, writeNote } from '../git.ts'
import { location, parseDiff } from '../diff.ts'
import { Annotation } from '../schema.ts'
import { validate } from '../validate.ts'

export const usage = 'add [<commit>] [-f <file>] [--force] [--partial] [--dry-run]   attach an annotation (JSON from file or stdin)'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: 'string', short: 'f' },
      force: { type: 'boolean' },
      partial: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')

  if (!values.file && process.stdin.isTTY) {
    console.error('error: pipe annotation JSON on stdin or pass -f <file> (see `git gloss schema`)')
    return 2
  }
  const raw = readFileSync(values.file ?? 0, 'utf8')

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    console.error(`error: annotation is not valid JSON: ${(err as Error).message}`)
    return 1
  }
  const parsed = Annotation.safeParse(json)
  if (!parsed.success) {
    console.error('error: annotation does not match the schema:\n' + z.prettifyError(parsed.error))
    return 1
  }

  const hunks = parseDiff(commitDiff(sha))
  const { errors, uncovered } = validate(parsed.data, hunks)
  if (uncovered.length && !values.partial) {
    errors.push(`hunks not assigned to any group: ${uncovered.join(', ')} (every hunk needs a group, or pass --partial)`)
  }
  if (errors.length) {
    console.error('error: annotation is inconsistent with the commit:\n' + errors.map((e) => `  ✖ ${e}`).join('\n'))
    return 1
  }

  if (values['dry-run']) {
    console.log(`ok: annotation is valid for ${sha.slice(0, 10)} (${parsed.data.groups.length} groups, ${hunks.length} hunks)`)
    return 0
  }
  if (!values.force && readNote(sha)) {
    console.error(`error: ${sha.slice(0, 10)} already has a gloss; pass --force to replace it`)
    return 1
  }

  writeNote(sha, {
    gloss: 1,
    commit: sha,
    created_at: new Date().toISOString(),
    annotation: parsed.data,
    hunks: hunks.map(location),
  })
  console.log(`glossed ${sha.slice(0, 10)}: ${parsed.data.groups.length} groups over ${hunks.length} hunks`)
  return 0
}
