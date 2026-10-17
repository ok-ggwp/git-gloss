import { git, gitTry, NOTES_REF, REMOTE_NOTES_REF } from '../git.ts'

export const usage = 'init   configure this repo so glosses follow amends/rebases and can be fetched from origin'

export function run(): number {
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
    // The default "manual" strategy leaves JSON conflicts to resolve by hand, and
    // union/cat_sort_uniq would join two JSON documents into an unreadable note.
    console.log(`  merge them into yours with: git notes --ref ${NOTES_REF} merge -s ours ${REMOTE_NOTES_REF}`)
    console.log('  (-s ours keeps your gloss where both sides glossed a commit; -s theirs keeps origin\'s)')
    console.log(`  share yours with:            git push origin ${NOTES_REF}`)
  } else {
    console.log('  no origin remote; skipped fetch config')
  }
  console.log('  note: squash merges drop notes; re-gloss the squashed commit if you squash')
  return 0
}
