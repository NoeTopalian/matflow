# Member Family (Parent + Kids)

> **Status:** ✅ Working · self-relation on Member (parentMemberId) · kids are passwordless with synthesised emails · parent sees children in their profile · staff manages link/unlink.

## Purpose

Let one paying parent manage their child's gym account without giving the kid a password (or an email address — most kids don't have one). The parent's logged-in session can view the kid's profile, attendance, belt etc. The kid never logs in directly; staff/coach perform check-ins and updates on their behalf.

## Surfaces

| Surface | Who | Path |
|---|---|---|
| Family list inside member profile | Parent | [components/member/FamilySection.tsx](../components/member/FamilySection.tsx) embedded in [/member/profile](../app/member/profile/page.tsx) |
| Kid detail page | Parent | [/member/family/[childId]](../app/member/family/[childId]/page.tsx) |
| Owner family management panel | Staff | [components/dashboard/OwnerFamilyManagement.tsx](../components/dashboard/OwnerFamilyManagement.tsx) embedded below member detail |

## Data model

```prisma
model Member {
  ...
  email           String   // unique per tenant; kids get synthesised "kid-{nanoid}@no-login.matflow.local"
  passwordHash    String?  // null for kids (passwordless)
  accountType     String   @default("adult")  // CHECK: adult | junior | kids
  parentMemberId  String?
  parent          Member?  @relation("MemberParent", fields: [parentMemberId], references: [id], onDelete: SetNull)
  children        Member[] @relation("MemberParent")
  hasKidsHint     Boolean  @default(false)   // owner-set hint that this adult has kids — surfaces "Add child" CTAs

  @@index([parentMemberId])
}
```

Synthesised email format: `kid-{32hex}@no-login.matflow.local` ([app/api/members/route.ts](../app/api/members/route.ts) `synthesiseKidEmail()`). The 32-hex random gives 2^128 collision space; tenantId NOT in the email to avoid leaking internal CUIDs via CSV exports.

## API routes

- [`GET /api/member/me/children`](../app/api/member/me/children/route.ts) — parent's kids: `[{ id, name, dateOfBirth, accountType, waiverAccepted, belt, totalClasses }]`
- [`GET /api/member/children/[id]`](../app/api/member/children/[id]/route.ts) — single kid for the parent (verifies `child.parentMemberId === parentMemberId`)
- [`POST /api/members/[id]/link-child`](../app/api/members/[id]/link-child/route.ts) — staff links an existing member as a child of `[id]`. Depth-cap (kids can't have kids).
- [`POST /api/members/[id]/unlink-child`](../app/api/members/[id]/unlink-child/route.ts) — staff unlinks a child (sets `parentMemberId = null`). Race-safe via `updateMany({where:{parentMemberId: parentId}})`.
- [`POST /api/members`](../app/api/members/route.ts) — when `accountType='kids'` or `parentMemberId` set: enforces "kids policy" (only owner can create), validates parent is top-level, synthesises kid email server-side, no invite token sent.

## Kid creation rules

From [/api/members POST](../app/api/members/route.ts):

1. `isKid = parsed.data.accountType === "kids" || !!parsed.data.parentMemberId`
2. Kids policy: **only owners** can create kid sub-accounts (`session.user.role === "owner"` enforced)
3. Kids must have a parent (`parentMemberId` required)
4. Parent must be top-level — `parent.parentMemberId === null` enforced (prevents kid-of-kid nesting)
5. Email synthesised server-side — never trust client field
6. `passwordHash: null` always (passwordless invariant)
7. No invite-link mint, no email sent

## Flow — parent's view

1. Parent logs in → /member/profile → "My Family" section
2. `GET /api/member/me/children` returns linked children (or empty)
3. Each child rendered as a tappable row: avatar (initials), name, age (calc from DOB), belt + stripes, total classes
4. Tap → `/member/family/{childId}` → renders kid's profile (read-only attendance + belt history)
5. Empty state: "To add a family member, contact {gym billing email}" — no self-serve add (intentional — staff verification required)

## Flow — staff's view

1. Staff opens member detail page → OwnerFamilyManagement panel below
2. "Link existing" → search for an unlinked member by name → POST `/api/members/[id]/link-child`
3. "Add child" → drawer for new kid creation → POST `/api/members` with `accountType='kids'` + `parentMemberId`
4. Each linked kid rendered with × to unlink

## Security

- Parent-side endpoints verify `child.parentMemberId === session.user.memberId` — no peeking at other parents' children
- Owner-only kid creation
- Depth-cap: kids cannot have kids (server-enforced)
- Race-safe parent change: `updateMany({where: {id: childId, parentMemberId: oldParentId}})` returns 0 if another transaction already moved the link
- Audit logged: `member.create.kid`, `member.link_child`, `member.unlink_child`

## Known limitations

- **No member-side add-child UI** — parents must email/text the gym to onboard a child. Intentional (verification + payment-info collection at point of join).
- **No member-side delete-child** — same reason.
- **Synthesised kid emails leak in admin views** — owner sees `kid-abc...@no-login.matflow.local` in the Members list. Cosmetic; could be hidden behind `accountType==='kids'`.
- **Kid waiver signing** uses staff-supervised flow with `signerName` set to the parent's name (see [waiver-system.md](waiver-system.md)). UI could show "Signed by {parent name}" on kid profiles instead of generic "Signed".
- **No "split adult into adult + kid" migration tool** — if a member was created as adult and should be a kid, owner has to delete + recreate.

## Test coverage

- [tests/unit/kids-tenant-scope.test.ts](../tests/unit/kids-tenant-scope.test.ts)
- [tests/unit/supervised-waiver-tenant-scope.test.ts](../tests/unit/supervised-waiver-tenant-scope.test.ts) (kids waivers signed via supervised flow)

## Files

- [components/member/FamilySection.tsx](../components/member/FamilySection.tsx)
- [components/dashboard/OwnerFamilyManagement.tsx](../components/dashboard/OwnerFamilyManagement.tsx)
- [app/member/family/[childId]/page.tsx](../app/member/family/[childId]/page.tsx)
- [app/api/member/me/children/route.ts](../app/api/member/me/children/route.ts)
- [app/api/member/children/[id]/route.ts](../app/api/member/children/[id]/route.ts)
- [app/api/members/[id]/link-child/route.ts](../app/api/members/[id]/link-child/route.ts)
- [app/api/members/[id]/unlink-child/route.ts](../app/api/members/[id]/unlink-child/route.ts)
- [app/api/members/route.ts](../app/api/members/route.ts) — `synthesiseKidEmail()`, kid creation rules
