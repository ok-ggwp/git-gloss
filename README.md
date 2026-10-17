# git-gloss

Agents write a lot of code, and reviewers can't easily tell what each part is for or whether it was needed. `git-gloss` lets the author of a commit (usually the agent that wrote it) attach a **gloss**: the diff grouped by intent, with each group graded for necessity and saying what breaks without it.

Glosses are stored in git notes (`refs/notes/gloss`), so they don't touch history. Git doesn't push or fetch notes by default; `git gloss init` and `git push origin refs/notes/gloss` set that up.

## Commands

```
git gloss init                        follow amends/rebases; fetch origin's glosses
git gloss hunks [<commit>]            list hunks with the ids annotations refer to
git gloss add [<commit>] -f a.json    attach an annotation (validated against the diff)
git gloss show [<commit>]             summary: one line per group, risks
      -g <group>                      ...expand groups, with their code
      --full                          ...every group's details
      --diff                          ...every group's details and code
      --only speculative,incidental   ...just the parts you might cut
git gloss html [<commit>] [--open]    self-contained HTML view (-o to choose the file)
git gloss why <file>:<line> [--json]  explain why a line exists (via blame)
git gloss review [<commit>]           print a review prompt: git gloss review | claude -p
git gloss schema                      print the annotation JSON Schema
```

Necessity categories: `required`, `supporting`, `mechanical`, `incidental`, `defensive`, `speculative`. See [skills/gloss/SKILL.md](skills/gloss/SKILL.md) for what each means and for the annotation format.

## Setup

Requires Node 23.6+ (TypeScript runs directly, no build step).

```sh
npm install
npm link                      # puts git-gloss on PATH, so `git gloss` works
ln -s "$PWD/skills/gloss" ~/.claude/skills/gloss   # teach Claude Code to write glosses
```

In each repo you use it in, run `git gloss init`. Share glosses with `git push origin refs/notes/gloss`. `git fetch` then stores origin's glosses in `refs/notes/remotes/origin/gloss`; merge them into yours with `git notes --ref refs/notes/gloss merge -s ours refs/notes/remotes/origin/gloss` (`-s theirs` to prefer origin's where both glossed a commit). Other merge strategies would join two JSON glosses into one unreadable note.

## HTML view

`git gloss html --open` writes a single HTML file (no network access, works offline) and opens it. It shows the task and summary, a bar of how the changed lines split across necessity categories, and a card per group with its rationale; code is collapsed until you ask for it. Click categories to filter, use the sidebar to jump between groups, or press `j`/`k` to move, `o` to show code, and `e`/`c` to expand or collapse everything. `#g-<group>` in the URL opens that group.

All gloss and diff text is rendered as text, and a Content-Security-Policy with a per-page nonce blocks any script the page didn't generate.

## Caveats

- Squash merges drop notes. Re-gloss the squashed commit.
- A gloss records each hunk's location and a hash of its content. If a commit is amended or rebased so its diff changes, `show`, `review` and `why` flag the gloss as stale instead of showing it against the wrong code.
- Merge commits are diffed against their first parent.
- `npm link` works because Node only strips types outside `node_modules`. Publishing to npm will need a build step.
