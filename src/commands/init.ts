import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { git, gitTry, NOTES_REF, REMOTE_NOTES_REF, WIP_REF } from '../git.ts'
import { REVIEWS_REF } from '../reviews.ts'

export const usage = 'init [--hooks]   set up glosses to follow amends/rebases and fetch from origin; --hooks: sync on push, adopt wip glosses on commit'

const HOOK_MARKER = '# installed by git-gloss'

// Runs before every `git push`. It syncs glosses with the remote being pushed
// to, passing on the refs being pushed (git gives them on stdin) so their
// glosses go too, and never blocks the push: a failed sync only prints a
// warning. The notes push inside sync uses --no-verify, so this hook doesn't
// run again.
const HOOK = `#!/bin/sh
${HOOK_MARKER}: sync glosses with the remote being pushed to (git gloss init --hooks)
remote="$1"
# Pushes to a URL rather than a named remote have nowhere to keep its glosses.
git remote | grep -qxF -- "$remote" || exit 0
# git runs this hook for --dry-run pushes too, without saying so; check the
# push command itself, so a dry run doesn't write glosses to the remote.
for arg in $(ps -o args= -p "$PPID" 2>/dev/null); do
  case "$arg" in --dry-run) exit 0 ;; --*) ;; -*n*) exit 0 ;; esac
done
# No credential prompts: a sync that needs one fails fast instead of stalling the push.
GIT_TERMINAL_PROMPT=0 git gloss sync "$remote" --pushing >&2 || echo "git-gloss: syncing glosses failed; your push continues. Retry with: git gloss sync $remote" >&2
exit 0
`

// Runs after every commit: if uncommitted work was glossed (a wip snapshot),
// move the parts this commit contains onto it; if the commit is a
// cherry-pick, or a squash merge with git's default message, gloss it from
// the commits it came from. Never fails the commit.
const POST_COMMIT = `#!/bin/sh
${HOOK_MARKER}: move glosses onto new commits (git gloss init --hooks)
# Most commits have neither; don't start git-gloss for them.
if git rev-parse -q --verify ${WIP_REF} >/dev/null; then
  git gloss adopt --quiet-unless-adopted >&2 || echo "git-gloss: adopting the wip gloss failed; run: git gloss adopt" >&2
fi
case "$(git reflog -1 --format=%gs HEAD 2>/dev/null)" in
  cherry-pick*|"commit: Squashed commit of the following:"*)
    git gloss carry --find --quiet >&2 || echo "git-gloss: carrying the gloss failed; run: git gloss carry --find" >&2 ;;
esac
exit 0
`

// Runs after an amend or a rebase, with git's old -> new commit list on
// stdin: a commit squashed or fixed up from several glossed commits is
// glossed from all of them, and one whose diff the rewrite changed is
// re-glossed line by line from the original. Never fails.
const POST_REWRITE = `#!/bin/sh
${HOOK_MARKER}: carry glosses through squashes, fixups and changed rewrites (git gloss init --hooks)
git rev-parse -q --verify ${NOTES_REF} >/dev/null || exit 0
git gloss carry --rewritten "$1" --quiet >&2 || echo "git-gloss: carrying glosses after the $1 failed; run git gloss carry <old commits> --to <new commit>" >&2
exit 0
`

