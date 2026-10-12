# Lane D report (saved by lead; agent write refused by hook)

Q9-1/2/3 FIXED LOCALLY: lib/audit-log.ts logAudit({tx}) strict in caller tx (alias logAuditStrict :260); logAudit({durable:true}) own awaited tx; else best-effort (~100 low-impact sites). Strict/durable metadata: actor, actorType, effectiveUserId, requestId (x-vercel-id or uuid), outcome. Secret keys stripped from all metadata (:60). Shared-secret attribution via "shared-secret" for cookie path.
In-tx audit: force-password-reset, totp-reset, member-totp-reset, transfer-ownership, suspend/unsuspend, review-lock, restore, import rollback, owner TOTP enrolment → audit failure = 500 "nothing was changed" (no temp password handed out).
Durable-first: soft-delete (requested row before Stripe; outcome row in stamp tx), impersonation start (before startSupportSession), impersonation end (durable, never blocks stop), DSAR export (before file; 500 on failure).
DSAR erase guard reachable: requested row durable before Stripe (:222); fulfilment row first statement in erase tx (:443); tests/unit/dsar-erase-audit-durability (4).
TOTP enrolment row auth.totp.enrolled in enable tx (totp/setup :136), no secrets.
Retention: auditLogRetentionWhere (audit-log.ts:292) — 365 d ordinary; 6 y for admin.*, member.dsar_erase*, rows with metadata.actingAs. Purge keeps AuditLog (no FK, no delete) — pinned.
Soft-delete step-up wired (route :67); restore deliberately no step-up (non-destructive, recovery path), audited in tx.
Labels added (lib/audit-labels.ts). XSS wording in audit doc → "tested cases passed" with coverage + not-covered list.
Lane C follow-ups D1–D6 FIXED (D3: isTenantRowBusyError → purge skipped busy, restore 503 Retry-After; D5 DangerZone deletion-state UI; D6 restore billingReview).
Tests: integration audit-durability-db 4/4 both roles; race 5/5 both; owner-recovery-revocation-db 5/5 both; operator-member-totp-reset 5 pass + 3 fail (lane B mock). Unit batch 24 files: 430 pass, 1 fail (operator-console-xss useParams mock — lane B LoginAsOwnerButton). tsc errors only in lane B test files.
Owed by lane B: useParams in operator-console-xss mock; refuseSupportSession in api-authz mocks of dsar-erase-completeness, dsar-erase-children-gate, dsar-export, import-commit-integrity, import-reconciliation-rehearsal-gaps, import-teamup-refresh, staff-unlock, staff-totp-reset, integration operator-member-totp-reset; enrolment now writes auth.totp.enrolled.
Policy owed (Noe/legal): app/legal/privacy/page.tsx §6 "Audit logs — twelve months" vs code 6 y for operator/support/erasure rows; docs/runbooks/db-restore.md:78.
Residual: impersonation start row says authorised before session minted (500 if mint throws); soft-delete stamp failure after Stripe leaves subs non-renewing (message says so; retry idempotent); step-up grant spent before action; best-effort remains for ordinary actions; DB not append-only; lane B no-cookie stop writes no row.
