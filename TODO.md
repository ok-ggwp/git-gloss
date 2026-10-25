# git-gloss: what is still to do

Written 2026-10-24, from the phase 1, phase 2 and review-desk work. Keep this
current: remove an item when it ships, and say where a new one came from.

"Verified" means someone ran it and saw it. "Read" means it comes from reading
the code only.

## Untrusted input: audit of 2026-10-24

Threat model: a collaborator or a compromised remote pushes notes refs, branch
names or commit text; the victim runs git-gloss, `git gloss ary` or opens an
html page. Every finding below was reproduced (a test or script run, seen
failing) before it was fixed. The tests are in `test/untrusted.test.ts`.

1. Notes from a remote (gloss, review and decision notes). Tried: one-line
   notes of 40 MB, 1.5 to 2 million levels of nesting, 300,000 hunks or risks,
   50,000 groups, 30 MB strings, `__proto__` and `constructor` keys, on `show`,
   `reviews`, `signals`, `hunks`, `html`.
   - Fixed, review records had no size cap. A report over 256 KiB, or a record
     line over 8 MiB, is now skipped with a warning (once per commit) on stderr;
     `reviews --record` refuses both, so what it writes is readable. The line
     limit is generous on purpose: the stamp holds a 16-character key per changed
     line (16,000 changed lines make a 300 KB line, a real review), and JSON.parse
     reads 32 MB in 0.08 s. Tests: "a review line over the size cap", "a review
     of a commit with 16,000 changed lines", "a review line of 10 MB".
   - Fixed, a gloss with 300,000 risks crashed `show` with a stack trace
     (spread into a call), and 8,000 groups made `html` run out of memory (the
     page was quadratic in groups: 50,000 groups ran over 60 s). Groups, risks,
     alternatives and attention reasons are now capped at 500 (`schema.ts`). Test: "absurdly many groups or risks".
   - Fixed, 500 groups all claiming one 20,000-line hunk made `html` run over
     40 s and would write a page of gigabytes. Measured (`html`, one hunk shared
     by many groups): 200,000 claimed lines 0.5 s, 800,000 3.4 s, 1,000,000 3 to
     10 s, 5,000,000 over 60 s; `show` stays under 0.5 s. A gloss may now claim at
     most max(500,000, 5 x the diff's changed lines): 7 or 50 groups sharing a
     4,000-line hunk read fine. One function (`claimsProblem`, `selection.ts`)
     checks it in `add` (so it never writes what readers refuse) and in the loader,
     with a message that says to claim narrower lines or use fewer groups. The
     per-group hunk-reference cap was removed (a one-group gloss of 600 files is
     legitimate; 500,000 references took 1 s). Tests: "many groups claiming the
     same big hunk", "groups sharing one big hunk", "one group over a change to
     600 files".
   - Fixed, terminal escape sequences (OSC 52 clipboard write, title, screen
     clear, conceal) in gloss text (task, intents, notes, risks) and in file
     names reached the terminal through `show`, `why`, `hunks` and `signals`.
     `readNote` strips them from gloss text (so adopt and carry copy the cleaned text; chosen over cleaning at every print site, which are many), and file names are cleaned where they are printed (hunk labels, `signals`, `why`), never in the parsed data, which must still match git. Tests: "escape sequences", "a file name with a tab".
   - Fixed, `sync` set `refs/notes/gloss` to whatever the remote's ref pointed
     at; a tree made `git gloss add` fail ("not a commit") until the ref was
     deleted by hand. It now refuses a fetched notes ref that is not a commit.
     Test: "sync does not adopt".
   - Fixed, a refused gloss (too many claims, over the caps, invalid) in a range no
     longer fails the whole `show` or `html`: the commit is skipped with a warning.
     A note's total size is capped at 8 MiB (`MAX_NOTE_BYTES`) on read and write.
     `adopt`, `carry` and `versions` were run with huge, malformed, prototype-keyed
     and escape-laden notes (`test/hardnotes.test.ts`); `versions` printed a notes
     commit's subject, group ids and `--show` raw (escape sequences reached the
     terminal), listed every group id of a huge note, and `--restore` took a version
     without checking it (a malformed one could be planted as the gloss): all fixed. The html page
     now strips bidi, zero-width and format characters from subjects, authors and
     decisions (gloss and review text were already cleaned on read). `add` read an
     8 MB pipe with `readFileSync(0)` and failed with EAGAIN; it now retries.
     `review` and `why` over a range skip a refused gloss like `show`; `lint` takes
     one commit only. `versions --restore` runs the same checks as the readers.
   - Not exploitable: deep nesting (the readers fail cleanly in under a second),
     `__proto__` keys (zod drops them), huge strings (linear, 1 to 2 s for 60 MB),
     many hunk references (1 s). Test: "deeply nested or prototype-keyed notes".
