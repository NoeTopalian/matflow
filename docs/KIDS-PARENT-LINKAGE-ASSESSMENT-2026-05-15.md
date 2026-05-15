# Kids ↔ Parent Linkage Assessment — 2026-05-15

**Question asked:** "When I create or have a kids account, how is it that on the owner side I can add a kid to someone's account (their kids) + have the parent have an account without a membership e.g. if the kid has a membership and the parent doesn't. Read the files and assess the current success of this feature. Kids accounts should be linked to a parent account."

**Method:** Read-and-assess — every claim below is backed by a `file:line` reference. No empirical test was run for this report; the test option is in §5 if you want it.

---

## TL;DR

| Question | Status | Evidence |
|---|---|---|
| Q1 — Owner-side "Add child to a parent" works? | ✅ Yes — two flows shipped: **Create-new** and **Link-existing** | OwnerFamilyManagement.tsx + 2 API routes |
| Q2 — Can parent have no membership while kid has one? | ✅ Yes — schema, API, and UI all handle it | `membershipType: String?` + UI null-safe renders |
| Q3 — Are kids always linked to a parent? | 🟡 At app layer yes, **NOT at DB layer** | No CHECK constraint; only Zod + API guards enforce it |

**Bottom line:** the feature works for the case you described (parent with `membershipType: null` + kid with `membershipType: "Monthly"`). Three soft gaps are flagged in §4 — none break the feature; they're hardening recommendations.

---

## Q1 — How an owner adds a kid to a parent's account

There are **two distinct flows** on the owner-side, both surfaced in the `OwnerFamilyManagement` panel on the staff member-detail page (`/dashboard/members/[id]`).

### Flow A — Create a brand-new kid linked to the parent

**Trigger:** Staff opens a parent Member's detail page → clicks `Add child` → fills the modal (name + DOB).

**Frontend** ([components/dashboard/OwnerFamilyManagement.tsx:317–366](../components/dashboard/OwnerFamilyManagement.tsx)):
```ts
const res = await fetch("/api/members", {
  method: "POST",
  body: JSON.stringify({
    name: name.trim(),
    accountType: "kids",
    parentMemberId: parentId,   // ← the viewed Member's ID
    dateOfBirth: dob,
  }),
});
```

**Backend** ([app/api/members/route.ts](../app/api/members/route.ts)): the staff create-member POST handler.
- Uses `memberCreateSchema` from [lib/schemas/member.ts:6–14](../lib/schemas/member.ts) — accepts `accountType` (enum `adult | junior | kids`), `parentMemberId` (string, optional), `membershipType` (optional)
- Synthesises a kid email server-side (`kid-{16-byte-hex}@no-login.matflow.local`) so the staff form doesn't need to ask for one
- Persists with `passwordHash: null` (kid is passwordless) and `tenantId` from the session (never trusted from body)

**Resulting row:** Member with `accountType=kids`, `parentMemberId=<parent>`, `passwordHash=null`, `email=kid-<hex>@no-login.matflow.local`, **`membershipType=null` until the owner sets one** (and `paymentStatus="paid"` by default — see §4 quirk 2).

**Authorisation:** the route is staff-only (`owner | manager | admin | coach`). All staff roles can create a kid via this flow.

### Flow B — Link an existing unlinked Member as a kid

**Trigger:** Staff opens a parent Member's detail page → clicks `Link existing` → searches for a Member → submits.

**Frontend** ([components/dashboard/OwnerFamilyManagement.tsx:204+](../components/dashboard/OwnerFamilyManagement.tsx)) — `LinkExistingModal` calls `POST /api/members/[id]/link-child`.

**Backend** ([app/api/members/[id]/link-child/route.ts](../app/api/members/[id]/link-child/route.ts)):
- **Owner-role-only** (line 15): managers, admins, coaches all get 403 here
- Parent must not already be a sub-account (line 37 — `parent.parentMemberId !== null` → 400 "nested")
- Child must have `passwordHash: null` AND `parentMemberId: null` (lines 39–48) — i.e. only kid-shaped unlinked Members can be linked
- Atomic `updateMany` with re-check (lines 50–58) handles the race where two staff link the same child simultaneously — losing call returns 409
- Logs to `AuditLog` with action `member.link.child`

### Cascade safety on parent deletion

Schema line 140: `onDelete: SetNull`. Deleting a parent does **not** delete their kids — kids are orphaned (`parentMemberId` becomes `null`). The deeper cascade-safe deletion (attendance, ranks, photos, etc.) goes through [lib/member-delete.ts](../lib/member-delete.ts) — that helper walks all FK-RESTRICT relations explicitly.

