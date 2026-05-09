# Rank / Class-Access Hardening + Comp-Class Roster — Spec

**Date:** 2026-05-09
**Status:** Approved 2026-05-09 (brainstorming + 4-lane deep-dive trace)
**Sub-project:** #2 of 5 in the rank/wizard cluster (the other four — custom rank construction, members-page preview, "Other" questionnaire textbox, group-chat link in socials — are scoped separately).

## Context

Today MatFlow gates class access via `Class.requiredRankId` / `Class.maxRankId` (rank-system-based, see [docs/MATFLOW-PIPELINES.md](MATFLOW-PIPELINES.md) §2.7). The owner asked for two things bundled:

1. **Add a third gating mode**: per-class allow-list ("competition class" — owner picks specific members). Mutually exclusive with rank gates at the form level.
2. **Stress-test and harden the existing rank/access system** against edge cases: class deletion, member demotion, rank-system soft-delete, roster lifecycle, kid accounts, suspended tenants, cross-tenant safety, member-portal visibility.

A 4-lane deep-dive trace produced ~50 findings. This spec covers **27 in-scope** items; **5 P1-grade findings are flagged as out-of-scope** and tracked at the bottom for separate PRs.

## Locked decisions

| # | Decision |
|---|---|
| 1 | New `ClassRoster` join table at the **Class level** (not class-instance) |
| 2 | Mutual exclusion between rank gates and roster: enforced at the API layer, not via DB CHECK constraint |
| 3 | UI: existing rank pickers stay; a smaller "+ Select specific people" link below them. Clicking it expands a member picker AND clears the rank fields |
| 4 | Member-portal visibility for **rank-ineligible** classes: shown-with-lock + caption ("Blue belt and above") |
| 5 | Member-portal visibility for **roster-only classes the member is NOT on**: hidden entirely (invite-only) |
| 6 | Demotion notifications to member: **only if owner ticks "notify"** in the demotion modal (silent corrections allowed by default) |
| 7 | When member loses access (demotion OR roster removal): cascade-cancel their `ClassSubscription` for affected classes. Symmetric. |

## Data model

### New: `ClassRoster`

```prisma
model ClassRoster {
  id            String   @id @default(cuid())
  tenantId      String
  tenant        Tenant   @relation(fields: [tenantId], references: [id])
  classId       String
  class         Class    @relation(fields: [classId], references: [id], onDelete: Cascade)
  memberId      String
  member        Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  addedAt       DateTime @default(now())
  addedByUserId String?
  addedByUser   User?    @relation(fields: [addedByUserId], references: [id], onDelete: SetNull)
  @@unique([classId, memberId])
  @@index([tenantId, classId])
  @@index([tenantId, memberId])
}
```

Cascades: Class delete → roster cascades; Member hard-delete → roster cascades; User (operator) delete → SetNull on `addedByUserId`.

Access mode is **derived**, not stored:
- `requiredRankId IS NULL` AND `maxRankId IS NULL` AND no roster rows → **everyone**
- Rank fields set, no roster rows → **rank-gated**
- Roster rows exist → **roster-only** (rank fields enforced-null at save)

### Schema fixes (in scope)

