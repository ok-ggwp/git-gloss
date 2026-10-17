---
name: gloss
description: Annotate a commit you just made with its intent and necessity using git-gloss, so reviewers and later agents can see why each change exists. Use after committing agent-written changes, when the user asks to "gloss" a commit, or before handing changes off for review. Also use `git gloss why <file:line>` to look up the intent behind existing code before changing it.
---

# Glossing a commit

A gloss records, for each part of a commit, what it does, how necessary it is, and what breaks without it. You are writing it while you still have the context of why you made each change. That context is the point: do not just restate the diff.

## Steps

1. Commit the change first. A gloss attaches to one commit; for several commits, gloss each one.
2. Run `git gloss hunks <commit>` (default `HEAD`) to see the diff split into hunks with ids `h1`, `h2`, …, with each hunk's changed (`+`/`-`) lines numbered from 1.
3. Group changes **by intent**, not by file. One intent often spans several files. When one hunk mixes intents (common in new files, which are a single hunk), give each group only its lines: `"h6:1-40"`, `"h6:41-55,60"`. The numbers count changed lines only, as `hunks` prints them. Every changed line must belong to at least one group; `add` lists any that don't.
4. Write the annotation JSON (shape below; `git gloss schema` prints the full JSON Schema) to a file in your scratchpad, then run:
   `git gloss add <commit> -f <file>`
   Fix any validation errors it reports and rerun. Use `--force` only to replace your own earlier gloss.
5. Run `git gloss show <commit>` (the summary) and `git gloss show <commit> --full` (every group's details) and check that they read well to someone who was not in the session.

If you amend or rebase a glossed commit, `show` will report the gloss as stale. Re-gloss it with `--force`.

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

Test each group with "what concretely breaks if this is removed?" and write the answer in `removal_impact`. If the honest answer is "nothing the task needs", the group is `incidental`, `defensive` or `speculative`. Saying so is the useful outcome; it tells the reviewer what can be dropped.

Tests are `supporting`, with `serves` listing every group they verify: `"serves": ["retry-core", "retry-config"]`. The same goes for a shared helper that several groups need. Groups the tests cover can cite them in `evidence`.

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

Before changing or deleting code you don't understand, run `git gloss why <file>:<line> --json`. It blames the line, finds the commit's gloss and returns the group(s) that line belongs to, including the chain of groups it serves.