2. Rendering in the html page and the desk. The markdown renderer builds DOM
   nodes and never parses HTML; there is no `innerHTML` anywhere.
   - Fixed, review text of 450 KB (`*a *a *a ...`, `[[[[`, `[a](x[a](x`) froze the
     page for 68 s: the emphasis and link scans re-read the rest of the text at
     every marker (quadratic). Spans are now limited to 500 characters (links:
     200 text, 400 target); the same note renders in under 3 s. Test: "markdown
     that is quadratic to scan".
   - Fixed, a group called `constructor` showed as already read (the read marks
     were a plain object), so a gloss could hide a group from the progress
     count. File-name counters had the same flaw. They have no prototype now.
     Test: "hostile text from commits, notes and reviews stays text".
   - Not exploitable (same test and "hostile branch names and query values"):
     `javascript:`, `data:`, `vbscript:`, mixed-case, entity and image links
     stay text; `</script>`, `<img onerror>` and attribute injection in commit
     subjects, authors, file names, gloss text, review fields, review stages
     (used in an element id), branch names and `?head=`/`?base=` notices. No
     handler ran, no element was made, every `a` is a `#` link, the page did not
     navigate. The page's CSP (`default-src 'none'`, nonce) is the second line.
3. The `ary` server.
   - Fixed, `GET //[` (a browser page can send it with `fetch`) made
     `new URL` throw outside the handler's try, which ended the whole server
     with a stack trace. Test: "ary survives request targets that are not URLs".
   - Not exploitable (test: "ary answers only its own host names"): Host
     variants (`127.0.0.1.evil.com`, `localhost.`, other port, leading zero,
     userinfo, IPv6, empty, missing, HTTP/1.0, duplicate Host) get 403 or 400;
     upper case is accepted on purpose. POST, OPTIONS (no CORS headers), TRACE,
     PUT, DELETE, PATCH get 405; HEAD works. Query values that start with `-`,
     contain NUL, or look like `--output=` are refused or reach git after
     `--end-of-options`; nothing was written. `@{1}`, `:/x`, `^{/x}`, `!`,
     `:(top)`, CR LF in a value, a 20 KB URL (431) and `/../` paths are harmless.
     Error pages escape what they echo, have `default-src 'none'`, `nosniff`
     and a charset; pages have `frame-ancestors 'none'` and `no-store`.
   - Measured, not fixed: every request runs git synchronously, so one heavy
     page blocks all others. A 190-commit range took 10.8 s and a trivial 404
     asked meanwhile waited 10.6 s; 5 such requests took 53 s. Any web page can
     send them (a no-cors GET to 127.0.0.1 passes the host check). Local DoS only.
     Follow-up: run git asynchronously, or allow one heavy request at a time and
     cache the page per revision.
4. `html -o` and the default path. Not exploitable: the default file name is made
   of commit ids only (`<10 hex>[..<10 hex>].html`), never of a ref name, so
   branch names like `a/b/c` cannot add a path separator or `..` (they are
   resolved by git first, and `..` is not legal in a ref name); the directory is
   created 0700. Test: "html writes its default file". Not a boundary: `-o` and
   `XDG_CACHE_HOME` are the user's; a symlink planted at the default path needs
   write access to the user's own cache directory.
5. `sync` and git arguments. Every revision from a query, note or message reaches
   git after `--end-of-options` or a hex check (`origins.ts` only passes matches of
   `[0-9a-f]{7,64}`); `-L` and `blame` take the file as one argument or after
   `--`; the remote name must be one of `git remote`. Fixed, see above: the fetched
   notes ref check.
   - [ ] After `sync` handles a remote moving from `refs/notes/gloss/x` to
     `refs/notes/gloss`, a plain `git fetch` still fails in that state until
     `git remote prune` or a `sync`, and the opposite move (remote has only
     `refs/notes/gloss/x`, tracking `.../gloss` exists) is not cleared. A
     glob-free refspec per ref, with an `init` migration, would fix both.

