import type { Annotation } from './schema.ts'
import type { Hunk } from './diff.ts'
import { changedCount, parseRef, refLabel, selections, uncovered, type Claim } from './selection.ts'

export type ValidationResult = { errors: string[]; uncovered: string[] }

export function validate(annotation: Annotation, hunks: Hunk[]): ValidationResult {
  const errors: string[] = []
  const groupIds = new Set<string>()

  for (const g of annotation.groups) {
    if (groupIds.has(g.id)) errors.push(`duplicate group id "${g.id}"`)
    groupIds.add(g.id)
  }

  const byHunkId = new Map(hunks.map((h) => [h.id, h]))
  const claims: Claim[] = []
  for (const g of annotation.groups) {
    for (const ref of g.hunks) {
      const r = parseRef(ref)!
      const h = byHunkId.get(r.hunk)
      if (!h) { errors.push(`group "${g.id}" references unknown hunk "${r.hunk}"`); continue }
      const n = changedCount(h)
      for (const [a, b] of r.ranges ?? []) {
        if (n === 0) errors.push(`group "${g.id}": ${r.hunk} has no changed lines to select; reference it whole`)
        else if (a < 1 || b < a || b > n) errors.push(`group "${g.id}": "${ref}" is out of range; ${r.hunk} has changed lines 1-${n}`)
      }
    }
    for (const [id, lines] of selections(g.hunks)) {
      const h = byHunkId.get(id)
      if (h) claims.push({ hunk: h, lines })
    }
    if (g.serves !== 'task' && !groupIds.has(g.serves)) {
      errors.push(`group "${g.id}" serves unknown group "${g.serves}" (use "task" or a group id)`)
    }
    if (g.serves === g.id) errors.push(`group "${g.id}" cannot serve itself`)
    if (g.necessity === 'supporting' && g.serves === 'task') {
      errors.push(`group "${g.id}" is "supporting" but serves "task"; name the group it supports`)
    }
  }

  const byId = new Map(annotation.groups.map((g) => [g.id, g]))
  for (const g of annotation.groups) {
    const seen = new Set([g.id])
    let cur = byId.get(g.serves)
    while (cur && !seen.has(cur.id)) { seen.add(cur.id); cur = byId.get(cur.serves) }
    if (cur?.id === g.id) errors.push(`group "${g.id}" is in a serves cycle; every chain must end at "task"`)
  }

  return { errors, uncovered: uncovered(hunks, claims).map((u) => refLabel(u.hunk.id, u.lines)) }
}
