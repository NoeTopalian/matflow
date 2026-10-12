# SF-62 chained with SF-57 (audit integrity) and SF-67 / attendance provenance (campaign conclusion item 4)

"Needs database write access" is an attacker prerequisite, not a dismissal. Under the deployed design the prerequisite
is **only the runtime database credential** (matflow_app or, if production uses it, the owner) — no owner rights, no
DDL. The SF-62 bypass turns that single credential into write access to every club's audit trail and import
provenance. Measured cells refer to harness-run-2026-10-09.json (scratch schema, genuine matflow_app login).

## The chain today

1. **Enter every club**: `set_config('app.bypass_rls','on',true)` (C05; public probe: 141 clubs, AuditLog of 132).
2. **Rewrite history (SF-57)**: UPDATE an AuditLog row's action, back-date `createdAt` 400 days so retention deletes it,
   or DELETE it — in any club (C15 CURRENT: `update ALLOWED rows=1`, `delete ALLOWED rows=1`; R's iteration-1 probe on
   the real AuditLog: same).
3. **Forge history**: INSERT an audit row in any club with any `createdAt` (C15 CURRENT: back-dated insert kept). The
   lane-D importer reads address-change/release rows as evidence when binding imported bookings (SF-67 residuals 1–3,
   REPORT-D3/D5): a forged or back-dated release row makes an old same-name member "acquire" the address before the
   earliest booking, so the import binds the true holder's attendance history to the wrong person.
4. **Re-point provenance directly**: UPDATE another club's `ImportSourceMapping` / `ImportedBooking` rows so a source
   key resolves to an attacker-chosen member (C16 CURRENT: `rewriteB = 1`), or change `Member.email` with no audit row
   at all (the raw-SQL residual R named).
5. **Hide it**: the audit rows that would show steps 2–4 are themselves writable (step 2).

## After each fix

| fix | step 1 | step 2 | step 3 | step 4 | step 5 |
|---|---|---|---|---|---|
| SF-57 alone (lane F: UPDATE/DELETE revoked, append-only trigger, createdAt forced) | open | **closed** | open (current-time forged rows in any club) | open | closed |
| SF-62 P1 alone | closed for the bypass GUC | via forged tenant GUC | via forged tenant GUC | via forged tenant GUC (C16 P1 BREACH) | via forged tenant GUC |
| **SF-62 P2 + SF-57** | **closed** | **closed** | needs the signing key (full app compromise); current-time only | needs the signing key (C16 P2 hold; R1 residual) | **closed** |

Residual with full application compromise (DB URL + signing key): inside any one club the attacker can still change
mutable provenance rows and append current-time audit rows. RLS is an isolation control, not an integrity control:
closing that needs append-only provenance (history rows for ImportSourceMapping/ImportedBooking changes, like the
AuditLog trigger) and an evidence store outside the database (lane D / lane F follow-up).

## Interplay with lane F's proposed SQL (evidence/F/proposed-auditlog-append-only.sql)

- Its purge function is SECURITY DEFINER **owned by the owner role** (BYPASSRLS + DDL) and EXECUTE is granted to
  matflow_app. Under this design: own it by a NOLOGIN role without BYPASSRLS (matflow_system works: it reaches AuditLog
  through `system_access`), and grant EXECUTE to matflow_system/matflow_ops only, so the public runtime cannot even run a
  bounded purge. The 365/2190-day floors stay inside the function, as C17 measures for the scratch purge.
- Its trigger exempts `current_user <> 'neondb_owner'` (R already asked for the owner name not to be hard-coded); with a
  dedicated function owner, the exemption keys on that role instead.
- Phase 1 here already revokes UPDATE/DELETE/TRUNCATE on AuditLog from matflow_system, so the new role cannot become a
  second audit-rewrite path.