---

## Q2 — Can a parent have an account without a membership while the kid has one?

**Yes, fully supported at every layer.**

### Schema layer

[prisma/schema.prisma:120](../prisma/schema.prisma): `membershipType String?` — nullable. There's no NOT NULL constraint and no CHECK forcing a value when `accountType=adult|parent`.

### API layer

[lib/schemas/member.ts:10](../lib/schemas/member.ts): `membershipType: z.string().max(60).optional()` — optional on create. Omitting it persists `null`.

### UI layer (verified null-safe)

Three render paths all handle null cleanly:

| Surface | Null rendering | File:line |
|---|---|---|
| Members list table (compact view) | `"—"` | [components/dashboard/MembersList.tsx:750](../components/dashboard/MembersList.tsx) |
| Members list table (full view) | `"No membership"` | [components/dashboard/MembersList.tsx:602](../components/dashboard/MembersList.tsx) |
| Member detail page (Membership tile) | `"Not set"` with amber accent | [components/dashboard/MemberProfile.tsx:639–641](../components/dashboard/MemberProfile.tsx) |

The amber accent on the detail page is a UX nudge — it flags "not set" as something the owner might want to address. Good design.

### Worked example

```
Parent: Reese Hall
  accountType: "adult"
  membershipType: null
  paymentStatus: "paid"  (default — see §4 quirk 2)

Kid: Reese's Daughter
  accountType: "kids"
  parentMemberId: <reese.id>
  membershipType: "Monthly Unlimited"
  paymentStatus: "paid"
  passwordHash: null
  email: kid-<hex>@no-login.matflow.local
```

This persists cleanly. Both rows surface independently in `/dashboard/members`. The kid surfaces in Reese's Family panel. The parent's Membership tile shows the amber "Not set" badge.

---

## Q3 — Are kids always linked to a parent?

**At the application layer, yes — the constraint is enforced by all API entry points.** At the database layer, no — there's no CHECK constraint backing it up.

### What enforces the invariant

1. **Parent-side create** ([app/api/member/children/route.ts:69–98](../app/api/member/children/route.ts)) always sets `parentMemberId: parentMemberId` (from session). Can't be omitted.
2. **Owner-side create** (Flow A above) — the AddChildModal forces `parentMemberId: parentId` in the body. The user can't fill the form without a parent context.
3. **Owner-side link-existing** (Flow B) — the entire purpose of the endpoint is to set `parentMemberId`. Atomic.

### What doesn't enforce it (the gap)

[prisma/schema.prisma:139](../prisma/schema.prisma): `parentMemberId String?` — nullable. There is **no DB-level CHECK** stating `accountType = 'kids' IMPLIES parentMemberId IS NOT NULL`.

**Consequences:**
- A direct DB write (e.g. a one-off `scripts/*.mjs` using `prisma.member.create`) could create `accountType: "kids", parentMemberId: null` and the DB would accept it
- If the `onDelete: SetNull` cascade fires on parent deletion, the kid is left as an orphan (`parentMemberId: null` while `accountType` stays `"kids"`)

The orphan-on-delete behaviour is actually deliberate per the original spec (`docs/KIDS-SYSTEM-VERIFICATION-2026-05-14.md`) — safeguarding requires that a kid record can survive its parent being deleted while staff sort out who the new guardian is. The CHECK constraint, if added, would have to allow the orphan transition. So this isn't a clean win — it's a tradeoff.

---

## 4. Flagged gaps (none break the feature; all are hardening recommendations)

### Gap 1 — `accountType: "parent"` exists in schema but not in `memberCreateSchema` Zod

[prisma/schema.prisma:131](../prisma/schema.prisma) CHECK constraint allows `adult | junior | kids | parent`. But [lib/schemas/member.ts:12](../lib/schemas/member.ts) only accepts `adult | junior | kids` on create. **You cannot create a Member with `accountType: "parent"` through the standard API.**

How `accountType: "parent"` gets set today is unclear from the read. Likely candidates:
- It's set by a backfill migration
- It's set elsewhere via raw SQL
- It's deprecated / not actually used in practice

**Suggested action:** either remove `"parent"` from the CHECK constraint (if it's truly unused) or add it to the Zod enum (if it's intended). Pick one — the drift is the problem.

### Gap 2 — `paymentStatus` defaults to `"paid"` even when there's no membership

