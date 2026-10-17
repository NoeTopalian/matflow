---
name: matflow-completion-report
description: Use when finishing any MatFlow coding task, before saying it is done — a short report of what changed, what was tested on which commit, what remains unverified, and the exact release state.
---

# MatFlow — completion report

Gather facts first; do not write from memory:
`git rev-parse HEAD` · `git status -sb` (branch, ahead/behind, dirty) · `git diff --stat <base>...HEAD` · `gh pr view --json number,state,isDraft,headRefOid,mergeCommit` · `gh pr checks <n>` if there is a PR.

Write four short parts, British English, no praise, no filler:

1. **What changed** — per behaviour, one line each, with the files. Say what did *not* change if the user could assume it did (schema, security gates, other routes).
2. **What was tested** — each command or run with its result and the commit it ran on: lint, focused tests, full suite (passed / failed / skipped counts), database suites (both roles), build, browser ledger (PASS / FAIL / NOTE counts). Results from an earlier commit are labelled as such.
3. **Not verified** — everything that was not exercised end to end: skipped suites, provider behaviour (email delivery, Stripe, blob storage, push), production data, other browsers. A blocker names the exact missing thing (credential, access, decision) and who can supply it.
4. **Release state** — exactly one of, with the SHA:
   - local only — commit `<sha>` on `<branch>`, not pushed;
   - pushed — `<branch>` at `<sha>`, PR #n (draft/open), CI: each check pass/fail/pending;
   - merged — main at `<sha>` (a push to main auto-deploys and migrates production);
   - deployed — only with evidence (deployment id and health check), otherwise "deployment not confirmed".
   Then the next action and who takes it. Never write "done", "ready" or "safe to ship" without the evidence above.

Keep it under about 25 lines unless the user asked for more. Long evidence goes in `docs/readiness/` (the repo's established location) when reviewers need it, linked from the report; scratch output stays out of git.
