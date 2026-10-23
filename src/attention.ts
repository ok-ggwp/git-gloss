import { ATTENTION, IMPACT, type Attention, type Group, type Impact } from './schema.ts'

// Rank of a group's impact; a group with none is below every level.
export const impactRank = (i: Impact | undefined) => (i ? IMPACT.indexOf(i) : -1)

// What the reviewer should do when glosses are combined (a squash, a rebase):
// the highest level of any of them. Focus groups of all of them, renamed to
// their new ids (`rename` returns undefined for a group that is gone), most
// impactful first, without repeats, at most three. Reasons are unioned.
export function combineAttention(parts: Attention[], rename: (part: number, id: string) => string | undefined, groups: Group[]): Attention | undefined {
  if (!parts.length) return undefined
  const level = parts.map((p) => p.level).reduce((a, b) => (ATTENTION.indexOf(b) > ATTENTION.indexOf(a) ? b : a))
  const impactOf = new Map(groups.map((g) => [g.id, g.impact]))
  const focus = [...new Set(parts.flatMap((p, i) => (p.focus ?? []).flatMap((id) => rename(i, id) ?? [])))]
    .sort((a, b) => impactRank(impactOf.get(b)) - impactRank(impactOf.get(a)))
    .slice(0, 3)
  const reasons = [...new Set(parts.flatMap((p) => p.reasons ?? []))]
  const overrides = [...new Set(parts.flatMap((p) => (p.override_reason && p.level === level ? [p.override_reason] : [])))]
  return {
    level,
    ...(focus.length ? { focus } : {}),
    ...(reasons.length ? { reasons } : {}),
    ...(overrides.length ? { override_reason: overrides.join('; ') } : {}),
  }
}
