# git-gloss

Agents write a lot of code, and reviewers can't easily tell what each part is for or whether it was needed. `git-gloss` lets the author of a commit (usually the agent that wrote it) attach a **gloss**: the diff grouped by intent, with each group graded for necessity and saying what breaks without it.

Glosses are stored in git notes (`refs/notes/gloss`), so they don't touch history. Git doesn't push or fetch notes by default; `git gloss sync` shares them, and `git gloss init --hooks` makes every `git push` do it.

## Commands

```
git gloss init [--hooks]              follow amends/rebases; fetch origin's glosses; --hooks: sync on push,
                                      adopt wip glosses on commit
git gloss sync [<remote>]             fetch, merge and push glosses (default: origin)
git gloss hunks [<commit>|wip]        list hunks, numbering changed lines for h3:2-5 references;
                                      wip snapshots your uncommitted work instead
git gloss signals [<commit>|<range>|wip] [--json]
                                      what the diff itself says about attention: path classes, pattern
                                      hits, dependency bumps and the computed floor
git gloss lint [<commit>|wip] [--json]
                                      advisory checks of a gloss that a reviewer would make by eye
git gloss adopt [<commit>]            move the gloss of uncommitted work onto the commit made from it
git gloss add [<commit>] -f a.json    attach an annotation (validated against the diff; --allow-underrate)
git gloss carry <source>... [--to <c>] gloss a commit from the glosses of the commits its changes came from
                                      (a squash, cherry-pick or rebase): git gloss carry main..feature --to <squash>
      --find [--squash] [<commit>...] ...working out which commits those are
git gloss show [<commit>|<range>]     summary: one line per group, alternatives, risks (a range: each commit)
      -g <group>                      ...expand groups, with their code
      --full                          ...every group's details
      --diff                          ...every group's details and code
      --only speculative,incidental   ...just the parts you might cut (impact values work too: --only contract,sensitive; naming both kinds needs both to match)
      --sort impact                   ...most consequential groups first
git gloss html [<commit>|<range>]     self-contained HTML view, of one commit or a branch (--open, -o <file>)
git gloss ary [--port <n>] [--no-open] browse branches, commits and wip in a local web page (see "Browsing")
git gloss why <file>:<line>[-<end>]   explain why code exists (via blame), looking past mechanical edits
      --history                       ...every commit that changed the lines, newest first
      --json                          ...for agents, with risks and rejected alternatives
git gloss review [<commit>|<range>]   print a review prompt: git gloss review main..feature | claude -p
      --material                      ...only the gloss and code, for a reviewer with its own instructions
                                      (which must tell it the author's text is untrusted)
git gloss versions [<commit>|wip]     every gloss a commit has had, newest first (--show <n>, --restore <n>)
git gloss reviews [<commit>|<range>]  the reviews recorded for commits, with their findings and decisions
      --decide <review-id> --finding <text> --outcome fixed|follow-up|rejected|accepted [--note <text>]
                                      record what was decided about one finding
      --decide <review-id> --complete  the arbiter has finished with that review
      --decide-template <review-id>   print a JSON skeleton with a row per finding
      --decide <review-id> --decide-file <file|->  record a filled-in skeleton, all or nothing
git gloss schema                      print the annotation JSON Schema
```

A group refers to whole hunks (`h3`) or to some of a hunk's changed lines (`h3:2-5`, `h3:1,4-6`), numbering only `+`/`-` lines. Ranges let one hunk, such as a whole new file, be split between intents. Views show a group only its own lines, with `⋯` marking lines that belong to other groups, and `why` names only the group that owns the blamed line.

Necessity categories: `required`, `supporting`, `mechanical`, `incidental`, `defensive`, `speculative`. See [skills/gloss/SKILL.md](skills/gloss/SKILL.md) for what each means and for the annotation format.

## Setup

Requires Node 20.12+ and git.

