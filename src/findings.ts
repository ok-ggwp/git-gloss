// Stable references for the findings of a review report. Reports are free
// markdown and every reviewer formats them differently, so for DISPLAY each
// top-level list item is rewritten as `- **[S.N]** text`, S the section number
// and N the item's position in that section. Nothing stored is changed: the
// report stays raw in the notes, and verdicts and review keys use the raw text.
//
// The input is untrusted and up to 256 KiB, so this is one pass over the lines
// with no backtracking patterns: every line is looked at a bounded number of
// characters from its start (a 200 KB line costs no more than a short one,
// apart from the copy into the output).
//
// Section numbers:
//  - a heading (# to ######) that starts with a number (`1.`, `1)` or `1`) sets
//    the section to that number;
//  - any other heading is the previous section plus one;
//  - EXCEPT titles: unnumbered headings before the first list item or numbered
//    heading take no number (the first item then falls in section 1). So the
//    headings `honesty`, `Review of X`, `1. Mismatches`, `Misgraded necessity`,
//    `3. Removal` give sections 1, 2, 3, and `## A`, `## B` with items under
//    both give 1 and 2.
//  - a heading is a `#` line, or a line that is ONLY bold text (`**1. Title**`,
//    `__Title__`, optional trailing colon), or, conservatively, a plain
//    `1. Title` / `1) Title` line that is short, has no sentence punctuation
//    at its end, follows a blank line (or the start), and whose next non-empty
//    line (within two blank lines) is a bullet or another heading: an ordinary
//    numbered sentence, or a numbered list, is an item, not a heading.
//  - list items before any heading are labelled `[N]` (no section).
// Items are indent-0 `-`, `*`, `+`, `1.` or `1)` lines; indented sub-items and
// wrapped lines are left alone, as are fenced code blocks, rules and empty
// items. A numbered heading with no list under it keeps its own number as its
// ref (`1`, or `1/2` when `1` is taken) and its line is not rewritten. A section whose
// first ref is already taken (a second `1.` heading with items) is labelled `S/N`, see
// below. Running it on its own output changes nothing.

type Row = { ref: string; text: string; heading: boolean; hasItems: boolean }
type Scan = { out: string; found: Map<string, string>; rows: Row[]; clashes: string[] }

// A section label is the section number, `1`. A section is labelled `S/N` (`1/2`, items
// `1/2.1`, N from 2 to 999) only when a ref it would emit equals one already emitted: the
// heading ref `1` of a list-less heading, or the first item ref `1.1` of a section with
// items. Within a section a heading ref and an item ref never collide, so an empty
// numbered heading, an unnumbered heading or a bold line uses no label up, and no ref the
// old labeller produced changes. The one new ref: a list-less heading whose bare number
// equals a loose item's (`- x` then `## 1.`) was unreachable before and now gets `1/2`. Past 999 repeats the label stays `S/999`
// and the items keep counting on, so item refs stay distinct; only the heading row of such
// a section without items has no row of its own (its ref is already taken).
const MAX_REPEAT = 999
const repeatLabel = (num: number, n: number) => (n === 1 ? String(num) : `${num}/${n}`)

const isDigit = (c: string) => c >= '0' && c <= '9'
const MAXDIG = 6

// The section number at the start of a heading's text: up to 3 digits, then `.` or
// `)`, then a space or the end. `2024 results` and `10 files changed` are text.
function leadingNumber(s: string): number | null {
  let i = 0
  while (i < s.length && i < 4 && isDigit(s[i])) i++
  if (i === 0 || i > 3) return null
  if (s[i] !== '.' && s[i] !== ')') return null
  i++
  if (i < s.length && s[i] !== ' ' && s[i] !== '\t') return null
  return Number(s.slice(0, i - 1))
}

function headingText(line: string): string | null {
  let i = 0
  while (i < 3 && line[i] === ' ') i++
  let h = 0
  while (line[i + h] === '#' && h < 7) h++
  if (h < 1 || h > 6) return null
  const c = line[i + h]
  if (c !== undefined && c !== ' ' && c !== '\t') return null
  let j = i + h
  while (line[j] === ' ' || line[j] === '\t') j++
  return line.slice(j, j + 16)
}

// The text of a line made only of bold (`**x**`, `__x__`, optional colon), else null.
function boldOnly(line: string): string | null {
  const mark = line.startsWith('**') ? '**' : line.startsWith('__') ? '__' : null
  if (mark === null) return null
  let end = line.length
  while (end > 0 && (line[end - 1] === ' ' || line[end - 1] === '\t' || line[end - 1] === '\r')) end--
  if (line[end - 1] === ':') end--
  if (end < 2 * mark.length + 1 || !line.startsWith(mark, end - mark.length)) return null
  const inner = line.slice(mark.length, end - mark.length)
  if (inner.indexOf(mark) !== -1 || inner.trim() === '') return null
  return inner.trimStart().slice(0, 16)
}

