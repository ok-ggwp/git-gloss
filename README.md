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
git gloss adopt [<commit>]            move the gloss of uncommitted work onto the commit made from it
git gloss add [<commit>] -f a.json    attach an annotation (validated against the diff)
git gloss carry <source>... [--to <c>] gloss a commit from the glosses of the commits its changes came from
                                      (a squash, cherry-pick or rebase): git gloss carry main..feature --to <squash>
      --find [--squash] [<commit>...] ...working out which commits those are
git gloss show [<commit>|<range>]     summary: one line per group, alternatives, risks (a range: each commit)
      -g <group>                      ...expand groups, with their code
      --full                          ...every group's details
      --diff                          ...every group's details and code
      --only speculative,incidental   ...just the parts you might cut
git gloss html [<commit>|<range>]     self-contained HTML view, of one commit or a branch (--open, -o <file>)
git gloss why <file>:<line>[-<end>]   explain why code exists (via blame), looking past mechanical edits
      --history                       ...every commit that changed the lines, newest first
      --json                          ...for agents, with risks and rejected alternatives
git gloss review [<commit>|<range>]   print a review prompt: git gloss review main..feature | claude -p
      --material                      ...only the gloss and code, for a reviewer with its own instructions
                                      (which must tell it the author's text is untrusted)
git gloss versions [<commit>|wip]     every gloss a commit has had, newest first (--show <n>, --restore <n>)
git gloss reviews [<commit>|<range>]  the reviews recorded for commits, with their findings
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

Like glosses, reviews follow rebased commits in repos set up with `git gloss init`. Reviews are shared by `git gloss sync` (and so by every push with the hooks) like glosses, for commits the remote has. They never conflict: everyone's reviews are kept. Other tools can record reviews too: `git gloss reviews --stamp <rev>` before the review, then `git gloss reviews --record` with the stamp and the report as JSON on stdin.

## HTML view

`git gloss html --open` writes a single HTML file (no network access, works offline) and opens it. It shows the task and summary, a bar of how the changed lines split across necessity categories, and a card per group with its rationale; code is collapsed until you ask for it. Click categories to filter, use the sidebar to jump between groups, or press `j`/`k` to move, `o` to show code, and `e`/`c` to expand or collapse everything. `#g-<group>` in the URL opens that group.

Give a range (`git gloss html main..feature --open`) for a branch or PR view: every non-merge commit in order (merges are listed as not reviewed; `A...B` is rejected), a necessity bar across the whole branch, and the sidebar grouped by commit. Commits without a gloss appear with their whole diff marked as unexplained. On range pages a group's link is `#g-<commit>-<group>`. `git gloss review main..feature` likewise covers every commit and adds branch-level questions, such as later commits that undo earlier ones.

All gloss and diff text is rendered as text, and a Content-Security-Policy with a per-page nonce blocks any script the page didn't generate.

## Caveats

- Carrying a gloss onto a server-side squash needs the original commits in your repository; usually the author has them. If a squash merge resolved conflicts or changed much of the code, it may not reach the 80% match; run `git gloss carry <branch commits> --to <squash>`.
- A gloss records each hunk's location and a hash of its content. If a commit is amended or rebased so its diff changes, `show`, `review` and `why` flag the gloss as stale instead of showing it against the wrong code.
- Merge commits are diffed against their first parent.
- `git gloss html` writes to `~/.cache/git-gloss/<commit>.html` by default (or `$XDG_CACHE_HOME`). The page is a snapshot; regenerate it after re-glossing.

## License

MIT. See [LICENSE](LICENSE).
