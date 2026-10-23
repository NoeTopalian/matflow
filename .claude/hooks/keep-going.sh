#!/usr/bin/env bash
# Stop hook (Noe, 22 Oct 2026): enforce the Definition of done in CLAUDE.md.
# Claude Code runs this every time the agent tries to stop. Exit 2 = keep going,
# and the message on stderr is fed back to the agent. Exit 0 = may stop.
input=$(cat)
# Don't loop forever: if we already pushed back once this turn, let it stop.
echo "$input" | grep -q '"stop_hook_active":true' && exit 0
branch=$(git branch --show-current 2>/dev/null)
[ -z "$branch" ] && exit 0
[ "$branch" = "main" ] && exit 0
pr=$(gh pr view --json number,state -q 'select(.state=="OPEN") | .number' 2>/dev/null)
[ -z "$pr" ] && exit 0
if gh pr checks "$pr" 2>/dev/null | grep -qE 'pending|fail'; then
  echo "PR #$pr has pending or failing checks. Watch them (gh pr checks $pr --watch), fix failures, and continue per the Definition of done." >&2
  exit 2
fi
exit 0
