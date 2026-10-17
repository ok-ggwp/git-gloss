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
    const fetches = gitTry(['config', '--get-all', 'remote.origin.fetch'])?.split('\n') ?? []
    if (!fetches.includes(refspec)) git(['config', '--add', 'remote.origin.fetch', refspec])
    console.log(`✓ \`git fetch\` stores origin's glosses in ${REMOTE_NOTES_REF}`)
    console.log(`  merge them into yours with: git notes --ref ${NOTES_REF} merge ${REMOTE_NOTES_REF}`)
    console.log(`  share yours with:            git push origin ${NOTES_REF}`)
  } else {
    console.log('  no origin remote; skipped fetch config')
  }
  console.log('  note: squash merges drop notes; re-gloss the squashed commit if you squash')
  return 0
}
