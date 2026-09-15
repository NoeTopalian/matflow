# MatFlow — UI Rules & Multi-Club Hosting: Assessment + Plan

**Date:** 2026-08-15 · **Method:** /deep-dive (5 read-only trace lanes + surface map + git archaeology; autonomous — no interview round, decisions made and marked) · **Trace:** `.omc/specs/deep-dive-trace-ui-rules-and-hosting.md` · **UI rules draft:** `.omc/specs/UI-RULES-draft.md`

## Context

Noe asked for a thorough UI assessment feeding an "ultimate UI rules file", plus an assessment of hosting fitness for multiple clubs including efficiency, memory and security. Run on auto; deliverable = this plan. Builds on the 2026-08-14 sellable-product deep-dive (concierge bar: one hand-held gym; TotalBJJ first).

## Verdicts (evidence in the trace file)

1. **UI:** governance failure, not design failure. A real design system exists on paper (`docs/design.md`, 48KB; genuine token layer) but was never wired in: CLAUDE.md never points to it, the only shadcn primitive has **0 importers vs 459 raw `<button>`s**, no Card/Dialog/Table/Input/Form primitive exists, and a deliberate-but-unfinished Jun-2026 dark→light migration left live white-on-white bugs. Where exactly one mechanism exists (lucide icons, Toast) the app is near-perfectly consistent — so rules + primitives + enforcement will work here.
2. **UX at the concierge bar:** Home, Schedule and Kiosk are sale-ready; **`/member/profile` is not** — it fabricates a member's belt history, medals, coach and syllabus, and flashes "Alex Johnson"/"Total BJJ" on every tenant. The PWA has never worked (manifest icons don't exist on disk; Serwist not installed despite CLAUDE.md's claim). HTTP errors render as empty states. Zoom is disabled app-wide.
3. **Hosting:** platform right (Vercel lhr1 + Neon eu-west-2 colocated; excellent composite tenant indexes; durable DB rate limiter), **code cost-model wrong beyond ~5 clubs**: every read is a 4-round-trip interactive transaction (296 sites), kiosk check-in ≈25–30 round-trips, zero server-side caching, sequential 300s-capped cron and bulk-invite, invocation-per-avatar image proxy, 5–6-call member-home waterfall. Pool contention (P2028) already appeared at ~1 club and was papered over by raising timeouts. All fixable in code; no platform migration.
4. **Security:** adequate for 25 clubs conditionally — disciplined tenant filters (no IDOR found in 20+ route sample), strong token/session hygiene. Conditions: prod DB role has **BYPASSRLS** (RLS is decorative — and the app still pays the set_config transaction tax for it: worst of both worlds), `unsafe-inline` CSP, admin v1 shared-secret cookie, blob-image proxy lacks a tenant check.
5. **Memory:** appropriate. Singleton Prisma, bounded queries, self-pruning module state. Two LOWs: fallback rate-limit Map lacks a size cap; DSAR export builds uncapped JSON in memory.

## Decisions taken (auto mode — veto any)

- **D1** Staff dashboard is **light**; member portal/kiosk **dark tenant-branded**; landing keeps its own look. The dark→light migration gets finished, not reverted.
- **D2** New `docs/UI-RULES.md` (short, enforced) supersedes `docs/design.md` for rules; design.md kept as banner-marked reference. Draft ready at `.omc/specs/UI-RULES-draft.md`.
- **D3** Primitive layer is built (shadcn-generated, token-restyled) with a **boy-scout ratchet** migration, not a big-bang rewrite.
- **D4** RLS becomes real (restricted role) rather than removing the wrapper — and hot paths get batched so the tax shrinks too.
- **D5** PWA: ship icons + minimal SW for installability; push delivery stays deferred; CLAUDE.md claim corrected now.

## Phase 0 — User probes, no code (~20 min, from Bali)

