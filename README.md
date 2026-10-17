# git-gloss

Agents write a lot of code, and reviewers can't easily tell what each part is for or whether it was needed. `git-gloss` lets the author of a commit (usually the agent that wrote it) attach a **gloss**: the diff grouped by intent, with each group graded for necessity and saying what breaks without it.

Glosses are stored in git notes (`refs/notes/gloss`), so they don't touch history. Git doesn't push or fetch notes by default; `git gloss init` and `git push origin refs/notes/gloss` set that up.

## Commands

```
git gloss init                        follow amends/rebases; fetch origin's glosses
git gloss hunks [<commit>]            list hunks, numbering changed lines for h3:2-5 references
git gloss add [<commit>] -f a.json    attach an annotation (validated against the diff)
git gloss show [<commit>]             summary: one line per group, risks
      -g <group>                      ...expand groups, with their code
      --full                          ...every group's details
      --diff                          ...every group's details and code
      --only speculative,incidental   ...just the parts you might cut
git gloss html [<commit>|<range>]     self-contained HTML view, of one commit or a branch (--open, -o <file>)
git gloss why <file>:<line> [--json]  explain why a line exists (via blame)
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

In each repo you use it in, run `git gloss init`. Share glosses with `git push origin refs/notes/gloss`. `git fetch` then stores origin's glosses in `refs/notes/remotes/origin/gloss`; merge them into yours with `git notes --ref refs/notes/gloss merge -s ours refs/notes/remotes/origin/gloss` (`-s theirs` to prefer origin's where both glossed a commit). Other merge strategies would join two JSON glosses into one unreadable note.

## Agent review in a sandbox

`git gloss review | claude -p` gives the reviewer only what it reads. `scripts/agent-review.sh [<commit>]` instead runs Claude Code in a disposable clone of the repo, where it may write scratch tests and repos and run them, and asks it to mark each finding as verified or read-only.

Its shell commands run in Claude Code's OS sandbox (bubblewrap on Linux; the run fails rather than run unsandboxed): writes only inside the sandbox directory, no access to your home directory, no network. The file tools are limited to the sandbox too. Only your user-level Claude Code settings load, and the reviewed commit's `CLAUDE.md`, `.claude/` and `.mcp.json` are removed from the checkout so the commit can't instruct or configure its own reviewer. Paths outside your home directory (such as `/etc`) stay readable.

## HTML view

`git gloss html --open` writes a single HTML file (no network access, works offline) and opens it. It shows the task and summary, a bar of how the changed lines split across necessity categories, and a card per group with its rationale; code is collapsed until you ask for it. Click categories to filter, use the sidebar to jump between groups, or press `j`/`k` to move, `o` to show code, and `e`/`c` to expand or collapse everything. `#g-<group>` in the URL opens that group.

Give a range (`git gloss html main..feature --open`) for a branch or PR view: every non-merge commit in order, a necessity bar across the whole branch, and the sidebar grouped by commit. Commits without a gloss appear with their whole diff marked as unexplained. On range pages a group's link is `#g-<commit>-<group>`. `git gloss review main..feature` likewise covers every commit and adds branch-level questions, such as later commits that undo earlier ones.

All gloss and diff text is rendered as text, and a Content-Security-Policy with a per-page nonce blocks any script the page didn't generate.

## Caveats

- Squash merges drop notes. Re-gloss the squashed commit.
- A gloss records each hunk's location and a hash of its content. If a commit is amended or rebased so its diff changes, `show`, `review` and `why` flag the gloss as stale instead of showing it against the wrong code.
- Merge commits are diffed against their first parent.
- `npm link` works because Node only strips types outside `node_modules`. Publishing to npm will need a build step, which must also copy `src/html/client.js` and `src/html/style.css`.
- `git gloss html` writes to `~/.cache/git-gloss/<commit>.html` by default (or `$XDG_CACHE_HOME`). The page is a snapshot; regenerate it after re-glossing.
