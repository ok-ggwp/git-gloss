# git-gloss

Agents write a lot of code, and reviewers can't easily tell what each part is for or whether it was needed. `git-gloss` lets the author of a commit (usually the agent that wrote it) attach a **gloss**: the diff grouped by intent, with each group graded for necessity and saying what breaks without it.

Glosses are stored in git notes (`refs/notes/gloss`), so they don't touch history and they travel with the repository.

## Commands

```
git gloss init                        follow amends/rebases; fetch glosses from origin
git gloss hunks [<commit>]            list hunks with the ids annotations refer to
git gloss add [<commit>] -f a.json    attach an annotation (validated against the diff)
git gloss show [<commit>]             show the diff grouped by intent
      --only speculative,incidental   ...just the parts you might cut
      --no-diff                       ...annotations only
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

In each repo you use it in, run `git gloss init`, and share glosses with `git push origin refs/notes/gloss`.

## Caveats

- Squash merges drop notes. Re-gloss the squashed commit.
- Merge commits are diffed against their first parent.
- `npm link` works because Node only strips types outside `node_modules`. Publishing to npm will need a build step.
