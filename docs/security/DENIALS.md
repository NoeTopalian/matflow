# Denial register — operations refused to agents in this campaign, and the rule that keeps them refused

Maintained by the coordinator. A denial listed here is binding on every agent, tool, interpreter, host, sub-agent and later turn of this campaign until Noe lifts it through the permitted process. Nobody re-routes a listed operation; a lane that needs it stops and reports.

## How a refusal is classified (from its exact wording)
1. **Operation-level denial.** The message names the outcome, target or capability as refused (examples: "Production Reads"; "judged this action dangerous"; "[Auto-Mode Bypass]"; "This denial applies to the outcome"). The operation is forbidden however it is expressed: not through another tool, agent, encoding, host, smaller pieces, or a different file path. It is entered below and stays in force.
2. **Command-shape guard.** The message names a property of the command text, not the outcome (example: a quoted path that would resolve to the drive root if its variables were empty). The same outcome may be requested again in a form that does not carry the flagged property, once, by the coordinator, after reading the guard; the original block and the re-expression are both recorded below. If the re-expression is blocked too, it becomes an operation-level denial.
3. **Harness policy, not a denial.** The message states a standing rule (example: "Subagents should return findings as text, not write report files"). Followed as written; recorded once, not retried.

An agent that cannot tell which class a refusal falls into treats it as class 1 and reports.

## In force
| # | Date (UTC) | Operation refused | Exact wording (abridged only where marked) | Class | Status |
|---|---|---|---|---|---|
| D-1 | 2026-10-09 | Any read of the production database by an agent | "Production Reads" (permission layer) | 1 | In force. Noe runs `db-role-inspect.mjs` himself. |
| D-2 | 2026-10-09 14:14 | Applying the SF-57 append-only AuditLog migration to any shared database, switching retention to the purge function, and adding the two ci.yml steps | "Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation)." | 1 | In force. Migration and CI steps are proposals for Noe (`evidence/F2/patches/0001`, `0002`). |
| D-3 | 2026-10-09 (admin-hub loop) | Bulk deletion of historical Vercel deployments | permission layer refusal (admin-hub ledger) | 1 | In force. Retirement list prepared; Noe deletes in the dashboard. |
| D-4 | 2026-10-10 ~09:30 | Launching lane M1 (SF-120 log-family-only change, per-job retention cron gate, and a demo-account rotation script with a production mode) as a sub-agent | "Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Auto-Mode Bypass]. … This denial applies to the outcome, not only this exact command: don't pursue the same outcome through another tool, interpreter, host, encoding, sub-agent or later turn" | 1 | In force. Not split, not retried, not done by the coordinator. Noe decides whether any of the three items may proceed and in what form (the production-capable rotation script is the likely trigger). |

## Recorded command-shape guards and harness policies
| # | Date (UTC) | What was blocked | Wording | Class | What happened |
|---|---|---|---|---|---|
| G-1 | 2026-10-10 ~03:00 | `rd` on a quoted worktree path by reviewer R6 | "cmd's rd on '\\\\?\\$p' is blocked because, if its variables are empty, it targets '\\\\', which no command may remove." | 2 | R6 re-expressed the removal with `Remove-Item -LiteralPath` itself, which the rule at the time did not allow; recorded as SF-117. Under this register the re-expression is the coordinator's to make, once, after reading the guard. |
| G-2 | 2026-10-10 ~08:40 | `git worktree remove --force` by reviewer R7 failed with a git "Filename too long" error (not a hook) | git error | — | R7 deleted the directory with `Remove-Item -LiteralPath` and pruned; a git error is not a refusal. |
| P-1 | throughout | Every lane's write of `REPORT.md` | "Subagents should return findings as text, not write report files. Include this content in your final response instead." | 3 | Hand-back text saved by the coordinator as the file. |
