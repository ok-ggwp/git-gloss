import type { Hunk } from './diff.ts'
import { servesOf, type Annotation, type GlossNote } from './schema.ts'
import { bodyLines, changedCount, parseRef, selections, uncovered, type Claim, type Uncovered } from './selection.ts'
import { alsoServed } from './validate.ts'

export type Carried = {
  // The gloss as it applies to the new diff, or null if no group carried over.
  annotation: Annotation | null
  kept: number
  total: number
  // Ids of groups left behind because none of their hunks matched.
  dropped: string[]
  // Changes in the new diff the carried gloss doesn't explain.
  gaps: Uncovered[]
  // Some new hunk shares changed lines with a glossed hunk without matching
  // it: a hunk split across commits, or edited since it was glossed.
  partialMatch: boolean
}

const changedText = (h: Hunk) => new Set(bodyLines(h).filter((l) => l.idx !== null).map((l) => l.raw))

// Move a gloss onto another diff: a commit made from a wip snapshot, or a new
// snapshot of work that has partly changed. Each glossed hunk is matched to
// the new hunk with the same changes (the content hash used to follow
// rebases); a group keeps its references to the hunks that matched, renamed
// to the new ids, with line ranges unchanged because matched hunks have the
// same changed lines. Groups with no matching hunk are left behind.
// `previous` is the diff the gloss was written for, used to compare content
// (line numbers from two different bases can't be compared).
export function carryGloss(note: GlossNote, current: Hunk[], previous: Hunk[] = []): Carried {
  const used = new Set<Hunk>()
  const idMap = new Map<string, Hunk>()
  for (const stored of note.hunks) {
    const match = stored.hash ? current.find((h) => !used.has(h) && h.hash === stored.hash && h.file === stored.file) : undefined
    if (match) { used.add(match); idMap.set(stored.id, match) }
  }
  const unmatchedOld = note.hunks.filter((s) => !idMap.has(s.id))
    .flatMap((s) => previous.filter((p) => p.id === s.id && p.hash === s.hash && p.file === s.file))
    .map((p) => ({ file: p.file, lines: changedText(p) }))
  const partialMatch = current.some((h) => !used.has(h) &&
    unmatchedOld.some((p) => p.file === h.file && [...changedText(h)].some((l) => p.lines.has(l))))

  const a = note.annotation
  const kept = a.groups.flatMap((g) => {
    const hunks = g.hunks.flatMap((ref) => {
      const r = parseRef(ref)
      const h = r && idMap.get(r.hunk)
      return h ? [r.ranges ? `${h.id}:${r.ranges.map(([x, y]) => (x === y ? `${x}` : `${x}-${y}`)).join(',')}` : h.id] : []
    })
    return hunks.length ? [{ ...g, hunks }] : []
  })
  const dropped = a.groups.filter((g) => !kept.some((k) => k.id === g.id)).map((g) => g.id)
  if (!kept.length) return { annotation: null, kept: 0, total: a.groups.length, dropped, gaps: [], partialMatch }

  // A group may serve one that was left behind; point it at the task instead
  // and say so, rather than leave a reference validation would reject.
  const keptIds = new Set(kept.map((g) => g.id))
  const groups = kept.map((g) => {
    const targets = servesOf(g)
    const lost = targets.filter((t) => t !== 'task' && !keptIds.has(t))
    if (!lost.length) return g
    const remaining = targets.filter((t) => t === 'task' || keptIds.has(t))
    const note = alsoServed(lost, 'glossed with other changes')
    return { ...g, serves: remaining.length > 1 ? remaining : remaining[0] ?? 'task', notes: g.notes ? `${g.notes} ${note}` : note }
  })

  const byId = new Map(current.map((h) => [h.id, h]))
  const claims = groups.flatMap((g) =>
    [...selections(g.hunks, (id) => { const h = byId.get(id); return h && changedCount(h) })]
      .flatMap(([id, lines]): Claim[] => { const h = byId.get(id); return h ? [{ hunk: h, lines }] : [] }))
  return { annotation: { ...a, groups }, kept: groups.length, total: a.groups.length, dropped, gaps: uncovered(current, claims), partialMatch }
}
