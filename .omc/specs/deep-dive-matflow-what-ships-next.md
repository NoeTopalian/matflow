# Deep Dive — What ships next on MatFlow

**Captured:** 2026-05-15
**Status:** Comprehensive execution plan
**Inputs:** `docs/KIDS-FULL-VERIFICATION-2026-05-15.md` (full sweep), `docs/KIDS-PARENT-LINKAGE-ASSESSMENT-2026-05-15.md`, `docs/KIDS-SYSTEM-VERIFICATION-2026-05-14.md`, plus the Tier-A/B/C audit captured in `C:\Users\NoeTo\.claude\plans\majestic-bubbling-gosling.md`.

## Context

The kids-billing six-feature push (F1–F6) shipped earlier today. The Tier-A audit confirmed 22 integration tests passing, 13 owner-side surfaces and 4 member-side surfaces verified live on `matflow.studio`, and a behavioural matrix covering parent-delete, kid-delete, account-deactivation, race/invariant edges, and subscription edges. Two follow-up commits closed Gaps #6 (`MembershipTier.stripePriceId` column) and #11 (members-list orphan stat tile).

Thirteen items remain on the "needs work" list. They split cleanly into three causal lanes — three reasons something isn't yet verified-in-prod or shipped:

- **Lane A — Config gates** (the feature is built, but a tenant-level switch or piece of seed data blocks the live walk)
- **Lane B — Missing UI** (a back-end is shipped, no front-end surface exists yet to drive it)
- **Lane C — Missing features** (genuinely new product surface area)