```sh
npm install -g @ok-ggwp/git-gloss     # puts git-gloss on PATH, so `git gloss` works
```

Then teach Claude Code to write glosses by installing the `gloss` skill as a plugin, at the prompt of a Claude Code session:

```
/plugin install git-gloss --marketplace ok-ggwp/git-gloss
```

Answer `y` to add the marketplace and choose the user scope. From a shell, the same is `claude plugin install git-gloss --marketplace ok-ggwp/git-gloss`. `/plugin update` picks up new versions of the skill. (Without the plugin, a symlink works too: `ln -s "$(npm root -g)/@ok-ggwp/git-gloss/skills/gloss" ~/.claude/skills/gloss`.)

git finds `git-gloss` on PATH, so `git gloss` works wherever npm's global folder is on PATH, as it is after a normal Node install. On Windows this should work the same way (npm installs a shell launcher git can run), but it hasn't been tested yet.

For a team, add it to the project instead, so everyone gets the same version with `npm install`:

```sh
npm install -D @ok-ggwp/git-gloss
npx git-gloss init --hooks
```

The hooks run `git gloss`, so it must be on PATH wherever git runs. A project install isn't, by default: a GUI git client, or a shell that didn't run `pnpm`/`npm` scripts, won't find it. See [Project installs](#project-installs) for how to keep the team on one version anyway.

To work on git-gloss itself: clone it, `npm install`, `npm link`, `npm test`. From a checkout, on Node 22.18+, the TypeScript source runs directly; on older versions the launcher runs `dist/`, which `npm install` builds (and `npm run build` rebuilds after changes). The tests need Node 23.6+.

### Project installs

A project install (`npm install -D`) keeps every teammate on the same version, which matters because glosses and reviews are shared git notes that each copy reads and writes. The cost is that `git gloss` is then on PATH only inside a shell that has `node_modules/.bin` on it. Two ways to deal with that:

- **Put it on PATH in the hooks.** Add one line near the top of each hook that calls `git gloss` (`pre-push`, `post-commit`, `post-rewrite`), with the hooks kept in a tracked folder (for example, `.githooks/`, set with `git config core.hooksPath .githooks`):

  ```sh
  PATH="$PWD/node_modules/.bin:$PATH"
  ```

  Git runs hooks from the top of the working tree, so `$PWD` is that directory. In a monorepo where the install lives in a subfolder (`web/node_modules/.bin`), use that path instead. On Windows, use `$PWD` rather than `git rev-parse --show-toplevel`, which returns a `C:/…` path that Git for Windows' shell can't put on PATH.
- **Run the setup from `prepare`.** A `prepare` script in the package that owns `node_modules` can set `core.hooksPath` and run `git gloss init --hooks` on every install, so nobody has to remember it in each clone. Skip it in CI, and make it never fail the install. Note that pnpm doesn't run `prepare` when `node_modules` is already up to date, so an existing clone needs `pnpm run prepare` once.

Either way, the hooks never block a commit or push. Without `git gloss` on PATH they print an error and glosses aren't adopted, carried or synced, so check that `git gloss init` prints no warning after changing it. The Claude Code skill can run the tool through the project install too; see "Calling git-gloss" in the skill.

### Setting up a repo

In each repo you use it in:

1. Run `git gloss init --hooks`. Glosses then follow amends and rebases, `git commit` moves a wip-gloss onto the new commit, and `git push` to a named remote also syncs glosses with it. The hooks call `git gloss`, so it must be on the PATH of whatever runs git (a GUI client may not have it); `init` warns if it isn't. Without the hooks, run `git gloss adopt` after committing and `git gloss sync` to share.
2. Tell your coding agent to wip-gloss its changes. Add this to the repo's `CLAUDE.md` (Claude Code), or `AGENTS.md` for agents that read that file:

   ```markdown
   ## git-gloss
   After making a non-trivial code change, wip-gloss it before reporting back: leave
   the changes uncommitted and gloss them with git-gloss, following the gloss skill.
   Don't commit unless asked.
   ```

   Claude Code finds the procedure in the `gloss` skill (the plugin installed above). Other agents won't have the skill, so for them add a pointer in `AGENTS.md` to a copy of `skills/gloss/SKILL.md`.

