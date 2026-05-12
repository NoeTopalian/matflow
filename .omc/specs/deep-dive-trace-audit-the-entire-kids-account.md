# Deep Dive Trace: audit-the-entire-kids-account

Generated: 2026-05-12. Trace executed in 3 parallel lanes against the kids-account surface shipped by Session E (commits c2aa855, 4e2faf6, 2fd22e9, 5ce489b) plus the bug fix at 93c40a6.

## Observed Result
"Ensure the kids account system is working effectively and is prepared well — a parent who hasn't joined the club themselves should be able to see their kids' accounts, info, stats, level, and uploaded evidence photos."

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|------|------------|------------|-------------------|--------------|
| 1 | **Parent-side UI is the primary gap.** Backend largely supports the use case; UI either calls 0 of the endpoints (Add/Edit/Remove) or renders raw data without parent-facing stats / photo / waiver affordances. | **High** | **Strong** — confirmed missing buttons + read-only detail page (Lane 2) cross-referenced with working backend endpoints (Lane 1) |
| 2 | **Three backend endpoints are still missing.** PATCH /api/member/children/[id], any photo-upload route, and a parent-signs-kid-waiver route. Existing schema has no MemberPhoto model. | High | Strong — direct file-search misses, schema.prisma read in full (Lane 1) |
| 3 | **One latent FK migration drift** in LoginEvent: schema declares ON DELETE CASCADE; migration 20260504000000 doesn't actually create the FK. Member deletion would either succeed-with-orphans or fail-with-P2003 depending on whether constraint was hot-applied. | Medium | Moderate — migration file ↔ schema mismatch is real, prod state unknown without a `\d+` query (Lane 3) |

## Evidence Summary by Hypothesis

### H1 — Parent-side UI is the primary gap
- `components/member/FamilySection.tsx:79-96` tells the parent "contact the gym to add a family member" — there is no "+ Add child" button despite `POST /api/member/children` being live.
- `app/member/family/[childId]/page.tsx:141` ships with the explicit footer "Read-only · Belt and rank changes are managed by the gym" — no edit, no remove, no photo, no waiver-sign UI.
- `app/member/home/page.tsx:214` introduces `parentOnly` state in the onboarding modal but the dashboard branch that would render a kids-focused home view for `accountType==="parent"` is not yet wired — parent-only users still see `DEMO_TODAY_CLASSES` lines 21-26.
- The SignInSheet kid picker (lines 952-992) is the one parent-side UI surface that DOES work post-onboarding, but only for check-in.

### H2 — Three backend endpoints missing
- Only GET + DELETE exist on `app/api/member/children/[id]/route.ts`. No PATCH handler. Parent cannot rename a kid or fix DOB.
- Zero references to `MemberPhoto` anywhere in `prisma/schema.prisma` (lines 1-862). No `photoUrl`, `avatarUrl`, `imageUrl` on Member. The "Add Photo" affordance at `app/member/profile/page.tsx:373` is a hard-coded button against a `MILESTONES` mock array (lines 14-21), not a real upload flow.
- `app/api/waiver/sign/route.ts:52` signs only for `session.user.memberId`. No `onBehalfOfMemberId` body field, no `/api/waiver/sign-for-child` sibling route. Kid's `waiverAccepted` stays `false` after creation with no in-app path to flip it.

### H3 — LoginEvent FK migration drift
- `prisma/schema.prisma:418, 420` declare LoginEvent FKs to User and Member with `onDelete: Cascade`.
- `prisma/migrations/20260504000000_login_events/migration.sql` creates the table + unique indexes but **omits the `ALTER TABLE LoginEvent ADD CONSTRAINT … FOREIGN KEY` statements**.
- `lib/member-delete.ts:19` documents LoginEvent as "SET NULL" (incorrect — schema says Cascade) and the helper does NOT explicitly `deleteMany` LoginEvent rows.
- Tests at `tests/integration/member-cascade-delete.test.ts` never create a LoginEvent row, so the question is unresolved by code alone.

## Evidence Against / Missing Evidence

### H1 (UI gap)
- Against: parent-side UI for the *creation* and *sign-in* paths DOES exist and works. So this isn't a total UI absence — only the post-onboarding lifecycle (edit/remove/photo/waiver) is missing.
- Missing: a screenshot or user report confirming the dashboard for a parent-only user is actually unusable (it might look empty but still be technically functional).