Follow-ups, real but left alone:
- [ ] Code lines in a diff are printed as they are (`show -g`, `--diff`, `hunks`),
  as `git diff` does; a commit that contains escape sequences reaches the terminal.
- Fixed in the same audit: a review stage named `constructor` or `__proto__` printed `undefined` in the verdict phrase (a plain-object lookup).
- [ ] Not tried: catastrophic regexes in `rev=HEAD^{/...}` (git's own).
- [ ] A note over 256 MB (git()'s `maxBuffer`) fails the read as a git failure, not
  as "over the size limit", and in a range that is not skipped (only refusals are).
- [ ] The html page still shows file names and diff code lines as they are (bidi and
  zero-width characters in them are not removed; file names must stay as git has them).

## Release

- [ ] A ConfigError from an unreadable base config is not cached, so `lint`, `show` and `html` over many commits repeat the failing git calls (and the warning text).
- [ ] `sync` clearing stale tracking refs: remote `a/gloss` and remote `a` share the namespace `refs/notes/remotes/a/gloss/`, so each can evict the other's tracking refs (remote names with `/`).
- [ ] The 250 ms pattern budget is still wall-clock: a slow machine can time a pattern out on one run and not another, so the floor can differ between runs (now visible: the hit and the reasons say "timed out", but nothing stabilises it). Follow-up to the timed-out marker; from the bugs review of the config hardening.

## Attention and impact: the rest of the brief

The brief is `gloss-review.md` (kept outside the repo; consider adding it under
`docs/`). Phases 1 and 2 are done. Remaining:

- [ ] HTML signals panel (collapsible: path classes, pattern hits, dependency
  bumps). The per-commit attention list for ranges now exists in the review desk.
- [ ] `impactCommand`: the repo's own "affected projects" command, and the
  `manyProjects` setting. Both were removed from phase 2 as unused; add them back
  together with the feature.
- [ ] Inline `gloss-ignore` for pattern false positives. The first real case is
  this repo's own `src/config.ts`, whose default `secret` regexes match
  themselves and push the floor to must-read.
- [ ] More lockfile formats (only `package-lock.json` and `pnpm-lock.yaml` are
  parsed; others are still classified `contract` without version detail).
- [ ] git-gud: the honesty prompt checks impact and attention and flags
  under-rating; a recorded reviewer attention verdict; `gud.tiers` and
  `review --auto`. See section 7 of the brief.
- [ ] Presets (named, never implicit).
- [ ] Phase 2 wording follow-ups: README and the `config` gloss group call the
  defaults "language-free" but they include a SQL regex and ecosystem file
  names; the `pathFloor` comment mentions a manifest rule that does not exist;
  `add` also gates on the working-tree config, and the risks do not say so; a
  malformed config warns once on stderr while `show` and `html` fall back to
  unrated.

## Review desk (the new `git gloss html` page)

- [ ] Merge the `feature/review-desk` work (see the branch or the commit that
  replaced this line) and delete the worktree and `~/.cache/claude-gloss-review`.
- [ ] Choosing a branch whose range over its base has more than 200 commits still
  opens the branch's newest commit alone (an explicit range shows the newest 200);
  the commit filter searches only the commits loaded, and the wip link stays
  visible on the wip view itself. Cutting a range to its newest 200 still runs
  `rev-list` over the whole range first, so a huge range costs its full walk.
- [ ] Polish: the narrow rail wraps awkwardly in the reviews rows; a filter
  that hides the open group leaves it showing in the pane; changing a filter on
  a range's commit overview rebuilds the pane, so the scroll position can jump.
- [ ] On ranges the group filter and necessity chips are one global setting, so
  a filter chosen in one commit still hides groups after opening another (the
  filter button counts are per commit, so labels and rows can disagree). Reset
  the filters when the open commit changes, or keep them per commit.
- Timing guards: the hostile decision text browser test lost its wall-time check (102 ms, nothing slow to mutate it against; its safety asserts stay), and the signals performance test is a ratio (900 vs 100 hunks) rather than a time. The 10 MB line and nesting tests keep generous "slow, not hang" budgets, their functional asserts fail first.
- Hung test suite (twice a full `npm test` stalled for minutes with an orphan headless Chromium, cause never identified or reproduced; hours-old `--user-data-dir=/tmp/g-...` Chromiums were also found after SIGKILLed test runs). Guards added: `--test-timeout=180000` plus `test/guard.ts` (a 10 min file backstop, because a timed-out test does not end its file's process while a child lives: verified), `test/run.ts` (every test child gets a 120 s timeout and SIGKILL), `browse()` has a 100 s deadline and kills its Chromium process group (and waits for it), `dumpDom` kills its group also after its own timeout (it uses node's raw `spawnSync` for the pid; run.ts would throw first), and both `browse()` and `dumpDom` run Chromium under `timeout --signal=KILL 600` where coreutils `timeout` exists (bounds it after a SIGKILLed test run). Tested with the real node: the default child timeout (`GLOSS_CHILD_TIMEOUT`, also with `undefined` options) and the group kill (stub browser via `GLOSS_CHROMIUM` that leaves a background helper; red with a parent-only kill). Not reproduced: the original hang; the SIGKILLed-parent wrapper is only checked by reading its behaviour, not by a test. Risks: async `spawn` children (the ary servers in ary.test.ts / untrusted.test.ts) are also SIGKILLed at 120 s; `browse()` steps already running when the deadline fires are not interrupted (only `waitFor` polling stops, through an abort signal) and can touch the profile being cleaned up; `test/guard.ts` ends a legitimate file that runs over 600 s (`GLOSS_FILE_TIMEOUT` overrides); the `timeout` wrapper's 600 s bound is lost when node SIGKILLs the wrapper alone (covered by the group kill); git calls in src/git.ts now have a timeout (120 s, `GIT_GLOSS_GIT_TIMEOUT` ms, 0 = none; fetch, push and ls-remote in sync get 600 s, `GIT_GLOSS_NETWORK_TIMEOUT` sets that alone; best-effort `update-ref -d` cleanups use `gitCleanup`, which swallows a timeout with a warning, so a tmp ref may be left) and run.ts's sync calls run under `timeout --signal=KILL`, which kills the whole process group (test/timeout.test.ts). The earlier guess that a grandchild holding a pipe makes `spawnSync` block past its timeout was checked and is false on this machine (it returned at the timeout; the grandchild was only orphaned), so the cause of the original hang is still unknown. Unguarded: a child spawned with raw `node:child_process` in a new test, and a one-off sync loop in a test (nothing interrupts it).
- [ ] test/run.ts: wrapped sync children report a missing command as exit 127 from `timeout`, not an ENOENT error.
- [ ] A git that ignores SIGTERM is waited for in the CLI commands (no second-stage kill); in `ary` the job's process group gets SIGKILL 2 s after SIGTERM, so only the CLI is affected.
- [ ] test/timeout.test.ts reads /proc (Linux only), and Ctrl-C does not reach the `timeout`-wrapped process group in tests: a child is bounded by its limit, not by the interrupt.
- [ ] Async `spawn` children in test/run.ts (the ary servers) are still killed alone, not as a group: tests kill and signal them by pid, so wrapping them in `timeout` would orphan the server on a SIGKILL of the wrapper; they would need `detached: true` and a group kill.
- [ ] The browser tests skip on Node 20 (no global `WebSocket`) and the skip is
  silent, so a Node 20 CI would lose all browser coverage without failing.
- [ ] Performance: every hunk of the selected group is now built eagerly (the old
  page built them on "Show code"). Checked on a 39-commit range (2.2 MB page, 11ms
  to select a commit) but not on one very large single commit.
- Decided against: a group order control (Review / Gloss / Largest / By file).
  It added a choice without solving a problem. The groups keep one review order
  (look-first, then impact, then size).
- [ ] Browser tests: they use a random port with no collision check, and the
  full suite takes about 2.5 minutes.
- [ ] Restoring marks across tabs is not supported on purpose: read marks use
  `sessionStorage` and are lost when the tab closes.

## Recording what was decided about each review finding

Phases 1 to 3 are built: decision records, `reviews --decide`, shown in
`reviews` and `show`, and carried by adopt, carry and sync. Known cost:
git-gloss versions without it copy only review records through adopt and carry
and drop decision lines. The reason for it: a review record holds the report
and a verdict, so a reader cannot tell "3 fixed, 2 deferred" from "5 ignored".

- [ ] git-gud (other repo): add the `gloss-findings` block spec (`BLOCK_SPEC` in `src/findings-block.ts`, also in the README) to every stage's prompt and feed the stderr of a refused `--record` back to the reviewer; use `reviews <target> --open` as the hand-off gate. `git gloss review` (the built-in prompt) already asks for the block.
- [ ] Structured findings (2026-10-25): reviews have no `--json` output yet, so `--open` is text only. The gate is fail-closed (every item of every structured review, per target; skipped records exit 1), so a superseded review's findings must be decided one by one: a bulk "decide all of review X" helper or a `superseded` outcome may be wanted. `show` and the page count per commit (only that commit's decisions), so a decision made through a narrower target can show as open there while the gate is shut/open by the union over its target. Not measured: how often real reviewers emit an invalid block.
- [ ] Structured findings: `adopt`, `carry` and a wip re-snapshot copy review note lines raw (also ones this version cannot read), so the fail-closed gate holds on the target; the copy cannot tell a line a newer writer made from junk, and carries both. Decision lines are copied only when valid and when their review is on the commit.
- [ ] Structured findings: a review is stale when its stage no longer covers the commit, or it saw a changed line (or honesty/improve gloss group) that is gone; a review that merely missed lines added later is only stale through its stage.
- [ ] Structured findings: an unclosed prose fence earlier in the report swallows a valid final block, and the refusal says "no gloss-findings block" without naming that case; the message could say so.
- [ ] Structured findings: `copyReviews` copies junk lines raw without a size bound (a trade-off against the fail-closed bypass); lines over the 8 MiB review cap that look like decisions are neither counted nor copied.
- [ ] Structured findings: `skippedCount`/`skippedAt` keep the last read's count per commit, so they can be stale if a commit's notes vanish within one process.
- [ ] Structured findings: a gate shut by an old review's undecided items needs one decision per item; consider `--supersede <review-id>` or a bulk decide.
- [ ] Structured findings: the findings table pads columns by UTF-16 length, so wide characters (CJK, emoji) in titles misalign it.
- [ ] Structured findings: `show` and the HTML page count a commit's own decisions, while the gate uses the union over its target, so a decision made through a narrower target can show as open there. The `show` line no longer summarises a legacy review's decisions (`reviews` lists them).
- [ ] Structured findings: the block's `detail` cap is 500 characters (was 2000) so the worst spec-compliant block fits the 256 KiB report cap; a reviewer needing more puts it in the prose.
- [ ] Structured findings: decisions with equal `at` (a batch in one millisecond plus another writer) pick the status by note-line order, which git sorts; no tie-break beyond that. `checkLength` in `batch.ts` is now unreachable from the CLI (a finding is an id of at most 32 characters, so a record cannot pass the 16 KiB cap); kept as a guard.
- [ ] Structured findings: the HTML pane omits an item's `detail` (the raw report holds it, under the disclosure); a rail row shows only the open count of a stage's newest review.


## Sync speed

Measured locally (no network): a sync with nothing to do takes 0.7 to 2.2s
(23 git calls); pushing 1,500 notes takes 22s (about 14ms per note, one
`git notes add` process each). The 2 to 3 minute syncs seen at work are probably
the network: a sync makes up to six round trips, and the pre-push hook runs one.

- [ ] Time `git ls-remote origin refs/notes/gloss` in the work repo to confirm.
- [ ] Combine the gloss and review round trips, skip the `ls-remote` before
  the fetch, and write many notes in one `git fast-import` instead of one process
  each.

## Review process (how we check changes)

- Tests clean up their /tmp dirs and Chromium profiles via test/tmp.ts; a long TMPDIR is handled (Chromium's scratch moves to a short /tmp dir past 90 bytes; test/browser.test.ts guards it); reviews/subagents should still set TMPDIR to a per-job dir (2026-10-24).
- [ ] Add an adversarial stage for high-impact groups: a reviewer with the
  source that must produce and run a working exploit or failing test, not an
  opinion. Findings only count if reproduced. Targets: untrusted text (the
  markdown renderer, html embedding, CSP), notes from remotes, config parsing,
  the `ary` server.
- [ ] "Tests bite" check: for each new test of a high-impact group, mutate the
  key line and show the test going red. Two vacuous tests were found this way
  by review in the desk work. A real mutation tool (Stryker) is worth trying on
  the small pure modules (`glob.ts`, `floor.ts`, `signals.ts`, `attention.ts`,
  `merge.ts`) but not on the browser tests.
- [ ] Run the existing security review skill on anything rated must-read or
  touching untrusted input.
- [ ] The `gg-deliver` skill was copied from a work project; trim its PR flow
  and `nx` steps for this repo.

## Batch decisions and lint (2026-10-25, from the reviews of `--decide-file` and `lint`)
- [ ] `lint` is silent about `config-edit` when the diff analysis is unavailable (malformed `.gloss/config.json`): the rating checks are skipped, `config-edit` with them.
- [ ] `newRecords` (idempotent re-run) relies on `readDecisions` returning every record: lines skipped as over-length or malformed make the "latest decision" fall back to an older one, so a re-run could write a decision again.

## Timeouts (2026-10-25, from the reviews of the git timeout work)

- [ ] `rethrowTimeout` at the stamp (reviews), the show hint, the versions summary and `createdAt` (sync) has no test; a regression that swallows a timeout there again stays green. Add one test per site with the hanging fake git.
- [ ] A `git push` that times out (600 s) in `round()`/`syncReviews()` fails before `notes merge -s ours` records what the remote has; the remote may already have accepted the push, so the next merge base is stale. Probably self-healing; verify and test.
- [ ] A network timeout message says to set `GIT_GLOSS_GIT_TIMEOUT`, but `GIT_GLOSS_NETWORK_TIMEOUT` is the variable that governs fetch/push/ls-remote; make the message name the right one.
- [ ] `dropWipNote` still uses `gitTry` (a timeout there throws); decide whether a hung note deletion should fail the command.
- [ ] `ary` page builds run in a child process per request (no cache, no coalescing of identical requests; a page costs a node start). A SIGKILL of the `ary` process itself cannot clean up: its children (own process groups) finish or hit GIT_GLOSS_ARY_TIMEOUT only if the parent lives, so a hung git can outlive a SIGKILLed server (Linux `prctl(PR_SET_PDEATHSIG)` is not available from node; a child could watch its stdin/IPC channel and exit when it closes).
- [ ] `ary`: the whole page is buffered in the server (up to 32 MiB, `GIT_GLOSS_ARY_MAX_OUTPUT`; peak about twice that per job while chunks are joined, so 4 jobs can hold 256 MiB) before the first byte is sent, so a slow build shows nothing until done. A request line over node's header limit (about 16 KB) is answered 431 by node, before the handler.
- [ ] test/arysync.test.ts: the "closing the server" test also passes without `pool.cancelAll()` in `close` (closeAllConnections cancels the jobs through the client-disconnect path); the two are redundant defences, only the pair is tested.
- [ ] `ary` stream the page body from the child to the response instead of buffering it (needs the status first, then bytes; would drop the 2x peak and the output cap's memory cost).
- [ ] jobs.ts: on the child's `close`, `killGroup('SIGKILL')` signals `-pid` after the leader is gone; if the group is empty, the pid could in theory be reused as a process group id by something else in that window (very small; a fix would track the group's liveness, or skip the kill when no member is left).
- [ ] `ary`'s signal handler calls `server.close()` then `process.exit()` in the same tick, so the SIGTERM grace (2 s before SIGKILL) is skipped: the exit handler SIGKILLs the jobs at once. Acceptable because ary's git calls are read-only (no lock files to leave), but a git that would clean up a temp file is not given the chance.
- [ ] `ary` child memory is not bounded by the output cap: the page data for 200 commits and git's own output (a 256 MiB `maxBuffer` per call) are held in the child before the page is rendered; only the rendered page is capped.
- [ ] ary jobs: `GIT_GLOSS_ARY_JOBS=0`/`abc`/`-1` silently fall back to the default (`posInt`); say so in the README or warn.
- [ ] The arysync 504 test (12 s budget) may not discriminate from the old blocking server (an 8 s block finishes inside it); tighten with a condition-based check.
- [ ] `sync` deletes stale tracking children before the network fetch; if the fetch then fails the deletion is silent (harmless: nothing reads them), and a failed `for-each-ref` skips the cleanup silently.
- [ ] No test for `lint`'s exit status when signals are unavailable (`incomplete`).
- [ ] `versions --show` and `--restore` read a whole historical blob before any size check (`--show` has no bound); check `cat-file -s` first.
- [ ] `versions --restore` rewrites other modules' error text with regexes; give `parseNote`/`loadGlossOf` a structured reason instead.
- [ ] `reviews <target> --open` prints "no open findings" even when no structured review was found (nothing checked); say so (`hasItems` exists for this).
- [ ] The size comment at the top of the block caps in `src/findings-block.ts` still says "about 450 KB" (from before the detail cap dropped to 500); README/skill say `--record` prints "every problem" but at most 25 are listed.
- [ ] Docs: the gate is only as strict as its writers (a record without `items` counts as legacy and hides nothing).
