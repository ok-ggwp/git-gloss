import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { resolveCommits } from '../git.ts'
import { buildPageData } from '../html/data.ts'
import { renderPage } from '../html/page.ts'

export const usage = 'html [<commit> | <range>] [-o <file>] [--open]   write a self-contained HTML view of a gloss, or of every commit in a range'

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
  const { shas, merges, range } = resolveCommits(positionals[0] ?? 'HEAD')
  const data = buildPageData(shas, range, merges)
  // A single commit must be glossed; a range may include unglossed commits,
  // which the page lists with their whole diff as unannotated.
  if (!range && !data.commits[0].glossed) {
    console.error(`${shas[0].slice(0, 10)} has no gloss (annotate it with \`git gloss add\`)`)
    return 1
  }
  const all = [...shas, ...merges]
  const name = range ? `${all[0].slice(0, 10)}..${all[all.length - 1].slice(0, 10)}` : shas[0].slice(0, 10)

  // Default to the user's cache directory: one file per commit, overwritten on
  // regeneration, and private to the user (a fixed /tmp path could be
  // pre-created as a symlink by someone else; mkdtemp leaked a dir per run).
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  const file = values.output ? resolve(values.output) : join(cache, 'git-gloss', `${name}.html`)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, renderPage(data))
  console.log(file)
  if (values.open) openInBrowser(file)
  return 0
}
