# MatFlow — Memory & Storage System Audit

**Date:** 2026-08-16 · **Method:** 6 evidence lanes (4 parallel code workers + live read-only prod DB probes + orchestrator integrity lane), synthesised against the 2026-08-15 hosting deep-dive · **Lenses:** scalability, longevity, legal (UK GDPR), accuracy, speed, security, stability · **Scope:** Neon Postgres (43 models), Vercel Blob, in-process server state, client localStorage, retention/DSAR, backups, storage-specific query performance. Read-only — no fixes applied.

Prod probes ran in transactions confirmed `transaction_read_only = on` with a 15s statement timeout, aggregate-only (no content columns selected). Full SQL + output in the appendix.

---

## 1. Executive summary (plain English)

**Can I lose members' data?** Partially, yes. The database has one working backup layer — Neon point-in-time recovery — and its window depends on your Neon plan (7 days on Free). The second layer, a weekly dump to S3, **has failed every Sunday since at least 12 July** because its four GitHub secrets were never configured (confirmed via `gh run list`). Worse: **files in Vercel Blob — signed waiver signatures, member photos — have no backup at all.** If the blob store is lost or a file is deleted, the waiver evidence for an injury claim is gone permanently. The restore runbook itself is good.

**Am I breaking UK GDPR today?** Yes, in specific, fixable ways. *Article 15 (access):* the export is incomplete — it omits photos, login/device history, push subscriptions and staff notes about the member, and silently truncates email/audit history at 1,000 rows with no marker. *Article 17 (erasure):* the erase route scrubs only the Member row — the member's staff notes, TOTP secret, Stripe IDs, face photos (children's included), signature images, and email address in the email log all survive a "completed" erasure. And one route uploads **entire member CSVs (names, emails, phones, DOBs) as publicly fetchable blobs that are never deleted**. Your published privacy policy promises 12-month audit-log retention, 6-year waiver retention and 35-day backup purges — none of which any code enforces.

**When does the database start hurting?** Not from data volume — prod is 12 MB with 3 tenants / 14 members; even 25 clubs generates only tens of MB a year. It hurts from specific queries that scan whole histories: the staff check-in screen answers "who's checked into this class?" without an index for it, so its cost grows with every check-in ever recorded (~15k rows/club/year → noticeably slow within the first year of real multi-club use). And if the production `DATABASE_URL` is the non-pooler host, roughly **10–11 concurrent serverless instances exhaust Neon's ~112 direct connections** — a kiosk rush plus dashboard traffic could hit that from club #2–3 onward. The app's pool-safety warning checks a parameter the driver ignores, so it can't catch this.

**Can one gym see another gym's stored data or files?** Database rows: no — tenant filtering held up everywhere sampled (RLS backstop still bypassed, known, tracked elsewhere). Files: **yes, given the URL** — the blob-image proxy authenticates the user but never checks the blob belongs to their tenant, so any logged-in member of any gym can mint fresh signed URLs for another gym's photos. URLs are 128-bit random (not guessable), but they persist in audit logs, API responses and browser history. The fix is ~5 lines that already exist in a sibling route.

**Top 5 fixes, in order:**

| # | Fix | Effort | What it buys |
|---|---|---|---|
| 1 | Flip `csv-handoff` upload to private + delete after white-glove import; fix the broken orphan-cleanup URL regex | ~2 h | Retires the public-PII P0 and un-breaks blob cleanup |
| 2 | Hard delete must **retain** SignedWaiver (SET NULL, like Payment) and cancel Stripe first | ~half day | Stops waiver destruction (liability P0) and ghost billing of deleted members |
| 3 | Complete the erase route: scrub notes/TOTP/Stripe IDs, delete photos + signature blobs, redact EmailLog recipient, delete tokens/push subs | 1–2 days | Makes Article 17 fulfilment real |
| 4 | One nightly retention cron: AuditLog + EmailLog 12 months, expired tokens, abandoned ImportJobs + blobs, tenant hard-delete after the promised 30 days | ~1 day | Makes the published retention policy true; kills 6 findings at once |
| 5 | Configure the 4 backup secrets (S3 dump goes green); add 2 indexes (`AttendanceRecord.classInstanceId`, `Payment.stripeChargeId`); add the tenant check to blob-image | ~half day | Second backup layer + the two fastest-degrading hot paths + cross-tenant file read |

