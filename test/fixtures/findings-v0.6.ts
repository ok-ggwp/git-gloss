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
// ref (`1`) and gets no label. Running it on its own output changes nothing.

type Scan = { out: string; found: Map<string, string> }

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

// Drop a label this function wrote before: `**[1.2]** `.
function stripLabel(t: string): string {
  if (!t.startsWith('**[')) return t
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
  const add = (ref: string, t: string) => { if (!found.has(ref)) found.set(ref, t) }
  let section = 0, count = 0
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
      const num = leadingNumber(h)
      if (num !== null) { section = num; sawNumbered = true; add(String(num), line.replace(/^[\s#*_]+/, '').replace(/^\d{1,3}[.)]?\s*/, '').replace(/[\s*_:]+$/, '')) }
      else if (!sawItem && !sawNumbered) section = 0
      else section += 1
      sawHeading = true
      count = 0
      continue
    }
    const item = itemText(line)
    if (item === null) continue
    if (section === 0 && sawHeading) section = 1
    sawItem = true
    count++
    const ref = sawHeading ? `${section}.${count}` : String(count)
    add(ref, stripLabel(item))
    lines[n] = `- **[${ref}]** ${stripLabel(item)}`
  }
  return { out: lines.join('\n'), found }
}

export function labelFindings(text: string): string {
  return scan(text).out
}

// The refs a report's findings carry (and its numbered headings'), as a set.
export function findingRefs(text: string): Set<string> {
  return new Set(scan(text).found.keys())
}

// Each ref a report carries, once, with the text of its finding (raw, for the caller to clean).
export function findingTexts(text: string): [string, string][] {
  return [...scan(text).found]
}

// A decision's finding names a finding by starting with its ref: `1.2 wording nit`,
// `1.2: ...`, or a bare section number only with a delimiter (`3: ...`, `3) ...`,
// `3. ...`). Numbers are up to 3 digits, so `2024 migration` and `3 files` are text.
export function refOf(finding: string): string | null {
  let i = 0
  while (i < 4 && isDigit(finding[i] ?? '')) i++
  if (i === 0 || i > 3) return null
  if (finding[i] === '.') {
    let j = i + 1
    while (j < i + 5 && isDigit(finding[j] ?? '')) j++
    if (j > i + 1 && j <= i + 4) {
      const c = finding[j]
      if (c === undefined || c === ' ' || c === '\t' || c === ':') return finding.slice(0, j)
    }
  }
  const c = finding[i]
  if (c === ':' || c === ')') return finding.slice(0, i)
  if (c === '.' && (finding[i + 1] === undefined || finding[i + 1] === ' ')) return finding.slice(0, i)
  return null
}

function compareRefs(a: string, b: string): number {
  const [a1, a2 = '-1'] = a.split('.')
  const [b1, b2 = '-1'] = b.split('.')
  return Number(a1) - Number(b1) || Number(a2) - Number(b2)
}

// Finding order: decisions whose finding starts with a ref, by ref (1.2 before
// 1.10, ties by time); the rest after them in time order.
export function orderDecisions<T extends { finding?: string; at: string }>(input: T[]): T[] {
  const ds = [...input].sort((a, b) => a.at.localeCompare(b.at))
  const withRef: [string, T][] = []
  const rest: T[] = []
  for (const d of ds) {
    const r = refOf(d.finding ?? '')
    if (r === null) rest.push(d)
    else withRef.push([r, d])
  }
  withRef.sort((a, b) => compareRefs(a[0], b[0]))
  return [...withRef.map((x) => x[1]), ...rest]
}
