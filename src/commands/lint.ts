import { parseArgs } from 'node:util'
import { GlossError, resolveCommits } from '../git.ts'
import { loadGloss } from '../loader.ts'
import { ratingIssues, tryAnalyze, whyText } from '../floor.ts'
import { attentionRank, impactRank } from '../attention.ts'
import { servesOf } from '../schema.ts'
import { unknownServes } from '../validate.ts'
import { plain } from '../plain.ts'

export const usage = 'lint [<commit> | wip] [--json]   advisory checks of a gloss that a reviewer would make by eye (always exits 0 for findings)'

export type Finding = { code: string; group?: string; hunk?: string; message: string }

// What removal_impact says when it admits the group is not needed. Matched on the
// lowercased text, after plain(): BARE phrases only when they are the whole text
// ("Nothing." but not "Nothing else would work"); the others may start it.
const NOTHING_BREAKS_WHOLE = ['nothing', 'none', 'n/a']
const NOTHING_BREAKS_START = ['nothing breaks', 'nothing would break', 'nothing is lost', 'nothing happens', 'no effect', 'no impact']

export function saysNothingBreaks(text: string): boolean {
  const t = plain(text).toLowerCase().trim().replace(/[\s.!;:,]+$/, '')
  if (NOTHING_BREAKS_WHOLE.includes(t)) return true
  return NOTHING_BREAKS_START.some((p) => t === p || (t.startsWith(p) && /^[\s.,;:!-]/.test(t.slice(p.length))))
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { json: { type: 'boolean' } } })
  const arg = positionals[0] ?? 'HEAD'
  const { shas, range } = resolveCommits(arg)
  if (range) throw new GlossError(`${arg}: lint takes one commit or wip, not a range`)
  const sha = shas[0]
  const gloss = loadGloss(sha)
  if (!gloss) throw new GlossError(`${sha.slice(0, 10)} has no gloss (annotate it with \`git gloss add\`)`)
  for (const w of gloss.warnings) console.error(`warning: ${plain(w)}`)

  const a = gloss.note.annotation
  const findings: Finding[] = []
  // Text from a note is sanitized here, once, for both outputs.
  const add = (code: string, message: string, at: { group?: string; hunk?: string } = {}) =>
    findings.push({ code, ...(at.group !== undefined && { group: plain(at.group) }), ...(at.hunk !== undefined && { hunk: plain(at.hunk) }), message: plain(message) })
  const ids = new Set(a.groups.map((g) => g.id))
  const an = tryAnalyze(gloss)

  if (an) {
    const issues = ratingIssues(a, an)
    for (const u of issues.unrated) add('no-impact', `no impact rated${u.signal ? ` (floor ${u.floor}: ${whyText(u.why)})` : ''}`, { group: u.id })
    for (const b of issues.belowFloor) add('impact-below-floor', `impact "${b.impact}" is below its floor "${b.floor}" (${whyText(b.why)})`, { group: b.id })
    if (issues.attention) add('attention-below-floor', `attention "${issues.attention.level}" is below the computed floor "${issues.attention.floor}" (${issues.attention.why}) and has no override_reason`)
    const sigOf = new Map(an.signals.hunks.map((s) => [s.id, s]))
    for (const g of gloss.groups) {
      const f = an.groups.get(g.group.id)
      // A mechanical group made only of lockfiles, docs, tests or generated files sits on a path-class floor honestly (the skill's lockfile example).
      const real = g.hunks.some((h) => h.current && !sigOf.get(h.current.id)?.inert)
      if (g.group.necessity === 'mechanical' && f && impactRank(f.floor) > impactRank('module') && real) {
        add('mechanical-on-floor', `graded mechanical but its floor is "${f.floor}" (${whyText(f.why)})`, { group: g.group.id })
      }
      if (f?.testsOnly && !servesOf(g.group).some((t) => t !== 'task' && ids.has(t) && t !== g.group.id)) {
        add('test-serves-nothing', 'a test group that serves no existing group (set serves to the groups it verifies)', { group: g.group.id })
      }
    }
  }
  for (const g of a.groups) {
    const bad = unknownServes(g, ids)
    if (bad.length) add('unknown-serves', `serves names no such group: ${bad.map((t) => `"${t}"`).join(', ')}`, { group: g.id })
    if (g.necessity === 'required' && saysNothingBreaks(g.removal_impact)) {
      add('required-but-nothing-breaks', `graded required but removal_impact says: "${g.removal_impact}"`, { group: g.id })
    }
  }
  const level = a.attention?.level ?? an?.derived.level
  if (level && attentionRank(level) >= attentionRank('careful') && !a.risks?.length) {
    add('missing-risks', `attention is ${level} but no risks are listed`)
  }
  for (const u of gloss.unannotated) {
    add('uncovered-hunks', `${u.hunk.file}: ${u.lines ? `changed lines ${[...u.lines].join(',')}` : 'the whole hunk'} not covered by any group`, { hunk: u.hunk.id })
  }

  if (values.json) {
    console.log(JSON.stringify({ target: sha.slice(0, 10), findings, ...(an ? {} : { incomplete: true }) }, null, 2))
    return 0
  }
  const subjects = new Map<string, Finding[]>()
  for (const f of findings) {
    const key = f.group !== undefined ? `group ${f.group}` : f.hunk !== undefined ? `hunk ${f.hunk}` : 'whole gloss'
    subjects.set(key, [...(subjects.get(key) ?? []), f])
  }
  for (const [key, fs] of subjects) {
    console.log(key)
    for (const f of fs) console.log(`  ${f.code.padEnd(28)} ${f.message}`)
  }
  if (findings.length) console.log(`${findings.length} finding${findings.length === 1 ? '' : 's'}`)
  if (!an) console.log('incomplete: the rating checks need the diff signals, which are unavailable (see the warning above)')
  else if (!findings.length) console.log('clean')
  return 0
}