Each item maps cleanly to one lane. The "what ships next" decision is mostly: how much of A do you want to close yourself with clicks (free, ~30 min), how much of B is worth my time building (each 1–2h), and which big-C item earns priority (the answer is almost certainly CSV import — it's the gate on customer #2).

---

## Trace synthesis — three lanes, ranked by leverage

### Lane A — Config gates (zero code, the user clicks once)

| # | Item | What unblocks it | Verified-on-prod outcome |
|---|---|---|---|
| A1 | **F5 CHECK constraint** not applied to prod | `DATABASE_URL=<prod> npx prisma migrate deploy` | The orphan-kid invariant is hard-enforced in prod, not just in code |
| A2 | **F4 parent timetable** never renders on Reese | Seed a parent-with-kid on TotalBJJ via the dashboard (Add child) | The "Your kids" accordion fires on parent login |
| A3 | **F6 multi-kid attendance picker** never appears | Same as A2 (needs a parent with ≥1 kid for the kiosk to fork into the picker) | Picker tiles render at the kiosk |
| A4 | **F2/F3 Stripe paths** return 403/503 | Connect Stripe (OAuth from Revenue tab) + flip `memberSelfBilling` toggle on | Members + parents can subscribe themselves and their kids in test-mode Stripe |
| A5 | **Prod migrate status unknown** | `DATABASE_URL=<prod> npx prisma migrate status` | Confirm prod schema matches `prisma/migrations/` HEAD |

**Total time if you do all five: under 30 minutes.** Promotes five Tier-B items to Tier-A with zero engineering cost.

### Lane B — Missing UI on top of shipped back-end

| # | Item | Effort | Risk |
|---|---|---|---|
| B1 | **Dashboard "Remove Member" UI** + the 3-strategy picker for F5 gateway | ~45 min | Low — gateway API verified by 6 tests |
| B2 | **`/dashboard/checkin` variant of WhoIsTrainingPicker** | ~30 min | Low — component already built for kiosk |
| B3 | **Tier-edit UI surfaces `stripePriceId` + `stripeProductId`** (paired with A4) | ~45 min | Low — schema column shipped; just need a form field in Memberships management |
| B4 | **Per-kid payment method override** (Stripe customer-portal session route + button on `/member/family/[id]`) | ~1h | Medium — touches a real Stripe surface |
| B5 | **Parent's "Pay for everything" button** on `/member/home` that fires sequential F3 intents | ~1h | Medium — sequential intent handling + per-row error UX |
| B6 | **Soft "Set up 2FA" nudge in member portal** (mirroring the owner banner) | ~30 min | Low |

### Lane C — Missing features, real engineering

| # | Item | Effort | Why it matters |
|---|---|---|---|
| C1 | **CSV import from TeamUp / Glofox / Mindbody** | 1–2 days | **The real blocker on customer #2.** Without it, every new gym means manual data entry. Single biggest leverage item on this list. |
| C2 | **PWA / Serwist service worker** | ~1 day | "Add to home screen" works as a bookmark; not a real PWA. Member portal feel is downstream of this. |
| C3 | **Retention curves + payment health reports** | ~1 day | Currently fabricated claims in some docs; need to actually build into `lib/reports.ts`. |
| C4 | **Auto-promote kid to adult on 18th birthday** (weekly cron + dashboard chip) | ~1h | Low priority for now; minor automation |
| C5 | **Class-pack self-purchase** (new flag + endpoint) | 1–2h | Round-trips the deferred F2/F3 follow-up |
| C6 | **Single combined Stripe payment intent** (replaces the sequential pay-everything flow) | ~3h | Optional polish; sequential is acceptable for v1 |
| C7 | **Staff impersonation** for support purposes | ~half day | Unimportant until you have paying gyms calling for support |
| C8 | **Investigate React #418 hydration** on `/dashboard/members` | ~30 min | One console warning; functional. Probably a `toLocaleDateString` server/client locale mismatch on a date cell |

---

## Hard invariants to preserve (must not regress)

These are now load-bearing across the system; any of the work below must respect them.

| # | Invariant | Enforced by |
|---|---|---|
| I1 | `accountType = 'kids'` ⇒ `parentMemberId IS NOT NULL` | DB CHECK constraint (migration `20260515000001`) + app-layer guards |
| I2 | No nested sub-accounts | App-layer (every link/create route checks `parent.parentMemberId === null`) |
| I3 | Member-side payment endpoints 403 unless `Tenant.memberSelfBilling = true` | Top-of-route gate in F2/F3 |
| I4 | Parent can only act on their own linked kids | Composite predicate `{ id, tenantId, parentMemberId }` on every kid-side lookup |
| I5 | Deleting a parent with kids requires an explicit strategy | `deleteParentMemberWithKidsResolution()` gateway in `lib/member-delete.ts` |
| I6 | Kid emails use the single shared `synthesiseKidEmail()` helper | `lib/synthesise-kid-email.ts` |
| I7 | Audit log action `member.create.kid` covers both creation paths | Unified in commit `0b5cc2a` |

---

## Recommended sequence

### Phase 0 — User actions (do these tonight, ~30 min total)

1. Apply F5 migration: `DATABASE_URL=<prod> npx prisma migrate deploy`
2. Confirm prod migrate status: `DATABASE_URL=<prod> npx prisma migrate status`
3. Seed one parent-with-kid on TotalBJJ via the Dashboard → Members → Family panel
4. Connect Stripe on TotalBJJ (Revenue tab → Connect Stripe button)
5. Flip `memberSelfBilling` toggle on

Result: Lane A fully closed. F2/F3/F4/F5/F6 all walkable on prod by morning.

### Phase 1 — Small UI follow-ups, in one bundled PR (~3h total)

Order chosen to maximise shared code reuse and minimise context-switching:

1. **B3 first** — Tier-edit UI for `stripePriceId` / `stripeProductId`. Required before B5 is meaningful.
2. **B1** — Dashboard Remove Member modal with 3-strategy picker. Wires the F5 gateway to a real surface.
3. **B2** — `/dashboard/checkin` WhoIsTrainingPicker variant. Reuses the existing component.
4. **B6** — Member-portal 2FA nudge. Single component.

Single commit: `feat(dashboard): wire F5 deletion picker + F2/F3 tier-priceId field + member 2FA nudge`.

### Phase 2 — Verification PR (~1h total)

5. **F2/F3 stub-Stripe integration tests** — `vi.mock("stripe")` with fake `customers.create` and `subscriptions.create`. Asserts: gate-off → 403, sub-account → 403, composite-predicate cross-parent → 404, success path returns `clientSecret`. 4–6 cases per endpoint.
6. Apply the F5 migration to a Neon test branch + run the existing `parent-deletion-gateway.test.ts` against it for real DB confirmation.

Result: Tier B → Tier A for F2 + F3 + F5. After this, every shipped feature has a test backing it.

### Phase 3 — Stripe polish (~2h)

7. **B4** — Per-kid payment method override via Stripe Customer Portal session
8. **B5** — Parent's "Pay for everything" button on `/member/home` (sequential intents with optimistic UI)

### Phase 4 — Strategic feature, focused PR (~1–2 days)

9. **C1 — TeamUp / Glofox / Mindbody CSV import.** This is the actual constraint on growth. Deserves its own spec — see "Out of scope below" for the proposed shape.

### Phase 5 — Polish, lower priority

10. **C2** PWA / Serwist (~1 day)
11. **C3** Retention curves + payment health (~1 day)
12. **C8** React #418 hydration fix (~30 min)
13. **C4** Auto-age-up kid (~1h)
14. **C5** Class-pack self-purchase (~1–2h)
15. **C6** Combined Stripe intent (~3h)
16. **C7** Staff impersonation (~half day)

---

## Critical files per feature

| Feature | Touches |
|---|---|
| B1 Remove Member UI | New: modal in `components/dashboard/RemoveMemberModal.tsx`; integrate into `MemberProfile.tsx` |
| B2 Dashboard checkin picker | `components/dashboard/CheckInPage.tsx` (find/edit), reuse `components/checkin/WhoIsTrainingPicker.tsx` |
| B3 Tier-priceId UI | Membership management page (location TBD — likely `app/dashboard/memberships/page.tsx` or similar) |
| B4 Per-kid payment override | New: `app/api/member/family/[id]/billing/portal/route.ts` → Stripe Customer Portal session |
| B5 Pay for everything | `app/member/home/page.tsx` parent-mode branch; fires N intents via existing endpoints |
| B6 Member 2FA nudge | `app/member/home/page.tsx` add banner; reuse owner banner component |
| F2/F3 tests | New: `tests/integration/member-self-pay.test.ts`, `tests/integration/parent-pays-for-kid.test.ts` |
| C1 CSV import | New: `lib/import/{teamup,glofox,mindbody}.ts` adapters, `app/api/admin/import/route.ts`, dashboard UI under `/dashboard/import` |

---

## Verification (per feature)

Phase 0 outcomes (after the user does the clicks):
- Re-run the Playwright sweep from `docs/KIDS-FULL-VERIFICATION-2026-05-15.md` Track 2. F4 accordion + F6 picker should now render. F2/F3 should now return 201 on the happy path instead of 403/503.

Phase 1:
- Each new UI screenshotted on localhost via Playwright MCP. Console-error sweep. Mobile 360px viewport check.

Phase 2:
- `npm test` against `TEST_DATABASE_URL=<neon-branch>`. Expect existing 26 tests + 8–12 new F2/F3 cases + 6 F5 gateway cases all passing.

Phase 3:
- Stripe test-mode subscription + portal session walk end-to-end.

Phase 4:
- Import 10-row CSVs from each of the 3 platforms. Diff the resulting Member rows against the source. Verify attendance dates, rank assignments, and subscription mappings.

---

## Out of scope (deliberate)

- A separate v2 spec for CSV import — that's a discovery + PRD job in itself. Plan above treats it as one phase but real work is multi-stage (parser per platform + idempotent upsert logic + dry-run mode + post-import audit).
- Real-Stripe verification with live cards (test mode is sufficient).
- Onboarding wizard rework — current wizard works.
- Tenant-level CSV export (separate feature).
- Cross-tenant parent (one parent across two gyms with the same email) — locked out by the `@@unique([tenantId, email])` constraint by design.

---

## Open questions

These don't block Phase 0 (Lane A — your clicks). They block Phases 1+ if I'm to start work.

1. **For B3** — should `stripePriceId` be edited free-form, or should I add a "Sync with Stripe" button that lists prices from the connected Stripe account and lets the owner pick? The second is friendlier but doubles the surface area.
2. **For B1** — when the staff member picks "reassign", should the typeahead show ALL eligible adults (free-form, the locked decision from the deep-interview) or just the kid's already-known emergency contacts? Locked answer was "free-form" — confirming you still want that.
3. **For C1** — which platform is highest priority? TeamUp, Glofox, Mindbody, or all three at once? If picking one, do you have access to a sample export from a real gym to test against?
4. **For Phase 0 step 4** — when you connect Stripe, do you want me to walk through it via Playwright so we capture screenshots of the success state and add them to the verification doc, or are you doing it manually?

---

## Execution bridge

When you're ready to run Phase 1, the most efficient path is to invoke the existing Ralph loop with this spec as the brief. Phases 0 + 4 are user-action and product-decision respectively — they happen outside any agent loop.

Ready commands once approved:

```
# Phase 0 — your clicks, no agent involved
DATABASE_URL=<prod> npx prisma migrate deploy
DATABASE_URL=<prod> npx prisma migrate status

# Phase 1 — ralph loop on the small UI bundle
# (run `/oh-my-claudecode:ralph` and paste the four B-items as the task)

# Phase 2 — verification PR
# (separate ralph run scoped to "stub-Stripe tests for F2/F3 + apply F5 migration to test branch and run gateway tests")
```

Or if you prefer to keep this conversation going, just say "go" with a phase number and I'll start on it.
