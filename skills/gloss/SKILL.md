---
name: gloss
description: Annotate changes with their intent and necessity using git-gloss, so reviewers and later agents can see why each change exists. The default is the wip-gloss procedure: gloss uncommitted work before reporting back, so the user can read and review it before committing. Use after a non-trivial code change in a repo whose CLAUDE.md or AGENTS.md asks for wip-gloss, when the user asks to "gloss" or "wip-gloss" changes or a commit, or before handing changes off for review. Also use `git gloss why <file>:<start>-<end>` when genuinely unsure why existing code is the way it is, such as before removing something that looks unnecessary.
---

# Glossing changes (wip-gloss)

A gloss records, for each part of a change, what it does, how necessary it is, and what breaks without it. You are writing it while you still have the context of why you made each change. That context is the point: do not just restate the diff.

## The wip-gloss procedure

In a repo whose `CLAUDE.md` or `AGENTS.md` asks for it (set up with `git gloss init --hooks`), when you finish a non-trivial code change, wip-gloss it before reporting back:

1. Leave the changes uncommitted; don't commit unless the user asks.
2. Gloss them with the steps below (`git gloss hunks wip`, `add wip`, `show wip`).
3. In your reply, say that the changes are wip-glossed and how to read them (`git gloss show wip`, or `git gloss html wip --open`), and mention anything you graded `speculative`, `incidental` or `defensive`: those are the parts the user may want to drop.
4. When the user or a reviewer asks for changes, make them, then run `git gloss hunks wip` and `git gloss add wip` again: the new snapshot gets a new gloss. A gloss must describe the code as it is now.
5. Committing is the user's call; see below for how the gloss moves onto the commit.

Skip it for trivial edits (a typo, a one-line config tweak) unless asked.

## Uncommitted work (the default) or a commit

Gloss changes **before they are committed**, unless the user asks you to commit first. `wip` stands for a snapshot of the uncommitted work (tracked and untracked files): `git gloss hunks wip` takes it without touching the branch, the index or any file, and the other commands then use that snapshot. The user reviews and iterates while nothing is committed. When they commit, the gloss moves onto the commit automatically if `git gloss init --hooks` was run and `git gloss` is on the PATH of whatever runs the commit; otherwise they run `git gloss adopt`. Glosses of uncommitted work are never shared by `sync`. Untracked files that look like secrets (`.env`, keys, credentials) are left out of the snapshot with a note; don't stage them just to gloss them.

To gloss a commit instead, use its revision (default `HEAD`) wherever these steps say `wip`.

## Steps

1. Run `git gloss hunks wip` to snapshot the uncommitted work and see it split into hunks with ids `h1`, `h2`, …, with each hunk's changed (`+`/`-`) lines numbered from 1. If you change files afterwards, run it again: that takes a new snapshot, and a gloss must match the snapshot it was written for.
2. Group changes **by intent**, not by file. One intent often spans several files. When one hunk mixes intents (common in new files, which are a single hunk), give each group only its lines: `"h6:1-40"`, `"h6:41-55,60"`. The numbers count changed lines only, as `hunks` prints them. Every changed line must belong to at least one group; `add` lists any that don't.
   Take hunk ids and line numbers from the `git gloss hunks` output for this snapshot or commit, never from memory of the diff or from an earlier commit. Ids depend on the order git lists hunks, and line numbers count only changed lines, so guesses are easily wrong. `add` rejects ranges past the end of a hunk, but a wrong range that stays in bounds is accepted and silently attaches an intent to the wrong code.
3. Write the annotation JSON (shape below; `git gloss schema` prints the full JSON Schema) to a file in your scratchpad, then run:
   `git gloss add wip -f <file>`
   Fix any validation errors it reports and rerun. Use `--force` only to replace your own earlier gloss.
