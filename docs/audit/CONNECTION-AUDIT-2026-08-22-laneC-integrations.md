# Lane C Audit — External Integrations + Background Machinery
MatFlow, static analysis, 2026-08-22. Scope: Stripe, Resend, Vercel Blob, crons, DB/migrations, env vars, auth infra.
All paths relative to `c:\Users\NoeTo\Desktop\matflow`.

## Summary counts

| Severity | Count |
|---|---|
| BROKEN | 3 |
| RISK | 8 |
| DEBT | 8 |

Positive verifications (checked, clean): Stripe `apiVersion: "2026-03-25.dahlia"` pinned identically at all 19 construction sites and matches the installed SDK (stripe 22.0.1, `node_modules/stripe/cjs/apiVersion.d.ts`); CRON_SECRET Bearer guard present on all 4 cron routes; every `put()` call site uses `access: "private"` + `tenants/<tenantId>/…` prefix + `addRandomSuffix`; blob-image proxy and delete-orphan both enforce the tenant path prefix; RLS enablement covers **every** tenant-scoped model in schema.prisma (empty diff, 40 tables, FORCE'd); the in-flight `20260821050000_announcement_expiry` migration SQL matches the schema field + index exactly; webhook signature verification + atomic claim-and-process idempotency (`stripeEvent.create` inside the tx) is sound; idempotency-backing uniques all exist (Payment.stripePaymentIntentId:866, Payment.stripeInvoiceId:865, MemberClassPack.stripePaymentIntentId:815, Member partial unique in `20260601000002_area8_rls_fk_indexes:59`); subscription helper passes `stripeAccount` + a 60s-bucket idempotency key; Connect OAuth state is HMAC'd, tenant-checked, constant-time compared, expiry-checked with NaN guard; Resend webhook is svix-verified, 503s in prod without secret, and has correct status-rank downgrade protection; client/server downscale constants match (512 avatar / 1600 edge); rate limiting is present on nearly every sensitive endpoint (one exception below).

---

## BROKEN (ranked by severity × silence)

### B1. Push notifications can never send — RLS-dead reads, zero signal
`lib/push.ts:12` — `sendPushToMember` queries via the **raw `prisma` singleton**:
```ts
const subs = await prisma.pushSubscription.findMany({ where: { memberId } });
```
`PushSubscription` has `ENABLE` + `FORCE ROW LEVEL SECURITY` with policy `USING (bypass_rls='on' OR tenantId = current_setting('app.current_tenant_id'))` (`prisma/migrations/20260513000004_push_subscriptions/migration.sql:26-31`). The raw singleton never sets either GUC (`set_config` is transaction-local, only in `lib/prisma-tenant.ts`), so the policy evaluates false and `findMany` returns `[]` **every time**. No error, no log — the loop body simply never runs. The 410-cleanup `delete` at `lib/push.ts:21` is equally dead.
Live call sites that believe they're pushing: `app/api/members/[id]/rank/route.ts:228` (promotion), `lib/notify-member-action.ts:81`, `app/api/tasks/route.ts` (member notes). CLAUDE.md says "push delivery not yet live — do not claim it" — this is plausibly the concrete root cause, not just a pending feature. Fix shape: read subscriptions through `withTenantContext`/`withRlsBypass`.
**Silence: total.** Nothing anywhere would ever reveal it short of a member asking where their notifications are.

### B2. Private blobs fetched via `head().downloadUrl` — waiver signatures + admin CSV import can't read their own files
Three routes still use the pattern that `app/api/blob-image/route.ts:18-27` documents as broken (and rewrote itself to avoid): on `@vercel/blob@2.3.3` the `downloadUrl` carries **no credential** (dist/index.js builds it as blob URL + `?download=1`; `get()` must send `authorization: Bearer <token>`), and the blob-image comment records the empirical result — every private-blob 302 came back unauthenticated ("every avatar rendered as blank space").
- `app/api/waiver/[signedWaiverId]/signature/route.ts:83-95` — `head(url).downloadUrl` then plain `fetch()`. Private signature blobs (all blob-stored signatures since the Bug-3 privacy fix, `lib/waiver-signature-upload.ts:28`) → upstream 401/403 → **502 "Signature unavailable"** for every blob-stored waiver signature. The data-URL fallback signatures still render, which masks this in Blob-down/dev environments.
- `app/api/admin/import/[id]/preview/route.ts:26` and `app/api/admin/import/[id]/commit/route.ts:44` — same pattern on private import CSVs (`app/api/admin/import/upload/route.ts:84` writes `access:"private"`) → `Failed to fetch file (403)` → white-glove CSV import preview/commit fails.
Caveat (see "could not verify"): if Vercel's API returns a *signed* downloadUrl for private stores, these work — but the codebase's own verified account in blob-image says it does not, and the SDK source shows no signing client-side. The comments in these three routes claiming head() resolves "a signed downloadUrl" contradict blob-image's verified account; one of them is wrong, and the evidence sides with blob-image.

### B3. Every chargeback emails each owner TWICE — two different templates, same event
`app/api/stripe/webhook/route.ts` queues **both** owner notifications on `charge.dispute.created`:
- lines 872-906: `templateId: "dispute_created"` to every owner
- lines 998-1039: `templateId: "dispute_opened_owner"` to every owner (comment "B3: notify the gym owners when a chargeback is first opened")
Both blocks are inside the same `if (tenantIdForRow)` branch and both are gated on the identical `event.type === "charge.dispute.created"`. One was clearly meant to supersede the other (the templates say almost the same thing). Every real dispute → 2 emails per owner, which trains owners to ignore exactly the time-boxed email that matters.

---

## RISK

### R1. `payment_intent.succeeded` "standalone-only" guard is inert — conditional double-counted revenue
`app/api/stripe/webhook/route.ts:741`: `const piInvoiceId = (obj.invoice as string) ?? null;` — **PaymentIntent has no `invoice` field on the pinned API version** (verified: no `invoice` property on `interface PaymentIntent` in `node_modules/stripe/cjs/resources/PaymentIntents.d.ts`; the field was removed post-basil). So `piInvoiceId` is always null and every invoice-backed PI takes the "standalone" mirror path at :743 — the exact `Record<string,unknown>`-cast bug class the file's own P0-1 comments (:86-97) describe as fixed elsewhere. Normally harmless because both legs key the upsert on the same PI id and converge to one row — **but** when `resolveInvoicePaymentIds` fails (its catch at `lib/stripe/invoice-payment.ts:77-83` returns nulls on any Stripe error), the invoice leg keys on `stripeInvoiceId` while the PI leg creates a second row keyed on the PI → two `succeeded` Payment rows for one charge → double-counted revenue in reports/CSV. The resolver failure is only a `console.error`, so the double-count arrives silently.

### R2. `checkout.session.completed` trusted without `payment_status`; async checkout events unhandled
`app/api/stripe/webhook/route.ts:416-588` mints class-pack credits and flips shop orders to `paid` on `checkout.session.completed` without checking `obj.payment_status === "paid"`. `checkout.session.async_payment_succeeded` / `async_payment_failed` are not in `HANDLED_EVENT_TYPES` (:46-63) and appear nowhere in the repo (grep: zero hits for `async_payment` / `payment_status`). Shop checkout pins `payment_method_types: ["card"]` (`app/api/member/checkout/route.ts:194`) so it completes synchronously — but **class-pack buy sets no payment_method_types** (`app/api/member/class-packs/buy/route.ts:104-121`), inheriting whatever delayed-notification methods the connected account enables in Checkout. If any gym turns one on: credits granted at session completion before funds settle, and the later `async_payment_failed` is silently ignored (reconcile won't flag it either — not a handled type).

### R3. `/api/auth/reset-password` has no rate limit on a 6-digit code
`app/api/auth/forgot-password/route.ts:76` issues `String(randomInt(100000, 999999))` (900k keyspace, 2-min expiry). The consuming route `app/api/auth/reset-password/route.ts` has **zero** `checkRateLimit` calls (verified by grep; every sibling auth route has 2-3) and no attempt counter on the token row. Brute-forcing 900k guesses in the 2-minute window is aggressive but serverless scales with the attacker. Add the same limiter the TOTP verify routes use, or an attempts column.

### R4. `RESEND_FROM` sandbox fallback in production
`lib/email.ts:387`: `process.env.RESEND_FROM ?? "MatFlow <onboarding@resend.dev>"`. In prod without RESEND_FROM every send goes out from Resend's sandbox sender — which Resend only delivers to the account owner's own address; all member/owner-facing mail (password resets, magic links, dispute alerts, receipts) fails or lands in spam. Failures are recorded in EmailLog rows nobody watches; webhook-dispatched sends are `sendEmail(email).catch(() => {})` (`webhook/route.ts:1080`) so nothing surfaces. `.env.example:102-104` documents the hazard but the code still defaults into it rather than failing loudly in prod.

### R5. Webhook Payment lookups not tenant-scoped — inconsistent with the codebase's own A8I1-S-4 defence
Inside `withRlsBypass`, `charge.refunded` (`webhook/route.ts:617-620`), `invoice.voided` (:705) and the dispute branch (:833-838) do `tx.payment.findFirst({ where: { stripeChargeId | stripePaymentIntentId | stripeInvoiceId } })` with **no tenantId filter**, then mutate the row (and void linked class packs). `findMember` (:166-186) refuses exactly this, citing test-mode ID reuse / Connect misconfig producing cross-tenant collisions. Stripe object IDs colliding across two connected accounts is unlikely in live mode but the codebase already decided that class of risk was worth closing — these three branches were missed.

### R6. `member/checkout` can create a platform-account charge on inconsistent tenant state
`app/api/member/checkout/route.ts:167`: `const connectedAccount = tenant.stripeConnected ? tenant.stripeAccountId : undefined;` then `:202` passes `undefined` options when unset. Guard at :145 only requires `stripeAccountId` non-null — so a row with `stripeAccountId` set but `stripeConnected=false` silently creates the Checkout Session **on the platform account**: money to MatFlow not the gym, and the resulting webhook has no `event.account` → 409-retry loop → order stays `pending` while the customer paid. Normal flows keep the two fields in sync (`disconnect/route.ts:40` clears both atomically), so this needs a partial write/manual edit to trigger — but the fallback should be a 400, not the platform account.

### R7. `delete-orphan` lets any authenticated tenant user delete any tenant blob
`app/api/upload/delete-orphan/route.ts` — auth = any session; the only scope check is the `tenants/<tenantId>/` prefix. A **member** (not just staff) who learns any blob URL in their tenant (other members' photos, gym branding, waiver signatures under `tenants/<id>/signatures/`) can `del()` it. Random suffixes make URLs hard to guess, but URLs do transit client-side payloads. Restrict to blobs the caller uploaded, or staff + self-profile-pic.

### R8. `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` undocumented; unset ⇒ shop silently cash-only
`app/member/shop/page.tsx:44`: `const PAY_AT_DESK = !process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;` — used purely as a build-time feature flag (the actual checkout is a hosted-session URL needing no publishable key). Not in `.env.example` or any runbook (grep: this is its only occurrence). Forget it in Vercel env → shop quietly degrades to pay-at-desk for every tenant even with Stripe fully connected. No error, no log.

---

## DEBT

### D1. Reconcile event-type drift: `charge.dispute.closed` missing
`lib/stripe/reconcile.ts:27-43` carries a "Keep in sync with HANDLED_EVENT_TYPES in app/api/stripe/webhook" comment but is missing `charge.dispute.closed` (added to the webhook at `route.ts:61` precisely so disputes don't stay "under_review" forever). A dropped dispute-closed event is now invisible to the safety net whose whole job is catching drops.

### D2. Orphan email templates: `welcome` and `rank_promoted`
`lib/email.ts:27` declares 21 TemplateIds; call-site sweep (all app/lib/components, tests excluded) shows `welcome` and `rank_promoted` have **no production call site**. No broken references the other way (every used id exists). Behavioural asymmetry worth noting: demotions email members (`app/api/members/[id]/rank/demote/route.ts:165`) but promotions never do (push is attempted instead — and push is dead, see B1, so promoted members currently hear nothing).

### D3. Stale/contradictory comments at load-bearing spots
- `app/api/cron/retention/route.ts:146` + `lib/stripe/reconcile.ts:17-19`: "Vercel Hobby allows 2 cron entries and monthly-reports + this one use both" — `vercel.json` schedules **three** crons. Either the plan changed (comment stale) or the third cron doesn't run (see Silent failures).
- `app/api/upload/route.ts` sharp block comment says "profile-pic → 256² cover-crop" while `PROFILE_PIC_SIZE_PX = 512`.
- `lib/waiver-signature-upload.ts:24-27`, `app/api/onboarding/csv-handoff/route.ts:77`, `app/api/admin/import/upload/route.ts:82`, import preview/commit: all claim `head()` resolves "a signed downloadUrl" — contradicted by `app/api/blob-image/route.ts:18-27` (see B2).

### D4. `announcements/[id]` blob delete uses a loose regex instead of the shared allowlist
`app/api/announcements/[id]/route.ts:94`: `/blob\.vercel-storage\.com/.test(existing.imageUrl)` — unanchored substring; every other del() site uses `isVercelBlobUrl` (`retention:322,669,750`, `rank:184`, `dsar/erase:420`). Harmless in effect (del on foreign URLs fails), but it's the exact validator drift the rank route's L1-I2-S-06 comment warns about.

### D5. `payment-method` route swallows Stripe errors into an empty state
`app/api/members/[id]/payment-method/route.ts:55-57`: bare `catch` → `{ card: null }`. A Stripe outage/misconfig is indistinguishable from "no card on file" — the exact pattern `docs/UI-RULES.md` ("an HTTP error is never an empty state") and blob-image's rewrite call out.

### D6. Env documentation gaps (beyond R8)
Full `process.env` sweep vs `.env.example`: prod-relevant undocumented names are `APP_URL` (`auth.ts:19`, secondary fallback for outbound link base) and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (R8). `E2E_BYPASS_TOKEN` (`auth.ts:236`) is undocumented but correctly triple-gated (`isTestingMode()` — refuses `VERCEL_ENV=production` AND refuses prod DATABASE_URL — plus localhost-only); document it in the test README rather than .env.example. Everything else undocumented is test/script-only or platform-injected (`VERCEL_ENV`, `NEXT_RUNTIME`, `NEXT_PHASE`, `CI`).

### D7. 19 inline `new Stripe(...)` constructions, no shared factory
apiVersion is consistent today, but the pin lives in 19 files (list in evidence sweep) — one missed file on the next API-version bump reintroduces the exact payload-shape bug family (P0-1/P1-5b) this codebase has already paid for twice. A `lib/stripe/client.ts` factory would make drift structurally impossible.

### D8. `monthly-reports` cron failures never reach Sentry
`app/api/cron/monthly-reports/route.ts:56-99`: per-tenant failures accumulate into the JSON response and console only; reconcile (`lib/stripe/reconcile.ts:123`) sets the precedent of `Sentry.captureMessage` for cron-detected problems. A month of failed AI reports for a tenant is visible only if someone reads Vercel cron logs.

---

## Silent failures (fail with no signal to anyone)

1. **Push delivery (B1)** — zero rows, zero logs, zero errors. The single most silent failure in the audit.
2. **Shop pay-at-desk downgrade (R8)** — env absence flips a revenue feature off with no signal.
3. **Webhook-queued emails** — `sendEmail(email).catch(() => {})` (`webhook/route.ts:1080`); combined with R4, production dispute/payment-failure notifications can be failing wholesale with the only evidence in unwatched EmailLog rows.
4. **Invoice-id resolver failure (R1)** — `console.error` only, then quietly writes null Stripe ids AND (via the inert guard) a potential duplicate revenue row.
5. **Upload inline fallback** — `app/api/upload/route.ts:243-249`: Blob outage/missing token silently stores base64 data-URLs in the DB (`console.warn` only; audit-log metadata records `storage:"inline"` if anyone looks). Uploads "work" while storage is down; rows bloat.
6. **`delete-orphan` returns 200 on delete failure** (`delete-orphan/route.ts:88-91`) — by design, but orphans then accumulate with no sweep (Blob has no GC; retention only deletes *referenced* URLs it knows about).
7. **Third cron on a Hobby plan** — if the account is still Hobby (as two code comments assert), `vercel.json`'s third entry (`class-instances`, daily 02:40) either blocks deploys or is not scheduled; if it's silently unscheduled, class instances stop materialising with no error anywhere in the repo. Needs a dashboard check.
8. **`stripe-reconcile` standalone route** — NOT scheduled in vercel.json, and that is **by design**: `runStripeReconciliation()` runs daily as step 1 of the retention cron (`retention/route.ts:160`); the standalone route is manual-only (`reconcile.ts:17-19`). Not a finding — recorded here so nobody "fixes" it into a fourth cron entry without checking the plan limit.

## What I could not verify statically

- **Vercel plan / cron reality**: whether all 3 vercel.json crons are actually scheduled (Hobby caps at 2, per the code's own comments), and whether CRON_SECRET is set in the deployment (unset ⇒ every cron 503s forever — guarded loudly, but only in cron logs).
- **Vercel Blob API behaviour for private stores**: whether the API's `downloadUrl` is signed (B2's remaining uncertainty). `blob-image`'s empirical account and the SDK source both say no; a 2-minute runtime probe (`head()` a private blob, curl the downloadUrl) settles it.
- **Stripe dashboard webhook subscription list**: the code handles 16 event types; whether the endpoint in the Stripe dashboard is subscribed to all 16 (esp. `charge.dispute.closed`, `mandate.updated`, `account.updated`) is dashboard-side config.
- **Resend dashboard**: webhook endpoint + secret actually configured (route 503s in prod if secret unset — visible only to Resend's retry logs).
- **Migrations vs live DB drift**: needs `prisma migrate diff` against a shadow DB or `prisma db pull --print`; only the hand-authored announcement-expiry migration could be (and was) verified against schema.prisma statically.
- **Connected accounts' enabled Checkout payment methods** (determines whether R2 is latent or live today).
- **Whether an account with `stripeConnected=false` + non-null `stripeAccountId` exists in prod data** (determines R6 exposure).
