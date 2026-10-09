# D2-01 — Attendance import under an explicit attacker model (written before the reproduction)

Lane D2, iteration 2, 9 Oct 2026. Candidate source = HEAD 2caa385 (docs-only over 5f87b11) + lane D2 working-tree
changes listed in the hand-back. Line numbers are at the D2 working tree.

## The five matching passes (who is a booking's person?)

`planAttendanceImport` → `resolvePerson` (lib/importers/attendance.ts:673), first hit wins:

| # | pass | where | inputs it trusts |
|---|---|---|---|
| P1 | frozen commit resolution | attendance.ts:680; frozen at commit, app/api/admin/import/attendance/route.ts:317 | `ImportJob.mappings.decisions.frozenPeople` (written by the commit, read by every step) |
| P2 | owner decision | attendance.ts:685; loaded lib/attendance-import.ts:150 | `ImportSourceMapping` kind=person (action, targetId) — **and, after D2, its provenance row (attendance-import.ts:174)** |
| P3 | source key | attendance.ts:689–694 | `Member.externalRef` (= `teamup:<email>\|<name>`, set only at members-import create, app/api/admin/import/[id]/commit/route.ts:264) |
| P4 | name+address fallback, release gate | attendance.ts:706 (`sameName.length === 1 && !released`) | Member.name/email; release digests from AuditLog (attendance-import.ts:206, every form incl. releasedEmailSha256) |
| P5 | held-since gate | attendance.ts:663 `heldSinceBefore` | creation time from the cuid id (attendance.ts:465, attendance-import.ts:154); own address-change time from AuditLog subject+time (attendance-import.ts:232) |

A preview is committable only as previewed (route.ts:301 planHash = file + decisions + roster + released keys).

## Import-chain writes an attacker can make, per prerequisite

| write | (a) runtime DB password (SF-62 bypass: any club, as matflow_app) | (b) staff/owner session in one club (real routes only) | (c) full app compromise (DB password + AUTH_SECRET) |
|---|---|---|---|
| release digests (AuditLog) | INSERT (forged, unkeyed form accepted — keyed needs the key); UPDATE/back-date; DELETE (SF-57) | only by really releasing (member/staff/child DELETE, DSAR erase, members-import rollback) — digest written in the same tx (after D2 for the three delete routes) | all of (a) plus keyed forms |
| address-change / acquisition rows | INSERT / back-date / DELETE (SF-57) | only by really changing an address (member PATCH, contact-email, guardian adopt) — each writes its own-address row in the tx | all |
| guardian adoption rows | as above | guardian confirm writes parent-subject row in the tx (guardian/route.ts:86) | all |
| ImportSourceMapping (P2) | UPDATE targetId / INSERT a mapping, in any club | the decide route (owner): an authorised decision | all, including the provenance row's keyed digest |
| Member.externalRef (P3) | UPDATE on any member (unique per club, case-sensitive) | none: only set at members-import create; existing address → row skipped (commit/route.ts:313–318) | all |
| Member.email / name / id (P4, P5) | raw UPDATE with no audit row; INSERT with a back-dated cuid id | audited routes only; ids are generated | all |
| ImportedBooking / AttendanceRecord | direct rewrite (no import needed) | only through the import (ledger + rollback snapshot) | all |

## Which pass each write defeats, and what closes it

| attack | defeats | today (measured, D2-02) | SF-57 v2 (append-only AuditLog) | B2 per-transaction fix (d4ea9fc) | P2 signed context (proposal) |
|---|---|---|---|---|---|
| (a) forged release row | nothing (only adds pending) | refused — pending | — | — | — |
| (a) raw takeover: victim removed + record re-named/re-addressed by raw SQL | P4 + P5 (no rows to see) | **OPEN** | no (no row is written) | no (the bypass is set deliberately) | **closes** (no tenant without the key) |
| (a) acquisition row back-dated, release row deleted | P4 + P5 | **OPEN** | **closes** (UPDATE/DELETE refused) | no | closes |
| (a) both rows deleted | P4 + P5 | **OPEN** | **closes** | no | closes |
| (a) forged creation time (back-dated cuid; a Member.createdAt column would be writable too) | P5 | **OPEN** | no | no | closes |
| (a) re-pointed decision (UPDATE targetId), incl. from another club | P2 | was OPEN → **refused after D2** (no matching provenance → pending) | keeps the provenance row from being rewritten | no | closes |
| (a) forged decision (INSERT mapping) | P2 | was OPEN → **refused after D2** | — | no | closes |
| (c) forged decision + forged provenance (keyed digest) | P2 | **OPEN** | current-time row only, but it stays (cannot be deleted) | no | no (c holds the key) |
| (a) externalRef planted on another member | P3 | **OPEN** | no | no | closes; (c) needs a keyed attestation of externalRef |
| (a) externalRef case collision | P3 | refused — two refs match → pending | — | — | — |
| (a) exact externalRef collision | P3 | refused by the unique index | — | — | — |
| (b) release via DELETE + acquisition via PATCH | P4/P5 inputs | refused — pending (route writes both rows) | — | — | — |
| (b) decision re-pointed via the decide route | P2 (authorised) | binds as decided — **prior target now recoverable** (provenance row, same tx) | protects that row | — | — |
| (b) externalRef collision via members import | P3 | refused — existing address skipped, no second identity | — | — | — |
| (any) mid-commit roster drift | P2–P5 | refused — P1 frozen at commit (lane D, AH-D1) | — | — | — |

The B2 per-transaction fix (withTenantContext resets `app.bypass_rls` in the statement that sets the tenant,
lib/prisma-tenant.ts:73) stops a stale bypass leaking into an ordinary request; it does nothing against an attacker who
sets the bypass on purpose, which is prerequisite (a).

## Conclusion

With (a) alone, after D2 the attacker can still bind history to the wrong person only by writing Member rows or
AuditLog rows directly (four OPEN cells). SF-57 v2 closes two of them; P2 closes all four for (a). With (c) the
residual is in-club: forged current-time provenance, planted externalRef, raw Member edits — closing that needs
provenance the runtime cannot write (an append-only store outside the app's credentials, or signed attestations
verified with a key the app does not hold). (b) cannot misbind through any route measured; an owner's decision is
authoritative by design, and its history is now recoverable.