[prisma/schema.prisma:122](../prisma/schema.prisma): `paymentStatus String @default("paid")`. A parent with `membershipType: null` will still surface a green "Paid" tile in the members list. That can mislead the owner into thinking the parent owes money but is current — actually, the parent doesn't owe anything because there's nothing to pay.

**Suggested fix:** in the members-list UI ([components/dashboard/MembersList.tsx](../components/dashboard/MembersList.tsx)), when `membershipType` is `null`, suppress the payment chip altogether (render the row without a payment indicator). Doesn't require a schema change. ~15 minutes.

### Gap 3 — `/api/members/[id]/link-child` is owner-only

[app/api/members/[id]/link-child/route.ts:15](../app/api/members/[id]/link-child/route.ts): `if (session.user.role !== "owner") return apiError("Forbidden", 403);`. Managers and admins cannot link kids — only the owner.

The Create-new flow (`POST /api/members`) is open to all staff. The Link-existing flow is owner-only. Inconsistent.

**Check with Noe before changing:** there may be a deliberate reason link-child is locked to owner (audit-trail clarity, safeguarding signoff). If not, widening to `owner | manager` matches the create flow.

### Gap 4 — Two different synthesised-email formats

- Staff create flow ([app/api/members/route.ts:34](../app/api/members/route.ts)): `kid-{16-byte-hex}@no-login.matflow.local`
- Parent self-serve flow ([app/api/member/children/route.ts:89](../app/api/member/children/route.ts)): `kid-{cuid}@kids.local`

Both are unique-per-tenant per the `@@unique([tenantId, email])` constraint, so functionally fine. But two formats make CSV exports and log searches harder. **Suggested fix:** pick one (probably `kid-{hex}@no-login.matflow.local` — the `.local` TLD is RFC-2606 reserved, and `no-login.matflow.local` is more self-documenting) and refactor the other route to use a shared `lib/synthesise-kid-email.ts` helper. ~30 minutes.

---

## 5. Empirical verification — optional

This assessment is based on reading the code. To **prove** the parent-no-membership case works against a real DB, the next step is a small integration test at `tests/integration/parent-no-membership.test.ts`:

```ts
it("persists parent with null membership + kid with non-null membership", async () => {
  const { tenantId, parentId } = await createTenantAndParent({ membershipType: null });
  const kid = await createKidFor(parentId, { membershipType: "Monthly Unlimited" });

  const parentRow = await prisma.member.findUnique({ where: { id: parentId } });
  const kidRow = await prisma.member.findUnique({ where: { id: kid.id } });

  expect(parentRow?.membershipType).toBeNull();
  expect(kidRow?.membershipType).toBe("Monthly Unlimited");
  expect(kidRow?.parentMemberId).toBe(parentId);
  expect(kidRow?.passwordHash).toBeNull();
});
```

If you want this written + run against the Neon test branch, say the word. Otherwise the code-read assessment above is sufficient evidence that the case is supported.

---

## 6. Source map (every claim → file:line)

| Claim | Source |
|---|---|
| Member schema, parentMemberId FK, accountType CHECK, membershipType nullable | [prisma/schema.prisma:120–182](../prisma/schema.prisma) |
| Owner-side "Add child" → POST /api/members with parentMemberId | [components/dashboard/OwnerFamilyManagement.tsx:340–349](../components/dashboard/OwnerFamilyManagement.tsx) |
| Owner-side "Link existing" → POST /api/members/[id]/link-child | [components/dashboard/OwnerFamilyManagement.tsx:182–188](../components/dashboard/OwnerFamilyManagement.tsx) |
| Link-child owner-only authorisation | [app/api/members/[id]/link-child/route.ts:15](../app/api/members/[id]/link-child/route.ts) |
| Link-child requires kid-shaped target (passwordHash + parentMemberId both null) | [app/api/members/[id]/link-child/route.ts:39–48](../app/api/members/[id]/link-child/route.ts) |
| Parent-side create-kid (POST /api/member/children) sets passwordHash=null, synthesises email | [app/api/member/children/route.ts:69–110](../app/api/member/children/route.ts) |
| Max 10 kids per parent | [app/api/member/children/route.ts:26](../app/api/member/children/route.ts) |
| memberCreateSchema accepts kids/junior/adult but NOT parent | [lib/schemas/member.ts:12](../lib/schemas/member.ts) |
| Members list null-safe rendering | [components/dashboard/MembersList.tsx:602, 750](../components/dashboard/MembersList.tsx) |
| MemberProfile "Not set" + amber badge | [components/dashboard/MemberProfile.tsx:639–641](../components/dashboard/MemberProfile.tsx) |
| Cascade safety: parent delete → kids orphaned, not deleted | [prisma/schema.prisma:140](../prisma/schema.prisma) (`onDelete: SetNull`) |
| Two synthesised-email formats | [app/api/members/route.ts:34](../app/api/members/route.ts) vs [app/api/member/children/route.ts:89](../app/api/member/children/route.ts) |

