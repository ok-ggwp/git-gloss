import vm from 'node:vm'

// Patterns come from a repo's config, so one may backtrack without end. Each
// batch of lines runs in a vm with a time budget; a pattern that exceeds it is
// reported once on stderr, and from then on it counts as matching every line:
// failing open would let a change pad a line to switch a trusted pattern off. Lines are never cut: a
// change controls its own lines, and padding one must not hide a hit.
const BUDGET_MS = 250

const script = new vm.Script('texts.map((t) => re.test(t))')
// One context for all calls: creating one per call dominates the cost.
const ctx = vm.createContext({ re: null, texts: [] as string[] })
const skipped = new Set<string>()

export function matchLines(re: RegExp, texts: string[]): boolean[] {
  const key = `${re.source}/${re.flags}`
  if (skipped.has(key)) return texts.map(() => true)
  ctx.re = re
  ctx.texts = texts
  try {
    return script.runInContext(ctx, { timeout: BUDGET_MS }) as boolean[]
  } catch (err) {
    if ((err as { code?: string }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err
    skipped.add(key)
    console.error(`warning: pattern ${JSON.stringify(re.source)} took over ${BUDGET_MS}ms and is treated as matching every line from now on (catastrophic backtracking, or a padded line?)`)
    return texts.map(() => true)
  }
}