Put the line in the repo rather than in your user-level `CLAUDE.md`: it only makes sense where `git gloss init` has been run.

`sync` fetches the remote's glosses into `refs/notes/remotes/<remote>/gloss`, merges them into yours, and pushes the glosses of commits the remote has (or, from the hook, is being sent), retrying if someone else pushed in between. Glosses of commits that exist only on your machine, such as a private branch, stay local until those commits are pushed. Glosses on different commits simply combine, and a gloss changed on only one side since you last synced is taken from that side. Only when both sides changed the same commit's gloss since then is it a conflict: the newer gloss (by its `created_at`) wins, because a re-gloss is normally a correction, and if either can't be read, yours is kept. It prints what it fetched, pushed and decided. The hook never blocks a push: if syncing fails it prints a warning and the push goes ahead. It does nothing for `git push --dry-run`. It syncs before the branch is pushed (so glosses arrive even if the branch push is then rejected), and it disables credential prompts so a remote that needs one fails fast instead of stalling the push. If you already have a `pre-push` or `post-commit` hook, `init --hooks` leaves it alone and prints the lines to add. It also won't install into a `core.hooksPath` outside the repository, since other repositories may share that directory.

## Glossing before you commit

You don't have to commit to gloss or review. `wip` stands for your uncommitted work:

```sh
git gloss hunks wip            # snapshot tracked and untracked changes (respects .gitignore)
git gloss add wip -f a.json    # gloss the snapshot
git gloss show wip             # read it; html wip and review wip work too
git commit                     # with init --hooks, the gloss moves onto the commit
git gloss adopt                # ...or move it by hand
```

The snapshot is a commit object built from a temporary index, kept by the private ref `refs/worktree/gloss/wip` (one per linked worktree); your branch, index and files are never touched. Taking a new snapshot keeps the gloss of groups whose changes are unchanged, so after committing part of the work or editing one part, only the rest needs glossing again. Its gloss lives in `refs/notes/gloss-wip`, which `sync` doesn't push. Untracked files that look like secrets (`.env`, `*.key`, `*.pem`, `credentials.json`, …) are left out of the snapshot, with a note, because snapshots are shown and sent to reviewers; stage one with `git add` to include it. If a branch or tag is called `wip`, `wip` still means it when there's no snapshot; otherwise use `heads/wip`. Commands warn when you've edited files or committed since the snapshot. `adopt` matches the snapshot's hunks to the commit's by content, so the work can be committed in several commits (each takes the groups whose changes it contains), and changes made after glossing are reported as unexplained rather than silently covered. Once everything is committed, the snapshot is cleared.

## Linting a gloss

`git gloss lint [<commit>|wip]` checks a gloss deterministically for what a reviewer checking its honesty would look for by eye, and prints one line per finding with a stable code: `no-impact`, `impact-below-floor`, `attention-below-floor`, `mechanical-on-floor` (graded mechanical over a floor signal such as CI or sensitive code; a lockfile bump is fine), `unknown-serves`, `test-serves-nothing`, `required-but-nothing-breaks` (`removal_impact` begins "nothing breaks", "no effect" and the like), `missing-risks` (attention `careful` or above and no `risks`), `config-edit` (the diff edits `.gloss/config.json`, which changes what the signals count; the same note `add` prints) and `uncovered-hunks` (a stale gloss). It is advisory: findings never change the exit code (errors such as no gloss still do). `--json` prints `{target, findings: [{code, group?, hunk?, message}]}`. When the diff signals are unavailable (a malformed `.gloss/config.json`), the rating checks are skipped and lint says `incomplete` (`"incomplete": true` in `--json`) instead of `clean`. Run it after `add` and fix what it reports, or be ready to defend it.

