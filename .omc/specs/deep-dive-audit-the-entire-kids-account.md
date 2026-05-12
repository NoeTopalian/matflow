# Spec: Kids-account system — parent-side completion guide

## Metadata
- Generated: 2026-05-12
- Source: deep-dive (skipped formal interview — user's intent crystal-clear + plan-mode decisions already captured + 3-lane trace ambiguity ≤ 0.2)
- Trace: `.omc/specs/deep-dive-trace-audit-the-entire-kids-account.md`
- Status: ready-for-ralph
- Estimated effort: 5-6 hours across 4 ralph iterations + 1 hygiene commit
- Ralph reviewer budget per iteration: ≤5 prod files, ≤200 non-test LoC, regression test required, no removed assertions

## Goal

Land the missing parent-side surface so a parent who never trains can complete onboarding, manage their kids' accounts (add / edit / remove / view stats / upload photo / sign waiver) from the app, without contacting the gym. Backend gaps + UI gaps ship paired.

## Constraints

- Every state-mutating route guarded by `assertSameOrigin` + parent-of-kid composite predicate (`{id, tenantId, parentMemberId}`) — same pattern as Session E.
- Every DB read/write goes through `withTenantContext` (RLS backstop).
- Photo upload reuses `app/api/upload/route.ts` (existing 2MB Vercel Blob cap + `data:` URL fallback for the known prod Blob outage per CLAUDE.md memory).
- Photos visible to parent + staff only (no cross-family browsing) — enforced server-side, not client-side.
- Onboarding parent-only fork must NOT regress the existing training-member flow.
- LoginEvent FK drift must be fixed in a separate commit to keep deletion-safety reasoning isolated.

## Non-Goals

- Staff dashboard surface for viewing kid photos (separate task).
- Belt-promotion-with-photo flow on staff promote-rank action (separate task; same model is reusable).
- Replacing the parent's own `MILESTONES` mock data in `/member/profile` with real photos (defer).
- Mobile app / Capacitor wrap (gated on Session I PWA push POC).

## Acceptance Criteria (the ralph-ready checklist)

> Each user story below maps to one ralph iteration. Mark `passes: true` only after every criterion is verified with fresh evidence (fresh test run, fresh build output).

### US-1 — Parent-only onboarding fork
- [ ] Step 0 of the onboarding modal in `app/member/home/page.tsx` shows two options: "I train at this gym" and "I'm here to manage my child's account" (instead of the current single "Let's Go" button).
- [ ] Picking the parent-only option sets `parentOnly=true` and routes Next from Step 0 → Step 5 (kids), skipping Steps 1-4 (belt, classes, style, heard).
- [ ] Step 6 (emergency contact) + Step 7 (waiver) still run for parent-only — parent has on-premises liability when collecting their kid.
- [ ] The Step 5 inline N-kid form (from Session E commit `4e2faf6`) is the first content the parent sees.
- [ ] On finish, `PATCH /api/member/me` is sent with `accountType: "parent"` (must be accepted by the route's allowlist — server side already extends accountType to `"parent"` per commit-in-progress).
- [ ] Back-button from Step 5 returns to Step 0, not Step 4.
- [ ] Unit test `tests/unit/onboarding-parent-mode.test.tsx` renders the modal, picks parent-only, asserts belt/style/heard steps are not reachable, and asserts the PATCH body includes `accountType: "parent"`.

### US-2 — Parent-only dashboard mode
- [ ] `/member/home` reads `accountType` from `/api/member/me` (already exposed) and, when `=== "parent"`, replaces the "Your next class" + personal stats panel with a "Your kids" feed that lists each kid + their next class.
- [ ] When `accountType !== "parent"`, the existing layout is byte-identical (no regression).
- [ ] The Sign-In sheet kid picker (Session E commit `2fd22e9`) still works for both modes.

### US-3 — Post-onboarding add / edit / remove kid (UI + backend PATCH)
- [ ] `components/member/FamilySection.tsx` replaces the "contact billing@…" copy with two affordances:
  - A "+ Add child" button that opens an `EditChildModal` (name + optional DOB).
  - Each kid row gains a "…" menu with Edit (name, DOB) and Remove (calls the existing DELETE endpoint).
- [ ] `components/member/EditChildModal.tsx` (new, shared for create + edit).
- [ ] `app/api/member/children/[id]/route.ts` gains a `PATCH` handler. Parent edits ONLY `name` + `dateOfBirth`. Server silently drops any other field (status, accountType, waiverAccepted, belt, parentMemberId all stay staff-managed). Composite predicate guard `{id, tenantId, parentMemberId}` mirrors Session E DELETE.
- [ ] Regression test extension in `tests/integration/member-children-lifecycle.test.ts`:
  - PATCH renames a kid → 200 + DB row updated
  - Cross-parent PATCH → 404, no mutation
  - Attempt to set `status="cancelled"` via PATCH → 200 but status unchanged in DB

### US-4 — Rich kid stats parity with parent's own dashboard
- [ ] New `lib/member-stats.ts` exports `computeMemberStats(tx, { memberId, tenantId })` returning `{ thisWeek, thisMonth, thisYear, streakWeeks, totalClasses, attendanceByClass, avgClassesPerWeek, nextClass }`.
- [ ] `app/api/member/me/route.ts` is refactored to call the helper (net code reduction; same shape returned).
- [ ] `app/api/member/children/[id]/route.ts` GET extends its response with the same stats object.
- [ ] `app/member/family/[childId]/page.tsx` renders the new stats next to the existing belt + waiver tiles.
- [ ] New test `tests/integration/member-children-stats.test.ts` seeds a kid with 3 attendances across 2 weeks, then asserts the GET response includes the same shape `/api/member/me` returns for a comparable adult member.

### US-5 — Kid photos (evidence) + parent waiver signing
- [ ] `prisma/schema.prisma` gains a `MemberPhoto` model: `{ id, tenantId, memberId (FK Member, ON DELETE CASCADE), url (String, accepts data: URLs up to ~3M chars per the existing upload route), caption String?, kind ("evidence" | "milestone" | "promotion" CHECK), uploadedAt, uploadedByMemberId (Member?) }`. Indexes: `(memberId, uploadedAt)`, `(tenantId)`.
- [ ] Migration `prisma/migrations/<timestamp>_member_photos/migration.sql` includes the table, FKs, indexes, RLS policy matching the existing `Member` table policy.
- [ ] `app/api/member/children/[id]/photos/route.ts`: POST (parent uploads — calls existing `/api/upload`), GET (parent fetches own kid's photos).
- [ ] `app/api/member/children/[id]/photos/[photoId]/route.ts`: DELETE (parent removes own kid's photo).
- [ ] `app/api/waiver/sign-for-child/route.ts`: mirror of `/api/waiver/sign` but accepts `onBehalfOfMemberId` where `parentMemberId === session.memberId`. Creates a `SignedWaiver` row with `memberId = kid.id`, `collectedBy = parent.memberId`.
- [ ] `app/member/family/[childId]/page.tsx` renders the photo grid + "+ Add Photo" CTA + (when `waiverAccepted=false`) a "Sign waiver for [child name]" button that opens an inline signature-pad flow.
- [ ] Cascade test: `tests/integration/member-children-photos.test.ts` — parent uploads → row exists; cross-parent upload returns 404; kid deletion via `lib/member-delete.ts` removes the photo row automatically (proves the `ON DELETE CASCADE` FK).
- [ ] Visibility: photos return only when the requesting session is (a) the parent of the kid, or (b) staff in the same tenant. Cross-family browsing returns 404.

### US-6 — Hygiene: LoginEvent FK drift fix
- [ ] Confirm via `psql` / `prisma db pull --print` whether LoginEvent has FK constraints on `userId` and `memberId` in the deployed databases.
- [ ] If missing: new migration `<timestamp>_login_event_fk_alignment` adds `ALTER TABLE "LoginEvent" ADD CONSTRAINT … FOREIGN KEY … ON DELETE CASCADE` to match `prisma/schema.prisma:418, 420`.
- [ ] If present (hotfix already happened): update the original migration file (`20260504000000_login_events`) to include the FK statements as documentation, AND add the FK constraints to the test branch with the same migration to keep drift from re-emerging.
- [ ] Either way: add explicit `await tx.loginEvent.deleteMany({ where: { memberId } })` to `lib/member-delete.ts` BEFORE the `member.deleteMany` call, so the helper stays correct regardless of FK presence.
- [ ] `tests/integration/member-cascade-delete.test.ts` extended: create a LoginEvent row for the test member, run DELETE, assert no LoginEvent row remains.

## Trace Findings (carried forward)

Three lanes confirmed:

1. **Backend is largely complete** for create + list + detail + delete + sign-in. Gaps: PATCH kid, photos endpoints, sign-kid-waiver. (Lane 1)
2. **Parent UI is hollow** post-onboarding: no add, no edit, no remove, no photo, no in-app waiver sign. The parent-only onboarding fork is half-written (state declared but not consumed). (Lane 2)
3. **Deletion safety is robust** except for a quiet migration drift on LoginEvent: schema says CASCADE, migration omits the FK. Fix isolated in US-6. (Lane 3)

Full trace: `.omc/specs/deep-dive-trace-audit-the-entire-kids-account.md`.

## Technical Context (existing patterns to reuse — do NOT re-invent)

| Pattern | File | Why reuse |
|---|---|---|
| Parent-of-kid composite predicate | `app/api/member/children/[id]/route.ts:23` | Single `findFirst` with `{id, tenantId, parentMemberId}` — never a post-fetch parent-of check (TOCTOU-safe) |
| Cascade-safe Member delete | `lib/member-delete.ts` | Walks every FK-RESTRICT relation in transaction; auto-handles new `MemberPhoto` once CASCADE FK is set |
| Synthetic kid email | `app/api/member/children/route.ts:80-83` | `kid-{uuid}@kids.local` satisfies the NOT NULL + unique constraint; no real address ever required |
| Upload + Vercel Blob fallback | `app/api/upload/route.ts` | Already caps at 2MB; data: URL fallback path for known prod Blob outage |
| `withTenantContext` for all reads | many call-sites | RLS backstop; required for every kid-related query |
| Mode A test infrastructure | `tests/setup-test-db.ts` + `withRlsBypass` + `vi.mock @/auth` | Same skeleton in all 3 Session E test files |
| `assertSameOrigin` CSRF guard | every POST/PATCH/DELETE | Standard pattern across this codebase |

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|---|---|---|---|
| Member (parent) | core | `id, tenantId, accountType="parent", parentMemberId=null` | has many `children: Member[]` |
| Member (kid) | core | `id, tenantId, name, email (synthetic), accountType="kids"|"junior", parentMemberId, dateOfBirth, waiverAccepted` | one `parent: Member` |
| MemberPhoto | new | `id, tenantId, memberId, url, caption, kind, uploadedAt, uploadedByMemberId` | belongs to Member (CASCADE delete) |
| SignedWaiver | existing | `id, tenantId, memberId, collectedBy` | sign-for-child sets `memberId=kid.id, collectedBy=parent.memberId` |
| LoginEvent | existing | `id, tenantId, userId|memberId` | hygiene fix in US-6 |

## Files to modify (full map)

**New files:**
- `prisma/migrations/<timestamp>_member_photos/migration.sql`
- `prisma/migrations/<timestamp>_login_event_fk_alignment/migration.sql` (US-6)
- `lib/member-stats.ts`
- `components/member/EditChildModal.tsx`
- `app/api/member/children/[id]/photos/route.ts`
- `app/api/member/children/[id]/photos/[photoId]/route.ts`
- `app/api/waiver/sign-for-child/route.ts`
- `tests/unit/onboarding-parent-mode.test.tsx`
- `tests/integration/member-children-stats.test.ts`
- `tests/integration/member-children-photos.test.ts`

**Modified files:**
- `prisma/schema.prisma` (add MemberPhoto model, document LoginEvent FK)
- `app/member/home/page.tsx` (onboarding fork + parent-mode dashboard)
- `components/member/FamilySection.tsx` (add/edit/remove UI)
- `app/member/family/[childId]/page.tsx` (stats + photos + waiver-sign)
- `app/api/member/children/[id]/route.ts` (add PATCH, extend GET)
- `app/api/member/me/route.ts` (refactor to use member-stats helper)
- `lib/member-delete.ts` (add LoginEvent cleanup, US-6)
- `tests/integration/member-children-lifecycle.test.ts` (extend with PATCH cases)
- `tests/integration/member-cascade-delete.test.ts` (extend with LoginEvent case)

## Verification

Per ralph iteration (US-1 through US-6 each):
1. `npx tsc --noEmit` clean
2. `npm run build` exit 0
3. Newly added / extended tests run via `npx vitest run <files>` and pass (skip without DB is OK — DB-gated tests skip cleanly per `setup-test-db.ts`)
4. Manual smoke: log in as a parent with zero attendance themselves, walk through the full flow

End-to-end success criterion (the user's stated need):
- Sign up as a parent → pick "I'm here to manage my child" → skip belt/style/heard → add 2 kids inline → land on a kids-focused `/member/home`
- From `/member/profile`: tap "+ Add child" → modal opens → submit → kid appears in list
- Tap a kid row → see rich stats (thisWeek, streak, nextClass) + belt + recent attendance + photo grid + waiver status
- "+ Add Photo" → upload → photo appears immediately; survives reload
- "Sign waiver for [child]" → sign → kid card's amber "Waiver missing" badge disappears
- "Edit" on a kid → rename → persists; "Remove" → cascade-cleans every dependent row including photos
- Sign the kid into class via the Sign-In sheet picker — still works (Session E unchanged)

## Out of scope / catalogue items for follow-up

- Staff dashboard photo viewer
- Belt-promotion-photo flow on the staff promote-rank action
- Replacing the parent's own MILESTONES mock data with real photo timeline
- Renaming the parent-only Member to indicate it's a "guardian" rather than a "member" in staff member lists (UX polish)

## How to hand off to ralph

Use this spec as the input to `Skill("oh-my-claudecode:ralph")`. Each user story (US-1 through US-6) becomes one ralph iteration. The reviewer prompt at `.omc/ralph/reviewer-prompt.md` (Session E foundation) applies as-is; the 6 hard-fail checks are already calibrated against the kids-domain test patterns established by `tests/integration/member-children-lifecycle.test.ts`.

Ralph kick-off prompt:

> Execute the spec at `.omc/specs/deep-dive-audit-the-entire-kids-account.md`. Iterate US-1 → US-6 in order. Each acceptance criterion must be verified with fresh evidence (fresh test run + fresh build) before marking the story complete. Use `lib/member-stats.ts` as the single source of truth for the stats helper introduced in US-4; both `/api/member/me` and `/api/member/children/[id]` must call it.

## Status

Ready to bridge to execution.
