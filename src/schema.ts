import { z } from 'zod'
import { REF_PATTERN } from './selection.ts'

// In the order `show` lists groups: what the task needs, then what a reviewer
// might cut, then edits with no design content.
export const NECESSITY = [
  'required',
  'supporting',
  'defensive',
  'incidental',
  'speculative',
  'mechanical',
] as const

export type Necessity = (typeof NECESSITY)[number]

export const isNecessity = (s: string): s is Necessity => (NECESSITY as readonly string[]).includes(s)

export const NECESSITY_HELP: Record<Necessity, string> = {
  required: 'The task cannot be done without this change',
  supporting: 'Needed only because other groups need it (name them in `serves`)',
  mechanical: 'Follow-on edits with no design content: renames, imports, formatting, lockfiles',
  incidental: 'Drive-by cleanup or refactor the task did not ask for',
  defensive: 'Guards edge cases or failures nobody asked about',
  speculative: 'Added because it might be useful later',
}

// How far a group's effect reaches if it is wrong, lowest first.
export const IMPACT = ['local', 'module', 'shared', 'contract', 'sensitive'] as const

export type Impact = (typeof IMPACT)[number]

export const isImpact = (s: string): s is Impact => (IMPACT as readonly string[]).includes(s)

export const IMPACT_HELP: Record<Impact, string> = {
  local: 'Contained in one file or component; no outside callers (a private helper, template text, a test)',
  module: 'One feature or project; its callers are inside it',
  shared: 'Code used by several projects or modules, or root build, test or lint config',
  contract: 'An interface others depend on: public APIs, routes, state shape, message formats, schemas, config keys, dependency versions, CI definitions',
  sensitive: 'Correctness or safety critical whatever the size: auth, crypto, permissions, data writes or deletes, payments, hardware I/O, secrets',
}

// What a reviewer should do with the change, lowest first.
export const ATTENTION = ['skim', 'look', 'careful', 'must-read'] as const

export type AttentionLevel = (typeof ATTENTION)[number]

export const ATTENTION_HELP: Record<AttentionLevel, string> = {
  skim: 'Glance at the summary',
  look: 'Read the focus groups',
  careful: 'Read every non-mechanical group',
  'must-read': 'Read line by line before approving',
}

// Notes come from anyone who can push to the remote, and the readers cost more
// than linear in the groups (the page lists, for each group, the groups it
// shares lines with) and spread lists into function calls. Real glosses have
// a few dozen groups; these are far above that.
export const MAX_GROUPS = 500
export const MAX_ITEMS = 500

export const Group = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase kebab-case')
    .describe('Short unique id for this group, e.g. "retry-core"'),
  intent: z.string().min(1).describe('What this group of changes does, in one short sentence (under ~80 characters)'),
  necessity: z.enum(NECESSITY).describe('How necessary the change is to the task'),
  serves: z
    .union([z.string(), z.array(z.string()).min(1)])
    .describe('"task" if it serves the task directly, otherwise the id of the group it supports, or a list of ids when it supports several (e.g. tests)'),
  removal_impact: z
    .string()
    .min(1)
    .describe('What concretely breaks or is lost if this group is removed'),
  evidence: z
    .string()
    .optional()
    .describe('A test, requirement or task line that demonstrates the need'),
  impact: z
    .enum(IMPACT)
    .optional()
    .describe('How far the effect reaches if this group is wrong: ' + IMPACT.join(' < ') + '; the highest that applies'),
  impact_reason: z
    .string()
    .max(120)
    .optional()
    .describe('One short sentence on why the impact applies (expected for contract and sensitive)'),
  hunks: z
    .array(z.string().regex(REF_PATTERN, 'use a hunk id like "h3", or changed lines of one like "h3:2-5" or "h3:1,4-6"'))
    .min(1)
    .describe('Hunks from `git gloss hunks` that belong to this group: "h3" for a whole hunk, "h3:2-5" for its changed lines 2 to 5'),
  notes: z.string().optional(),
})

export const Attention = z.object({
  level: z.enum(ATTENTION).describe('What the reviewer should do: ' + ATTENTION.map((l) => `${l} (${ATTENTION_HELP[l].toLowerCase()})`).join(', ')),
  focus: z
    .array(z.string())
    .min(1)
    .max(3)
    .optional()
    .describe('One to three group ids to look at first'),
  reasons: z.array(z.string()).max(MAX_ITEMS).optional().describe('Short reasons for the level'),
  override_reason: z.string().optional().describe('Why the level is lower than the change would suggest, if it is'),
})

export type Attention = z.infer<typeof Attention>

export const Annotation = z.object({
  version: z.literal(1).default(1),
  task: z.string().min(1).describe('The task or request these changes were made for'),
  summary: z.string().optional().describe('One or two sentences on the overall change'),
  groups: z.array(Group).min(1).max(MAX_GROUPS),
  alternatives: z
    .array(z.object({ option: z.string(), rejected_because: z.string() }))
    .max(MAX_ITEMS)
    .optional()
    .describe('Approaches considered and why they were not taken'),
  risks: z.array(z.string()).max(MAX_ITEMS).optional().describe('Known risks or open questions'),
  attention: Attention.optional().describe('How much attention a human reviewer should give this change'),
  author: z
    .object({
      agent: z.string().optional(),
      model: z.string().optional(),
      session: z.string().optional(),
    })
    .optional(),
})

export type Group = z.infer<typeof Group>

// A group's serves targets as a list, whichever form the gloss used.
export const servesOf = (g: Pick<Group, 'serves'>): string[] => (Array.isArray(g.serves) ? g.serves : [g.serves])

// Note formats: 1 whole-hunk references only; 2 line ranges ("h3:2-5");
// 3 serves lists; 4 impact, impact_reason or attention. A note is written with the lowest format that can hold it,
// so older readers only refuse notes that use something they can't read.
export const NOTE_FORMAT = 4
export function noteFormat(a: Annotation): 1 | 2 | 3 | 4 {
  // Readers of lower formats drop fields they don't know (they would lose
  // these on a carry), so they must refuse the note instead.
  if (a.attention || a.groups.some((g) => g.impact || g.impact_reason)) return 4
  if (a.groups.some((g) => servesOf(g).length > 1)) return 3
  if (a.groups.some((g) => g.hunks.some((ref) => ref.includes(':')))) return 2
  return 1
}
export type Annotation = z.infer<typeof Annotation>

export type HunkLocation = {
  id: string
  file: string
  oldFile: string | null
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  // Hash of the hunk's added/removed lines, to find it again after a rebase
  // and to detect a gloss carried onto a changed commit.
  // Optional because glosses written before it existed don't have it.
  hash?: string
}

// What is actually stored in the git note: the annotation plus where each hunk
// was, so `why` can map a blamed line back to a group without re-diffing.
// See NOTE_FORMAT: versions that don't understand a feature report "written
// by a newer git-gloss" instead of misreading the note.
export type GlossNote = {
  gloss: 1 | 2 | 3 | 4
  commit: string
  created_at: string
  annotation: Annotation
  hunks: HunkLocation[]
  // Set when the gloss was carried over from an earlier wip snapshot (the
  // parts whose changes were unchanged); a fresh gloss may replace it.
  carried_from?: string
  // Set when the gloss was built by `carry` from the glosses of the commits
  // these changes came from (a squash, cherry-pick or rebase); a fresh gloss
  // may replace it.
  sources?: string[]
}