| # | Action | Decides |
|---|---|---|
| 0.1 | Vercel dashboard → prod `DATABASE_URL`: must be `-pooler` host + `pgbouncer=true&connection_limit=1`; check whether **Fluid Compute** is on | The single biggest multi-club unknown; one-line fix if wrong (repo `.env` currently shows the non-pooler host) |
| 0.2 | Run read-only: `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user;` on prod | Confirms RLS decorative → gates 2.1 |
| 0.3 | `curl -I https://<prod>/icons/icon-192.png` (expect 404); DevTools → Application → Manifest + Service Workers; Lighthouse PWA+a11y baseline | Confirms PWA fiction; scored baseline for later |
| 0.4 | As a real member open `/member/profile` | Confirms the fabricated-data P0 with own eyes |

## Phase 1 — UI foundations + P0 honesty fixes (~4–6 days; blocks any demo)

| # | Change | Size | Key files |
|---|---|---|---|
| 1.1 | **Adopt UI-RULES:** promote draft to `docs/UI-RULES.md`; add UI section to `CLAUDE.md` (also fix its false "PWA via Serwist" line); banner on `docs/design.md`; add `scripts/check-ui-rules.mjs` ratchet to lint | S | draft ready |
| 1.2 | **P0 — strip fabricated data from member profile:** delete `MILESTONES`, `BEGINNER_CARD`, `DEMO_MEMBER`, "Alex Johnson"/"Total BJJ" seeds → `null` + skeletons; remove undeliverable "Class reminders" toggle | S | `app/member/profile/page.tsx:14-62,147-171,654`, `app/member/layout.tsx:48-55` |
| 1.3 | **P0 — finish the light migration (bug sweep):** delete `darkTheme` block (dashboard/layout.tsx:38-53), fix mobile header + `MobileNav` to light tokens, fix Toast `text-white`/hex → tokens, fix member `loading.tsx` polarity, fix globals.css white-alpha scrollbars/`.skeleton`/`.glass`, fix self-referential `--font-sans`, sweep the 20 `bg-white/5`-on-light files | M | per Lane 1 defect list |
| 1.4 | **P0 — error ≠ empty:** replace the 12 `r.ok ? r.json() : null` sites with error states; add `error.tsx` to dashboard + member segments; kill raw `error.message` passthrough; fix stale-classes-on-empty-refetch (`member/home:1125`) | M | member pages, `FamilySection`, dashboard pages with `catch {}` |
| 1.5 | **P0 — re-enable zoom** (drop `maximumScale`/`userScalable`, keep `viewportFit`) | XS | `app/layout.tsx:33-39` |
| 1.6 | **Build primitives v1:** Button, Input/Label/Select, Dialog/Sheet (+focus trap/Escape/scroll lock), ConfirmDialog, Skeleton, EmptyState/ErrorState, fixed StatusPill; extend Toast to member portal; adopt on the screens Phase 1 already touches | L | `components/ui/*` |
| 1.7 | **Shared helpers:** `lib/date.ts`; consolidate `FONT_IMPORTS` → `lib/fonts.ts`; migrate `hex()` copies opportunistically | S | — |
| 1.8 | **PWA minimum truth:** generate `public/icons/icon-192/512.png` (+`purpose:"any"`), register a minimal SW, align manifest `theme_color`; remove the 5 prototype HTML files from `public/` | S | `app/manifest.ts`, `app/layout.tsx`, `public/` |
| 1.9 | Route-manifest shared by Sidebar/MobileNav; kiosk search input gets a label | S | `components/layout/*`, `KioskPage.tsx:399` |

## Phase 2 — Hosting + security for multi-club (~4–6 days; before club #2, ideally before TotalBJJ go-live)

