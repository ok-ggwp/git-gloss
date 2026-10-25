import assert from 'node:assert/strict'

// A wall-clock guard against a call that is too slow (a quadratic blow-up). It
// always prints the time (`# time <name>: <ms>`), so the margin can be watched.
// It only fails a call that RETURNS too slowly: it cannot catch one that never
// returns (the spawned commands' own timeouts, where they have one, are the
// backstop; there is no per-test timeout).
export function within(name: string, ms: number, budget: number) {
  console.log(`# time ${name}: ${Math.round(ms)} ms (budget ${budget})`)
  assert.ok(ms < budget, `${name} took ${Math.round(ms)} ms, over the budget of ${budget} ms`)
}