- `RankSystem` DELETE endpoint at [app/api/ranks/[id]/route.ts:74-78](../app/api/ranks/[id]/route.ts#L74-L78): change from hard-delete to soft-delete (`deletedAt = now()`).
- All `RankSystem` reads filter `deletedAt: null` (currently inconsistent — [app/api/ranks/route.ts:20-26](../app/api/ranks/route.ts#L20-L26) doesn't, [lib/promotion-candidates.ts:104](../lib/promotion-candidates.ts#L104) does).
- `Class.requiredRank` / `maxRank` includes filter `rankSystem.deletedAt: null` ([app/api/classes/[id]/route.ts:25-26](../app/api/classes/[id]/route.ts#L25-L26), [app/api/members/[id]/rank/route.ts:43-46](../app/api/members/[id]/rank/route.ts#L43-L46)).

## API changes

### Class CRUD ([app/api/classes/[id]/route.ts](../app/api/classes/[id]/route.ts))
- PATCH: enforce mutual exclusion. If `requiredRankId` or `maxRankId` set in payload, server clears any existing `ClassRoster` rows. If a roster array is passed, server clears `requiredRankId` and `maxRankId`.
- PATCH `?dryRun=1`: returns affected member IDs (those who would lose access) + counts. UI shows preview modal; second PATCH (no dryRun) commits + cascade-cancels affected `ClassSubscription` rows.
- DELETE: pre-check attendance count + roster count; return 409 with counts if non-zero unless `?force=true`.

### New: roster management
- `GET /api/classes/[id]/roster` — list current roster (owner/manager/admin).
- `POST /api/classes/[id]/roster` — add member. Validates `class.tenantId === session.tenantId === member.tenantId`. Rejects if class has rank gates set (mutual exclusion).
- `DELETE /api/classes/[id]/roster/[memberId]` — remove member. Cascade-cancels any `ClassSubscription` for that class.

### New: demotion endpoint ([app/api/members/[id]/rank/demote/route.ts](../app/api/members/[id]/rank/demote/route.ts))
POST body: `{ toRankId: string, reason?: string, notify?: boolean }`.
Effect: writes new `MemberRank`, writes `RankHistory` with new audit code `member.rank.demote`, cascade-cancels `ClassSubscription` for now-ineligible classes, optionally emails member if `notify=true`.

### Concurrency
- Rank assignment ([app/api/members/[id]/rank/route.ts:48-54](../app/api/members/[id]/rank/route.ts#L48-L54)): switch from create-then-catch-unique to `upsert`; both audit rows logged.

### Check-in ([lib/checkin.ts](../lib/checkin.ts))
Add roster gate to the coverage decision tree (currently lines 106-208). Behaviour by method (mirrors existing rank-gate behaviour):
- **self** (member-initiated): rank AND roster gates ENFORCED
- **admin** (staff override): both BYPASSED
- **kiosk** (token-gated): rank AND roster gates ENFORCED; coverage forgiving as today

## UI changes

### Class edit form ([components/dashboard/TimetableManager.tsx](../components/dashboard/TimetableManager.tsx))
- Below existing rank pickers: `[ + Select specific people ]` link. Clicking expands a member picker (search + chips). Reuse the search-and-chip pattern already in [components/dashboard/AdminCheckin.tsx](../components/dashboard/AdminCheckin.tsx).
- Adding to the picker clears the rank fields (disabled with "switch back to rank gate" link).
- On tightening rank gate or switching mode: pre-save `?dryRun=1` call → confirm modal with affected count.
- On DELETE of a class: confirm dialog with attendance + roster counts.

### Member portal — schedule ([app/member/schedule/page.tsx](../app/member/schedule/page.tsx))
- Server returns classes with `eligibility: "ok" | "rank_below" | "rank_above"`. Roster-only classes the member is NOT on are filtered out **server-side** (security, not just UI).
- Class card renders lock badge + caption ("Blue belt and above") when `eligibility !== "ok"`. Click is disabled.
- "Comp team" tag on card when member is on the class's roster.

### Owner-side rank-system management
- Rename rank: confirm modal "Rename will be reflected for all members holding this rank. Continue?".
- Delete RankSystem: confirm modal lists classes pointing at it; refuses delete if any depend (must reassign first).

### Member portal — rank notifications
- Promotion: in-app toast on next login. Email only if owner ticks "notify" in promotion modal. New template: `rank_promoted`.
- Demotion: in-app banner on `/member/home` until dismissed. Email only if owner ticks "notify". New template: `rank_demoted`.

## Edge case catalogue (27 items)

### Group 1 — Lifecycle cascades
1. Class deleted → ClassRoster rows cascade
2. Member hard-deleted → ClassRoster + MemberRank rows cascade
3. RankSystem soft-deleted → MemberRank rows survive but skipped via `deletedAt: null` filter
4. RankSystem soft-deleted → Class.requiredRank/maxRank includes filter `rankSystem.deletedAt: null`
5. User (operator) deleted → ClassRoster.addedByUserId SetNull
6. DSAR-erased member with rank → MemberRank row kept (aggregate signal); member surfaces as "Deleted member"

### Group 2 — State change semantics
7. Member promoted at 20:00 → can attend 20:00 blue+ class (intentional; UI hint to staff)
8. Member demoted → ClassSubscription cancelled for ineligible classes; future check-in attempts fail at the door with friendly message
9. Class rank-gate tightened → pre-save dry-run preview shows affected count; on commit, cascade-cancel
10. Class mode changed (rank → roster, etc.) → same dry-run + cascade
11. Roster member removed → ClassSubscription for that class cancelled; past attendance untouched
12. Rank renamed → takes effect immediately (rank referenced by ID, name is label)
13. Rank reordered or middle-deleted → soft-delete only; reordering via existing `order` int field

### Group 3 — Concurrency
14. Concurrent rank assignment by two staff → `upsert` + last-write-wins; both audit rows logged
15. Concurrent roster-add → `@@unique([classId, memberId])` catches dupe, second request returns 409
16. Class config edit race → last-write-wins + audit log

### Group 4 — Special accounts
17. Kid accounts can hold MemberRank (kids' belts are real)
18. Kid accounts can be on ClassRoster
19. DSAR-erased member with rank: row kept, surfaces as "Deleted member" + colour belt

### Group 5 — Cross-tenant
20. Roster add validates `class.tenantId === session.tenantId === member.tenantId`; reject 403 on any mismatch
21. Operator impersonation: roster ops attribute via existing `actingAs` audit pattern

### Group 6 — UX / messaging
22. Member sees rank-ineligible class with lock badge + caption
23. Member doesn't see roster-only classes they're not on
24. Self-check-in rejection includes "ask your coach about promotion" recovery hint
25. Owner warning before tightening rank gate
26. Owner warning before deleting class with attendances OR active roster (counts)
27. Owner warning before deleting RankSystem with dependent classes (list shown)

## Out of scope — flagged P1s for separate PRs

| ID | Severity | What | Why deferred |
|---|---|---|---|
| O1 | P1 | `Class.maxCapacity` not enforced in [lib/checkin.ts:184-194](../lib/checkin.ts#L184-L194) — capacity-1 + concurrent self-check-in = both succeed | Capacity enforcement is a separate concurrency story |
| O2 | P1 | Past `AttendanceRecord` DELETE has no temporal gate — staff can delete arbitrarily old attendance | Immutability is its own audit-integrity story |
| O3 | P1 | Suspended-tenant JWTs continue to work mid-session — `withTenantContext` doesn't re-check `subscriptionStatus` | RLS-layer hardening |
| O4 | P1 | [lib/reports.ts](../lib/reports.ts) attendance aggregates miss `class.deletedAt` filter | Reports-module bug |
| O5 | P2 | Edge runtime sessionVersion not validated; mitigated today because all check-in routes are Node | Doc-only fix |

## Critical files

**Schema:**
- `prisma/schema.prisma` — add `ClassRoster`, RankSystem soft-delete consistency
- New migration: `prisma/migrations/<ts>_add_class_roster/migration.sql`

**Server:**
- `app/api/classes/[id]/route.ts` — PATCH dry-run, DELETE with counts, mutual exclusion
- `app/api/classes/[id]/roster/route.ts` (NEW)
- `app/api/classes/[id]/roster/[memberId]/route.ts` (NEW)
- `app/api/members/[id]/rank/demote/route.ts` (NEW)
- `app/api/members/[id]/rank/route.ts` — create→upsert; rename audit code
- `app/api/ranks/route.ts` — `deletedAt: null` filter
- `app/api/ranks/[id]/route.ts` — soft-delete; refuse if classes depend
- `app/api/member/schedule/route.ts` — eligibility flag + roster filter
- `lib/checkin.ts` — roster gate in coverage decision tree

**Client:**
- `components/dashboard/TimetableManager.tsx` — picker + dry-run modal
- `app/dashboard/members/[id]/page.tsx` — show class-roster memberships
- `app/member/schedule/page.tsx` — lock badges + filter
- `app/member/home/page.tsx` — demotion banner

**Email templates** (`lib/email.ts` `TemplateId` union):
- `rank_promoted` (NEW)
- `rank_demoted` (NEW)

## Verification

### Unit tests (`tests/unit/`)
- `class-roster-cascade.test.ts` — Class delete cascades roster; Member hard-delete cascades roster; User delete sets addedByUserId null
- `rank-gate-mutual-exclusion.test.ts` — PATCH with rank fields clears roster; PATCH with roster clears rank fields
- `demotion-cascade.test.ts` — demote → ClassSubscription cancelled for ineligible classes
- `roster-removal-cascade.test.ts` — remove from roster → ClassSubscription cancelled for that class

### Integration tests (`tests/integration/`)
- `roster-cross-tenant.test.ts` — POST roster with cross-tenant memberId returns 403
- `ranksystem-soft-delete.test.ts` — soft-deleted RankSystem hidden from list; classes pointing at it report "rank deleted"

### E2E tests (`tests/e2e/`)
- `owner-roster-flow.spec.ts` — owner creates class → switches to roster mode → adds 2 members → one self-check-ins (allowed) → other tries (rejected)
- `owner-tighten-rank-gate.spec.ts` — class with 5 white-belt subscribers → owner sets requiredRank=blue → confirm modal shows count → commit → 5 ClassSubscription rows cancelled

### Manual smoke (dev server, port 3847)
- Create comp class with roster of 2 members; non-rostered members don't see it on `/member/schedule`
- Demote a member below a class's rank gate; ClassSubscription cancelled; `/member/home` banner appears (if `notify=true`)
- Delete a class with active roster — 409 + count surfaces in UI

### Pre-merge
- `npm run lint && npm test && npm run build` clean
- `npx prisma migrate dev` applies cleanly

## Risks

- **Mutual-exclusion enforced at API not DB**: future code paths bypassing the API (raw SQL, Prisma Studio) could create inconsistent state. Mitigation: documented contract + integration test coverage.
- **Cascade-cancel of ClassSubscription on demotion is destructive** — if the owner mis-clicks demote, subscriptions are gone. Mitigation: demotion modal includes a "Confirm demotion" step with the cancellation count shown.
- **Member-portal visibility filter for roster-only classes** uses server-side filtering. Mitigation: filter in API layer not page layer; integration test confirms.

## Out of scope (do not implement here)

- Custom rank construction in wizard stage 3 (sub-project #1)
- Members-page preview in wizard branding stage 5 (sub-project #3)
- "Other" textbox on questionnaire stage 6 (sub-project #4)
- Group-chat link in socials settings (sub-project #5)
- The 5 P1s flagged above (O1-O5)