## Glosses that follow your history

A gloss is attached to a commit, so anything that makes new commits from old ones has to bring it along. With `git gloss init --hooks`:

| You | What happens to the gloss |
|---|---|
| amend, or rebase without changing a commit's diff | copied to the new commit (`notes.rewriteRef`) |
| amend or rebase that changes the diff (a conflict, an edit) | re-glossed from the original, line by line; changes it doesn't explain are listed |
| squash or fixup commits in a rebase | the glosses of all of them are combined into one |
| cherry-pick (with or without `-x`) | carried from the picked commit |
| `git merge --squash`, keeping git's message | carried from the squashed commits |
| a squash or rebase merge on GitHub, or any other squash (your own message, `reset --soft`) | carried on your next `git gloss sync` or push, if you have the original commits (the author does): it looks for unglossed commits whose diff matches a glossed branch's combined diff (80% of changed lines in common), or a glossed commit's patch with the same author and date. By hand: `git gloss carry --find --squash` |

Carrying matches each changed line to a glossed line with the same text in the original commits, and gives it that line's group: intents, grades and notes survive, and anything changed along the way is reported as unexplained rather than guessed. `git gloss carry` does the same by hand.

Nothing is deleted. Replacing a gloss, a group dropped from a wip gloss, or the losing side of a sync conflict all stay in the notes history, and glossed wip snapshots stay reachable from `refs/worktree/gloss/archive` so `git gc` keeps them. `git gloss versions <commit>` (or `wip`) lists every version, and `--restore <n>` brings one back; a wip version is carried onto the current snapshot. The archive keeps those snapshots' files too, including anything since removed from them; `git update-ref -d refs/worktree/gloss/archive` lets `git gc` collect them (the glosses' text stays in the notes history).

## Agent reviews

`git gloss review | claude -p` gives a reviewer the gloss and the code, and asks it whether the gloss is honest: does each group do what it says, is its necessity graded fairly, what could be cut.