Total: roughly **4–5 working days** to clear every P0 and most P1s. None of it is architectural.

---

## 2. Lens scorecard

| Lens | Verdict | One line |
|---|---|---|
| Legal | 🔴 RED | Public member CSVs, destructible waivers, Member-row-only erasure, and a published retention policy nothing enforces. |
| Security | 🔴 RED | The public-CSV P0 plus known cross-tenant blob proxy read and decorative RLS; row-level tenant isolation itself held up. |
| Longevity | 🟠 AMBER | Only 2 of ~14 growing tables ever pruned; blobs orphan forever with no GC; S3 backup dead — but PITR works and volumes are tiny. |
| Scalability | 🟠 AMBER | Storage volume is a non-problem for years; missing hot-path indexes and the connection-pool maths bite within ~12 months of multi-club use. |
| Speed | 🟠 AMBER | Fine today at 12 MB; check-in screens, coach register and all-time report aggregates degrade linearly with history (zero caching, known). |
| Stability | 🟠 AMBER | Excellent webhook idempotency and restore runbook; undermined by dead S3 backups, pool-exhaustion risk and DSAR memory spikes. |
| Accuracy | 🟠 AMBER | Integer-pence money and idempotent crons are right; silent truncations, a credit-leaking check-in undo, and policy-vs-code lies are not. |

---

## 3. Findings by severity

Confirmed = file:line or probe evidence in hand. [KNOWN] = already tracked in `.omc/specs/deep-dive-ui-rules-and-hosting.md` — listed for completeness, excluded from new-findings counts. **New findings: 4 P0 · 12 P1 · 11 P2 · 10 P3.**

### P0 — active legal exposure or data-loss path exercisable today

**P0-1 · Public member-roster CSVs, never deleted** *(legal, security · Confirmed)*
`app/api/onboarding/csv-handoff/route.ts:70-74` uploads the full member CSV (names, emails, phones, DOBs) with `access: "public"` — the one upload missed by the efebb33 "all blobs private" sweep — and emails the raw URL in cleartext (`:113`). White-glove jobs never pass the commit-route cleanup, so the public blob persists forever. Only 128-bit path entropy protects it; one forwarded email = permanent public PII.

**P0-2 · Hard delete destroys signed waivers — the gym's liability defence** *(legal, longevity · Confirmed)*
`lib/member-delete.ts:113` does `signedWaiver.deleteMany`, reachable from the staff DELETE endpoint **and parent self-serve child deletion** (`app/api/member/children/[id]/route.ts:235`). The privacy policy promises 6-year post-departure waiver retention (`app/legal/privacy/page.tsx:73`); `docs/spec.md:269` requires it. A parent can delete their kid's profile before an injury claim and the club has no waiver. Payments got SET NULL treatment; waivers got the opposite.

**P0-3 · Article 17 erasure is Member-row-only; substantial PII survives every "completed" erase** *(legal · Confirmed)*
`app/api/admin/dsar/erase/route.ts:158-177` scrubs 9 Member columns and nothing else. Surviving an erasure: `Member.notes` (free-text staff notes — injuries, disputes), `waiverIpAddress`, `stripeCustomerId`/`SubscriptionId` (still resolve to full identity in Stripe), a **live TOTP secret**, all face photos (rows + blob files, children included), signature PNGs, `EmailLog.recipient` forever, LoginEvent device history, live PushSubscription channels, magic-link/reset tokens keyed to the email, Task notes about the member — and `AuditLog.metadata.memberEmail`, written in cleartext **by the DSAR export route itself** (`export/route.ts:332`). A member who erases and then SARs again receives proof of non-erasure. Full residue table in §5.

