import { createHash } from 'node:crypto'
import type { HunkLocation } from './schema.ts'

export type Hunk = HunkLocation & {
  hash: string
  // Diff text for display: the @@ header and body, or the file header lines for
  // changes with no textual hunks (binary, pure rename, mode change).
  text: string
  added: number
  removed: number
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function stripPath(raw: string): string | null {
  let p = raw.replace(/\t.*$/, '')
  if (p === '/dev/null') return null
  if (p.startsWith('"') && p.endsWith('"')) p = JSON.parse(p)
  return p.replace(/^[ab]\//, '')
}

type FileState = {
  oldFile: string | null
  newFile: string | null
  meta: string[]
  hunks: Hunk[]
}

export function parseDiff(diff: string): Hunk[] {
  const lines = diff.split('\n')
  const hunks: Hunk[] = []
  let file: FileState | null = null
  let i = 0

  const flush = () => {
    if (!file) return
    if (file.hunks.length === 0) {
      // Still give header-only changes an id so they can be annotated.
      hunks.push({
        id: '',
        file: file.newFile ?? file.oldFile ?? '?',
        oldFile: file.oldFile,
        oldStart: 0, oldLines: 0, newStart: 0, newLines: 0,
        text: file.meta.join('\n'),
        hash: '',
        added: 0, removed: 0,
      })
    }
    hunks.push(...file.hunks)
    file = null
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      flush()
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      file = { oldFile: m?.[1] ?? null, newFile: m?.[2] ?? null, meta: [line], hunks: [] }
      i++
      continue
    }
    if (!file) { i++; continue }

    if (line.startsWith('--- ')) { file.oldFile = stripPath(line.slice(4)); file.meta.push(line); i++; continue }
    if (line.startsWith('+++ ')) { file.newFile = stripPath(line.slice(4)); file.meta.push(line); i++; continue }
    if (line.startsWith('new file mode')) { file.oldFile = null }
    if (line.startsWith('deleted file mode')) { file.newFile = null }
    if (line.startsWith('rename from ')) file.oldFile = line.slice(12)
    if (line.startsWith('rename to ')) file.newFile = line.slice(10)

    const h = HUNK_HEADER.exec(line)
    if (!h) { file.meta.push(line); i++; continue }

    const oldStart = Number(h[1]), oldLines = h[2] === undefined ? 1 : Number(h[2])
    const newStart = Number(h[3]), newLines = h[4] === undefined ? 1 : Number(h[4])
    const body = [line]
    let oldLeft = oldLines, newLeft = newLines, added = 0, removed = 0
    i++
    // Consume by line counts, not by prefix: a removed line "-- x" looks like a
    // "--- " file header and would otherwise end the hunk early.
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith('\\'))) {
      const l = lines[i]
      if (l.startsWith('+')) { newLeft--; added++ }
      else if (l.startsWith('-')) { oldLeft--; removed++ }
      else if (l.startsWith('\\')) { /* "\ No newline at end of file" */ }
      else { oldLeft--; newLeft-- }
      body.push(l)
      i++
    }
    file.hunks.push({
      id: '',
      file: file.newFile ?? file.oldFile ?? '?',
      oldFile: file.oldFile,
      oldStart, oldLines, newStart, newLines,
      text: body.join('\n'),
      hash: '',
      added, removed,
    })
  }
  flush()

  hunks.forEach((h, n) => {
    h.id = `h${n + 1}`
    // Hash only what the hunk changes, so a rebase that shifts line numbers or
    // context lines doesn't make an otherwise identical hunk look different.
    const body = h.text.startsWith('@@')
      ? h.text.split('\n').slice(1).filter((l) => l[0] === '+' || l[0] === '-').join('\n')
      : h.text
    h.hash = createHash('sha256').update(h.file + '\0' + body).digest('hex').slice(0, 16)
  })
  return hunks
}

export function location(h: Hunk): HunkLocation {
  const { id, file, oldFile, oldStart, oldLines, newStart, newLines, hash } = h
  return { id, file, oldFile, oldStart, oldLines, newStart, newLines, hash }
}