---

## 7. Verdict

The feature **works for the case you described.** An owner can:

- Add a brand-new kid to a parent's account (Flow A — staff-wide)
- Link an existing unlinked Member as a kid (Flow B — owner-only)
- Have a parent with `membershipType: null` while their kid has `membershipType: "Monthly Unlimited"`

The four flagged gaps in §4 are non-blocking. Decide which (if any) you want me to fix:

1. Gap 1 (parent enum drift) — schema vs Zod inconsistency
2. Gap 2 (paymentStatus on no-membership parent) — UX nudge
3. Gap 3 (link-child role allow-list) — feature vs safeguarding decision
4. Gap 4 (two kid-email formats) — code consistency

If you want the empirical integration test from §5 written, that's a fifth option.

---

## 2026-05-15 follow-up — owner ↔ member synergy pass

After the initial assessment shipped, audited the parallel pairs of endpoints/UI between the owner-side and member-side flows to confirm they behave consistently. **Three of four pairs already had synergy; one had two drift points; one is flagged as a follow-up.**

### Pairs audited

| Action | Owner-side | Member-side | Status |
|---|---|---|---|
| Create kid | `POST /api/members` | `POST /api/member/children` | 🟡 Was drifting (see below) — now fixed |
| Edit kid | `PATCH /api/members/[id]` (full edit) | `PATCH /api/member/children/[id]` (name + DOB only — defence in depth) | ✅ Intentionally asymmetric; parent surface is locked down |
| Delete kid | `DELETE /api/members/[id]` → `deleteMemberCascade` | `DELETE /api/member/children/[id]` → `deleteMemberCascade` | ✅ Both use the same shared cascade helper |
| View kid stats | `MemberProfile.tsx` (raw `prisma.attendance.count` etc.) | `/member/family/[id]` → `computeMemberStats` helper | ⚠ Drift — flagged for follow-up |

### Fixed in this pass

1. **Shared `lib/kids-policy.ts`** exports `MAX_KIDS_PER_PARENT = 10`. Both flows now import the same constant instead of duplicating a magic number.
2. **Owner-side now enforces the kid cap.** Previously `POST /api/members` had no check — an owner could pile arbitrary kids onto one parent, while a parent self-serving via `POST /api/member/children` was capped at 10. Both now 409 at the same limit.
3. **Owner-side sets `onboardingCompleted: true` on kid creation.** Previously the kid landed with `onboardingCompleted: false` even though they never log in. Member-side already did this; owner-side now matches.

### Confirmed already-good

- Email synthesis — single helper `lib/synthesise-kid-email.ts` (shipped earlier in this same change-set as Gap 4)
- No-nesting check — both routes reject creating a kid whose parent is itself a kid
- Parent-existence check — both routes 404 if the named parent isn't in the same tenant
- Cascade-safe delete — both use `lib/member-delete.ts`'s `deleteMemberCascade`

### Flagged for follow-up

**Stats computation drift.** `app/member/family/[id]/page.tsx` (parent UI) and `/api/member/children/[id]` GET (parent API) use the `computeMemberStats(tx, { memberId, tenantId })` helper from [lib/member-stats.ts](../lib/member-stats.ts), which is the canonical source of truth for "Total Visits / This Month / This Week / Streak / Subscriptions." But [components/dashboard/MemberProfile.tsx](../components/dashboard/MemberProfile.tsx) (owner UI) computes those numbers via its own queries.

This means the parent could see one streak count and the owner could see a different one for the same kid. The right fix is to lift `MemberProfile.tsx` to use `computeMemberStats` too — out of scope for this synergy pass because `MemberProfile` is a 1000+ line component with its own data-loading lifecycle; it deserves its own focused PR.

**Audit-log shape.** Both flows now log action `member.create.kid` — the parent-side was unified to match the staff side as part of the 2026-05-15 synergy pass (see `app/api/member/children/route.ts` `logAudit` call). A "kids activity" admin view can filter on one string.