4. Run `git gloss show wip` (the summary) and `git gloss show wip --full` (every group's details) and check that they read well to someone who was not in the session. Then spot-check the code under a few groups with `git gloss show wip -g <group>`. Validation checks that every line is covered, not that each line is under the right intent.

If you edit files after glossing, `show wip` warns that the working tree has changed: run `git gloss hunks wip` again and re-gloss with `--force`. If you amend or rebase a glossed commit, `show` reports the gloss as stale; re-gloss it with `--force`. For a review of the uncommitted work, the user can run `git gloss review wip` or `scripts/agent-review.sh wip`.

## Writing intents

`show` lists one row per group, so keep each `intent` to one short sentence (under ~80 characters) saying what the group does. Put mechanism, caveats and history in `notes`. `add` prints a note for intents over 100 characters.

## Grading necessity honestly

Self-grading tends to call everything "required". Resist that. Use these categories:

- `required`: the task cannot be done without it.
- `supporting`: needed only because other groups need it. Set `serves` to that group's id, or a list of ids.
- `mechanical`: follow-on edits with no design content (renames, imports, formatting, lockfiles). Keep these short.
- `incidental`: a drive-by cleanup or refactor the task did not ask for.
- `defensive`: guards edge cases or failures nobody asked about.
- `speculative`: added because it might be useful later.

Test each group with "what concretely breaks if this is removed?" and write the answer in `removal_impact`. Name the specific loss, even for tests and docs: "the merge-base conflict rule would have no test", not "Unverified"; "users wouldn't know `--rev` exists", not "Undocumented". If the honest answer is "nothing the task needs", the group is `incidental`, `defensive` or `speculative`. Saying so is the useful outcome; it tells the reviewer what can be dropped.

Tests are `supporting`, with `serves` listing every group they verify: `"serves": ["retry-core", "retry-config"]`. The same goes for a shared helper that several groups need. Groups the tests cover can cite them in `evidence`.

Documentation has no category of its own; grade it by why it changed. Docs for a feature or behaviour change in the same change are `supporting`, with `serves` set to that group. Docs that are themselves the task are `required`. Typos, reflowing and renames are `mechanical`; unrelated doc improvements are `incidental`; documenting something that doesn't exist yet is `speculative`. Agent instructions (a skill, `CLAUDE.md`, `AGENTS.md`) change what agents do, so grade them like behaviour, not as `mechanical`.

Where you can, set `evidence` to a test that exercises the change or the line of the task that requires it.

## Annotation shape

```json
{
  "task": "Retry uploads on transient 5xx errors (from the user's request)",
  "summary": "Wraps the upload call in exponential backoff and exposes the retry count.",
  "groups": [
    {
      "id": "retry-core",
      "intent": "Retry the upload with exponential backoff on 5xx",
      "necessity": "required",
      "serves": "task",
      "removal_impact": "Uploads fail on the first 503",
      "evidence": "test/upload.test.ts 'retries on 503'",
      "hunks": ["h1", "h3:1-12"]
    },
    {
      "id": "retry-config",
      "intent": "Make max retries configurable",
      "necessity": "speculative",
      "serves": "retry-core",
      "removal_impact": "Retry count would be a hardcoded 3; nothing in the task needs it configurable",
      "hunks": ["h2"]
    }
  ],
  "alternatives": [
    { "option": "Retry inside the HTTP client", "rejected_because": "Would also retry non-idempotent calls" }
  ],
  "risks": ["Duplicate uploads if the server is not idempotent"],
  "author": { "agent": "claude-code", "model": "<your model id>" }
}
```

`alternatives` and `risks` are optional, but fill them in when you weighed real options. They are what later readers most often lack.

## Looking up intent

You don't need to look up intent before ordinary edits. Use `git gloss why` when you are genuinely unsure why existing code is the way it is, especially before removing or rewriting something that looks unnecessary, defensive or wrong. That is when an unexplained check gets deleted and a fixed bug comes back.

Ask about the block you're changing, not each line: `git gloss why <file>:<start>-<end> --json`. You get one explanation per commit that last changed those lines: the group's intent, `removal_impact`, `notes`, and the commit's `risks` and rejected `alternatives`. Check the alternatives before proposing an approach someone already tried and turned down. If the latest change to the lines was only `mechanical` (a rename, a reformat), `why` looks back past it to the real explanation; `--history` shows every change.
