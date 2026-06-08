-- feat/member-tickable-notes Phase 4 + Phase 5: extend Task model to support
-- member assignees, optional body content, kind discriminator, and ticked-by
-- attribution. Add Member.taskAssignments notification preference.
--
-- Design invariants the CHECK constraints lock in:
--   1. Task_assignee_xor_check    : exactly one of (assignedToId, assigneeMemberId)
--      is set. Tasks always have an assignee.
--   2. Task_kind_check            : kind ∈ {staff_task, member_note}.
--   3. Task_member_note_check     : kind='member_note' ⇒ assigneeMemberId
--      set AND body present.
--   4. Task_staff_task_check      : kind='staff_task' ⇒ assignedToId set.
--
-- Duplicate-prevention partial unique index Task_member_note_open_unique:
--   For OPEN member_notes only, (tenantId, assigneeMemberId, lower(title)) is
--   unique. Lets staff re-send the same action AFTER the member ticked it
--   ("Sign new waiver" each year), but blocks accidental double-send while
--   the same action is still on the member's list.
--
-- All ALTERs are idempotent via DROP/ADD CONSTRAINT IF EXISTS + ADD COLUMN
-- IF NOT EXISTS so re-applying on a test branch is safe.

-- ─────────────────────────────────────────────────────────────────────────
-- Task columns
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "assigneeMemberId" TEXT;
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "body" VARCHAR(1000);
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'staff_task';
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "completedById" TEXT;

-- Foreign keys (Member assignee + User completer). SET NULL keeps task
-- history visible after the referenced row is deleted — mirrors the
-- existing TaskCreatedBy / TaskAssignedTo behaviour.
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_assigneeMemberId_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeMemberId_fkey"
  FOREIGN KEY ("assigneeMemberId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_completedById_fkey";
ALTER TABLE "Task" ADD CONSTRAINT "Task_completedById_fkey"
  FOREIGN KEY ("completedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- CHECK constraints — the invariants the application layer relies on.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_kind_check";
ALTER TABLE "Task" ADD CONSTRAINT "Task_kind_check"
  CHECK ("kind" IN ('staff_task', 'member_note'));

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_assignee_xor_check";
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignee_xor_check"
  CHECK (
    (("assignedToId" IS NOT NULL)::int + ("assigneeMemberId" IS NOT NULL)::int) = 1
  );

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_member_note_check";
ALTER TABLE "Task" ADD CONSTRAINT "Task_member_note_check"
  CHECK (
    "kind" <> 'member_note'
    OR ("assigneeMemberId" IS NOT NULL AND "body" IS NOT NULL AND char_length("body") > 0)
  );

ALTER TABLE "Task" DROP CONSTRAINT IF EXISTS "Task_staff_task_check";
ALTER TABLE "Task" ADD CONSTRAINT "Task_staff_task_check"
  CHECK ("kind" <> 'staff_task' OR "assignedToId" IS NOT NULL);

-- ─────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────
-- Member-side fetch path: GET /api/member/tasks filters on
-- (tenantId, assigneeMemberId, status='open').
CREATE INDEX IF NOT EXISTS "Task_tenantId_status_assigneeMemberId_idx"
  ON "Task" ("tenantId", "status", "assigneeMemberId");

-- Duplicate-prevention partial unique index. Open member_note tasks with
-- the same case-insensitive title for the same member are rejected at the
-- DB level (Prisma surfaces this as P2002 → the API returns 409 with the
-- existing taskId so the staff UI can link to it).
CREATE UNIQUE INDEX IF NOT EXISTS "Task_member_note_open_unique"
  ON "Task" ("tenantId", "assigneeMemberId", lower("title"))
  WHERE "kind" = 'member_note' AND "status" = 'open';

-- ─────────────────────────────────────────────────────────────────────────
-- Member.taskAssignments preference column (Phase 5 notification gate)
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "Member" ADD COLUMN IF NOT EXISTS "taskAssignments" BOOLEAN NOT NULL DEFAULT true;