**P0-4 · The published retention policy is fiction** *(legal, accuracy · Confirmed)*
The only retention code in the entire platform is the RateLimitHit 1-hour prune (`lib/rate-limit.ts:31-34`) and a PasswordHistory cap. Zero `deleteMany` exists for EmailLog, AuditLog, LoginEvent, Notification, MagicLinkToken, PasswordResetToken or ImportJob; the only cron is monthly-reports (`vercel.json:3-8`). Meanwhile `app/legal/privacy/page.tsx:70-77` publicly promises audit logs 12 months, waivers 6 years, backup purges within 35 days. Publishing a retention schedule you do not operate is itself an ICO finding on first complaint. Probe confirmation: every MagicLinkToken in prod is expired-but-retained.

### P1 — breaks, breaches or materially misleads within ~12 months

**P1-1 · Weekly S3 backup failing since ≥12 July; blobs have no backup at all** *(longevity, stability · Confirmed)*
`.github/workflows/db-backup.yml` schedules Sundays 03:00 UTC but its required secrets were never set — `gh run list` shows failures on 12/19/26 Jul, 2/9 Aug (~13–19 s each). Sole DB backup is Neon PITR (window plan-dependent — verify plan). Vercel Blob (waiver signatures, photos, import CSVs) has **no backup story anywhere**. The runbook also misdescribes the workflow as "disabled by default" — drift.

**P1-2 · Connection-pool guard checks a signal the driver ignores** *(stability, scalability · Confirmed)*
`lib/prisma.ts:29-39` warns on missing `pgbouncer=true` — but under `@prisma/adapter-pg` that URL param is inert; what matters is the `-pooler` hostname and pg `Pool` `max` (default 10, never set). Repo `.env` points at the **non-pooler** host [KNOWN]; if prod does too, ~10–11 concurrent instances exhaust Neon's ~112 direct connections and routes time out at 60 s under burst. The warning both false-passes and false-alarms. Fix: set a small pool `max`, gate the warning on hostname, confirm the Vercel env URL (Phase-0 probe from the hosting spec, still outstanding).

**P1-3 · Check-in screens have no index for their hottest question** *(speed, scalability · Confirmed)*
No index on `AttendanceRecord.classInstanceId`. Five call sites — three HOT (`app/dashboard/checkin/page.tsx:85`, `app/api/checkin/members/route.ts:42`, coach register `:47`, plus staff-home `_count` at `dashboard/page.tsx:71`) — answer "who is checked into this class?" by scanning the tenant's entire attendance history via the `(tenantId, checkInTime)` prefix. Cost is O(all check-ins ever) for a ~20-row answer; fastest-degrading hot path in the app.

**P1-4 · Coach register fetches every member's full attendance history per open** *(speed · Confirmed)*
`app/api/coach/instances/[id]/register/route.ts:61-66`: `distinct: ["memberId"]` with no `take` — Prisma (no `nativeDistinct` flag) applies distinct in-process after fetching each booked member's entire history. 30 members × 2 years ≈ 9k rows per register open, growing forever.

**P1-5 · `Payment.stripeChargeId` unindexed → full-table scan per refund/dispute webhook** *(scalability · Confirmed)*
`app/api/stripe/webhook/route.ts:437,602` look up by `stripeChargeId`, which has no index — a cross-tenant sequential scan of Payment inside the webhook window, every `charge.refunded`/dispute event.

**P1-6 · "Deleted" tenants are never deleted, against an explicit UI promise** *(legal, longevity · Confirmed)*
`app/api/admin/customers/[id]/soft-delete/route.ts:6` admits hard-delete is "a future cron"; no such cron exists — yet `app/admin/tenants/[id]/DangerZone.tsx:70,226` tells the operator "reversible for 30 days, then a cron hard-deletes", and the audit row even stamps `hardDeleteAfter`. A closed gym's entire member PII set is retained indefinitely against a 30-day representation.

**P1-7 · Article 15 export incomplete and silently truncated** *(legal, accuracy · Confirmed)*
Missing entirely from `dsar/export`: MemberPhoto, LoginEvent (IP/device history), PushSubscription, Notification, ClassWaitlist/Roster, Task member-notes, token metadata — while its header claims "every PII row MatFlow holds". EmailLog/AuditLog are capped `take: 1000` with no truncation marker (`export:261,279`): a 3-year member's SAR under-reports as if complete.

