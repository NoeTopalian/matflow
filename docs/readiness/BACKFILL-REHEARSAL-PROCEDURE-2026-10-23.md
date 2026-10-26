# Status-history back-fill: rehearsal on a production-derived branch (procedure, 23 Oct 2026)

Purpose: run `scripts/backfill-status-events.ts` in preview and apply mode against a copy of production data, read the plan, and record reconciliation totals — before any production back-fill, which is a separate approval. Built on `docs/runbooks/RESTORE-REHEARSAL-ISOLATED.md` (steps marked **[AUTH]** need Noe's explicit go-ahead; everything else is read-only or local).

## 0. Prerequisites
- PR #39 merged and deployed (the script and migration `20261017022302_status_event_source_provenance` must be on the branch's schema: the Neon branch is created from production AFTER that deploy, or the migration is applied to the branch by `prisma migrate deploy` with the branch URL — never with the production URL).
- The read-only count of refresh events without provenance re-read on production and recorded (0 on 23 Oct 03:29Z).

## 1. Authorisation **[AUTH]**
Noe records in the rehearsal log: approval to create **one** Neon branch from the production root, named `bf-<yyyymmdd>`, with a hard deletion deadline of **24 hours**; who holds the branch connection string (it inherits the production roles and password: handle it as a production secret, never in chat, never in a repo file); approval for the apply step on the branch.

## 2. Create the branch **[AUTH, Noe in the Neon console]**
Neon console → MatFlow project → Branches → create from the production root at "now". Record branch id, endpoint id (`ep-…`), creation time and the deletion deadline. Copy the endpoint id only (not the URL) into the rehearsal log.

## 3. Isolation of the rehearsal environment (local only)
- A dedicated worktree at the deployed commit, with NO `.env`. The branch URL lives only in a private env file outside the repo (e.g. `%LOCALAPPDATA%\matflow-verify\bf.env`), passed to scripts by path; `db-target.mjs` guard with `expectHost` = the branch endpoint id, `allowProduction` false (the branch endpoint id is not the production id, so the guard admits it without the production exception).
- **No outbound messages:** `EMAIL_DELIVERY` unset/off (`lib/email-delivery.ts` treats unset as OFF); `RESEND_API_KEY` absent; `RESEND_WEBHOOK_SECRET` absent.
- **No payments:** `STRIPE_SECRET_KEY` absent (any Stripe call refuses); `STRIPE_WEBHOOK_SECRET` absent; no `CRON_SECRET` (cron routes 503).
- **No application server** is needed for the rehearsal: only the script and read-only report queries. If a production build is started for a visual check, start it with the branch URL and the variables above absent, on a private port, and stop it before step 7.
- Nothing from the branch is exported: outputs are counts, month/kind tallies, ledger row ids and digests; no names, emails or phones.

## 4. Preview (read-only)
`npx tsx scripts/backfill-status-events.ts --expect-host <branch endpoint id>` with `DATABASE_URL` = the branch URL (per club with `--tenant <id>`; the customer club's id is in the owner's private evidence). Record: per club, the proposed events per month and kind; the exceptions by ledger row id and reason (`undated_end`, `end_before_start`, …); the plan digest. Noe reads the plan (ticket T8b "Done when").

## 5. Snapshot, apply, reconcile **[AUTH]**
- Snapshot: note the branch's point-in-time (Neon keeps history on the branch) — or create a child branch of the rehearsal branch before apply.
- Apply: `… --apply --plan-digest <digest>` (refuses if the data moved since the preview). One transaction per club; a refusal rolls that club back and is reported; one AuditLog row per club.
- Reconcile: re-run the preview (should propose nothing); run the Reports movement/headcount read for the club (`lib/membership-report.ts` via a read-only script) and record the month-end headcount series against the pre-apply series; count `MemberStatusEvent` rows by `sourceAction` before and after; the "estimated" boundary (months before recorded history) must move back to the earliest ledger date.
- Rollback rehearsal: `… --rollback` (preview with digest) then `… --rollback --confirm-digest <digest>`; verify the event counts return to the pre-apply numbers; then apply again to leave the branch in the applied state for inspection.

## 6. Record
In `docs/readiness/HEADCOUNT-MOVEMENT-EVIDENCE-2026-10-23.md` "Back-fill rehearsal": branch id/endpoint, times, the per-club tallies, exceptions count by reason, digests, reconciliation totals, the rollback result, who read the plan. Counts only.

## 7. Cleanup **[AUTH, mandatory, within 24 h]**
Delete the Neon branch (and any child); delete the private env file; confirm in the log with the deletion time. No branch may outlive its deadline.

## Production back-fill (separate, not covered here)
Requires: this rehearsal read and accepted; a fresh production snapshot/point-in-time noted; a build whose guard is deliberately changed to admit production for the back-fill (today's build refuses it), reviewed on its own; Noe's explicit approval naming the plan digest.
