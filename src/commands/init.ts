import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { git, gitTry, NOTES_REF, REMOTE_NOTES_REF } from '../git.ts'

export const usage = 'init [--hooks]   set up glosses to follow amends/rebases and fetch from origin; --hooks also syncs them on every push'

const HOOK_MARKER = '# installed by git-gloss'

// Runs before every `git push`. It syncs glosses with the remote being pushed
// to, and never blocks the push: a failed sync only prints a warning. The
// notes push inside sync uses --no-verify, so this hook doesn't run again.
const HOOK = `#!/bin/sh
${HOOK_MARKER}: sync glosses with the remote being pushed to (git gloss init --hooks)
remote="$1"
# Pushes to a URL rather than a named remote have nowhere to keep its glosses.
git remote | grep -qxF -- "$remote" || exit 0
git gloss sync "$remote" >&2 || echo "git-gloss: syncing glosses failed; your push continues. Retry with: git gloss sync $remote" >&2
exit 0
`

function installHook(): void {
  // --git-path follows core.hooksPath when it is set.
  const dir = resolve(git(['rev-parse', '--git-path', 'hooks']).trim())
  const path = join(dir, 'pre-push')
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8')
    if (!current.includes(HOOK_MARKER)) {
      console.log(`✗ ${path} already exists and isn't git-gloss's; left it unchanged.`)
      console.log(`  to sync glosses on push, add this line to it: git gloss sync "$1" >&2 || true`)
      return
    }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, HOOK)
  chmodSync(path, 0o755)
  console.log(`✓ \`git push\` now syncs glosses with the remote it pushes to (${path})`)
}

export function run(argv: string[] = []): number {
  const { values } = parseArgs({ args: argv, options: { hooks: { type: 'boolean' } } })

  const rewriteRefs = gitTry(['config', '--get-all', 'notes.rewriteRef'])?.split('\n') ?? []
  if (!rewriteRefs.includes(NOTES_REF)) git(['config', '--add', 'notes.rewriteRef', NOTES_REF])
  console.log(`✓ glosses follow commits through amend and rebase (notes.rewriteRef=${NOTES_REF})`)
  console.log('  if the commit\'s diff changes, `show` and `review` will flag the gloss as stale')

  if (gitTry(['remote', 'get-url', 'origin'])) {
    // Fetch into a separate ref and merge explicitly. Fetching straight into
    // NOTES_REF with a forced refspec would overwrite unpushed local glosses.
    const refspec = `+${NOTES_REF}:${REMOTE_NOTES_REF}`
    // Earlier versions of init added exactly that destructive refspec.
    const legacy = `+${NOTES_REF}:${NOTES_REF}`
    if (gitTry(['config', '--get-all', 'remote.origin.fetch'])?.split('\n').includes(legacy)) {
      git(['config', '--unset-all', '--fixed-value', 'remote.origin.fetch', legacy])
      console.log(`✓ removed the old refspec ${legacy}, which overwrote local glosses on fetch`)
    }
    const fetches = gitTry(['config', '--get-all', 'remote.origin.fetch'])?.split('\n') ?? []
    if (!fetches.includes(refspec)) git(['config', '--add', 'remote.origin.fetch', refspec])
    console.log(`✓ \`git fetch\` stores origin's glosses in ${REMOTE_NOTES_REF}`)
    if (!values.hooks) console.log('  share glosses with: git gloss sync   (or run init --hooks to do it on every push)')
  } else {
    console.log('  no origin remote; skipped fetch config')
  }
  if (values.hooks) installHook()
  console.log('  note: squash merges drop notes; re-gloss the squashed commit if you squash')
  return 0
}
