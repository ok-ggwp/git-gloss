#!/usr/bin/env bash
# Review a glossed commit with Claude Code inside a disposable clone, where the
# reviewer may write scratch tests and repos and run them, so it can verify
# findings instead of only reading code.
#
# usage: scripts/agent-review.sh [<commit>] > review.md
#        GLOSS_REVIEW_DRY=1 scripts/agent-review.sh   print the setup and prompt, run no agent
#
# Confinement (Linux needs bubblewrap and socat; the run fails rather than
# falling back to unsandboxed commands):
# - Bash runs in Claude Code's OS sandbox: it can write only inside the
#   sandbox directory, cannot read your home directory, and has no network.
#   That covers git, node and tests the reviewer runs.
# - The file tools may read and edit the sandbox only; reads of ~ are denied.
# - Only your user settings load (not the reviewed repo's .claude/ settings),
#   and the reviewed commit's CLAUDE.md, .claude/ and .mcp.json are removed
#   from the checkout, so the commit can't instruct or configure its reviewer.
# Not covered: paths outside ~ remain readable (e.g. /etc), and anything your
# own user settings allow still applies.
set -euo pipefail

rev=${1:-HEAD}
repo=$(git rev-parse --show-toplevel)
sha=$(git -C "$repo" rev-parse --verify "$rev^{commit}")
if ! git -C "$repo" rev-parse -q --verify refs/notes/gloss >/dev/null; then
  echo "error: no glosses in this repository (refs/notes/gloss doesn't exist)" >&2
  exit 1
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/gloss-review-XXXXXX")
trap 'rm -rf "$work"' EXIT

clone="$work/repo"
git clone -q --no-hardlinks "$repo" "$clone"
git -C "$clone" remote remove origin
git -C "$clone" fetch -q "$repo" refs/notes/gloss:refs/notes/gloss
git -C "$clone" checkout -q --detach "$sha"
# The reflog names the real repository's path; nothing in the sandbox needs it.
git -C "$clone" reflog expire --expire=now --all
# Agent configuration in the reviewed commit stays readable through git
# (git show HEAD:CLAUDE.md) but is not left where Claude Code would load it.
removed=$(cd "$clone" && for f in CLAUDE.md CLAUDE.local.md .claude .mcp.json; do
  if [ -e "$f" ]; then rm -rf "$f"; echo "$f"; fi
done)
# Copy rather than link dependencies, so nothing the reviewer does reaches the real repo.
if [ -d "$repo/node_modules" ]; then cp -R "$repo/node_modules" "$clone/node_modules"; fi
mkdir -p "$work/scratch"

# Build the prompt with the reviewed commit's own git-gloss when it has one.
if [ -f "$clone/bin/git-gloss.js" ]; then
  prompt=$(cd "$clone" && node bin/git-gloss.js review "$sha")
else
  prompt=$(cd "$clone" && git gloss review "$sha")
fi

preamble="You are running in a sandbox directory $work containing a disposable clone of the repository at $clone,
checked out at the reviewed commit. Your shell commands run in an OS sandbox: you can write only under $work, cannot
read the user's home directory, and have no network. Create scratch tests and throwaway git repos under $work/scratch
and run them. To run the code under review, use the clone's own entry points (for this project: node bin/git-gloss.js,
npm test), not any globally installed copy.${removed:+

These files from the reviewed commit were removed from the checkout so they could not configure you; read them with
git show HEAD:<path> if they matter to the review: $(echo $removed)}

Verify findings by running them where you can. In your report, mark each finding as **verified** (you ran something
that shows it) or **read** (from reading the code only)."

# Permission rules take //path for absolute paths, which "/$work" expands to.
settings=$(cat <<JSON
{
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": { "denyRead": ["~/"], "allowRead": ["$work"], "allowWrite": ["$work"] }
  },
  "permissions": {
    "allow": ["Read(/$work/**)", "Edit(/$work/**)"],
    "deny": ["Read(~/**)", "Edit(~/**)", "WebFetch", "WebSearch"]
  }
}
JSON
)

cd "$work"
if [ -n "${GLOSS_REVIEW_DRY:-}" ]; then
  echo "clone: $clone"
  echo "remotes: $(git -C "$clone" remote | wc -l)"
  echo "head: $(git -C "$clone" rev-parse HEAD)"
  echo "notes: $(git -C "$clone" notes --ref refs/notes/gloss list | wc -l)"
  echo "reflog entries: $(git -C "$clone" reflog | wc -l)"
  echo "removed: ${removed:-none}"
  echo "node_modules: $([ -d "$clone/node_modules" ] && echo copied || echo none)"
  echo "settings: $settings"
  printf '%s\n\n%s\n' "$preamble" "$prompt"
  exit 0
fi
printf '%s\n\n%s\n' "$preamble" "$prompt" | claude -p --setting-sources user --settings "$settings"