| # | Change | Size | Key files / evidence |
|---|---|---|---|
| 2.1 | **Restricted DB role in prod** (NOBYPASSRLS; script exists — extend `scripts/create-restricted-role.ts` beyond test branch), plus fix repo `.env` pooler URL per probe 0.1 | S code + config | Lane 5 #1 |
| 2.2 | **Batch the kiosk check-in path** into ONE `withTenantContext` transaction (gates are sequential awaits today: 7–9 transactions, ~25–30 round-trips) | M | `lib/checkin.ts:58-225`, kiosk route |
| 2.3 | **Introduce caching where data is monthly-static:** per-tenant branding/settings/timetable via `unstable_cache`/s-maxage + explicit invalidation on settings write; keep auth surfaces no-store | M | Lane 4 A3; pattern exists at `api/tenant/[slug]:88` |
| 2.4 | **Consolidate member-home waterfall** into one `/api/member/home` payload (5–6 invocations → 1); mirrors the dashboard's own server-side rationale | M | `app/member/home/page.tsx:1102-1171` |
| 2.5 | **Blob-image read path:** cache signed URLs per session / emit derived public thumbnails for avatars; add tenant-ownership check while there (Lane 5 LOW #5) | M | `app/api/blob-image/route.ts`, `lib/blob-url.ts` |
| 2.6 | **Cron fan-out:** chunk monthly-reports with a resume cursor (idempotency unique already exists); alert on partial completion | S | `app/api/cron/monthly-reports/route.ts:57-97` |
| 2.7 | **Bulk-invite resumability:** skip already-invited on re-run, batch sends, cursor for partial completion (fixes 300s-timeout poison state) | S | `app/api/members/bulk-invite/route.ts:78-114` |
| 2.8 | Module-level Stripe client (Resend already does this); add `take` to unbounded hot reads (`checkin` roster, `timetable`, `reports.ts:262`); pagination for members page past 500 | S | Lane 4 A9/A12 |
| 2.9 | **Tenant observability:** tag Sentry scope with `tenantId`; Prisma slow-query log (>500ms warn) | S | `instrumentation.ts`, `lib/prisma.ts` |
| 2.10 | Security follow-ups: `dangerouslySetInnerHTML` XSS sweep (member layout style injection → CSS vars per UI-RULES), retire admin v1 cookie path once operator sessions proven, size-cap the rate-limit fallback Map, `take` caps on DSAR export | S each | Lane 5 |

## Phase 3 — Fast-follow (post first paying club)

CSP nonces (drop `unsafe-inline`) · `ClassInstance.tenantId` + composite index and `ClassSchedule` indexes (the one index whose cost grows with club count) · forms migration to RHF+zod as screens get touched · `DataTable` + card-collapse for staff tables on mobile · boy-scout primitive migration ratchet continues · load probe: concurrency ramp on kiosk check-in against a Neon branch measuring `set_config`:business-query ratio and P2028 knee (Lane 4's probe, decisive for the 25-club claim) · Anthropic per-tenant quota enforcement (`costPence` recorded but never enforced) · EmailLog/AuditLog retention · admin console responsiveness (explicitly deprioritised — desktop-only is fine).

## What NOT to do (avoidance guard)

No redesign, no rebrand, no new stack, no Storybook, no platform migration. The member-facing product mostly looks fine; the work above is scaffolding + honesty + cost-model, sized in days. The scored item remains: one paying gym. This plan serves that — Phase 1 makes the demo safe, Phase 2 makes club #2+ safe. Everything else waits.

## Verification

- Gate every PR: `npm run lint && npm test && npm run build`; ratchet script counts must not rise.
- Phase 1: Playwright chromium pass on a seeded Neon test branch (never local `.env` prod URL): member profile shows real data only (assert "Alex Johnson"/"Total BJJ"/"Coach Mike" appear nowhere); blocked `/api/member/*` renders ErrorState with retry, not empty; Toast readable on light dashboard (screenshot); pinch-zoom works on device; Lighthouse installability passes post-1.8.
- Phase 2: `pg_roles` shows `rolbypassrls = false` for the app role, and a cross-tenant read without `set_config` fails on the test branch; kiosk check-in ≤2 transactions (count via `pg_stat_statements` on a branch); member home = 1 API call in the network tab; second bulk-invite run sends 0 duplicate emails; Sentry events carry `tenantId`.
- The Lane 4 load probe (Phase 3) is the definitive 25-club evidence — run before signing club #5.

## Execution route (when taken off auto)

Recommended: `/oh-my-claudecode:plan --consensus --direct` on this spec → autopilot for Phase 1, with Phase 2 as a second run. Phase 0 is Noe-only (dashboard access). Or point `/ralph` at Phase 1 directly — the acceptance criteria above are its checklist.
