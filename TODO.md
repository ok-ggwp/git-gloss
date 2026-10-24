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
   - Reproduced, not fixed: the refspec `init` adds, `+refs/notes/gloss*:refs/notes/remotes/origin/gloss*`,
     lets a remote that publishes `refs/notes/gloss/x` and later `refs/notes/gloss`
     break every `git fetch` (exit 128, "cannot lock ref ... exists; cannot create") and `git gloss sync` ("some local refs could
     not be updated") until the user runs `git remote prune origin`. The glob is
     there on purpose (a plain refspec fails while the remote has no notes).
     Follow-up: one glob-free refspec per ref, with a migration in `init`, or
     delete a conflicting tracking ref before the fetch in `sync`.

Follow-ups, real but left alone:
- [ ] Code lines in a diff are printed as they are (`show -g`, `--diff`, `hunks`),
  as `git diff` does; a commit that contains escape sequences reaches the terminal.
- [ ] A refused gloss (too many claims, over the caps) fails the whole `html` or
  `show` of a range; skip that commit with a warning instead, as for an unglossed one.
- Fixed in the same audit: a review stage named `constructor` or `__proto__` printed `undefined` in the verdict phrase (a plain-object lookup).
- [ ] No cap on a note's total size (all costs are linear in it: 60 MB took 1 to 2 s).
- [ ] Not tried: `adopt`, `carry` and `versions` end to end with a hostile note
  (they use the same readers); catastrophic regexes in `rev=HEAD^{/...}` (git's own).

## Release

- [ ] The 250 ms pattern budget is still wall-clock: a slow machine can time a pattern out on one run and not another, so the floor can differ between runs (now visible: the hit and the reasons say "timed out", but nothing stabilises it). Follow-up to the timed-out marker; from the bugs review of the config hardening.
- [ ] A git failure reading the base config warns and uses the built-in defaults, so the repo's stricter patterns do not apply to that run; a failing base candidate warns and the next one is tried (defaults only if none works). A failing run could throw instead if a loud warning is judged too weak. From the honesty review of the config hardening.

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
- [ ] Show whether the wip snapshot is stale (the old ary list warned; the desk
  does not) — dropped by the ary restyle.
- [ ] `ary` no longer has a way to browse single commits of a range over 200
  commits except typing a narrower revision.
- [ ] `ary` lost searching commits by message or author (the old sidebar
  search), with no replacement.
- [ ] In a repo with no local branches and a detached HEAD, `/` returns 422 and
  the error page's "Back to the default view" link loops (fall back to
  `rev=HEAD`, or render the pickers).
- [ ] `ary` has no way to get back to the wip snapshot from the pickers; consider
  a 'wip' entry in the revision field's hint or a link.
- [ ] Polish: the narrow rail wraps awkwardly in the reviews rows; a filter
  that hides the open group leaves it showing in the pane; changing a filter on
  a range's commit overview rebuilds the pane, so the scroll position can jump.
- [ ] On ranges the group filter and necessity chips are one global setting, so
  a filter chosen in one commit still hides groups after opening another (the
  filter button counts are per commit, so labels and rows can disagree). Reset
  the filters when the open commit changes, or keep them per commit.
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

- [ ] `plain()` misses the bidi marks U+200E, U+200F and U+061C (README says control characters are removed; say so).
- [ ] The decision reader and writer disagree on `complete` lines (the reader accepts a `note` on one; the writer refuses it), and `isDecisionLine` requires `decision` to be the first key, so a valid hand-written line with another key order is dropped silently. Parse, then check `decision === 1`. From the honesty review of the decision records.
- [ ] The html Reviews view does not show decisions yet.
- [ ] Phase 5 (git-gud, other repo): structured findings, so "N still open" can
  be computed.

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
