# Security findings ledger (campaign of 9 Oct 2026)

Candidate: `2a6487e` (source build `c837e38`); branch `security/assurance-2026-10`; production runs `e8afb6a`.
Statuses per the brief: applicability APPLICABLE / NOT APPLICABLE WITH EVIDENCE / UNKNOWN; verification NOT RUN / FAIL /
FIXED AWAITING RETEST / PASS / BLOCKED. Severity is argued, not asserted. Every row names an owner and, once fixed, an
independent reviewer (never the author). Rows are reopened when code, configuration or advisories invalidate the evidence.

## Iteration 1 — reconciliation of the admin-hub report's open items (brief table)

| ID | Item | Lane | Applicability | Verification | Evidence / disposition |
|---|---|---|---|---|---|
| SF-01 | AH-G7 session-revocation check fails open on a database error | A | APPLICABLE | NOT RUN | Blocker unless disproved. |
| SF-02 | Production runtime database role unknown (SEC-021 / SEC-068) | lead | APPLICABLE | **BLOCKED — permission layer refused the production read** ("Production Reads", 9 Oct 11:40 UK); not retried by any route. | The read-only script is prepared: `node scripts/readiness/db-role-inspect.mjs .env ep-bold-wave-abt39t7x` (run from the repo root; it refuses any other host) — a `BEGIN READ ONLY` transaction printing current_user/session_user, role flags (superuser, bypassrls), memberships, table owners, RLS/force flags, policies, grants, settings; no credentials, no row data. **Noe runs it** and pastes the output; until then production readiness is PENDING. The same script against the TEST branch under both roles (`evidence/lead/test-db-role-*.txt`, 9 Oct 11:50 UK) shows the two candidate identities: `neondb_owner` — rolsuper false, **rolbypassrls TRUE**, createrole/createdb/replication true, member of neon_superuser and matflow_app, ALL privileges incl. TRUNCATE and TRIGGER on every table → RLS never applies, the application-layer tenant filter is the only control; `matflow_app` — rolsuper false, rolbypassrls false, no memberships, DELETE/INSERT/SELECT/UPDATE only → RLS enforced (every public table has rls + force_rls and a permissive `tenant_isolation` policy for ALL on {public}). Both connect through the `-pooler` host; `app.bypass_rls`/`app.tenant_id` are unset at session start (set per transaction by the app). The production verdict is simply which of these two the deployed `DATABASE_URL` logs in as, plus whether `matflow_app` exists on the production branch at all. |
| SF-03 | AH-G6 owner-route body not strict (SEC-019) | C | APPLICABLE | NOT RUN | Lane C (wave 2). |
| SF-04 | Contact-email route refuses no-login records — meaning of each record state; Sean's scenario reproducible and correctable | B | APPLICABLE | NOT RUN | |
| SF-05 | AH-D2 tokens not subject-bound (SEC-003 / SEC-004) | A | APPLICABLE | NOT RUN | |
| SF-06 | AH-D1 attendance fallback may match a same-name hand-added member (SEC-053) | D | APPLICABLE | NOT RUN | Lane D (wave 2). |
| SF-07 | AH-R3 writer inventory misses upsert / raw SQL / nested forms (SEC-029) | B | APPLICABLE | NOT RUN | |
| SF-08 | AH-R7 transfer revocation not DB-tested; no standalone revoke-all control (SEC-013 / SEC-032) | A (control), B (transfer) | APPLICABLE | NOT RUN | |
| SF-09 | AH-C2 / AH-G5 / remaining AH-G6: version-at-check, grant expiry labels, audit actor attribution, refusal logging | A, B, C | APPLICABLE | NOT RUN | |
| SF-10 | Old-deployment retirement incomplete (SEC-066 / SEC-067) | E | APPLICABLE | NOT RUN | Read-only inventory; the earlier deletion denial stands. |
| SF-11 | mysql2 / prisma advisory called not applicable (SEC-057 / SEC-058) | E | UNKNOWN | NOT RUN | |
| SF-12 | Native code declared not applicable — sharp / libvips / Node (SEC-050 / SEC-064) | E | UNKNOWN | NOT RUN | |
| SF-13 | Final candidate includes docs beyond the tested source — equivalence of 2a6487e to build c837e38 | E | APPLICABLE | NOT RUN | |

## Work queue (persistent; the coordinator edits)
Wave 1 (running): A, B, E. Wave 2: C (SEC-033–048, SF-03, SF-09 part), D (SEC-049–056, SEC-089–096, SF-06), F (SEC-073–088).
Iteration budget: 5. Iteration 1 started 9 Oct 2026 11:35 UK.

## New findings (appended by the coordinator from lane reports)
_None yet._