const isBullet = (l: string) => (l[0] === '-' || l[0] === '*' || l[0] === '+') && (l[1] === ' ' || l[1] === '\t')

// A plain `1. Title` line that is a section title rather than a numbered finding.
function plainTitle(lines: string[], n: number): boolean {
  const line = lines[n]
  if (leadingNumber(line.slice(0, 12)) === null || itemText(line) === null) return false
  if (line.length > 70 || (n > 0 && lines[n - 1].trim() !== '')) return false
  const last = line.trimEnd().slice(-1)
  if ('.!?,;:'.includes(last) && last !== ':') return false
  // A real title has a blank line after it too: `1. Race` straight above bullets is an item with sub-items.
  if (n + 1 >= lines.length || lines[n + 1].trim() !== '') return false
  let k = n + 1
  while (k < lines.length && k <= n + 3 && lines[k].trim() === '') k++
  if (k >= lines.length || k > n + 3) return false
  const next = lines[k]
  return isBullet(next) || headingText(next) !== null || boldOnly(next) !== null
}

// The text after a top-level list marker, or null when the line is not an item.
function itemText(line: string): string | null {
  const c = line[0]
  let i = 0
  if (c === '-' || c === '*' || c === '+') i = 1
  else if (c !== undefined && isDigit(c)) {
    while (i < MAXDIG + 1 && isDigit(line[i] ?? '')) i++
    if (i > MAXDIG || (line[i] !== '.' && line[i] !== ')')) return null
    i++
  } else return null
  if (line[i] !== ' ' && line[i] !== '\t') return null
  // A rule (`* * *`, `- - -`, `___`): at most 64 characters, so the pattern is bounded.
  if (line.length <= 64 && /^([-*_])( *\1){2,} *$/.test(line)) return null
  let j = i
  while (line[j] === ' ' || line[j] === '\t') j++
  if (j >= line.length) return null
  return line.slice(j)
}

// Drop a label this function wrote before: `**[1.2]** ` or `**[1/2.2]** `.
function stripLabel(t: string): string {
  if (!t.startsWith('**[')) return t
  const m = /^\*\*\[\d{1,3}\/\d{1,3}\.\d{1,6}\]\*\* */.exec(t.slice(0, 40))
  if (m) return t.slice(m[0].length)
  let i = 3
  while (i < 20 && (isDigit(t[i] ?? '') || t[i] === '.')) i++
  if (i > 3 && t.startsWith(']**', i)) {
    let j = i + 3
    while (t[j] === ' ') j++
    return t.slice(j)
  }
  return t
}

