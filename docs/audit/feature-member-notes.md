# Feature — Member-tickable notes + notes hardening

**Date**: 2026-06-01
**Branch**: `feat/member-tickable-notes`
**Scope**: harden the existing staff-only `Member.notes` field against string-content abuse, then extend the `Task` model so staff can send tickable notes that members see and complete from a single "action list" inside the member app.

## Why

The previous shape had two gaps:

1. **`Member.notes` was safe by accident.** Zod `max(2000)` was the only gate; no DB CHECK, no control-character strip, no rate-limit on `PATCH /api/members/[id]`. React's text-node escaping kept XSS out, but nothing locked that invariant in — one regression could expose it silently.
2. **Members had no to-do surface.** The `Task` model was staff-to-staff only (`assignedToId` → `User`). Members had no way to receive a note from their gym, see what they were expected to do, or tick it off. Things like "sign the new waiver" and "update your card" lived in scattered banners.

The user explicitly asked for the system to make it **clear what is a note vs. what is a built-in to-do**. The answer is a single member action list with two visually distinct item types:

- **member_note** — staff-authored, person icon + creator name + relative time, tickable
- **system** — computed on the fly from member state (waiver, emergency contact, payment), ⚡ icon + "Suggested by MatFlow", resolves automatically when the underlying condition is fixed

## Design invariants (locked in by tests + DB)

### Notes hygiene (Phase 1)

- Every notes column written via the API runs through `notesField(maxLength)` in [lib/schemas/notes-sanitiser.ts](../../lib/schemas/notes-sanitiser.ts) before persistence.
- The sanitiser strips C0/C1 controls (except TAB/LF/CR), zero-width characters, bidi overrides, line/paragraph separators, BOM. Length-rejects BEFORE strip so an attacker cannot pad with controls past the limit. Whitespace-only becomes `null`.
- HTML is NOT escaped in the sanitiser — that's the renderer's job. React text nodes escape automatically. `lib/email.ts escape()` escapes for the HTML email layer.
- Postgres CHECK constraints (`Member_notes_length_check`, `RankHistory_notes_length_check`, `GymApplication_notes_length_check`) backstop the Zod limits at the DB.
- `PATCH /api/members/[id]` is rate-limited to 60 writes/hour per (tenant, user) via `checkRateLimit` ([lib/rate-limit.ts](../../lib/rate-limit.ts)).

### XSS surface (Phase 2)

- `tests/unit/dangerously-set-inner-html-allowlist.test.ts` pins the set of files using `dangerouslySetInnerHTML` to a single entry ([app/member/layout.tsx](../../app/member/layout.tsx) — CSS variable injection from server-validated branding hex values, no user input flows in). Any new call site fails CI until added to the allow-list with a justification.
- The same test asserts no file feeds `member.notes` / `task.body` through `dangerouslySetInnerHTML`.
- `tests/e2e/security/notes-xss-render.spec.ts` runs end-to-end: hostile payload via PATCH, no dialog fires, sanitised string round-trips through the textarea, oversize payload returns 400.

### Task discriminator (Phase 4)

The `Task` model gained four columns and four CHECK constraints:

| Column            | Type           | Purpose                                                                |
|-------------------|----------------|------------------------------------------------------------------------|
| `assigneeMemberId`| `String?`      | XOR with `assignedToId`. Set when the task is addressed to a member.   |
| `body`            | `VarChar(1000)`| Long-form content. Required when `kind='member_note'`.                  |
| `kind`            | `String`       | `'staff_task'` (legacy) or `'member_note'` (new).                       |
| `completedById`   | `String?`      | Audit attribution — who ticked the box (always a User row or NULL).     |

CHECK constraints enforce:
1. `Task_kind_check`: kind ∈ {staff_task, member_note}
2. `Task_assignee_xor_check`: exactly one of (assignedToId, assigneeMemberId) is set
3. `Task_member_note_check`: kind='member_note' ⇒ assigneeMemberId set AND body present
4. `Task_staff_task_check`: kind='staff_task' ⇒ assignedToId set

Duplicate prevention via partial unique index `Task_member_note_open_unique` on `(tenantId, assigneeMemberId, lower(title))` WHERE `kind='member_note' AND status='open'`. Staff can re-send the same action AFTER the member ticked it (annual waiver), but a double-tap during creation returns HTTP 409 with the existing task id.

### Member-facing fetch (Phase 6)

`GET /api/member/tasks` returns a single `{ items: [...] }` array with two kinds:

