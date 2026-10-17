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

export const NECESSITY_HELP: Record<Necessity, string> = {
  required: 'The task cannot be done without this change',
  supporting: 'Needed only because another group needs it (name that group in `serves`)',
  mechanical: 'Follow-on edits with no design content: renames, imports, formatting, lockfiles',
  incidental: 'Drive-by cleanup or refactor the task did not ask for',
  defensive: 'Guards edge cases or failures nobody asked about',
  speculative: 'Added because it might be useful later',
}

export const Group = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase kebab-case')
    .describe('Short unique id for this group, e.g. "retry-core"'),
  intent: z.string().min(1).describe('What this group of changes does, in one short sentence (under ~80 characters)'),
  necessity: z.enum(NECESSITY).describe('How necessary the change is to the task'),
  serves: z
    .string()
    .describe('"task" if it serves the task directly, otherwise the id of the group it supports'),
  removal_impact: z
    .string()
    .min(1)
    .describe('What concretely breaks or is lost if this group is removed'),
  evidence: z
    .string()
    .optional()
    .describe('A test, requirement or task line that demonstrates the need'),
  hunks: z
    .array(z.string().regex(REF_PATTERN, 'use a hunk id like "h3", or changed lines of one like "h3:2-5" or "h3:1,4-6"'))
    .min(1)
    .describe('Hunks from `git gloss hunks` that belong to this group: "h3" for a whole hunk, "h3:2-5" for its changed lines 2 to 5'),
  notes: z.string().optional(),
})

export const Annotation = z.object({
  version: z.literal(1).default(1),
  task: z.string().min(1).describe('The task or request these changes were made for'),
  summary: z.string().optional().describe('One or two sentences on the overall change'),
  groups: z.array(Group).min(1),
  alternatives: z
    .array(z.object({ option: z.string(), rejected_because: z.string() }))
    .optional()
    .describe('Approaches considered and why they were not taken'),
  risks: z.array(z.string()).optional().describe('Known risks or open questions'),
  author: z
    .object({
      agent: z.string().optional(),
      model: z.string().optional(),
      session: z.string().optional(),
    })
    .optional(),
})

export type Group = z.infer<typeof Group>
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
// Format 2 marks notes that use line ranges ("h3:2-5"), so versions that only
// understand whole-hunk references report "written by a newer git-gloss"
// instead of silently treating ranged groups as missing.
export type GlossNote = {
  gloss: 1 | 2
  commit: string
  created_at: string
  annotation: Annotation
  hunks: HunkLocation[]
}