**P1-8 · Hard DELETE doesn't cancel Stripe → deleted members keep being charged** *(legal, accuracy · Confirmed)*
Fail-closed Stripe cancellation exists on the PATCH-to-cancelled and DSAR-erase paths, but the DELETE handler (`app/api/members/[id]/route.ts:402-516`) goes straight to the cascade; subsequent Payments land with `memberId = null`.

**P1-9 · Cross-tenant blob read via proxy — still present post-efebb33** *(security, legal · Confirmed · [KNOWN])*
`app/api/blob-image/route.ts:17-37` checks session + host allowlist but never tenant ownership; any authenticated user of any tenant can mint ~1-hour signed URLs for another tenant's private blobs given the URL. The exact pathname-prefix check already exists in `upload/delete-orphan/route.ts:65-73`. Re-verified this audit because efebb33 touched the area — unchanged.

**P1-10 · Orphan-blob cleanup silently broken since the private-blobs migration** *(longevity, stability · Confirmed)*
`upload/delete-orphan/route.ts:32` requires a `.public.blob.vercel-storage.com` host shape; since efebb33 all uploads are private (no `.public.` label), so its only caller (`AvatarUploader.tsx:98`) gets a swallowed 400 every time. The same stale `.public.` filter skips blob deletion in the rank-photo replacement path (`members/[id]/rank/route.ts:175`).

**P1-11 · No re-erasure after restore; backup retention contradicts policy** *(legal · Confirmed)*
`docs/runbooks/db-restore.md` pre-flight covers Stripe/email/rate-limits but never replaying DSAR erasures between recovery point and now (ICO expects this documented); policy's "backups purged within 35 days" conflicts with PITR windows up to 365 days.

**P1-12 · Reports page re-aggregates all-time history on every visit** *(speed · Confirmed · [KNOWN family])*
`lib/reports.ts:179` (groupBy checkInMethod, all-time), `:204` (groupBy classInstanceId, all-time — `take:200` applies *after* aggregating every row), `:229` (all-time count). With zero caching [KNOWN], every reports visit pays the full-history price.

### P2 — degradation or cost creep with workarounds

- **P2-1** *(stability, accuracy)* Check-in undo leaks a paid class-pack credit: both undo paths delete the AttendanceRecord without deleting the `ClassPackRedemption` (bare `String @unique`, no FK — `schema:800`) or re-incrementing `creditsRemaining`. Staff correcting a kiosk mistake permanently costs the member a credit. (`app/api/checkin/route.ts:189`, coach attendance `:52`)
- **P2-2** *(legal, scalability)* Expired auth tokens accumulate forever with email+IP+UA; `MagicLinkToken` even ships a purpose-built `@@index([expiresAt])` (`schema:577`) nothing uses. Probe: 6/6 prod tokens expired-and-retained.
- **P2-3** *(legal, scalability · [KNOWN, sharpened])* AuditLog: 115 call sites, full IP + UA + free-form metadata, no delete path — GDPR storage-limitation exposure, not just cost.
- **P2-4** *(scalability)* EmailLog: runtime only ever reads a 30-day window (`lib/email.ts:317-329`); everything older is dead weight retained forever.
- **P2-5** *(longevity, legal)* Systematic blob orphaning with no GC: initiative/attachment deletes are DB-only, branding logo re-uploads abandon old blobs, member deletion strands photo + signature files (no `@vercel/blob` import in `member-delete.ts`), abandoned ImportJobs keep PII CSVs. Vercel Blob never garbage-collects.
- **P2-6** *(security, stability)* `localStorage["gym-settings"]` un-namespaced: cross-tenant branding + business-contact bleed on shared devices; 6 of 7 read sites skip the slug guard `login/page.tsx:69-71` already implements; never cleared on logout. (Kiosk routes themselves use zero localStorage — clean.)
- **P2-7** *(speed)* `lib/promotion-candidates.ts:108` window = earliest rank date across all candidates → effectively all-time; own comment concedes ~70k rows/2MB per dashboard render at 200 members.
- **P2-8** *(speed)* Analysis page ships up to 60k timestamp rows to Node to bucket into 6 monthly numbers (`dashboard/analysis/page.tsx:41-49`); revenue summary similarly sums rows in JS instead of `_sum` (`api/revenue/summary/route.ts:36-46`).
- **P2-9** *(stability · [KNOWN])* DSAR export builds uncapped attendance/payments/orders/waivers + full waiver `contentSnapshot`s into one in-memory JSON — serverless memory spike grows with member tenure.
- **P2-10** *(legal, accuracy)* Export hands over raw signature-blob URLs/base64 (`export:180`) while its own `_meta` claims proxy URLs; legacy public blobs make that a live auth-free signature image inside the SAR file.
- **P2-11** *(speed)* Staff check-in page SSR loads the full active-member roster with no cap (`dashboard/checkin/page.tsx:59`) — its own API twin is paginated; members-list SSR caps at 500 without true pagination.