### H2 (missing endpoints)
- Against: nothing — the absence of these routes is verifiable by directory listing.

### H3 (LoginEvent FK drift)
- Against: deletion tests pass against the Neon test branch in CI/local, suggesting whatever schema state the test DB is in, deletes work in practice. Drift may exist on paper but not bite at runtime.
- Missing: `information_schema.table_constraints WHERE table_name='LoginEvent'` query result.

## Per-Lane Critical Unknowns

- **Lane 1 (Backend API + schema):** *Has migration `20260512000001_member_account_type_parent` actually been applied to the deployed databases (prod + Neon test branch)?* The new CHECK constraint allowing `accountType="parent"` was added today; if not applied, the upcoming parent-only onboarding will fail at the DB layer with a CHECK violation when calling `PATCH /api/member/me { accountType: "parent" }`.

- **Lane 2 (Parent-side UI):** *Should kid avatars in `FamilySection` support inline tap-to-upload-photo, or is photo upload only on the kid detail page?* The visual pattern in the parent's own profile ("My Journey" + "+ Add Photo" button) is currently mock data — we need to decide whether the same milestone-style timeline applies to kids or whether a simpler "Photos" grid suffices.

- **Lane 3 (Deletion cascade):** *Are the LoginEvent FK constraints actually present in the production database, even though the migration SQL doesn't add them?* Possible the FKs were applied via a hotfix outside the migration history.

## Rebuttal Round

**Best rebuttal to H1 (UI is primary gap):** "The UI gap is downstream of the missing backend endpoints — fixing UI alone with no PATCH route, no photo upload, no kid-waiver-sign means clicking the button would 404."

**Why H1 still holds as leader:** Both gaps must be fixed for the feature to work, but the UI is the LARGER scope (5 different surfaces vs 3 endpoints) and is the visible part the user is judging. The plan must therefore land the UI + backend in the same commits — they're not separable. H1 stays #1 because it sets the work scope; H2 supplies the prerequisite endpoints inside the same commits.

## Convergence / Separation Notes

- H1 and H2 are not independent — they are two sides of the same delivery. Each new UI surface needs a backend endpoint underneath. The plan treats them as paired commits.
- H3 is a separate concern from H1/H2: it's a hygiene fix for the existing deletion safety net and doesn't block the parent-management feature. Worth a small follow-up commit.

## Most Likely Explanation

The kids-account system is **structurally sound at the backend** (creation, sign-in, cascade-safe deletion, parent-of-kid scoping, accountType plumbing) but the **parent's day-to-day management UI is hollow** for everything except the initial onboarding-time kid creation and the per-class sign-in picker. The fix requires:

1. Three new backend endpoints (PATCH kid, photos CRUD, sign-kid-waiver)
2. One new schema model (MemberPhoto with ON DELETE CASCADE)
3. Full kid-management UI on `FamilySection` + the `/member/family/[childId]` page
4. Completing the half-shipped onboarding parent-only fork
5. A small hygiene fix to align LoginEvent FK migration with schema

## Critical Unknown (synthesised)

**Will the parent-only onboarding fork actually skip the right steps?** Specifically, the parent who never trains should not see Step 1 (belt picker), Step 3 (style), or Step 4 (heard about us) — but the current `parentOnly` state at `home/page.tsx:214` is declared and never read. The fork's branching logic in `goNext()` / `goBack()` / `canNext` / the step bodies is the highest-risk piece because it has to interact with the existing 8-step state machine without regressing the training-member flow.

## Recommended Discriminating Probe

Run two queries against the Neon test branch in sequence:

```sql
-- 1. Confirm parent CHECK constraint is live
SELECT check_clause
FROM information_schema.check_constraints
WHERE constraint_name = 'Member_accountType_check';

-- 2. Confirm LoginEvent FK constraints are present (or not)
SELECT constraint_name, constraint_type
FROM information_schema.table_constraints
WHERE table_name = 'LoginEvent';
```

If query 1 returns the 4-value list including `'parent'`: safe to proceed with Commit 1 in the guide.
If query 2 returns FK constraints on `userId` / `memberId`: drift exists only in the migration file (update the file to match); if it returns nothing: add the FKs in a new migration AND extend `lib/member-delete.ts` to wipe LoginEvent before delete.
