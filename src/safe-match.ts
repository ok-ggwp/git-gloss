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

// `timedOut` is true when the answer is the fail-closed one (this call or an
// earlier one in the process hit the budget), so hits can say so.
export function matchLines(re: RegExp, texts: string[]): { hit: boolean[]; timedOut: boolean } {
  const key = `${re.source}/${re.flags}`
  if (skipped.has(key)) return { hit: texts.map(() => true), timedOut: true }
  ctx.re = re
  ctx.texts = texts
  try {
    return { hit: script.runInContext(ctx, { timeout: BUDGET_MS }) as boolean[], timedOut: false }
  } catch (err) {
    if ((err as { code?: string }).code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw err
    skipped.add(key)
    console.error(`warning: pattern ${JSON.stringify(re.source)} took over ${BUDGET_MS}ms and is treated as matching every line from now on (catastrophic backtracking, or a padded line?)`)
    return { hit: texts.map(() => true), timedOut: true }
  }
}
