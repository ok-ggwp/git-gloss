import { readFileSync, readSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { commitDiff, isWipSnapshot, NOTES_REF, readNote, resolveCommit, WIP_NOTES_REF, writeNote } from '../git.ts'
import { location, parseDiff } from '../diff.ts'
import { Annotation, noteFormat } from '../schema.ts'
import { validate } from '../validate.ts'
import { loadConfig } from '../config.ts'
import { analyzeGroups, groupInputsFor, ratingProblems } from '../floor.ts'

// readFileSync(0) throws EAGAIN when the pipe is non-blocking and momentarily empty
// (a big gloss from a slower writer): wait a moment and read on.
function readStdin(): string {
  const chunks: Buffer[] = []
  const buf = Buffer.alloc(1 << 20)
  for (;;) {
    let n: number
    try { n = readSync(0, buf) } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); continue }
      if (code === 'EOF') break
      throw err
    }
    if (n === 0) break
    chunks.push(Buffer.from(buf.subarray(0, n)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const usage = 'add [<commit>] [-f <file>] [--force] [--partial] [--allow-underrate] [--dry-run]   attach an annotation (JSON from file or stdin)'

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      file: { type: 'string', short: 'f' },
      force: { type: 'boolean' },
      partial: { type: 'boolean' },
      'allow-underrate': { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')

  if (!values.file && process.stdin.isTTY) {
    console.error('error: pipe annotation JSON on stdin or pass -f <file> (see `git gloss schema`)')
    return 2
  }
  const raw = values.file ? readFileSync(values.file, 'utf8') : readStdin()

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
  // Computed signals: group impact below its floor is a warning; attention
  // below the floor is an error unless explained (override_reason) or allowed.
  // A malformed config stops here with its own message.
  const warnings: string[] = []
  if (!errors.length) {
    const analysis = analyzeGroups(hunks, groupInputsFor(parsed.data, hunks), loadConfig())
    const problems = ratingProblems(parsed.data, analysis)
    warnings.push(...problems.warnings)
    if (problems.underrated) (values['allow-underrate'] ? warnings : errors).push(problems.underrated)
  }
  if (errors.length) {
    console.error('error: annotation is inconsistent with the commit:\n' + errors.map((e) => `  ✖ ${e}`).join('\n'))
    return 1
  }

  for (const w of warnings) console.error(`warning: ${w}`)
  // Not an error: long intents still work, but they make the summary rows tall.
  for (const g of parsed.data.groups.filter((g) => g.intent.length > 100)) {
    console.error(`note: group "${g.id}" has a ${g.intent.length}-character intent; keep it under ~80 and move detail to "notes"`)
  }

  if (values['dry-run']) {
    console.log(`ok: annotation is valid for ${sha.slice(0, 10)} (${parsed.data.groups.length} groups, ${hunks.length} hunks)`)
    return 0
  }
  // A gloss carried over from an earlier snapshot, or by `carry` from the
  // commits these changes came from, is a starting point; a fresh gloss
  // replaces it without --force (the old one stays in the notes history).
  const existing = values.force ? null : readNote(sha)
  if (existing && !existing.carried_from && !existing.sources) {
    console.error(`error: ${sha.slice(0, 10)} already has a gloss; pass --force to replace it`)
    return 1
  }

  // Store a one-item serves list as a plain string: same meaning, and it keeps
  // the note readable by versions without list support (format below 3).
  for (const g of parsed.data.groups) if (Array.isArray(g.serves) && g.serves.length === 1) g.serves = g.serves[0]

  writeNote(sha, {
    gloss: noteFormat(parsed.data),
    commit: sha,
    created_at: new Date().toISOString(),
    annotation: parsed.data,
    hunks: hunks.map(location),
  }, isWipSnapshot(sha) ? WIP_NOTES_REF : NOTES_REF)
  console.log(`glossed ${sha.slice(0, 10)}: ${parsed.data.groups.length} groups over ${hunks.length} hunks`)
  return 0
}
