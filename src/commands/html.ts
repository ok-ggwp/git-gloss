import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveCommit } from '../git.ts'
import { loadGloss } from '../loader.ts'
import { buildPageData } from '../html/data.ts'
import { renderPage } from '../html/page.ts'

export const usage = 'html [<commit>] [-o <file>] [--open]   write a self-contained HTML view of a gloss'

function openInBrowser(file: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : ['xdg-open', [file]]
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {
    console.error(`could not open a browser; open ${file} yourself`)
  }).unref()
}

export function run(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { output: { type: 'string', short: 'o' }, open: { type: 'boolean' } },
  })
  const sha = resolveCommit(positionals[0] ?? 'HEAD')
  const gloss = loadGloss(sha)
  if (!gloss) {
    console.error(`${sha.slice(0, 10)} has no gloss (annotate it with \`git gloss add\`)`)
    return 1
  }

  // Default to a fresh private directory: a fixed path under /tmp could be
  // pre-created as a symlink by another user on a shared machine.
  const file = values.output
    ? resolve(values.output)
    : join(mkdtempSync(join(tmpdir(), 'git-gloss-')), `${sha.slice(0, 10)}.html`)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderPage(buildPageData(gloss)))
  console.log(file)
  if (values.open) openInBrowser(file)
  return 0
}
