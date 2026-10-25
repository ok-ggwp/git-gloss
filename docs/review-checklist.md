# git-gloss review checklist (project block)

Appended to every implementer brief after the generic checklist in the gg-deliver
skill. Each line comes from a finding that repeated in review. Add a line when a
finding repeats; remove one when tooling enforces it.

## Subprocesses and timeouts
- Every git call goes through `src/git.ts` (`git`, `gitTry`, `gitCleanup`); never call
  `execFileSync('git', ...)` directly. A timeout must propagate: no `catch` may turn a
  `GitError` with `timedOut` into "not found" or a default (use `rethrowTimeout`).
- Best-effort cleanups use `gitCleanup`, which cannot throw.
- A "bounded by T" promise means ONE deadline over the whole operation (every call,
  including the ones before and after the main one), and the test uses a slow `git` shim.
- Long-lived children (ary jobs, test servers) run in their own process group and are
  killed as a group; SIGTERM first where git lock files matter.
- `setTimeout` and `execFileSync` delays above 2^31-1 ms overflow: clamp or treat as "no limit".

## Untrusted input
- Notes, review reports, config, remote refs, commit text and file names are untrusted.
  Anything printed to a terminal goes through `plain()`; anything in the HTML page is text
  (no `innerHTML` with data), and the page strips bidi/zero-width characters.
- Every new reader has size caps (see `src/schema.ts`: `MAX_NOTE_BYTES`, `MAX_GROUPS`, ...) and a
  hostile-input test with `within()`: oversized, malformed, `__proto__`/`constructor` keys,
  escape sequences, catastrophic regexes. Loops over input must scale linearly: test with a
  size-scaled input.
- Refs and revisions from input reach git only after `--end-of-options` or a hex check.
- A refused or malformed note in a range is skipped with a warning; a single-commit target
  errors. New commands over ranges must follow this, not abort the whole range.

## Servers (`ary`)
- The server is read-only: it never writes refs, notes or objects (prove with `git
  count-objects -v` and `git fsck --unreachable` before and after).
- Pages are built in a child process with the job, timeout and output caps; the main loop
  never runs git.

## Reviews and findings
- A review report must end with a valid `gloss-findings` block (see the README); decisions
  name items by id; `reviews <target> --open` exits 0 before hand-off.
- Decision files are validated as a whole and written once per commit, or not at all.

## Tests
- Use `test/tmp.ts` `tmp()` (never `mkdtempSync`), `test/run.ts` for child processes,
  `test/timing.ts` `within()` for time limits and, in browser tests, `waitFor` from
  `test/browser.ts`. Elsewhere poll for a condition; no fixed sleeps or tight budgets.
- A full run takes about four minutes: background it and poll; at most two at once.
- Changes to `src/git.ts`, `src/schema.ts`, `src/loader.ts`, `src/reviews.ts`, `src/config.ts`
  or `src/html/data.ts` need a full run after every rework round.

## Process
- Wip-gloss before reporting; no commit, no `git stash`, no push or release without being asked.
- Finish README, TODO.md and comments before the final gloss snapshot.
