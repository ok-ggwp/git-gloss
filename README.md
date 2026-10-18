# git-gloss

Agents write a lot of code, and reviewers can't easily tell what each part is for or whether it was needed. `git-gloss` lets the author of a commit (usually the agent that wrote it) attach a **gloss**: the diff grouped by intent, with each group graded for necessity and saying what breaks without it.

Glosses are stored in git notes (`refs/notes/gloss`), so they don't touch history. Git doesn't push or fetch notes by default; `git gloss sync` shares them, and `git gloss init --hooks` makes every `git push` do it.

## Commands

```
git gloss init [--hooks]              follow amends/rebases; fetch origin's glosses; --hooks: sync on push
git gloss sync [<remote>]             fetch, merge and push glosses (default: origin)
git gloss hunks [<commit>]            list hunks, numbering changed lines for h3:2-5 references
git gloss add [<commit>] -f a.json    attach an annotation (validated against the diff)
git gloss show [<commit>]             summary: one line per group, risks
      -g <group>                      ...expand groups, with their code
      --full                          ...every group's details
      --diff                          ...every group's details and code
      --only speculative,incidental   ...just the parts you might cut
git gloss html [<commit>|<range>]     self-contained HTML view, of one commit or a branch (--open, -o <file>)
git gloss why <file>:<line> [--json]  explain why a line exists (via blame), looking past mechanical edits
      --history                       ...every commit that changed the line, newest first
git gloss review [<commit>|<range>]   print a review prompt: git gloss review main..feature | claude -p
git gloss schema                      print the annotation JSON Schema
```

A group refers to whole hunks (`h3`) or to some of a hunk's changed lines (`h3:2-5`, `h3:1,4-6`), numbering only `+`/`-` lines. Ranges let one hunk, such as a whole new file, be split between intents. Views show a group only its own lines, with `⋯` marking lines that belong to other groups, and `why` names only the group that owns the blamed line.

Necessity categories: `required`, `supporting`, `mechanical`, `incidental`, `defensive`, `speculative`. See [skills/gloss/SKILL.md](skills/gloss/SKILL.md) for what each means and for the annotation format.

## Setup

Requires Node 23.6+ (TypeScript runs directly, no build step).

```sh
npm install
npm link                      # puts git-gloss on PATH, so `git gloss` works
ln -s "$PWD/skills/gloss" ~/.claude/skills/gloss   # teach Claude Code to write glosses
```

In each repo you use it in, run `git gloss init --hooks`. After that, every `git push` to a named remote also syncs glosses with it. Without the hook, run `git gloss sync` yourself.

`sync` fetches the remote's glosses into `refs/notes/remotes/<remote>/gloss`, merges them into yours and pushes the result, retrying if someone else pushed in between. Glosses on different commits simply combine, and a gloss changed on only one side since you last synced is taken from that side. Only when both sides changed the same commit's gloss since then is it a conflict: the newer gloss (by its `created_at`) wins, because a re-gloss is normally a correction, and if either can't be read, yours is kept. It prints what it fetched, pushed and decided. The hook never blocks a push: if syncing fails it prints a warning and the push goes ahead. It syncs before the branch is pushed (so glosses arrive even if the branch push is then rejected), and it disables credential prompts so a remote that needs one fails fast instead of stalling the push. If you already have a `pre-push` hook, `init --hooks` leaves it alone and prints the one line to add to it.

## Agent review in a sandbox

`git gloss review | claude -p` gives the reviewer only what it reads. `scripts/agent-review.sh [<commit>]` instead runs Claude Code in a disposable clone of the repo, where it may write scratch tests and repos and run them, and asks it to mark each finding as verified or read-only.

Its shell commands run in Claude Code's OS sandbox (bubblewrap on Linux; the run fails rather than run unsandboxed): writes only inside the sandbox directory, no access to your home directory, no network. The file tools are limited to the sandbox too. Only your user-level Claude Code settings load, and the reviewed commit's `CLAUDE.md`, `.claude/` and `.mcp.json` are removed from the checkout so the commit can't instruct or configure its own reviewer. Paths outside your home directory (such as `/etc`) stay readable.

## HTML view

`git gloss html --open` writes a single HTML file (no network access, works offline) and opens it. It shows the task and summary, a bar of how the changed lines split across necessity categories, and a card per group with its rationale; code is collapsed until you ask for it. Click categories to filter, use the sidebar to jump between groups, or press `j`/`k` to move, `o` to show code, and `e`/`c` to expand or collapse everything. `#g-<group>` in the URL opens that group.

Give a range (`git gloss html main..feature --open`) for a branch or PR view: every non-merge commit in order (merges are listed as not reviewed; `A...B` is rejected), a necessity bar across the whole branch, and the sidebar grouped by commit. Commits without a gloss appear with their whole diff marked as unexplained. On range pages a group's link is `#g-<commit>-<group>`. `git gloss review main..feature` likewise covers every commit and adds branch-level questions, such as later commits that undo earlier ones.

All gloss and diff text is rendered as text, and a Content-Security-Policy with a per-page nonce blocks any script the page didn't generate.

## Caveats

- Squash merges drop notes. Re-gloss the squashed commit.
- A gloss records each hunk's location and a hash of its content. If a commit is amended or rebased so its diff changes, `show`, `review` and `why` flag the gloss as stale instead of showing it against the wrong code.
- Merge commits are diffed against their first parent.
- `npm link` works because Node only strips types outside `node_modules`. Publishing to npm will need a build step, which must also copy `src/html/client.js` and `src/html/style.css`.
- `git gloss html` writes to `~/.cache/git-gloss/<commit>.html` by default (or `$XDG_CACHE_HOME`). The page is a snapshot; regenerate it after re-glossing.
