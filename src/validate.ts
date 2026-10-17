import type { Annotation } from './schema.ts'
import type { Hunk } from './diff.ts'

export type ValidationResult = { errors: string[]; uncovered: string[] }

export function validate(annotation: Annotation, hunks: Hunk[]): ValidationResult {
  const errors: string[] = []
  const hunkIds = new Set(hunks.map((h) => h.id))
  const groupIds = new Set<string>()

  for (const g of annotation.groups) {
    if (groupIds.has(g.id)) errors.push(`duplicate group id "${g.id}"`)
    groupIds.add(g.id)
  }

  const covered = new Set<string>()
  for (const g of annotation.groups) {
    for (const id of g.hunks) {
      if (!hunkIds.has(id)) errors.push(`group "${g.id}" references unknown hunk "${id}"`)
      covered.add(id)
    }
    if (g.serves !== 'task' && !groupIds.has(g.serves)) {
      errors.push(`group "${g.id}" serves unknown group "${g.serves}" (use "task" or a group id)`)
    }
    if (g.serves === g.id) errors.push(`group "${g.id}" cannot serve itself`)
    if (g.necessity === 'supporting' && g.serves === 'task') {
      errors.push(`group "${g.id}" is "supporting" but serves "task"; name the group it supports`)
    }
  }

  const uncovered = hunks.map((h) => h.id).filter((id) => !covered.has(id))
  return { errors, uncovered }
}
