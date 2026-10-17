import { git, gitTry, NOTES_REF } from '../git.ts'

export const usage = 'init   configure this repo so glosses follow amends/rebases and sync with origin'

export function run(): number {
  const rewriteRefs = gitTry(['config', '--get-all', 'notes.rewriteRef'])?.split('\n') ?? []
  if (!rewriteRefs.includes(NOTES_REF)) git(['config', '--add', 'notes.rewriteRef', NOTES_REF])
  console.log(`✓ glosses follow commits through amend and rebase (notes.rewriteRef=${NOTES_REF})`)

  if (gitTry(['remote', 'get-url', 'origin'])) {
    const refspec = `+${NOTES_REF}:${NOTES_REF}`
    const fetches = gitTry(['config', '--get-all', 'remote.origin.fetch'])?.split('\n') ?? []
    if (!fetches.includes(refspec)) git(['config', '--add', 'remote.origin.fetch', refspec])
    console.log('✓ `git fetch` pulls glosses from origin')
    console.log(`  share yours with: git push origin ${NOTES_REF}`)
  } else {
    console.log('  no origin remote; skipped fetch config')
  }
  console.log('  note: squash merges drop notes; re-gloss the squashed commit if you squash')
  return 0
}
