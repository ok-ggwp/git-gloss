import assert from 'node:assert/strict'

// A wall-clock guard against a call that is too slow (a quadratic blow-up). It
// always prints the time (`# time <name>: <ms>`), so the margin can be watched.
// It only fails a call that RETURNS too slowly: it cannot catch one that never
// returns: that is the job of `--test-timeout` (package.json), the child
// timeouts of test/run.ts and the deadline of browse().
export function within(name: string, ms: number, budget: number) {
  console.log(`# time ${name}: ${Math.round(ms)} ms (budget ${budget})`)
  assert.ok(ms < budget, `${name} took ${Math.round(ms)} ms, over the budget of ${budget} ms`)
}
