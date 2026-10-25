// Test helper: a review report that ends with the gloss-findings block `reviews --record` requires.
export type TestItem = { id: string; kind?: string; severity?: string; basis?: string; where?: string; title?: string; detail?: string }

export const item = (id: string, over: Partial<TestItem> = {}): Required<Pick<TestItem, 'id' | 'kind' | 'severity' | 'basis' | 'title'>> & TestItem =>
  ({ id, kind: 'defect', severity: 'minor', basis: 'read', title: `title of ${id}`, ...over })

// prose, then the block, then the VERDICT line (issues when there are items, unless given).
export function report(prose: string, items: TestItem[] = [], verdict: 'CLEAN' | 'ISSUES' | null = items.length ? 'ISSUES' : 'CLEAN'): string {
  return `${prose}\n\n\`\`\`gloss-findings\n${JSON.stringify(items, null, 1)}\n\`\`\`\n${verdict ? `\nVERDICT: ${verdict}\n` : ''}`
}

// Free report text with the block put in before its trailing VERDICT line (or at the end), for tests that care about the prose.
export function withBlock(text: string, items: TestItem[] = []): string {
  const lines = text.replace(/\n+$/, '').split('\n')
  const at = lines.length - 1
  const block = `\`\`\`gloss-findings\n${JSON.stringify(items)}\n\`\`\``
  return /^\W*VERDICT:/i.test(lines[at] ?? '') ? [...lines.slice(0, at), '', block, '', lines[at]].join('\n') : `${lines.join('\n')}\n\n${block}\n`
}

import { execFileSync } from './run.ts'

// Plants a review record as an older git-gloss wrote it: a report and a verdict, no items.
export function plantLegacy(dir: string, sha: string, over: object = {}): string {
  const id = `legacy-${Math.random().toString(36).slice(2, 8)}`
  const rec = { review: 1, id, at: '2026-01-01T00:00:00.000Z', stage: 'bugs', agent: 'old', target: 'HEAD', lines: [], groups: [], findings: '## 1. Mismatches\n- the old format\n\nVERDICT: ISSUES', verdict: 'issues', ...over }
  const had = (() => { try { return execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'show', sha], { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).split('\n').filter(Boolean) } catch { return [] } })()
  execFileSync('git', ['notes', '--ref', 'gloss-reviews', 'add', '-f', '-F', '-', sha], { cwd: dir, input: [...had, JSON.stringify(rec)].join('\n') + '\n' })
  return (rec as { id: string }).id
}
