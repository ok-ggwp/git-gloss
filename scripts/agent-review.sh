#!/usr/bin/env bash
# Review a glossed commit with Claude Code inside a disposable clone, where the
# reviewer may write scratch tests and repos and run them, so it can verify
# findings instead of only reading code.
#
# usage: scripts/agent-review.sh [<commit>] > review.md
#        GLOSS_REVIEW_DRY=1 scripts/agent-review.sh   print the setup and prompt, run no agent
#
# Limits: the clone has no remote, git push/remote are denied, and the file
# tools (an Edit rule covers Write too) only reach the sandbox directory. Code the reviewer runs
# with node or npm test is NOT confined: it runs as you and could touch any
# file you can. Only use this for reviews you would let an agent run code for.
set -euo pipefail

rev=${1:-HEAD}
repo=$(git rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse --verify "$rev^{commit}")
work=$(mktemp -d "${TMPDIR:-/tmp}/gloss-review-XXXXXX")
trap 'rm -rf "$work"' EXIT

clone="$work/repo"
git clone -q --no-hardlinks "$repo" "$clone"
git -C "$clone" remote remove origin
git -C "$clone" fetch -q "$repo" refs/notes/gloss:refs/notes/gloss
git -C "$clone" checkout -q --detach "$sha"
# Copy rather than link dependencies, so nothing the reviewer does reaches the real repo.
if [ -d "$repo/node_modules" ]; then cp -R "$repo/node_modules" "$clone/node_modules"; fi
mkdir -p "$work/scratch"

prompt=$(cd "$clone" && git gloss review "$sha")
preamble="You are running in a disposable clone of the repository at $clone, checked out at the reviewed commit.
You may create files there and under $work/scratch (scratch tests, throwaway git repos) and run them; nothing you do
affects the real repository, and the clone is deleted afterwards. To run the code under review, use the clone's own
entry points (for this project: node bin/git-gloss.js, npm test), not any globally installed copy.

Verify findings by running them where you can. In your report, mark each finding as **verified** (you ran something
that shows it) or **read** (from reading the code only)."

cd "$clone"
if [ -n "${GLOSS_REVIEW_DRY:-}" ]; then
  echo "clone: $clone"
  echo "remotes: $(git remote | wc -l)"
  echo "head: $(git rev-parse HEAD)"
  echo "notes: $(git notes --ref refs/notes/gloss list | wc -l)"
  echo "node_modules: $([ -d node_modules ] && echo copied || echo none)"
  printf '%s\n\n%s\n' "$preamble" "$prompt"
  exit 0
fi
printf '%s\n\n%s\n' "$preamble" "$prompt" | claude -p \
  --add-dir "$work" \
  --allowedTools Read Grep Glob "Edit(/$work/**)" \
    "Bash(git:*)" "Bash(node:*)" "Bash(npm test)" "Bash(npx tsc)" \
    "Bash(cd:*)" "Bash(ls:*)" "Bash(cat:*)" "Bash(mkdir:*)" "Bash(mktemp:*)" "Bash(printf:*)" "Bash(echo:*)" \
  --disallowedTools "Bash(git push:*)" "Bash(git remote:*)"