function installHook(name: string, body: string, done: string, manual: string[]): void {
  // --git-path follows core.hooksPath when it is set. A hooks directory
  // outside this repository (neither in .git nor in the working tree, like
  // .githooks) is shared with other repositories, where these hooks would run
  // without git-gloss being set up, so leave it alone.
  const dir = resolve(git(['rev-parse', '--git-path', 'hooks']).trim())
  const path = join(dir, name)
  const inside = [['--git-common-dir'], ['--show-toplevel']]
    .map((flag) => gitTry(['rev-parse', '--path-format=absolute', ...flag])?.trim())
    .some((root) => root && (dir + sep).startsWith(resolve(root) + sep))
  if (!inside) {
    console.log(`✗ core.hooksPath points to ${dir}, outside this repository, so other repositories may share it;`)
    console.log(`  not installing ${name} there. To use it anyway, add these lines to ${path}:`)
    for (const line of manual) console.log(`    ${line}`)
    return
  }
  if (existsSync(path)) {
    const current = readFileSync(path, 'utf8')
    if (!current.includes(HOOK_MARKER)) {
      console.log(`✗ ${path} already exists and isn't git-gloss's; left it unchanged.`)
      console.log('  to use it with git-gloss, add these lines to it:')
      for (const line of manual) console.log(`    ${line}`)
      return
    }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  console.log(`✓ ${done} (${path})`)
}

export function run(argv: string[] = []): number {
  const { values } = parseArgs({ args: argv, options: { hooks: { type: 'boolean' } } })

  // Reviews follow commits too; a squash joins their lines, which is what they need.
  const rewriteRefs = gitTry(['config', '--get-all', 'notes.rewriteRef'])?.split('\n') ?? []
  for (const ref of [NOTES_REF, REVIEWS_REF]) if (!rewriteRefs.includes(ref)) git(['config', '--add', 'notes.rewriteRef', ref])
  console.log(`✓ glosses follow commits through amend and rebase (notes.rewriteRef=${NOTES_REF})`)
  console.log('  if the commit\'s diff changes, `show` and `review` will flag the gloss as stale')

  if (gitTry(['remote', 'get-url', 'origin'])) {
    // Fetch into a separate ref and merge explicitly. Fetching straight into
    // NOTES_REF with a forced refspec would overwrite unpushed local glosses.
    // One glob for the glosses and their reviews: a glob doesn't make
    // `git fetch` fail while origin has none yet, as a plain refspec does.
    const refspec = `+${NOTES_REF}*:${REMOTE_NOTES_REF}*`
    const fetches = () => gitTry(['config', '--get-all', 'remote.origin.fetch'])?.split('\n') ?? []
    // Earlier versions of init added exactly that destructive refspec, and
    // later ones a plain one that the glob replaces.
    const legacy = `+${NOTES_REF}:${NOTES_REF}`
    if (fetches().includes(legacy)) {
      git(['config', '--unset-all', '--fixed-value', 'remote.origin.fetch', legacy])
      console.log(`✓ removed the old refspec ${legacy}, which overwrote local glosses on fetch`)
    }
    const plain = `+${NOTES_REF}:${REMOTE_NOTES_REF}`
    if (fetches().includes(plain)) git(['config', '--unset-all', '--fixed-value', 'remote.origin.fetch', plain])
    if (!fetches().includes(refspec)) git(['config', '--add', 'remote.origin.fetch', refspec])
    console.log(`✓ \`git fetch\` stores origin's glosses in ${REMOTE_NOTES_REF}`)
    if (!values.hooks) console.log('  share glosses with: git gloss sync   (or run init --hooks to do it on every push)')
  } else {
    console.log('  no origin remote; skipped fetch config')
  }
  if (values.hooks) {
    // The hooks run `git gloss`; a git without it on PATH (a GUI client, a
    // different shell) would print an error after every commit and push.
    if (spawnSync('sh', ['-c', 'command -v git-gloss'], { stdio: 'ignore' }).status !== 0) {
      // Without it, every commit and push prints an error and the gloss isn't
      // moved, synced or carried, so say that plainly.
      console.log('! git-gloss is not on PATH in this shell, so the hooks will fail on every commit and push.')
      console.log('  Their errors are only warnings, and glosses are not adopted, carried or synced until it is fixed.')
      console.log('  Either install it globally (npm install -g @ok-ggwp/git-gloss), or, for a project install,')
      console.log('  put its node_modules/.bin first on PATH in each hook (see README: "Project installs").')
    }
    installHook('pre-push', HOOK, '`git push` now syncs glosses with the remote it pushes to', [
      'git remote | grep -qxF -- "$1" && { GIT_TERMINAL_PROMPT=0 git gloss sync "$1" --pushing >&2 ||',
      '  echo "git-gloss: syncing glosses failed; your push continues" >&2; }',
    ])
    installHook('post-commit', POST_COMMIT, '`git commit` now moves the gloss of uncommitted work, or of a cherry-picked commit, onto the new commit', [
      `git rev-parse -q --verify ${WIP_REF} >/dev/null && { git gloss adopt --quiet-unless-adopted >&2 || true; }`,
      'case "$(git reflog -1 --format=%gs HEAD)" in cherry-pick*|"commit: Squashed commit of the following:"*) git gloss carry --find --quiet >&2 || true ;; esac',
    ])
    installHook('post-rewrite', POST_REWRITE, 'squashes and fixups in a rebase now combine their glosses', [
      `git rev-parse -q --verify ${NOTES_REF} >/dev/null && { git gloss carry --rewritten "$1" --quiet >&2 || true; }`,
    ])
  }
  console.log('  squash and rebase merges done on a server (GitHub\'s "Squash and merge") are glossed from the')
  console.log('  original commits by git gloss sync, which every push runs with --hooks; by hand: git gloss carry --find --squash')
  return 0
}
