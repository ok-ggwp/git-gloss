import type { Hunk } from './diff.ts'
import { matchHunks } from './loader.ts'
import { combineAttention } from './attention.ts'
import { servesOf, type Annotation, type Group, type GlossNote } from './schema.ts'
import { bodyLines, changedCount, formatRanges, selections, uncovered, type Claim, type Uncovered } from './selection.ts'
import { alsoServed } from './validate.ts'

export type Source = { sha: string; note: GlossNote; hunks: Hunk[] }

export type Merged = {
  // The gloss for the target, or null if no source explains any of its changes.
  annotation: Annotation | null
  // Sources that explain at least one change in the target, in source order.
  used: string[]
  // Source groups with no change left in the target (undone, or rewritten by
  // a later source), as "<sha7>:<group>".
  dropped: string[]
  // Changes in the target that no source explains.
  gaps: Uncovered[]
  // Source hunks whose glossed changes no longer match the source commit's
  // diff (the gloss was copied onto a changed commit), as "<sha7>:<hunk>";
  // their lines are not used.
  stale: string[]
}

type Owner = { src: number; group: string }

// A changed line is identified by its file and its text with the +/- sign.
const lineKey = (file: string, raw: string) => `${file}\0${raw}`
// A header-only hunk (binary, rename, mode change) by its file and content hash.
const metaKey = (h: Hunk, file = h.file) => `meta\0${file}\0${h.hash}`

