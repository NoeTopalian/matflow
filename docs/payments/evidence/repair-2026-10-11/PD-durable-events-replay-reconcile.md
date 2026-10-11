# Lane PD report - durable event processing, failed-event visibility, controlled replay, reconciliation

Branch payments/stripe-defects-2026-10. Started 11 Oct 2026 (UK).

## Log
- Step 0: read RULES.md, BRIEF-PD.md, BRIEF-PC.md and the runner scripts.
- Step 1 (schema): `node --version` = v24.21.0 (Node 24 from the scratchpad toolchain on PATH for every run).
  - `prisma/schema.prisma`: `StripeEvent` extended (tenantId, stripeAccountId, livemode, objectId, created, status, attempts, lastError, firstSeenAt, lastAttemptAt, reconcileFoundAt; indexes (tenantId,status) and (status,lastAttemptAt); eventId @unique kept; processedAt kept as the retention key). NEW model `StripeReconcileRun`.
  - `bash pay/run-prisma.sh migrate dev --create-only --name pay_pd_stripe_event_store` -> first run P1001 (cannot reach server), second run REFUSED by Prisma itself: "The migration `20260930100000_import_provenance_review_lock` was modified after it was applied. We need to reset the public schema" (exit 130, prompt aborted, nothing reset). A reset of the shared TEST branch is not acceptable, so the migration SQL was generated with `npx prisma migrate diff --from-schema <HEAD schema> --to-schema prisma/schema.prisma --script` (diff contained only this lane's changes), hand-completed, and applied with `bash pay/run-prisma.sh migrate deploy` -> exit 0 ("All migrations have been successfully applied").
  - Migration `prisma/migrations/20261011180000_pay_pd_stripe_event_store/migration.sql`: additive; backfills existing rows as `processed` (they were claimed in the handler transaction, so all were processed), CHECK on status and attempts, RLS ENABLE+FORCE+`tenant_isolation` on StripeEvent (it now has tenantId, so rls-coverage requires it), RLS ENABLE+FORCE+`platform_only` (bypass-only) on StripeReconcileRun.
  - Owner note: migration 20260930100000 has a checksum mismatch on the TEST branch (pre-existing; `migrate dev` cannot be used there until it is resolved).
- Step 2 (defect reproduced, RED): `tests/integration/pay-pd-webhook-durability-db.test.ts` drives the REAL webhook route (real constructEvent with a synthetic local secret, real Prisma rows on the TEST branch). Scenario: failed Payment row for invoice I + succeeded row for PaymentIntent P; `invoice.payment_succeeded` resolves P and stamps stripeInvoiceId=I on P's row, colliding on the unique key.
  - Command: `bash att/run-engine.sh tests/integration/pay-pd-webhook-durability-db.test.ts` -> EXIT=1 (RED). Excerpt: `AssertionError: expected true not to be true` at `expect(first.body.alreadyProcessed).not.toBe(true)`; the log shows `Unique constraint failed on the fields: ("stripeInvoiceId")` inside the handler — the route answered 200 `{alreadyProcessed: true}` for an event it never processed, and left no StripeEvent row.
  - Two defects confirmed by this run: (1) no durable record of a failed event (audit §14); (2) NEW: the route reads ANY P2002 thrown by a handler statement as "duplicate delivery" (`webhook/route.ts` catch: `if ((err as {code?}).code === "P2002") return 200 alreadyProcessed`), so a handler unique-key collision acks and drops the event permanently. The event-store design fixes both because duplicates are detected by the row status, not by a P2002.
  - This test stays RED until lane PC wires `runStripeEvent` into `app/api/stripe/webhook/route.ts` (not my file). It is the acceptance test for that wiring.
- Step 3 (store + replay built, GREEN): NEW `lib/stripe/event-store.ts`, NEW `lib/stripe/replay.ts`. DB test `tests/integration/pay-pd-event-store-db.test.ts` (12 cases: record-before-process; (a) duplicate sequential; (a) duplicate concurrent on two connections; row-lock busy/claimed/missing; (b) out-of-order both recorded with Stripe created; (c) crash after Payment insert -> no Payment, row failed with masked error, retry once; retryable refusal recorded; (d) replay of failed after fix -> fetched fresh with stripeAccount, replayed, one operator audit, second replay refused; (e) forced replay of processed invoice.payment_succeeded -> 1 Payment, 1 handler audit, 1 email, 1 replay audit; replay refusals (not_found, reason_required, not_wired, livemode_mismatch, mismatch x2, stripe_unavailable, club_disconnected with no Stripe call); RLS club-context isolation; reconcile-run table bypass-only).
  - `bash att/run-engine.sh tests/integration/pay-pd-event-store-db.test.ts` -> EXIT=0, `Tests 12 passed (12)` (owner role; RLS not in force, the RLS case asserts the owner view and is recorded as such).
  - `bash q78/run-restricted.sh tests/integration/pay-pd-event-store-db.test.ts` -> EXIT=0, `Tests 12 passed (12)` (matflow_app, RLS_ENFORCED=1: club A sees its row only, club B sees none, unattributed rows only under bypass; StripeReconcileRun invisible outside bypass).
- Commit 81bfe97 `payments(PD): durable Stripe event store, controlled replay, StripeReconcileRun model`. NOTE: my first commit of this slice (492ddb6) accidentally carried lane PC's uncommitted `MemberSubscription` hunks from the shared `prisma/schema.prisma` working copy. It was undone at once (`git reset --soft HEAD~1`, HEAD was still my commit) and re-committed as 81bfe97 with ONLY the StripeEvent/StripeReconcileRun hunk staged (blob built from HEAD~1 schema + my block, `git update-index --cacheinfo`). PC's working-copy edits and migration were not touched. 492ddb6 exists only as an unreachable object.
- Step 4 (reconciliation, RED then GREEN): `lib/stripe/reconcile.ts` rewritten; `tests/unit/pay-pd-reconcile.test.ts` (8 cases, Stripe and DB mocked).
  - RED: the test run against the ORIGINAL reconcile.ts (copied back from a0ff39c for the run, then restored, `cmp` identical): `npx vitest run tests/unit/pay-pd-reconcile.test.ts` -> EXIT=1, `Tests 8 failed (8)`.
  - GREEN: same command on the new code -> EXIT=0, `Tests 8 passed (8)`.
  - DB proof (f): `tests/integration/pay-pd-reconcile-db.test.ts` (2 cases: deleted store row found and recorded received/attempts 0/reconcileFoundAt, NOT processed, Payment count unchanged; state drift reported with member/payment rows unchanged; deauthorised club reported with backlog 1 and never called; run row status mismatches, counts; second run records nothing new).
    - `bash att/run-engine.sh tests/integration/pay-pd-reconcile-db.test.ts` -> EXIT=0, `Tests 2 passed (2)`.
    - `bash q78/run-restricted.sh tests/integration/pay-pd-reconcile-db.test.ts` -> EXIT=0, `Tests 2 passed (2)`.
- Step 5 (schedule + gate): `vercel.json` adds `/api/cron/stripe-reconcile` at `15 4 * * *` (retention entry unchanged). Route keeps CRON_SECRET bearer + throttle, then `STRIPE_SECRET_KEY` presence, then its own gate `STRIPE_RECONCILE_ENABLED === "true"` (default OFF -> 503 "stripe reconcile cron disabled", same pattern as retention). Per-club errors -> 500 ok:false; drift alone -> 200 with status mismatches on the run row.
  - `tests/unit/pay-pd-cron-schedule.test.ts` (10 cases). RED against the original route + vercel.json (swapped in from a0ff39c, restored after): EXIT=1, `Tests 8 failed | 2 passed (10)`. GREEN: EXIT=0, `Tests 10 passed (10)`.
  - `tests/integration/cron-smoke.test.ts` un-mocked: the module mock of `@/lib/stripe/reconcile` is replaced by a fake of the `stripe` SDK only (empty event lists, retrieves 404); the reconcile tests now assert a real run row. `bash att/run-engine.sh tests/integration/cron-smoke.test.ts -t stripe-reconcile --reporter=verbose` -> EXIT=0, `Tests 6 passed | 13 skipped (19)`, output `stripe-reconcile -> 200 {"ok":true,"runId":"cmv43rupw...","tenantsChecked":1,"missingCount":0,"mismatches":0,"errors":[]}`. Same under `q78/run-restricted.sh` -> EXIT=0, `Tests 6 passed | 13 skipped (19)`.
  - Full cron-smoke under the owner role: EXIT=1, `Tests 1 failed | 18 passed (19)`. The failure is the PRE-EXISTING retention safety guard, which fails BEFORE the retention route is called: "The test branch now holds tenant(s) soft-deleted over 30 days ago ... expected 7 to be +0". Not caused by this lane; I did not clear or re-date the 7 tenants on the shared TEST branch (owner decision). Recorded as unproven for the retention half of cron-smoke.
  - Existing unit tests around these files: `npx vitest run` retention-cron, sec-m1-retention-cron-gate, sec-m2-lg3-retention-matcher, sec-m2-retention-log-reason, tenant-lifecycle-constraints, class-instances-cron, pay-pd-reconcile, pay-pd-cron-schedule -> EXIT=0, `Test Files 8 passed (8)`, `Tests 140 passed (140)`.
  - `npx eslint` on the slice -> EXIT=0. Commit 2d305b7.

## Integration note for lane PC (webhook wiring) — written 11 Oct, available now

Store API (all in `lib/stripe/event-store.ts`, committed 81bfe97; replay `prepare` hook added after):

```ts
export type StoreEventInput = { id: string; type: string; account?: string | null; livemode?: boolean | null; created?: number | null; data?: { object?: { id?: unknown } | Record<string, unknown> | null } | null };
export async function recordReceived(event: StoreEventInput, opts?: { reconcileFound?: boolean; tenantId?: string | null }): Promise<RecordReceivedResult>;   // own tx, BEFORE processing
export async function claimStripeEvent(tx: Prisma.TransactionClient, eventId: string): Promise<{ kind: "claimed" | "done"; status } | { kind: "busy" } | { kind: "missing" }>; // SELECT … FOR UPDATE SKIP LOCKED
export async function markProcessed(tx, eventId, opts?: { tenantId?: string | null; status?: "processed" | "replayed" }): Promise<void>;
export async function markIgnored(tx, eventId, kind: "ignored_foreign" | "ignored_stale", opts?: { tenantId?: string | null }): Promise<void>;
export async function markFailed(eventId: string, error: unknown): Promise<void>;                                                                        // own tx, AFTER rollback
export type ProcessorContext = { tx: Prisma.TransactionClient; mode: "delivery" | "replay" | "replay_forced"; tenantId: string | null };
export type ProcessorResult = { outcome: "processed" | "ignored_foreign" | "ignored_stale"; tenantId?: string | null; emails?: QueuedEmail[]; audits?: QueuedAudit[]; after?: Array<() => Promise<unknown>> };
export type StripeEventProcessor<E extends StoreEventInput = StoreEventInput> = (event: E, ctx: ProcessorContext) => Promise<ProcessorResult>;
export class StripeEventRetryableError extends Error {}   // replaces WebhookRetryableError -> recorded failed, answered 409
export async function runStripeEvent<E>(event: E, processor: StripeEventProcessor<E>, opts?: { mode?: RunMode }): Promise<RunResult>;
// RunResult: { kind: "processed" | "ignored_foreign" | "ignored_stale", status, tenantId, emailsSent, auditsWritten } | { kind: "already_processed", status } | { kind: "in_progress" } | { kind: "failed", retryable, error }
```

What PC must change in `app/api/stripe/webhook/route.ts` (and what I need exposed for replay):

1. Move the body of `withRlsBypass(async (tx) => { … })` into a function in your directory, e.g. `lib/stripe/webhook/process.ts`:
   `export async function prepareStripeEvent(event: WebhookEvent, stripe?: Stripe): Promise<StripeEventProcessor<WebhookEvent>>` — does the existing pre-transaction network lookups (`resolveInvoicePaymentIds`, `resolveMandateCustomerId`, any fresh subscription retrieve for staleness) and returns `async (event, { tx, mode, tenantId }) => { …handler body… ; return { outcome, tenantId, emails, audits, after } }`.
2. DELETE `await tx.stripeEvent.create({ data: { eventId: event.id, type: event.type } })` — the claim moves into `runStripeEvent` (recordReceived before the tx; claimStripeEvent as the tx first statement; markProcessed/markIgnored in the same commit as the effects).
3. `throw new WebhookRetryableError(...)` -> `throw new StripeEventRetryableError(...)` (account missing / not linked yet). Your "unknown subscription on a known account" path returns `{ outcome: "ignored_foreign" }`; the stale path returns `{ outcome: "ignored_stale" }` — the store records those statuses.
4. Do not dispatch side effects inside: replace `pendingEmails.push` / `pendingAuditLogs.push` with arrays you RETURN as `emails` / `audits`; `accountStatusRefresh` becomes `after: [() => refreshStripeAccountStatus(tenantId, acct)]`. `runStripeEvent` writes the audits INSIDE the transaction (durable now, `logAudit({ ...a, tx })`), sends emails after commit, runs `after` jobs after commit, and SUPPRESSES emails+audits on a forced replay.
5. Replace the try/catch tail with:
   ```ts
   // livemode refusal (your item 6) and the unhandled-type ack stay BEFORE this line: not recorded.
   const r = await runStripeEvent(event, await prepareStripeEvent(event));
   switch (r.kind) {
     case "processed": case "ignored_foreign": case "ignored_stale":
       return NextResponse.json({ received: true, status: r.status });
     case "already_processed": return NextResponse.json({ received: true, alreadyProcessed: true });
     case "in_progress": return NextResponse.json({ error: "Event is being processed" }, { status: 409 });
     case "failed": return NextResponse.json({ error: r.retryable ? r.error : "Processing failed" }, { status: r.retryable ? 409 : 500 });
   }
   ```
   and REMOVE `if ((err as { code?: string }).code === "P2002") return … alreadyProcessed` — today any unique violation inside a handler statement is acked as a duplicate and the event is lost (reproduced RED by `tests/integration/pay-pd-webhook-durability-db.test.ts`). Duplicates are now detected by the row status, not by P2002.
6. Acceptance: `tests/integration/pay-pd-webhook-durability-db.test.ts` (both runners) must go GREEN after your wiring without edits; existing unit cases in `tests/unit/stripe-webhook-handlers.test.ts` that mock `prisma.stripeEvent.create` / P2002 need to mock `@/lib/stripe/event-store` instead (that file is yours).
7. Replay wiring (my file, one line, after your module lands): in `app/api/admin/stripe/events/[id]/replay/route.ts` the deps currently pass `prepare: null` (route answers 501 "not wired" before any step-up is spent); it becomes `prepare: (e) => prepareStripeEvent(e)` imported from your module.

## Log (continued)
- Step 6 (operator page + replay routes): NEW `app/api/admin/stripe/events/route.ts` (GET overview), NEW `app/api/admin/stripe/events/[id]/replay/route.ts` (POST replay), NEW `app/admin/stripe/page.tsx`, NEW `components/admin/stripe/StripeSyncPanel.tsx`, NEW `components/admin/stripe/ReplayDialog.tsx`; `lib/stripe/replay.ts` gained `prepare` + `loadWebhookPrepare()` (the one-line wiring point for PC's processor; returns null today).
  - Gate (both routes): `isAdminAuthed` (MFA operator session + OPERATOR_ALLOWED_IDS allowlist) -> 403; `refuseSupportSession(await auth())` -> 403 supportReadOnly; replay also `assertSameOrigin`, rate limit 30/h per operator+IP, zod body `{reason 5-500, force?}` strict.
  - Replay order: harmless preflight (event exists, account linked to a club, club connected, settled-without-force refused 409 without asking for a code, processor wired else 501 `notWired` — all BEFORE any grant is spent), then `requireStepUp(req, ctx, "stripe.event_replay", stepUpTarget(tenantId, eventId), { change: { force } })`; settled+grant -> echo the recorded outcome via `findAppliedGrant` or 409 without spending; then ONE tx: `consumeStepUpGrant` (echo on a spent grant) + durable `stripe.event.replay.requested` audit row; then `replayStripeEvent` -> durable `stripe.event.replayed` row with the grant's requestId and operatorId.
  - OUT-OF-LIST FILE (disclosed): `lib/operator-step-up.ts` — added ONE step-up action `stripe.event_replay` (STEP_UP_ACTIONS entry, change schema `{ force: boolean }` strict, `stepUpVersion` case = `stripe-event:<id>:<status>` with the club check). The brief requires "step-up for replay" and step-up actions are a closed list in that file; no other lane owns it. Existing tests: `npx vitest run tests/unit/operator-step-up.test.ts tests/unit/operator-hub-conflict-routes.test.ts tests/unit/operator-owner-profile.test.ts` -> EXIT=0, `Tests 158 passed (158)`; `operator-step-up-db.test.ts` owner -> EXIT=0 `10 passed`, restricted -> EXIT=0 `10 passed`.
  - DB test `tests/integration/pay-pd-admin-replay-db.test.ts` (8 cases: no operator 403 / support 403; overview lists the failed event, counts, no member email/name, masked error, no key prefix; replay without grant 403 nothing written; unwired 501 nothing spent; with grant processed once, fetched with stripeAccount, requested+replayed rows share the grant requestId and operatorId, same grant echoes alreadyApplied with no second Stripe call; settled without force 409, a fresh grant is NOT spent and writes nothing; a non-force grant cannot be spent on force (403 wrong_change); forced replay -> 1 Payment, 1 handler audit, 2 replay rows; short reason 400).
    - First run (owner) EXIT=1 `1 failed | 7 passed`: `expected 409 to be 200` — a retried grant on a now-settled event hit the preflight before the echo. Fixed in the route (settled + grant -> echo via findAppliedGrant or 409 without spending), and the test extended to prove the unspent grant.
    - After the fix: `bash att/run-engine.sh tests/integration/pay-pd-admin-replay-db.test.ts` -> EXIT=0 `Tests 8 passed (8)`; `bash q78/run-restricted.sh …` -> EXIT=0 `Tests 8 passed (8)`.
  - Component test `tests/unit/pay-pd-admin-stripe-panel.test.tsx` (5 cases: HTTP 500 -> ErrorState with reference and retry, never the empty state; loaded overview shows club, failed event, masked error, drift; Replay posts step-up `{action:"stripe.event_replay", targetId:"t1/evt_pd_1", change:{force:false}}` and sends the grant header; a 501 refusal shows the server message, no success toast; withdrawn club has no Replay button). First run EXIT=1 (2 failed: "Found multiple elements with the text" — my query, the club name appears twice); query fixed to the heading role -> EXIT=0 `Tests 5 passed (5)`.
  - UI rules: `node scripts/check-ui-rules.mjs` -> EXIT=0, "All ratchets at baseline". Primitives used: Card, Button (secondary/primary/compact, loading), Dialog, DataTable, ErrorState, EmptyState, Skeleton, Toast. Hand-rolled: one `<textarea>` and one `<input>` in ReplayDialog, because `components/ui/` has no Input/Textarea primitive; both labelled with htmlFor and token classes. The page shell uses `adminPage`/`adminContainer` from `app/admin/admin-theme.ts` like every /admin page (UI-RULES §1 names admin-theme as the operator surface theme); everything inside uses tokens, no hex.
  - eslint on the slice -> EXIT=0 (one react-hooks/set-state-in-effect error fixed first by moving the fetch out of the effect body). Commit 3d3c37c.
- Step 7 (RLS coverage after adding tenantId to StripeEvent): `tests/integration/rls-coverage.test.ts` owner -> EXIT=0 `1 passed`; restricted -> EXIT=0 `1 passed`.
- `npx tsc --noEmit -p .` -> EXIT=0, 0 errors (whole working tree, including the other lanes' uncommitted edits at that moment).
- Step 8 (full unit suite, first pass): `npx vitest run tests/unit` -> EXIT=1, `Test Files 6 failed | 479 passed (485)`, `Tests 11 failed | 6833 passed | 1 skipped (6845)`. Mine (5 guard tests): `sec-c-static-guards` (new raw-SQL call site in lib/stripe/event-store.ts not on the SEC-033 reviewed list), `migrations-are-atomic` (my migration lacked BEGIN/COMMIT), `audit-labels` (no sentence for `stripe.event.replay.requested`), `operator-endpoint-authz-matrix` (2 new admin routes unclassified), `journeys-manifest` (2 new api routes unclaimed). Not mine: 6 cases in `tests/unit/pay-pa-route-guard-matrix.test.ts` (lane PA's file).
- Step 9 (fixes):
  - Raw SQL removed from the store instead of widening the security allowlist: `recordReceived` = `createMany({ skipDuplicates: true })` (INSERT … ON CONFLICT DO NOTHING) + conditional `updateMany`s; `claimStripeEvent` = conditional `updateMany({ where: { eventId, status: in [received, failed] } })` as the first statement of the handler tx. Its row lock is held to the end of that tx; a concurrent delivery WAITS on it and then re-evaluates: first committed -> `done` (already_processed), first rolled back -> `claimed`. A wait past the 15 s lock_timeout (55P03) -> `in_progress` (non-2xx). A forced replay of a settled row also takes the row lock. DB tests updated to prove both outcomes of the wait (holder commits -> second sees `done`; holder crashes -> second `claimed`) and the concurrent pair now asserts exactly `["already_processed","processed"]`.
  - Migration wrapped in `BEGIN;` … `COMMIT;` (statements unchanged). The TEST branch already had it applied, so its `_prisma_migrations.checksum` was re-stamped from the old file hash (ed9c4c34…) to the new one (460abceb…) by a temporary guarded vitest file (owner runner, asserted the URL is ep-hidden-salad, conditional on the old checksum; file deleted after): EXIT=0, "updated 1". Production has never seen this migration.
  - Registries (outside my explicit list, additive entries only, disclosed): `lib/audit-labels.ts` (+2 sentences: "MatFlow asked to reprocess a Stripe payment event", "MatFlow reprocessed a Stripe payment event"); `tests/unit/operator-endpoint-authz-matrix.test.ts` (+2 routes in the operator inventory — the matrix then drives every refused persona through both routes and asserts no DB/side effect); `tests/e2e/campaign/assess/journeys.ts` (J60 operator journey claims `GET admin/stripe/events` and `POST admin/stripe/events/[id]/replay`).
  - Re-run of the five guard files: EXIT=1, `Tests 1 failed | 285 passed (286)`; the one failure is `audit-labels`: "add labels for: member.payment.requires_action" — lane PC's new action name in PC's files, not mine.
  - Lane DB tests re-run after the store change, both roles: event-store 12/12 (owner EXIT=0, restricted EXIT=0); reconcile 2/2 (both EXIT=0); admin replay 8/8 (both EXIT=0).
  - `tests/integration/pay-pd-webhook-durability-db.test.ts` re-run against the tree after lane PC wired the route to the store (PC commit bb2a935): EXIT=0, `Tests 1 passed (1)` — the defect reproduction is now GREEN through PC's wiring (non-2xx, row `failed` with lastError, attempts 1 then 2, no `alreadyProcessed`).
  - Commit e96d35c.
- Step 10 (real Stripe TEST MODE, read-only):
  - Probe script `<scratchpad>/pay/PD/scripts/testmode-probe.mjs` (reads .env.test, refuses unless `sk_test_`, never prints the key): 1 connected account visible; `events.list` AS the account returned events with `account` = the account and `livemode=false`; `events.retrieve` AS the account returned the same id with `account` present and matching; the same id WITHOUT `Stripe-Account` -> `resource_missing`; `events.list delivery_success=false` AS the account -> accepted, 0 events. This settles audit S3 U6 (listing missed connected-account events must be done per account with `Stripe-Account`) and confirms replay must retrieve with the header.
  - Opt-in DB test `tests/integration/pay-pd-testmode-reconcile-db.test.ts` (`PAY_PD_STRIPE_TESTMODE=1`): owner EXIT=0 `Tests 2 passed (2)`, restricted EXIT=0 `Tests 2 passed (2)`. The account is held on the TEST branch by the `totalbjj` copy with `stripeConnected: false`; I did NOT flip that shared fixture. So the full-run case exercised the withdrawn-club path on real data: `{"clubConnected":false,"tenantsChecked":0,"tenantsSkipped":1,"errors":[],"stripeCalls":0}` (reported, never called). The write path over a real CONNECTED account is therefore proven only with mocked Stripe (unit + DB), not against test mode — see "unproven".
- Step 11: added a store DB case "a unique violation SWALLOWED inside the processor still aborts the transaction: recorded failed, never processed". Postgres aborts the transaction at the error, so a handler that catches P2002 and carries on cannot commit. The event-store DB test now has 13 cases: owner EXIT=0 `13 passed`, restricted EXIT=0 `13 passed`. Commit 44e27d1.

## Proofs required by the brief (§5): where each is evidenced

| Proof | Evidence | Status |
|---|---|---|
| (a) duplicate delivery, sequential | pay-pd-event-store-db "(a) … sequential": the second run returns `already_processed`; 1 Payment, 1 audit, 1 email | GREEN, both roles |
| (a) duplicate delivery, concurrent (two connections) | "(a) … concurrent": kinds are exactly `[already_processed, processed]`; 1 Payment, 1 audit, 1 email. Also the row-lock case: holder commits → the waiter gets `done`; holder crashes → the waiter gets `claimed` | GREEN, both roles |
| (b) out-of-order events recorded with Stripe `created` | "(b)": both rows kept with their own `created`; the newer is processed, the older is `ignored_stale` (the ordering rule itself is PC's) | GREEN, both roles |
| (c) crash after the Payment insert, before commit | "(c)": 0 Payment, row `failed` with the error masked, attempts 1; the retry processes it, 1 Payment, attempts 2; a third delivery is a no-op | GREEN, both roles |
| (c) at the real webhook route | pay-pd-webhook-durability-db: RED on a0ff39c (200 alreadyProcessed, no row); GREEN after PC wired the store (bb2a935) | GREEN (owner run) |
| (d) replay of a failed event after the cause is removed | "(d)" (lib) and admin-replay-db (route, step-up, audit): fetched fresh with stripeAccount, processed once, status `replayed`, 1 operator audit row on the grant requestId; a second replay is refused | GREEN, both roles |
| (e) forced replay of a processed invoice.payment_succeeded | "(e)" and the admin-replay-db forced case: 1 Payment, the handler audit stays at 1, emails stay at 1, replay rows +1 | GREEN, both roles |
| (f) reconcile finds a deleted store row, records it and does not process it | pay-pd-reconcile-db "(f)": `received`, attempts 0, reconcileFoundAt set, Payment count unchanged; a second run records nothing | GREEN, both roles |

## Commits (branch payments/stripe-defects-2026-10, local, not pushed)
- 81bfe97: store, replay, schema and migration, store DB tests, route-level acceptance test (RED at the time).
- 2d305b7: reconciliation rewrite, its own schedule and gate, cron-smoke un-mocked, unit and DB tests.
- 3d3c37c: operator page, overview and replay routes, step-up action, component and DB tests.
- e96d35c: store without raw SQL (conditional-update lock), migration BEGIN/COMMIT, registries, test-mode check.
- 44e27d1: the swallowed-P2002 store case.
- 492ddb6 was a mistaken first commit that carried PC's schema hunks. It was replaced by 81bfe97 before anything else was committed on top.

## Lint and typecheck
- `npx eslint <every file I touched>` → EXIT=0 at each commit.
- `npx tsc --noEmit -p .` → EXIT=0, 0 errors (whole working tree, after 3d3c37c).
- `node scripts/check-ui-rules.mjs` → EXIT=0, all ratchets at baseline.
- NOT run: `npm run build`. Its first step (`scripts/maybe-migrate.mjs`) runs `prisma migrate deploy` against whatever DATABASE_URL the shell holds, and I would not risk production. The build is owed by whoever integrates the lanes, on a shell with no production credentials.

## What remains unproven
1. Replay through the real webhook processor. PC wired `runStripeEvent` inline in `POST` (bb2a935) but did not export a processor. So `loadWebhookPrepare()` in `lib/stripe/replay.ts` returns null, and the replay route answers 501 `notWired` before any grant is spent. Replay is proven end to end with a stand-in processor that writes real Payment rows, not with PC's handler.
2. Reconcile's write path against a real CONNECTED test-mode account. The only test-mode account is held by the TEST-branch `totalbjj` copy, which has `stripeConnected: false`, and I did not flip that shared fixture. What real test mode did prove: listing and retrieval per account with `Stripe-Account`; `resource_missing` without it; `delivery_success=false` accepted; and the withdrawn-club path (reported, zero Stripe calls).
3. The state comparison covers `Member.stripeSubscriptionId` → `paymentStatus` and Stripe-backed Payments (status, amount_refunded). It does not yet read PC's `MemberSubscription` mapping. It does not compare `current_period_end`: Member has no mirror field, while PC's mapping has `currentPeriodEnd`.
4. Post-commit emails are still fire-and-forget (no outbox). Handler audit rows are now durable, because `runStripeEvent` writes them inside the processing transaction. Emails are not.
5. Full cron-smoke: the retention half fails on a pre-existing TEST-branch guard (7 tenants soft-deleted more than 30 days ago), so it never ran past the guard.
6. The 90-day retention prune keys on `processedAt`, so failed and received rows also age out after 90 days (Stripe's own event history is 30 days). A tenant hard-delete does not remove StripeEvent rows (there is no FK); they age out the same way.
7. Production: nothing deployed, nothing migrated, no live key touched.

## Requests to other lanes
- PC (app/api/stripe/webhook/route.ts):
  1. Export the processor for replay. For example, add `export async function prepareStripeEvent(event): Promise<StripeEventProcessor>` under `lib/stripe/webhook/`. It would do the pre-transaction lookups (invoice ids, mandate subscriptions, fresh subscription) and return the processor that is currently inline in `POST`. I then change one line: `loadWebhookPrepare()` in `lib/stripe/replay.ts` returns `(e) => prepareStripeEvent(e)`.
  2. The comment near route.ts line 222 says the lock is "FOR UPDATE SKIP LOCKED — a second concurrent delivery is told in progress". Since e96d35c the lock is a conditional UPDATE. A concurrent delivery waits, then gets `already_processed`, or claims the row after a rollback. It gets `in_progress` only on the 15 s lock timeout. Please correct the comment; your `in_progress` → 409 mapping is still right.
  3. The class-pack and shop branches (route.ts about lines 711 and 770; already present at a0ff39c lines 529 and 588) catch P2002 inside the transaction and carry on. Postgres has already aborted the transaction at the error, so the commit cannot happen. Such an event is now recorded `failed` and retried for ever; my "SWALLOWED" store test pins this. Use `createMany({ skipDuplicates: true })`, an upsert or a check-first read instead of catch-and-continue.
  4. `audit-labels.test.ts` failed on your new `member.payment.requires_action` literal, which needs a sentence in `lib/audit-labels.ts`. Your 18eb305 may already resolve it; check after rebasing.
  5. Reconcile imports `subscriptionStatusToPaymentStatus` from your `lib/stripe/subscription-status.ts`. Please keep that export.
- PA: my full-suite run had 6 failing cases in your `tests/unit/pay-pa-route-guard-matrix.test.ts` ("succeeds on a healthy club …", "succeeds after a stale status is refreshed …"). Please check them against PC's subscriptions changes.
- Owner of `app/admin/AdminTopNav.tsx` (no lane owns it): add `{ href: "/admin/stripe", label: "Stripe sync" }` to NAV_ITEMS. Today the page can only be reached by URL.
- Owner of `app/api/cron/retention/route.ts` (no lane owns it; I did not touch it): it still calls `runStripeReconciliation()` as its first step. With both switches on, reconcile runs twice a night. That is harmless (the job is idempotent) but leaves two run rows. Remove the call once `STRIPE_RECONCILE_ENABLED` is on.
- Owner of `lib/audit-log.ts`: add `stripe.event.` to the AUDIT_EVIDENCE prefixes if operator replays should be kept 6 years like other operator actions. Today they get the ordinary 12 months.
- Security lane (SF-62 proposal): if its phase SQL lists tables by name, add `StripeEvent` (`tenant_isolation`) and `StripeReconcileRun` (`platform_only`, bypass-only).

## Files touched outside the brief's explicit list (all additive, all disclosed)
- `lib/operator-step-up.ts`: one step-up action, `stripe.event_replay`. The brief requires step-up for replay, and the action list is closed.
- `lib/audit-labels.ts` (two sentences), `tests/unit/operator-endpoint-authz-matrix.test.ts` (two inventory lines) and `tests/e2e/campaign/assess/journeys.ts` (two routes on J60). The unit suite fails on any new route or audit action that these registries do not list.

## Owner questions (Noe)
1. Turning the reconcile job on means setting `CRON_SECRET` (a NEW value, not the leaked one) and `STRIPE_RECONCILE_ENABLED=true` in Vercel production. Until then the job is scheduled but answers 503. Please also confirm the Vercel plan accepts a fourth cron entry: `vercel.json` now lists four, and the old route comment claimed Hobby allows two.
2. The TEST-branch `totalbjj` copy holds the only test-mode connected account and is `stripeConnected: false`. May the sandbox lane reconnect it, or connect a second test account, so the reconcile write path can be proven against real test mode?
3. The TEST branch has a pre-existing checksum mismatch on `20260930100000_import_provenance_review_lock`, which makes `prisma migrate dev` want to reset the branch. I used `migrate diff` plus `migrate deploy` instead. Should that checksum be re-stamped?
4. 7 tenants on the TEST branch were soft-deleted more than 30 days ago, which blocks the retention half of cron-smoke. Should they be cleared or re-dated?

## Final full unit suite (after e96d35c/44e27d1, whole working tree including other lanes' uncommitted edits)
- `npx vitest run tests/unit` -> EXIT=1, `Test Files 1 failed | 484 passed (485)`, `Tests 6 failed | 6838 passed | 1 skipped (6845)`. All 6 failures are in lane PA file `tests/unit/pay-pa-route-guard-matrix.test.ts` (subscribe routes: "succeeds on a healthy club ..." / "succeeds after a stale status is refreshed ..."). None in lane PD files; all five registry/guard failures from the first pass are cleared (the audit-labels requires_action failure no longer appears after PC 18eb305).


---

# Round 2 (coordinator message, branch head cffd3b1)

Lane PC exported `prepareStripeEvent(event, { baseUrl? })` from `lib/stripe/webhook/process.ts` and added `ignored_mode` to the store (migration 20261011200000). `bash pay/run-prisma.sh migrate status`: "103 migrations found … Database schema is up to date!" (TEST branch). Node v24.21.0 for every run.

## 1. Replay wired to the real webhook processor (commit 2ef511c)
- `lib/stripe/replay.ts`: `loadWebhookPrepare()` now returns `(e) => prepareStripeEvent(e, { baseUrl: NEXTAUTH_URL })`; it is never null.
- `app/api/admin/stripe/events/[id]/replay/route.ts`: the 501 `notWired` path is removed. The library's `not_wired` refusal is unreachable from the route and maps to 500 if it ever happens.
- `app/api/admin/stripe/events/route.ts`: an event that failed before its account was linked (tenantId null) is now listed under the club that holds that account, not as "unattributed".
- NEW `tests/integration/pay-pd-replay-e2e-db.test.ts` drives the real `POST /api/stripe/webhook` and the real replay route through the real processor, with the real MemberSubscription mapping, Payment and AuditLog rows.
  - Stubbed at the boundary only: the cookie jar, rate limits, email (counted, not sent), the NextAuth session, Sentry, the account-status refresh, the invoice → PaymentIntent resolver, and `events.retrieve`. The retrieve call records which account it was made as.
  - The scenario is the real connect race: an invoice event arrives before the club's account id is stored.
- Results under both runners:

| Case | Owner (run-engine) | Restricted (run-restricted) |
|---|---|---|
| (1) First delivery → 409, row `failed`, attempts 1, tenantId null, lastError "…not linked…", 0 Payment. Account linked, then one replay → `200 {"ok":true,"result":"processed","status":"replayed","forced":false}`. Retrieved once as the account. Payment rows for the invoice = **1**; `member.payment.succeeded` audits = 1; `stripe.event.replayed` = 1; member paymentStatus overdue → paid | pass | pass |
| (2) Stripe redelivery after replay → `200 {"received":true,"alreadyProcessed":true}`; Payment rows still **1**; handler audits still 1 | pass | pass |
| (3) Forced replay of the processed event → `200 {"ok":true,"result":"processed","status":"replayed","forced":true}`; Payment rows **1**; handler audits **1** (suppressed); `stripe.event.replayed` = **2**; last row has operatorId = the operator, previousStatus "replayed", forced true | pass | pass |
| (4) Processed `invoice.payment_failed` (sends the member email on delivery) then forced replay → `200 … forced:true`; emails before/after **1 / 1**; `member.payment.failed` audits unchanged; Payment rows **1** | pass | pass |

  - `bash att/run-engine.sh tests/integration/pay-pd-replay-e2e-db.test.ts --reporter=verbose` → EXIT=0, `Tests 4 passed (4)`.
  - `bash q78/run-restricted.sh …` → EXIT=0, `Tests 4 passed (4)`.
- `pay-pd-admin-replay-db.test.ts`: the 501 case was deleted because the behaviour no longer exists. It still uses a stand-in processor to cover the gate and step-up mechanics. Owner and restricted: `Tests 7 passed (7)`.
- `pay-pd-admin-stripe-panel.test.tsx`: the refused-replay case now uses a 409 "access withdrawn" message instead of the deleted 501. Result: `Tests 5 passed (5)`.

## 2. Reconcile reads the MemberSubscription mapping (commit d290fcf)
- For every live mapping in a club (`endedAt` null), reconcile retrieves the subscription as the connected account and compares:
  - `status` against the mapping;
  - `current_period_end` against the mapping, at second precision, via PC's `subscriptionCurrentPeriodEnd` (handles dahlia items);
  - `Member.paymentStatus`, only when this mapping is the member's ACTIVE one (`Member.stripeSubscriptionId` points at it).
- A member pointer with no mapping row is reported as `field: "mapping", stored: "missing"`, without a Stripe call. Ended mappings are never fetched. Nothing is written to mappings, members or payments.
- RED: the new unit case run against the previous reconcile (HEAD copy swapped in, then restored; `cmp` identical) → EXIT=1, `Tests 1 failed | 7 passed (8)`.
- GREEN: `npx vitest run tests/unit/pay-pd-reconcile.test.ts` → EXIT=0, `Tests 8 passed (8)`.
- The new case covers: two mappings for one member, where only the active one moves paymentStatus; status drift; period-end drift; a subscription missing in Stripe; a pointer with no mapping; an ended mapping that is not fetched; zero writes.
- DB test `pay-pd-reconcile-db.test.ts` now creates a real mapping. It expects status, currentPeriodEnd and paymentStatus mismatches plus the payment ones, and asserts the mapping row is unchanged afterwards (`{status:"active", currentPeriodEnd: stored, endedAt:null}`). Owner → `Tests 2 passed (2)`; restricted → `Tests 2 passed (2)`.

## 3. The small edits authorised in this round (commit aa618b5)
- `app/api/cron/retention/route.ts`: removed only the `runStripeReconciliation` call, its import, the `reconcile` field of the response, and two stale comment lines. Every gate (CRON_SECRET, bearer throttle, RETENTION_CRON_ENABLED, ?dryRun) is untouched.
  - `tests/unit/sec-m1-retention-cron-gate.test.ts`: the one assertion `expect(m.reconcile).toHaveBeenCalledTimes(1)` under the open gate now asserts `not.toHaveBeenCalled()`. This encodes the deliberate change; nothing else in that file changed.
- `app/admin/AdminTopNav.tsx`: "Stripe sync" link to /admin/stripe (RefreshCw icon).
- `lib/audit-log.ts`: `stripe.event.` added to `AUDIT_EVIDENCE_ACTION_PREFIXES`, so replay rows are kept six years.
  - `tests/unit/operator-audit-durability.test.ts` pinned the exact list and now pins the new one.
  - `tests/integration/audit-durability-db.test.ts`: owner `4 passed`, restricted `4 passed`.
- `components/admin/stripe/StripeSyncPanel.tsx`: `ignored_mode: "Wrong mode (test/live)"`.
- `prisma/schema.prisma`: the StripeEvent status comment lists `ignored_mode`. Comment only; no migration.
- Affected unit files (operator-audit-durability, sec-m1/sec-m2 retention, retention-cron, tenant-lifecycle-constraints, panel, cron schedule, audit-labels): EXIT=0, `Test Files 9 passed (9)`, `Tests 142 passed (142)`.

## 4. SF-62 note (docs/security owns it; not edited)
The SF-62 RLS proposal (docs/security/evidence/B2/proposed-sf62-phase1.sql and phase2.sql) must name the new tables when it rewrites policies:
- `StripeEvent`: RLS forced, `tenant_isolation`, from 20261011180000.
- `StripeReconcileRun`: RLS forced, bypass-only `platform_only`, from 20261011180000.
- `MemberSubscription`: lane PC's, from 20261011190000.

Its catalogue check ("every RLS table has the role-keyed system policy") would otherwise fail on them once the proposal is applied.

## Lint, typecheck, cron-smoke
- `npx eslint` on every file touched in round 2 → EXIT=0 for each commit's set.
- `npx tsc --noEmit -p .` → EXIT=0, 0 errors.
- `node scripts/check-ui-rules.mjs` → EXIT=0.
- cron-smoke under both runners: `Tests 1 failed | 18 passed (19)`, so the vitest run exited non-zero. The single failure is the pre-existing TEST-branch guard: "7 tenants soft-deleted over 30 days ago", which fires before the retention route is called. The stripe-reconcile cases and all door cases pass under both roles.
  - A correction for the log: in that loop and in an earlier loop ("rerun2") the printed `EXIT=` value was taken after a `$(basename …)` substitution, so it showed basename's status, not vitest's. Use the `Tests` line for those runs. The final re-run below captures `rc` correctly.

## 5. Lane TS sandbox findings (commit 5abbf26)
Lane TS ran a real test-mode account (acct_1UPRQ1JpZMl35yzx) and found two problems. A reconcile run answered 500 ok:false because one TEST club is connected with a fake account id (acct_revfn_fake). And the cron JSON and the stored summary carried Stripe's error text, which quotes the platform key in partly masked form.

- (a) One club cannot fail the run. A per-club failure is recorded as `{ tenantId, code }` and the next club is checked.
  - Codes come from `reconcileErrorCode()` in `lib/stripe/reconcile.ts`: `account_invalid`, `permission_error`, `authentication_error`, `rate_limited`, `timeout`, `connection_error`, `stripe_api_error`, `invalid_request`, `internal_error`. A skipped run uses `stripe_not_configured`.
  - The run row's status is `errors`, but the cron answers **200 ok:true**. Only a run that cannot complete (for example, the database is unreachable) answers 500, as `{ ok:false, error:"reconcile_failed", code }`.
- (b) Codes only, never text, in the response and the row. The message goes to the server log at error level through `maskStripeSecrets()`: `sk_|rk_|pk_` live/test keys and `whsec_` secrets become `…_[masked]`.
  - `sanitiseEventError` in the event store now masks the same patterns, so a `lastError` cannot keep a key fragment either.
  - The operator panel maps each code to a sentence.
- Tests:
  - Unit `pay-pd-reconcile.test.ts`, new case: five connected clubs. Four fail with Stripe-shaped errors (account_invalid carrying TS's real message shape with a masked key, permission, authentication, ETIMEDOUT) and one succeeds.
    - Result: `errors` is exactly the four `{tenantId, code}`; tenantsChecked 5; the good club's missing event is still recorded.
    - The result plus the run row match none of `sk_test|****|does not have|Invalid API Key|timed out`.
    - The server-log lines contain `sk_test_[masked]` and not the key fragment.
  - Unit, new case: `?dryRun` records nothing (`recordReceived` not called, no run row) and still lists the missing event.
  - RED against the previous reconcile → EXIT=1, `2 failed | 7 passed (9)`. GREEN → EXIT=0, `Tests 9 passed (9)`.
  - Unit `pay-pd-cron-schedule.test.ts`:
    - Per-club code → 200 ok:true.
    - Run failure → 500 `{ok:false, error:"reconcile_failed", code:"authentication_error"}`, with no key text in the body and the masked key in the log.
    - `?dryRun=1` runs while the switch is off; without it the switch still answers 503; the bearer is still first.
    - RED against the previous route → EXIT=1, `3 failed | 9 passed (12)`. GREEN → EXIT=0, `Tests 12 passed (12)`.
  - DB `pay-pd-reconcile-db.test.ts`, new case: a connected club with a rejected account id, run together with a good club. The real run row has `status:"errors"` and `errors:[{tenantId, code:"account_invalid"}]`, with no message text; the good club is still reconciled. Owner → rc=0 `3 passed`; restricted → rc=0 `3 passed`.
- dryRun decision: implemented, not documented away. `GET /api/cron/stripe-reconcile?dryRun=1` is report-only. It lists missing events and drift and records nothing (no StripeEvent row, no StripeReconcileRun row). Like retention's dry run, it is allowed while `STRIPE_RECONCILE_ENABLED` is off, behind the same bearer.
- An operational consequence for Noe: the TEST branch's `revfnnuwngs` club is connected with `acct_rev…fake`. Every scheduled run against the TEST branch will now record it as `account_invalid` rather than failing the run. Disconnect that fixture, or give it a real test account, if a clean run is wanted.

## Final verification for round 2 (head 5abbf26; rc is the vitest exit code, captured correctly)
```
UNIT rc=0  Tests 6915 passed | 1 skipped (6916)
pay-pd-event-store-db run-engine rc=0  Tests 13 passed (13)
pay-pd-event-store-db run-restricted rc=0  Tests 13 passed (13)
pay-pd-reconcile-db run-engine rc=0  Tests 3 passed (3)
pay-pd-reconcile-db run-restricted rc=0  Tests 3 passed (3)
pay-pd-admin-replay-db run-engine rc=0  Tests 7 passed (7)
pay-pd-admin-replay-db run-restricted rc=0  Tests 7 passed (7)
pay-pd-replay-e2e-db run-engine rc=0  Tests 4 passed (4)
pay-pd-replay-e2e-db run-restricted rc=0  Tests 4 passed (4)
pay-pd-webhook-durability-db run-engine rc=0  Tests 1 passed (1)
pay-pd-webhook-durability-db run-restricted rc=0  Tests 1 passed (1)
cron-smoke run-engine rc=1  Tests 1 failed | 18 passed (19)
 FAIL  tests/integration/cron-smoke.test.ts > Vercel cron entrypoints > retention sweeps every rule without a single one erroring
cron-smoke run-restricted rc=1  Tests 1 failed | 18 passed (19)
 FAIL  tests/integration/cron-smoke.test.ts > Vercel cron entrypoints > retention sweeps every rule without a single one erroring

```
- cron-smoke rc=1 under both roles: the single failure is the pre-existing TEST-branch retention guard (7 tenants soft-deleted over 30 days ago), which fires before the retention route runs. All 6 stripe-reconcile and door cases pass.
- Round 2 commits: 2ef511c (replay wired + end-to-end proof), d290fcf (reconcile via MemberSubscription), aa618b5 (retention call removed, nav link, six-year audit prefix, ignored_mode label and comment), 5abbf26 (per-club error codes, no Stripe text, dryRun).
- Not run: npm run build (see round 1: its migrate step could reach production).


---

# Round 3 (independent review: RP-8, RP-10, RP-5; base head 1da1e5a)

## Commit c33c5a5, first as asked: `runStripeEvent(event, processor, { mode?, recorded? })`
- Signature: `runStripeEvent<E>(event: E, processor: StripeEventProcessor<E>, opts: { mode?; recorded?: RecordReceivedResult } = {}): Promise<RunResult>`.
- When `recorded` is given and `recorded.eventId === event.id`, the store skips its own `recordReceived`, so one delivery counts as one attempt. Everything else is identical, and two-argument callers are unchanged.
- NEW `tests/unit/pay-pd-recorded-option.test.ts`, using an in-memory fake of the exact StripeEvent operations the store issues. Six cases:
  - a route-style call counts 1 attempt;
  - the old call shape counts 1 attempt;
  - recorded, then lookups fail → row `received`, attempts 1; the next delivery is attempt 2 and is processed once;
  - a failed recorded run → `failed` with the message masked (`sk_test_[masked]`, `[email]`);
  - a record for a different event id is ignored;
  - an already-processed record short-circuits without running the processor.
- RED against the previous code: EXIT=1, `3 failed | 3 passed (6)`. GREEN: EXIT=0, `6 passed (6)`.
- `pay-pd-webhook-durability-db` (attempts 1 then 2) at this commit: owner rc=0 `1 passed`; restricted rc=0 `1 passed`.
- Lane PC (agent aff1c25678075d2f1) was sent the exact signature, the SHA, the route pattern and the masking note.

## Commit 208dc9e: RP-8 (forced replay is compare-only) and RP-10 (BIGINT)
- **RP-8.** `prepareStripeEvent` has no reporting mode, so compare-only is enforced in the store and works for every event type. Nothing had to be refused.
  - NEW `compareStripeEvent(event, processor)` takes the row lock (a no-op update) and runs the processor on a transaction client that records every model write.
  - It then always throws, so the whole transaction rolls back.
  - It returns `{kind:"compared", status (unchanged), wouldBe, writes[], emailsSuppressed, auditsSuppressed}`; the processor's emails, audit rows and `after` jobs are dropped.
  - `runStripeEvent` now throws if asked for `replay_forced`.
  - `replayStripeEvent` uses `compareStripeEvent` for `force`. The operator audit row `stripe.event.replayed` is still written, with `result: "compared"`, `wouldBe` and `writesRolledBack`.
  - The replay route returns `result:"compared", wouldBe, writesRolledBack`; an in-progress run now answers 409.
- **RP-10.** `StripeEvent.created` is now `BigInt` in the schema. Migration `20261011223000_pay_pd_stripe_event_created_bigint` (BEGIN/COMMIT, `ALTER COLUMN "created" TYPE BIGINT`) widens it without changing any value, and is applied to the TEST branch: `migrate deploy` → "All migrations have been successfully applied". The store writes `BigInt`, and the overview route serialises it as a number. Only my one schema line was committed (staged from HEAD); lane PC's uncommitted schema hunks were left alone.
- **RP-5** (store side). Covered by c33c5a5 and a DB case in `pay-pd-event-store-db`: a recorded event that was never processed stays `received`, attempts 1, `lastError` null. The next delivery passes its record and is processed with attempts 2 and one Payment. `markFailed` masks emails and keys (`sanitiseEventError`).
- **Tests.** Both branches are covered, both runners:
  - **Store DB, owner and restricted (15 each):**
    - (e) a forced replay of a processed `invoice.payment_succeeded` returns `{kind:"compared", status:"processed", wouldBe:"processed", writes:["payment.upsert"], emailsSuppressed:1, auditsSuppressed:1}` and changes no Payment, audit, email or row.
    - NEW: a compare against a NON-idempotent processor reports `["payment.create"]`, still leaves 1 Payment, and leaves the row byte-for-byte equal (attempts, status, lastAttemptAt).
    - NEW: `runStripeEvent` with `replay_forced` rejects with "compare-only".
    - The RP-5 case described above.
  - **End to end through the real processor, owner and restricted (5 each):**
    - (1) and (2) are unchanged: one replay of the failed event → 1 Payment; redelivery → alreadyProcessed. This is the normal-replay branch.
    - (3) forced → `200 {"result":"compared","status":"replayed","wouldBe":"processed","writesRolledBack":["member.update","memberSubscription.updateMany","payment.upsert"]}`; 1 Payment; handler audits still 1; replay audits 2.
    - (4) forced on a processed `payment_failed` → compared; emails before/after 1/1.
    - NEW (5), the RP-8 scenario: an old `invoice.payment_failed` (created 2 h earlier) is processed, then a later paid invoice is processed (member `paid`), then the old failure is force-replayed.
      - Result: `200 {"result":"compared","status":"processed","wouldBe":"processed","writesRolledBack":["member.update","memberSubscription.update","payment.upsert"]}`.
      - The member row is unchanged (still `paid`). Every Payment row is unchanged. Failed-payment audits, emails and the event row are unchanged.
      - The operator audit row is written with result `compared`.
    - RED: the same file run against the previous store, replay and route code → rc=1. (3), (4) and (5) failed, and the old code answered `{"result":"processed","status":"replayed","forced":true}`: it re-applied the writes the compare now rolls back.
  - **Admin replay DB, owner and restricted (7 each):** the forced case returns `result:"compared"`, `writesRolledBack:["payment.upsert"]`.
  - **Remaining lane suites, both runners:** reconcile 3/3, webhook-durability 1/1.
  - **Unit:** pay-pd-recorded-option, reconcile, cron-schedule, panel, migrations-are-atomic and sec-c-static-guards → rc=0, `73 passed (73)`. No new raw SQL: the write recorder is a Proxy over Prisma delegates.
- **Lint and types.** `npx eslint` on every touched file → 0. `npx tsc --noEmit -p .` → 0, with 0 errors over the whole tree.
  - An earlier tsc run in this round showed errors only in lane PC's uncommitted `lib/stripe/webhook/process.ts` (fields not yet in the shared schema). They were gone on the next run once PC's working schema caught up. None were in my files.
- **Caveat.** The DB runs exercise the working tree, which includes lane PC's uncommitted edits to `lib/stripe/webhook/*`, `lib/stripe/invoice-payment.ts` and `prisma/schema.prisma`. The real-processor results therefore reflect PC's handler as it stands in the working tree.

- Note (after round 3): lane PC reports the route wired to the recorded option in 24da8f1. The route calls recordReceived first and returns 200 if the event is already processed. A StripeLookupError (extends StripeEventRetryableError) from prepare answers 409 and leaves the row received. Any other prepare failure calls markFailed and answers 500. Otherwise the route calls runStripeEvent(event, processor, { recorded }). PC reports durability and replay-e2e green under both runners on 6c2b022; I have not re-run them on that head.