function scan(text: string): Scan {
  const lines = text.split('\n')
  // Each ref with its text (an item's, or a numbered heading's line); the first wins.
  const found = new Map<string, string>()
  // The rows of a decision template: one per ref that was added, marked heading or item.
  const rows: Row[] = []
  // Refs a heading row could not take because another row has them (a template row lost, or a
  // heading whose ref a decision would give to the other finding).
  const clashes = new Set<string>()
  // `lost` marks a heading row that would have been listed: only then is a lost ref a clash.
  const add = (ref: string, t: string, heading: boolean, lost = false): Row | null => {
    if (found.has(ref)) { if (lost) clashes.add(ref); return null }
    found.set(ref, t)
    const row = { ref, text: t, heading, hasItems: false }
    rows.push(row)
    return row
  }
  // How many items each label has.
  const counts = new Map<string, number>()
  // The first label of `num` whose first ref is not taken: the heading's own ref, or `.1`.
  // Refs only get added, so a label found taken stays taken: each (number, kind) resumes
  // from where it stopped, which keeps this linear in the number of sections.
  const resume = new Map<string, number>()
  const pick = (num: number, forHeading: boolean) => {
    const key = `${num}:${forHeading}`
    let k = resume.get(key) ?? 1
    while (k < MAX_REPEAT && found.has(forHeading ? repeatLabel(num, k) : `${repeatLabel(num, k)}.1`)) k++
    resume.set(key, k)
    return repeatLabel(num, k)
  }
  // A numbered heading waits for its first item: with items it only names the section
  // (the items are the findings), without it is a row of its own.
  let pending: { num: number; text: string } | null = null
  const flush = (withItems = false) => {
    if (!pending) return
    const lab = pick(pending.num, true)
    const row = add(lab, pending.text, true, !withItems)
    if (row && withItems) row.hasItems = true
    pending = null
  }
  let section = 0
  let label: string | null = null
  let sawHeading = false, sawNumbered = false, sawItem = false
  let fence: string | null = null
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]
    const t = line.trimStart()
    if (t.startsWith('```') || t.startsWith('~~~')) {
      if (fence === null) fence = t.slice(0, 3)
      else if (t.startsWith(fence)) fence = null
      continue
    }
    if (fence !== null) continue
    const h = headingText(line) ?? boldOnly(line) ?? (plainTitle(lines, n) ? line : null)
    if (h !== null) {
      flush()
      const num = leadingNumber(h)
      if (num !== null) { section = num; sawNumbered = true; pending = { num, text: line.replace(/^[\s#*_]+/, '').replace(/^\d{1,3}[.)]?\s*/, '').replace(/[\s*_:]+$/, '') } }
      else if (!sawItem && !sawNumbered) section = 0
      else section += 1
      label = null
      sawHeading = true
      continue
    }
    const item = itemText(line)
    if (item === null) continue
    if (section === 0 && sawHeading) section = 1
    // A heading numbered 0 keeps its own ref: it is not the section its items fall in.
    if (pending && pending.num !== section) flush(true)
    sawItem = true
    if (sawHeading && label === null) {
      label = pick(section, false)
      if (pending) { const row = add(label, pending.text, true); if (row) row.hasItems = true; pending = null }
    }
    const key = label ?? ''
    const k = (counts.get(key) ?? 0) + 1
    counts.set(key, k)
    const ref = sawHeading ? `${label}.${k}` : String(k)
    add(ref, stripLabel(item), false)
    lines[n] = `- **[${ref}]** ${stripLabel(item)}`
  }
  flush()
  return { out: lines.join('\n'), found, rows, clashes: [...clashes] }
}

export function labelFindings(text: string): string {
  return scan(text).out
}

// The refs a report's findings carry (and its numbered headings'), as a set.
export function findingRefs(text: string): Set<string> {
  return new Set(scan(text).found.keys())
}

// What a decision template lists: each finding's ref once, with its text (raw, for the
// caller to clean). A numbered heading is listed only when no items sit under it; its
// ref stays valid for a decision (findingRefs has it) but is not suggested.
// Refs that more than one finding of a report claims, so a decision naming one is ambiguous.
export function findingClashes(text: string): string[] {
  return scan(text).clashes
}

export function findingTexts(text: string): [string, string][] {
  return scan(text).rows.filter((r) => !(r.heading && r.hasItems)).map((r) => [r.ref, r.text])
}

// A decision's finding names a finding by starting with its ref: `1.2 wording nit`,
// `1.2: ...`, or a bare section number only with a delimiter (`3: ...`, `3) ...`,
// `3. ...`). Numbers are up to 3 digits, so `2024 migration` and `3 files` are text.
export function refOf(finding: string): string | null {
  // The end of the digit run at `from` (1 to `max` digits), or null if there is none or it is longer.
  const digits = (from: number, max: number): number | null => {
    let e = from
    while (e < from + max && isDigit(finding[e] ?? '')) e++
    return e === from || isDigit(finding[e] ?? '') ? null : e
  }
  let s = digits(0, 3)
  if (s === null) return null
  // The Nth occurrence of a section number: `1/2`, N from 2 to 999.
  if (finding[s] === '/') {
    const e = digits(s + 1, 3)
    if (e === null || Number(finding.slice(s + 1, e)) < 2) return null
    s = e
  }
  if (finding[s] === '.') {
    let j = s + 1
    while (j < s + 5 && isDigit(finding[j] ?? '')) j++
    if (j > s + 1 && j <= s + 4) {
      const c = finding[j]
      if (c === undefined || c === ' ' || c === '\t' || c === ':') return finding.slice(0, j)
    }
  }
  const c = finding[s]
  if (c === ':' || c === ')') return finding.slice(0, s)
  if (c === '.' && (finding[s + 1] === undefined || finding[s + 1] === ' ')) return finding.slice(0, s)
  return null
}

// `1` < `1.1` < `1.10` < `1/2` < `1/2.1` < `2`: section number, then repeat, then item.
// Only refs from refOf reach this.
const refKey = (r: string) => {
  const [sec, item = '-1'] = r.split('.')
  const [num, rep = '1'] = sec.split('/')
  return { num: Number(num), rep: Number(rep), item: Number(item) }
}
type Key = ReturnType<typeof refKey>
const compareKeys = (x: Key, y: Key) => x.num - y.num || x.rep - y.rep || x.item - y.item

// Finding order: decisions whose finding starts with a ref, by ref (1.2 before
// 1.10, ties by time); the rest after them in time order.
export function orderDecisions<T extends { finding?: string; at: string }>(input: T[]): T[] {
  const ds = [...input].sort((a, b) => a.at.localeCompare(b.at))
  const withRef: [Key, T][] = []
  const rest: T[] = []
  for (const d of ds) {
    const r = refOf(d.finding ?? '')
    if (r === null) rest.push(d)
    else withRef.push([refKey(r), d])
  }
  withRef.sort((a, b) => compareKeys(a[0], b[0]))
  return [...withRef.map((x) => x[1]), ...rest]
}