// Build one gloss for `target` (the diff of a commit) from the glosses of the
// commits its changes came from: a squash of several commits, a cherry-pick,
// a rebase whose diff changed. Each changed line in the target is matched to
// a source line with the same file and text, and takes that line's group.
// For an added line the latest source wins (the last commit to write that
// text); for a removed line, the earliest. Each source line is used once, and
// a line several groups wrote (such as "}") goes to the group of its nearest
// neighbour, so repeated lines are shared out sensibly. Groups keep their intent, grade and notes; lines no source explains
// are left as gaps, never assigned to a guess.
export function mergeGlosses(sources: Source[], target: Hunk[]): Merged {
  const pools = new Map<string, Owner[]>()
  const add = (key: string, owner: Owner) => {
    const pool = pools.get(key)
    if (pool) pool.push(owner)
    else pools.set(key, [owner])
  }
  // A file renamed by a later source is known in the target by its last name,
  // so lines written under an earlier name follow the renames.
  const renames = sources.map((s) => new Map(s.hunks.filter((h) => h.oldFile && h.oldFile !== h.file).map((h) => [h.oldFile!, h.file])))
  const finalName = (file: string, src: number) => {
    for (let i = src + 1; i < sources.length; i++) file = renames[i].get(file) ?? file
    return file
  }
  const stale: string[] = []
  sources.forEach((s, src) => {
    // Hunk ids are positional, so a stored id is resolved to the source's
    // current hunk by content; a hunk whose changes differ from what was
    // glossed is left out rather than read under the wrong group.
    const byId = new Map<string, Hunk>()
    for (const [id, r] of matchHunks(s.note.hunks, s.hunks)) {
      if (r.status === 'ok' && r.current) byId.set(id, r.current)
      else stale.push(`${s.sha.slice(0, 7)}:${id}`)
    }
    for (const g of s.note.annotation.groups) {
      for (const [id, sel] of selections(g.hunks, (hid) => { const h = byId.get(hid); return h && changedCount(h) })) {
        const h = byId.get(id)
        if (!h) continue
        if (changedCount(h) === 0) { add(metaKey(h, finalName(h.file, src)), { src, group: g.id }); continue }
        for (const l of bodyLines(h)) {
          if (l.idx !== null && (sel === null || sel.has(l.idx))) add(lineKey(finalName(h.file, src), l.raw), { src, group: g.id })
        }
      }
    }
  })

  // Takes a source line for one of `keys`: from `prefer`'s group when it has
  // one, else the latest source (added lines) or the earliest (removed lines).
  const take = (keys: string[], latest: boolean, prefer?: Owner): Owner | null => {
    for (const key of keys) {
      const pool = pools.get(key)
      if (!pool?.length) continue
      // Pools are filled in source order, so the last entry is the latest.
      let best = prefer ? pool.findIndex((o) => o.src === prefer.src && o.group === prefer.group) : -1
      if (best < 0) best = latest ? pool.length - 1 : 0
      return pool.splice(best, 1)[0]
    }
    return null
  }
  const owners = (keys: string[]) => new Set(keys.flatMap((k) => (pools.get(k) ?? []).map((o) => `${o.src}\0${o.group}`)))

  // Claimed lines per source group, per target hunk.
  const claimed = new Map<string, Map<Hunk, Set<number> | null>>()
  const claim = (o: Owner, h: Hunk, idx: number | null) => {
    const key = `${o.src}\0${o.group}`
    let byHunk = claimed.get(key)
    if (!byHunk) claimed.set(key, (byHunk = new Map()))
    if (idx === null) { byHunk.set(h, null); return }
    const set = byHunk.get(h)
    if (set === null) return
    byHunk.set(h, (set ?? new Set()).add(idx))
  }
  for (const h of target) {
    if (changedCount(h) === 0) {
      const o = take([metaKey(h)], true)
      if (o) claim(o, h, null)
      continue
    }
    // A line may have been written under the file's earlier name.
    const files = h.oldFile && h.oldFile !== h.file ? [h.file, h.oldFile] : [h.file]
    const lines = bodyLines(h).filter((l) => l.idx !== null).map((l) => ({ l, keys: files.map((f) => lineKey(f, l.raw)) }))
    // First the lines only one group could own; then lines several groups
    // wrote (such as "}"), which go to the group of the nearest line above,
    // or else below, that one of them owns.
    const got = new Map<number, Owner>()
    for (const { l, keys } of lines) {
      if (owners(keys).size !== 1) continue
      const o = take(keys, l.kind === 'add')
      if (o) got.set(l.idx!, o)
    }
    lines.forEach(({ l, keys }, i) => {
      if (got.has(l.idx!) || !owners(keys).size) return
      const candidates = owners(keys)
      const near = [...lines.slice(0, i).reverse(), ...lines.slice(i + 1)]
        .map((x) => got.get(x.l.idx!)).find((o) => o && candidates.has(`${o.src}\0${o.group}`))
      const o = take(keys, l.kind === 'add', near)
      if (o) got.set(l.idx!, o)
    })
    for (const [idx, o] of got) claim(o, h, idx)
  }

  // The groups that kept a change, in source order then group order. Ids that
  // clash between sources get the source's position appended.
  const kept: { src: number; g: Group; byHunk: Map<Hunk, Set<number> | null> }[] = []
  const dropped: string[] = []
  sources.forEach((s, src) => s.note.annotation.groups.forEach((g) => {
    const byHunk = claimed.get(`${src}\0${g.id}`)
    if (byHunk) kept.push({ src, g, byHunk })
    else dropped.push(`${s.sha.slice(0, 7)}:${g.id}`)
  }))
  if (!kept.length) return { annotation: null, used: [], dropped, gaps: [], stale }

  const used = [...new Set(kept.map((k) => k.src))]
  const several = used.length > 1
  const clash = new Set(kept.map((k) => k.g.id).filter((id, i, all) => all.indexOf(id) !== i))
  const taken = new Set(kept.map((k) => k.g.id))
  const newId = new Map(kept.map((k) => {
    if (!clash.has(k.g.id)) return [`${k.src}\0${k.g.id}`, k.g.id]
    let id = `${k.g.id}-${k.src + 1}`
    for (let n = 2; taken.has(id); n++) id = `${k.g.id}-${k.src + 1}-${n}`
    taken.add(id)
    return [`${k.src}\0${k.g.id}`, id]
  }))

  const groups: Group[] = kept.map(({ src, g, byHunk }) => {
    const hunks = [...byHunk].sort(([a], [b]) => target.indexOf(a) - target.indexOf(b)).map(([h, set]) =>
      set === null || set.size === changedCount(h) ? h.id : `${h.id}:${formatRanges(set)}`)
    // A group may serve one that kept no change; point it at the task and say
    // so, rather than leave a reference validation would reject.
    const targets = servesOf(g)
    const mapped = targets.map((t) => (t === 'task' ? t : newId.get(`${src}\0${t}`))).filter((t): t is string => !!t)
    const lost = targets.filter((t) => t !== 'task' && !newId.has(`${src}\0${t}`))
    const extra = [
      ...(lost.length ? [alsoServed(lost, 'which has no change left here')] : []),
      ...(several ? [`(from ${sources[src].sha.slice(0, 7)})`] : []),
    ].join(' ')
    return {
      ...g,
      id: newId.get(`${src}\0${g.id}`)!,
      hunks,
      serves: mapped.length > 1 ? mapped : mapped[0] ?? 'task',
      ...(extra ? { notes: g.notes ? `${g.notes} ${extra}` : extra } : {}),
    }
  })

  const notes = used.map((i) => sources[i].note.annotation)
  const unique = <T,>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()]
  const tasks = unique(notes.map((a) => a.task))
  const summaries = unique(notes.flatMap((a) => (a.summary ? [a.summary] : [])))
  const alternatives = unique(notes.flatMap((a) => a.alternatives ?? []))
  const risks = unique(notes.flatMap((a) => a.risks ?? []))
  const rated = used.filter((i) => sources[i].note.annotation.attention)
  // One unrated source makes the whole gloss unrated: its changes have no level to take.
  const attention = rated.length < used.length ? undefined : combineAttention(
    rated.map((i) => sources[i].note.annotation.attention!),
    (part, id) => newId.get(`${rated[part]}\0${id}`),
    groups,
  )
  const annotation: Annotation = {
    version: 1,
    task: tasks.join('; '),
    ...(summaries.length ? { summary: summaries.join(' ') } : {}),
    groups,
    ...(alternatives.length ? { alternatives } : {}),
    ...(risks.length ? { risks } : {}),
    ...(attention ? { attention } : {}),
    ...(notes[0].author ? { author: notes[0].author } : {}),
  }

  const claims: Claim[] = kept.flatMap(({ byHunk }) => [...byHunk].map(([hunk, lines]) => ({ hunk, lines })))
  return { annotation, used: used.map((i) => sources[i].sha), dropped, gaps: uncovered(target, claims), stale }
}
