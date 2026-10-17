import { parseArgs } from 'node:util'
import { commitDiff, commitSubject, readNote, resolveCommit } from '../git.ts'
import { parseDiff } from '../diff.ts'
import { NECESSITY_HELP } from '../schema.ts'

export const usage = 'review [<commit>]   print a review prompt (pipe it to an agent, e.g. `| claude -p`)'

export function run(argv: string[]): number {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')
  const note = readNote(sha)
  if (!note) {
    console.error(`${sha.slice(0, 10)} has no gloss to review`)
    return 1
  }
  const hunks = new Map(parseDiff(commitDiff(sha)).map((h) => [h.id, h]))
  const a = note.annotation

  const groups = a.groups.map((g) => [
    `### Group \`${g.id}\` [${g.necessity}]`,
    `- intent: ${g.intent}`,
    `- serves: ${g.serves}`,
    `- if removed: ${g.removal_impact}`,
    ...(g.evidence ? [`- evidence: ${g.evidence}`] : []),
    ...(g.notes ? [`- notes: ${g.notes}`] : []),
    '',
    '```diff',
    ...g.hunks.map((id) => hunks.get(id)?.text ?? `(hunk ${id} missing)`),
    '```',
  ].join('\n'))

  console.log(`You are reviewing a commit whose author (usually an AI agent) annotated each part of the change with its intent and how necessary it is. The annotations are self-reported and may be wrong or self-serving. Your job is to check them against the code.

Necessity categories:
${Object.entries(NECESSITY_HELP).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Report, most important first:
1. **Mismatches** — where the code does not do what the stated intent says, or does more than it says.
2. **Misgraded necessity** — groups labelled required/supporting that look incidental, defensive or speculative, and vice versa. Be sceptical of "required".
3. **Removal candidates** — groups that could be dropped or deferred without hurting the task, with the expected impact.
4. **Simplifications** — a smaller or clearer way to achieve a group's intent.
5. **Missing risks** — risks the author did not list.

For each finding, cite the group id and explain briefly. If the annotation is accurate and the change is lean, say so.

---

## Commit ${sha.slice(0, 10)}: ${commitSubject(sha)}

**Task:** ${a.task}
${a.summary ? `\n**Summary:** ${a.summary}\n` : ''}
${groups.join('\n\n')}
${a.alternatives?.length ? `\n## Alternatives the author considered\n${a.alternatives.map((x) => `- ${x.option} — ${x.rejected_because}`).join('\n')}\n` : ''}${a.risks?.length ? `\n## Risks the author listed\n${a.risks.map((r) => `- ${r}`).join('\n')}\n` : ''}`)
  return 0
}