### P3 — hygiene

- **P3-1** PlatformConfig "audit-log retention days" is a phantom knob — zero application-code references; comment-only feature (`schema:1018-1025`).
- **P3-2** Notification is a dead table: zero writers, zero readers (tests assert it's never called); drop or wire it.
- **P3-3** StripeEvent grows one row per webhook forever; no `processedAt` index for a future prune; Stripe's replay window is ~30 days.
- **P3-4** RateLimitHit prune can't use its own bucket-leading index (seq-scans on each 5% lottery); bucket keys embed raw IPs (~1 h lifetime, defensible).
- **P3-5** Month/period boundaries computed in server-local time (UTC on Vercel) — a 00:30 BST check-in on the 1st lands in the previous month (`cron/monthly-reports/route.ts:38-39`).
- **P3-6** `hashSnippet` 32-bit email hash in erase audit metadata is brute-forceable — use the HMAC pattern from `lib/token-hash.ts`.
- **P3-7** GymApplication prospect PII (incl. IP/UA) has no deletion path; staff (User) accounts have no DSAR path at all (MatFlow is controller for staff).
- **P3-8** Payments CSV export silently truncates at 5,000 rows; stats-drift checker (`scripts/check-stats-accuracy.ts`) exists but is manual-only.
- **P3-9** Rate-limit fallback Map: no eviction [KNOWN LOW]; per-instance fallback multiplies limits during DB outage on fail-open buckets (security-critical buckets correctly fail closed).
- **P3-10** ImportJob `errorLog`/`dryRunSummary` JSON plausibly embeds row-level member data (Suspected); rows never deleted.

### What's genuinely good (confirmed, keep doing it)

Integer-pence money everywhere (zero Decimal/Float). Stripe webhook idempotency done properly (claim → P2002 → rollback-on-early-exit → side-effects after commit). Monthly-report cron idempotent via unique constraint. Migrations linear and in sync with prod (66 = 66). LoginEvent is the model citizen: bounded upsert-per-device, deliberately coarsened IPs, cascades on delete. Duplicate check-in detection is optimal (unique constraint + P2002, no read). Blob paths are tenant-prefixed with ≥128-bit entropy. `refreshLocks` self-cleans; Prisma singleton correct; no other module-level mutable state. Kiosk uses zero localStorage; the service worker caches nothing. Restore runbook is founder-executable with correct anti-patterns.

---

## 4. Data lifecycle matrix (condensed — full version in Lane A working file)

| Table | Growth model | Deleter | Retention |
|---|---|---|---|
| AttendanceRecord | ~15k rows/club/yr | user-undo + member-delete | none (arguably correct — business data) |
| AuditLog | tens of k/club/yr, full IP+UA | **none** | none (policy says 12 m) |
| EmailLog | 1/send, recipient+subject | **none** | none (only 30-day window ever read) |
| MagicLinkToken / PasswordResetToken | 1/invite/login-link/reset | **none** (only `used:true`) | none; expiry index unused |
| StripeEvent | 1/webhook | failure-compensation only | none |
| ClassInstance | ~1k/club/yr; generation idempotent, ≤52 wks ahead | **none** (cancel = flag) | none; no tenantId [KNOWN] |
| Payment / Order | ledger | none (correct — HMRC 6 y) | correct by accident (SET NULL) |
| Notification | **zero — dead table** | — | — |
| LoginEvent | bounded (subject × device) | member-delete cascade | self-limiting ✅ |
| RateLimitHit | self-pruned 1 h ✅ | probabilistic 5% | the only real retention in the app |
| ImportJob | 1/import + PII blob | blob on commit only | abandoned jobs keep CSVs forever |
| MonthlyReport | 1–2/tenant/month | none | fine |

## 5. Article 17 erase-gap (what survives a "completed" erasure)

Member.notes · waiverIpAddress · stripeCustomerId/SubscriptionId · **live totpSecret + recovery codes** · MemberPhoto rows **and** blob files (child photos included) · SignedWaiver signer name/IP/UA/signature PNG/content snapshot · EmailLog.recipient + named subjects · LoginEvent device history · PushSubscription live channels · MagicLink/PasswordReset tokens (email+IP+UA) · Notification bodies · AuditLog IP/UA/metadata **including `memberEmail` written by the export route** · Task member-note bodies · originating ImportJob CSV blob · full pre-erase copy in every backup within the PITR window (no re-erase procedure).

## 6. Growth projections (from live probe, 2026-08-16)

Prod baseline: 12 MB database, 3 tenants, 14 members, 6 users. AttendanceRecord 1,015 rows over 98 active days ≈ 10.4/day for one demo club. Extrapolated: 25 active clubs ≈ **91k attendance rows/year ≈ low tens of MB/year** — Postgres volume is a non-problem for years. The scaling constraints are (a) per-query history scans (P1-3/4/12) and (b) the connection cost-model [KNOWN — hosting deep-dive], not storage. `pg_stat_statements` is not installed, so per-query timings need a load probe on a Neon branch (hosting spec Phase 3) — that remains the decisive multi-club evidence.

Index-usage stats at this scale are noise (planner correctly seq-scans tiny tables; AttendanceRecord already prefers its indexes 20,165:751). Re-check `idx_scan = 0` candidates only after real load.

## 7. Explicitly not audited here

Hosting/latency architecture, transaction round-trip cost-model, kiosk RT counts, zero-caching remediation → `.omc/specs/deep-dive-ui-rules-and-hosting.md` (2026-08-15, Phase 2 plan). RLS BYPASSRLS (re-confirmed live: `neondb_owner rolbypassrls = true`) → same spec, item 2.1. Product/market → `deep-dive-matflow-sellable-product.md`. UI → `docs/UI-RULES.md` work, Phase 1 shipped.

## 8. Appendix — probe evidence (key outputs)

Both probe transactions echoed `transaction_read_only = on`, `statement_timeout = 15s`. Aggregate-only SQL; no content columns selected. Scripts + full raw output preserved in the session scratchpad (`probe.mjs`, `probe2.mjs`, `probe-output.md`).

```
current_user = neondb_owner · rolbypassrls = TRUE · db_size = 12 MB
tenants = 3 · members = 14 · users = 6
AttendanceRecord: 1,015 rows (2026-03-04 → 2026-06-10) · AuditLog: 61 · EmailLog: 10
expired MagicLinkTokens: 6 of 6 · expired PasswordResetTokens: 1 of 1
RateLimitHit rows older than 1 h: 6 of 6 (prune only fires on new traffic)
pg_stat_statements: not installed · autovacuum: healthy · dead tuples: trivial
ClassInstance window: 2026-02-23 → 2026-06-10 (bounded generation confirmed)
gh run list db-backup.yml: failure 12 Jul, 19 Jul, 26 Jul, 2 Aug, 9 Aug (schedule)
```

Queries run: read-only confirmation · role/RLS check · db/table/index sizes (top 30) · exact counts + min/max timestamps for the 14 growth tables · `pg_stat_user_indexes` (idx_scan=0) · `pg_stat_user_tables` (seq/idx scans, dead tuples, autovacuum) · pg_stat_statements availability · expired-token and stale-rate-limit counts · tenant/member/user counts.
