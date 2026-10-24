# git-gloss: what is still to do

Written 2026-10-24, from the phase 1, phase 2 and review-desk work. Keep this
current: remove an item when it ships, and say where a new one came from.

"Verified" means someone ran it and saw it. "Read" means it comes from reading
the code only.

## Security: do these before the next release

- [ ] Look at the other places untrusted text enters: notes fetched from a
  remote (huge or malformed JSON), the `ary` server's host check and request
  handling, and the paths `html -o` will write to. See "Review process".

## Release

- [ ] Bump the git-gloss dependency in git-gud (it bundles 0.2.0 and cannot read
  format-4 glosses, so `git gud review` refuses them). Until then, reviews need a
  copy of git-gud pointed at the current build.

- [ ] A timed-out pattern now counts as matching every line (fails closed) and
  warns on stderr, but the 250 ms budget is wall-clock, so on a loaded machine a
  slow pattern can raise the floor on one run and not another, and the hit says
  nothing about a timeout. Carry a "pattern timed out" marker into
  `signals --json`, `show` and `html`. Found by the honesty and bugs reviews of the config hardening.
- [ ] `readRepoConfig` turns any git failure into "no config" without a warning (a failing `git show` on an existing base ref, or a failing `merge-base` reported as "no base branch"). Distinguish "no file" from "git failed". From the honesty review of the config hardening.

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

Scoped, not started. Today a review record holds the report and a verdict, so a
reader cannot tell "3 fixed, 2 deferred" from "5 ignored".

- [ ] Phase 1: a `decision` record in the same notes ref (`{decision: 1, review,
  at, by, finding, outcome: fixed|follow-up|rejected|accepted, note?}`),
  validation, and `git gloss reviews --decide <review-id> --finding … --outcome …
  [--complete]`. Older readers must ignore the lines. Known cost: old versions
  copy review records through rebases and would drop lines they do not know.
- [ ] Phase 2: show decisions in `show`, `reviews` and the Reviews view of `html`.
- [ ] Phase 3: decisions follow adopt, carry and squash like reviews do.
- [ ] Phase 4: update the `gg-deliver` and gloss skills so the arbiter records
  decisions.
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
