import { servesOf, type Annotation } from './schema.ts'
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
      if (r.ranges && n === 0) errors.push(`group "${g.id}": ${r.hunk} has no changed lines to select; reference it whole`)
      else if (r.ranges?.some(([a, b]) => b < a)) {
        errors.push(`group "${g.id}": "${ref}" runs backwards; write ranges low to high, e.g. ${r.hunk}:3-5`)
      } else if (r.ranges?.some(([a, b]) => a < 1 || b > n)) {
        errors.push(`group "${g.id}": "${ref}" is out of range; ${r.hunk} has changed lines 1-${n}`)
      }
    }
    for (const [id, lines] of selections(g.hunks, (id) => { const h = byHunkId.get(id); return h && changedCount(h) })) {
      const h = byHunkId.get(id)
      if (h) claims.push({ hunk: h, lines })
    }
    const targets = servesOf(g)
    for (const t of targets) {
      if (t !== 'task' && !groupIds.has(t)) errors.push(`group "${g.id}" serves unknown group "${t}" (use "task" or group ids)`)
      if (t === g.id) errors.push(`group "${g.id}" cannot serve itself`)
    }
    if (targets.length > 1 && targets.includes('task')) {
      errors.push(`group "${g.id}" serves "task" and groups; use "task" alone or list only groups`)
    }
    if (new Set(targets).size < targets.length) errors.push(`group "${g.id}" lists a serves target twice`)
    if (g.necessity === 'supporting' && targets.includes('task')) {
      errors.push(`group "${g.id}" is "supporting" but serves "task"; name the group(s) it supports`)
    }
  }

  // A group is in a cycle if it can reach itself by following serves links.
  const byId = new Map(annotation.groups.map((g) => [g.id, g]))
  for (const g of annotation.groups) {
    const seen = new Set<string>()
    const queue = servesOf(g).filter((t) => t !== 'task')
    while (queue.length) {
      const id = queue.shift()!
      if (id === g.id) { errors.push(`group "${g.id}" is in a serves cycle; every chain must end at "task"`); break }
      if (seen.has(id)) continue
      seen.add(id)
      queue.push(...servesOf(byId.get(id) ?? { serves: 'task' }).filter((t) => t !== 'task'))
    }
  }

  return { errors, uncovered: uncovered(hunks, claims).map((u) => refLabel(u.hunk.id, u.lines)) }
}