To have agents review in a disposable clone, where they can run the code and verify what they find, use [git-gud](https://github.com/ok-ggwp/git-gud). `git gud review [<commit>|<range>|wip]` runs this honesty review, a blind bug review that doesn't see the gloss, and an improvements review informed by it, with Claude Code, Codex or Cursor as the reviewer. git-gloss itself never runs an agent.

### Recorded reviews

git-gud records each review beside the glosses (`refs/notes/gloss-reviews`), so whoever reads a branch later can see whether its glosses were checked and what the checks found:

```
$ git gloss show main..feature
main..feature: 4 commits, 4 glossed, 3 honesty-reviewed (1 with issues)
...
reviews: honesty: no issues (claude, 2026-10-18) · bugs: defects found (claude, 2026-10-18)
```

`git gloss reviews <commit>` prints the findings, and the HTML view shows each commit's reviews, with their reports a click away. A review records what it saw: a fingerprint of each changed line and of each gloss group. So it keeps counting through rebases, squashes and a wip gloss moved onto commits. If the code or the gloss changed after the review, the line says so ("gloss changed since review") instead of vouching for it.

A review says that something was checked, not that it passed. Each review ends with a verdict (`VERDICT: CLEAN` or `VERDICT: ISSUES`). For each part of the commit, the latest review that saw it decides, and a clean result that followed one with issues says so.

### Decisions

A review holds a report and a verdict, so by itself it cannot tell "3 fixed, 2 deferred" from "5 ignored". Whoever arbitrates a review (the `gg-deliver` arbiter, or a person) records **decisions** about it, in the same notes ref and on the same commits as the review. A decision is one JSON line:

```
{"decision":1,"review":"<review id>","at":"…","by":"…","finding":"1","outcome":"fixed","note":"…"}
{"decision":1,"review":"<review id>","at":"…","by":"…","complete":true}
```

`finding` is free text naming the finding. Reports are free markdown, so git-gloss does not parse findings out of the stored text, but for display (in `reviews` and the html page; the stored report stays raw) it labels every top-level list item `**[S.N]**`, S the section (a `#` heading, a bold-only line such as `**2. Removal**`, or a short plain `3. Title` line with a blank line on each side, followed by a bullet list; its own number if it has one, else the previous section plus one; unnumbered headings before the first item are titles and take none) and N the item's place in it, replacing the source's own bullet or number. Items before the first heading are labelled `[N]` and must be named `N:` or `N)` in `--decide` (`1 wording nit` is free text); a numbered heading (`3. Removal`) counts as the ref `3` for `--decide` although no label is printed for it.

Name a decision's finding by that ref, e.g. `--finding "1.2 wording nit"`: `--decide` warns on stderr (and records anyway) when the report has no such ref.

Decisions whose finding starts with a ref (`1.2 `, `1.2: `, or a bare `3:`, `3)`, `3.`; numbers over 3 digits are text) are listed in ref order (1.2 before 1.10), the others after them in time order.

A finding must have visible text: one that is empty, whitespace or only invisible characters is refused by `--decide` and skipped by the reader. `outcome` is `fixed`, `follow-up`, `rejected` or `accepted`; `note` is optional. The second line says the arbiter has finished and no more decisions are coming, which is what separates "all arbitrated" from "5 ignored". The marker carries no `finding`, `outcome` or `note` (`--complete` refuses them, and the reader skips a marker that has one, or `"complete": false`, which only a hand-written line has). The reader takes the keys in any order. The marker is advisory: decisions added after it are still accepted and counted. A review whose verdict is clean needs none.

```bash
git gloss reviews wip --decide <review-id> --finding "Rework: wip rule claim" --outcome follow-up --note "next release"
git gloss reviews wip --decide <review-id> --complete
```

To decide many findings at once, print a skeleton, fill in each `outcome` (and `note`), and record the file:

```bash
git gloss reviews wip --decide-template <review-id> > d.json    # one row per finding, outcome ""
git gloss reviews wip --decide <review-id> --decide-file d.json  # or - for stdin
```

The template has a row for each finding, but none for a numbered heading that has items under it (those items are its findings); a hand-written row naming such a heading's bare number (`2`) is still accepted. A report that would give two findings the same ref (two `1.` headings with items, both `1.1`) gets `1/2`, `1/3`, ... (items `1/2.1`) on the later sections; the first keeps `1`. Only an actual clash relabels: a heading ref (`1`) and an item ref (`1.1`) never clash, so an empty numbered heading, an unnumbered heading or a bold line changes nothing, and every report whose refs were all distinct keeps exactly the refs it had. Decisions already recorded under an old, ambiguous ref (only reports with a clash) no longer match after the relabel and are listed as free text. Past `1/999` the label stays `1/999` and its items keep counting on, so no item row is lost. The file is either an array of `{"finding", "outcome", "note"?}` or the template's object `{"review", "complete", "decisions": [...]}` (`review` and unknown keys are ignored, though a `review` that isn't the `--decide` id is refused; `"complete": true` also records the complete marker). Keys may come in any order. Each finding is the ref and the start of its text (`1.2 wording nit`), checked as for the single call, with the same warning for a ref the report lacks. Validation is all or nothing: everything is checked before anything is written (a repeated finding is refused too), and the records go in one write per commit, with a range written commit by commit (so a git failure midway can leave earlier commits written), so a bad row (naming its entry number), an empty `outcome` (an unfilled row), or a file over 500 entries or 1 MiB, or one whose records come to over 512 KiB once written, records nothing. It prints `recorded N decisions on M commits`. Running the same file again is safe for its own author: a record equal to the latest decision for its finding on that commit (same review, finding, outcome, note and `by`) is skipped, so after a partly failed range write the re-run adds only what is missing, and says `recorded N decisions on W commits (S already recorded)`; S counts records, summed over the commits, and includes the complete marker. It is not a merge of arbiters: if someone else decided the same finding differently since, re-running an old file writes its decision again, as the latest. `--decide-template` warns on stderr when refs are ambiguous (a heading row that shares its ref with another finding). It cannot be combined with `--finding`, `--outcome`, `--note`, `--stamp` or `--record`.

The target (`wip`, a commit, a range) is as for `reviews`; the decision is added to every commit there that holds that review, and an unknown review id is an error. `by` is `--by <name>`, else `git config user.name`, else "unknown". `reviews` prints each review's id in its header line (the id `--decide` takes) and lists its decisions under it with a summary ("3 fixed, 2 follow-up · complete", or "4 decided · not marked complete"), and `show` carries the same summary on its reviews line. The HTML view (`html` and `ary`) shows the same under each review in its Reviews pane, with an outcome chip per decision, and adds how far they got to the stage's rail row (the latest 200 decisions of a review are listed). Decisions follow their reviews through `adopt` (so decisions made on `wip` survive committing), `carry`, rebases and `sync`. In the terminal, text from notes (decisions and review records) and commit subjects is shown with control characters, escape sequences, and bidi and zero-width characters (U+200B, U+200E, U+200F, U+061C, U+2060-U+2064, U+FEFF, tag characters) removed (each becomes a space; ZWNJ and ZWJ stay, so Persian words and emoji sequences render intact, and so does the soft hyphen; the html page applies none of this, so bidi overrides there are not removed), since it can arrive from a remote; decision lines over 16 KB are skipped silently, and review lines over 8 MiB or with findings text over 256 KiB are skipped with a warning; unknown outcomes and decisions for a review that is not on the commit are ignored.

Known cost: decisions share the review note, and a git-gloss without this feature ignores decision lines when reading but does not know to keep them: when it copies review records onto another commit (`adopt` and `carry`), it writes only the review records, so the decisions are lost on that copy (git's own note rewriting on an amend or rebase copies whole notes, so that path keeps them). Keep everyone who arbitrates on the same version. Likewise, decisions follow their reviews through `adopt` and `carry` only in versions that know them.

Like glosses, reviews follow rebased commits in repos set up with `git gloss init`. Reviews are shared by `git gloss sync` (and so by every push with the hooks) like glosses, for commits the remote has. They never conflict: everyone's reviews are kept. Other tools can record reviews too: `git gloss reviews --stamp <rev>` before the review, then `git gloss reviews --record` with the stamp and the report as JSON on stdin.

## Impact and attention

Necessity and consequence are separate: a `required` one-line fix to a login helper matters more than a `required` rename in a leaf component. Two optional fields say so. Each group may have `impact` (`local < module < shared < contract < sensitive`, the farthest its effect reaches if it is wrong) and an `impact_reason` of up to 120 characters. The annotation may have `attention`: `level` (`skim`, `look`, `careful` or `must-read`), one to three `focus` group ids to read first, `reasons`, and an optional `override_reason`. `git gloss schema` lists them all.

`show` leads with `attention: CAREFUL (declared) · floor: careful · focus: a, b` and the reasons, and badges each group with its impact; `html` shows the same as a banner whose focus links jump to the groups. Where nothing is declared, `show` and `html` show a value computed from the diff and mark it, as in `attention: LOOK (derived)` (a group's derived impact is in parentheses); a gloss reads as `attention: unrated` only where no signals can be computed. When glosses are combined (`carry`, a squash, a rebase) the attention level is the highest of them and the focus groups are the most impactful three, with the reasons joined; if any of them declared none, the combined gloss declares none and shows a derived one.

Notes using these fields are format 4; a git-gloss that predates them refuses such a note ("written by a newer git-gloss") rather than silently dropping the fields. A gloss that doesn't use them is still written in its old format. Derived values and floors are computed on every read and never stored in a note.

### Computed signals and the floor

`git gloss signals [<commit>|<range>|wip] [--json]` reports, per hunk, file and change: the path classes (`sensitive`, `shared`, `contract`, `generated`, `test`, `docs`, plus `lockfile` and `manifest`), pattern hits, stats (files, hunks, lines, test files, share of hunks in tests), dependency changes, and the floor. `wip` is the working tree as it is now (no snapshot is taken). `hunks` ends with a short summary of the same, so read it before writing a gloss. Signals are cheap heuristics from globs and regexes, not a security scanner.

- **Pattern hits** are regexes (case-insensitive unless the pattern sets `flags`) matched against the *added and removed* lines of a hunk only: never unchanged context lines, never the `@@` header. In test, docs and lockfile paths they are *damped*: still reported, but they don't count towards the floor (a `password` in a test file is not sensitive).
- **Dependencies.** Edits to manifests and lockfiles are listed. `package-lock.json` and `pnpm-lock.yaml` are parsed from their changed lines for version bumps, and a bump of a package that no `package.json` change names is flagged as transitive. Other lockfiles are `contract` with no version detail.
- **Floor of a hunk**: the highest of its path class (`sensitive`, `contract`, `shared`; lockfiles and manifests are at least `contract`; otherwise `module`) and its undamped pattern hits. Test, docs and generated files cap at `local` (a pattern hit in generated code still counts). A group's floor is the highest floor of its hunks; for a group that claims only some lines of a hunk, only the hits on those lines count.
- **Floor of the change**: skim for `local`, look for `module`, careful for `shared` and `contract`, must-read for `sensitive`, and at least careful when more than `attention.largeChangeFiles` (default 50) files changed.
- **Derived attention** (when the gloss declares none): start from the highest group impact (declared, else the group's floor) with the same mapping, then raise it one step (capped at must-read, once however many apply) for a behaviour-changing group that no test group serves, for a speculative or defensive group outside tests, or for more than `largeChangeFiles` files; never below the floor. A group is *behaviour-changing* when its necessity is not `mechanical` and not all its hunks are tests, docs, generated files or lockfiles. It is *served by tests* when a group made only of test-file hunks names it in `serves`, directly or through groups it serves; a test group serving `"task"` doesn't count.

`add` checks a gloss against the floor. A group whose declared `impact` is below its floor (above plain `module`) is a warning naming the signal. A declared `attention.level` below the floor is an error unless `attention.override_reason` says why; `--allow-underrate` turns that error into a warning. `add` also warns, once, naming the groups with no `impact` that should have one: every group except a `mechanical` one on plain source (floor `module` or below); a mechanical lockfile bump, say, still counts. It still accepts the gloss, and leaving `impact` or `attention` out is never an error. An `override_reason` is shown by `show` and `html` next to the floor, flagged as a mismatch.

### Config

The built-in defaults name no language, framework or tool, only common file names. A repo adds to them with `.gloss/config.json`, committed in that repo. The file is read from the base branch (the merge base of the checked-out `HEAD` and `origin/main`, `main`, `origin/master` or `master`, so a long-lived branch sees the config as of where it forked; a commit on the base branch itself reads its own config, flagged `sensitive` if it edits the file), never from the working tree, so a change cannot reclassify its own paths; a config edit only takes effect once it is on the base branch. With none of those branches the defaults apply, with a warning. Editing the file is itself always a `sensitive` path. A pattern that takes over 250 ms on a hunk is cut off and from then on counts as matching every changed line (with a warning), so a slow or padded line raises the floor and never lowers it:

```json
{
  "attention": { "largeChangeFiles": 80 },
  "paths": {
    "shared": ["packages/shared/**", "tsconfig.base.json"],
    "sensitive": ["src/devices/**"],
    "test": { "extends": false, "globs": ["**/*.spec.*", "e2e/**"] }
  },
  "patterns": {
    "sensitive": [{ "regex": "\\bdevice\\.write\\(", "name": "device write" }],
    "contract": ["<regex for the repo's public-API markers>"]
  }
}
```

A class is a list that extends the default list, or `{ "extends": false, "globs": [...] }` (`"regexes"` for patterns) to replace it. Path classes: `sensitive`, `shared`, `contract`, `generated`, `test`, `docs`, `lockfile`, `manifest`; pattern classes: `sensitive`, `contract`, `shared`. Globs support `**`, `*`, `?` and `{a,b}`; a glob without a `/` matches that name at any depth. `git config gloss.attention.largeChangeFiles <n>` overrides the file. A malformed config is an error naming the file and key (`add` and `signals` stop; `show` falls back to declared values and "unrated").

## HTML view

`git gloss html --open` writes a single HTML file (no network access, works offline) and opens it. It shows the task and summary, a bar of how the changed lines split across necessity categories, and a card per group with its rationale; code is collapsed until you ask for it. Click categories to filter, use the sidebar to jump between groups, or press `j`/`k` to move, `o` to show code, and `e`/`c` to expand or collapse everything. `#g-<group>` in the URL opens that group.

Give a range (`git gloss html main..feature --open`) for a branch or PR view: every non-merge commit in order (merges are listed as not reviewed; `A...B` is rejected), a necessity bar across the whole branch, and the sidebar grouped by commit. Commits without a gloss appear with their whole diff marked as unexplained. On range pages a group's link is `#g-<commit>-<group>`. `git gloss review main..feature` likewise covers every commit and adds branch-level questions, such as later commits that undo earlier ones.

All gloss and diff text is rendered as text, and a Content-Security-Policy with a per-page nonce blocks any script the page didn't generate.

## Browsing

`git gloss ary` starts a small web server and opens it in your browser, so you can explore glosses without working out commits, branches and ranges on the command line. The page is the review desk that `git gloss html` writes, with the pickers in its top bar: choose a branch and a branch to compare it with (the repo's `main` or `master` by default); each picker has a search box, for repos with many branches. With a base, the desk's own sidebar lists the commits of the range; with "none" (or when there is nothing beyond the base, or more than 200 commits) the page shows just the branch's newest commit and its groups. To look at anything else, such as `HEAD~3` or `release..main`, type it into the revision box. As everywhere in git-gloss, `wip` there means the snapshot of uncommitted work, which is what opens first once it has been snapshotted (`git gloss hunks wip`); to view a branch or tag called `wip`, type `heads/wip` or `tags/wip`. Every choice loads a new page (`/?rev=…&head=…&base=…`), regenerated from the repo each time, so reloading picks up new glosses and reviews, and the address keeps the selection (with a random port, a bookmark lasts only until you stop the server; pass `--port` for a stable address).

It serves one repository, the one you run it in, until you press Ctrl-C. It listens on 127.0.0.1 only, on a free port (or `--port`), only answers requests addressed to that host name, and never writes anything: it doesn't take snapshots or change notes. A page shows at most 200 commits; pick a narrower range for more. `--no-open` doesn't launch a browser.

## Caveats

- Carrying a gloss onto a server-side squash needs the original commits in your repository; usually the author has them. If a squash merge resolved conflicts or changed much of the code, it may not reach the 80% match; run `git gloss carry <branch commits> --to <squash>`.
- A gloss records each hunk's location and a hash of its content. If a commit is amended or rebased so its diff changes, `show`, `review` and `why` flag the gloss as stale instead of showing it against the wrong code.
- Merge commits are diffed against their first parent.
- `git gloss html` writes to `~/.cache/git-gloss/<commit>.html` by default (or `$XDG_CACHE_HOME`). The page is a snapshot; regenerate it after re-glossing.

## License

MIT. See [LICENSE](LICENSE).