```ts
type Item =
  | { kind: "member_note"; id; title; body; createdAt; createdBy: { id; name }; href: null }
  | { kind: "system";      id; title; body; createdAt: null; createdBy: null;       href: string };
```

System actions are computed on the fly by [lib/member-actions.ts](../../lib/member-actions.ts) `getMemberSystemActions(memberId)` — same pattern as the staff dashboard's `getStats()`. There is no DB row for a system action; it lives and dies by the condition it tracks.

`POST /api/member/tasks/[id]/complete` is atomic via `updateMany` guarded by `(id, tenantId, assigneeMemberId, kind='member_note', status='open')`. On 0-rows-affected the route disambiguates with `findFirst` to return 404 vs 409 (already-done). System action ids (`sys:*`) cannot be ticked here — they return 400 with a clear error so the resolution must go through fixing the underlying state (signing the waiver, etc.).

## Files of interest

**New**:
- [lib/schemas/notes-sanitiser.ts](../../lib/schemas/notes-sanitiser.ts) — shared `sanitiseNoteText` + `notesField(n)` Zod helper
- [lib/notify-member-action.ts](../../lib/notify-member-action.ts) — fire-and-forget push + email bundle
- [lib/member-actions.ts](../../lib/member-actions.ts) — `getMemberSystemActions(memberId)` helper
- [app/api/member/tasks/route.ts](../../app/api/member/tasks/route.ts) — GET combined action list
- [app/api/member/tasks/[id]/complete/route.ts](../../app/api/member/tasks/%5Bid%5D/complete/route.ts) — POST tick
- [app/member/actions/page.tsx](../../app/member/actions/page.tsx) — full list page
- [components/member/MemberActionsPanel.tsx](../../components/member/MemberActionsPanel.tsx) — compact + full panel
- `prisma/migrations/20260601100000_notes_length_check/` — DB-level length CHECK for every notes column
- `prisma/migrations/20260601110000_task_member_assignee_and_body/` — Task extension + Member.taskAssignments

**Modified**:
- [prisma/schema.prisma](../../prisma/schema.prisma) — Task + Member + User extensions
- [lib/schemas/member.ts](../../lib/schemas/member.ts) — wire notesField
- [lib/email.ts](../../lib/email.ts) — `member_action_assigned` template
- [app/api/members/route.ts](../../app/api/members/route.ts) — `?search=` for the modal combobox
- [app/api/members/[id]/route.ts](../../app/api/members/%5Bid%5D/route.ts) — rate-limit on PATCH
- [app/api/members/[id]/rank/route.ts](../../app/api/members/%5Bid%5D/rank/route.ts) — sanitiser on RankHistory.notes
- [app/api/apply/route.ts](../../app/api/apply/route.ts) — sanitiser on GymApplication.notes
- [app/api/tasks/route.ts](../../app/api/tasks/route.ts) — discriminated-union schema, member_note branch
- [components/dashboard/AddTaskModal.tsx](../../components/dashboard/AddTaskModal.tsx) — staff/member toggle, member combobox, body textarea
- [components/dashboard/DashboardStats.tsx](../../components/dashboard/DashboardStats.tsx) — UserTask extended, member_note rendering
- [components/dashboard/MemberProfile.tsx](../../components/dashboard/MemberProfile.tsx) — "Account Notes" → "Internal Notes" + clarifying copy
- [app/member/home/page.tsx](../../app/member/home/page.tsx) — embed MemberActionsPanel above greeting

## Verification

- `npx tsc --noEmit` — clean
- `npm test -- notes-sanitiser` — 18/18 pass
- `npm test -- dangerously-set-inner-html-allowlist` — 3/3 pass
- `npx playwright test --list tests/e2e/security/notes-xss-render.spec.ts` — 4 tests (2 × dual-project)
- `npm run lint && npm run build` — final pre-commit gate

E2E XSS run + member-tick happy path are TEST_PASSWORD-gated (audit C-1) and run against a real dev server in the next session.

## Follow-ups (not in this PR)

- Notification preference UI (`taskAssignments` toggle) on `/member/profile` — column shipped with `default true`; add the checkbox alongside the existing classReminders / beltPromotions / gymAnnouncements toggles.
- Integration tests for the new `/api/member/tasks` GET + complete paths (cross-tenant isolation, duplicate rejection, member-only auth). Carried as a backlog item — same RB-001 mock-migration scope as [docs/audit/iter-1-tests.md](./iter-1-tests.md).
- "Sent items" view on the staff dashboard so coaches can see which member_notes they've sent and which are still open. Staff GET `/api/tasks` already returns sent items inline — UI just needs a separate tab.
