-- Task 3b: make `skipDuplicates` real on ClassInstance.
--
-- Both generation routes (POST /api/instances/generate, POST
-- /api/classes/[id]/instances) call createMany({ skipDuplicates: true }).
-- That flag only skips rows which would violate a UNIQUE constraint, and
-- ClassInstance had none — only @@index([classId, date]) and
-- @@index([date, isCancelled]). So the flag was decorative, and the only real
-- dedup was a read-then-filter inside a READ COMMITTED transaction: a textbook
-- TOCTOU. Two concurrent clicks, or the per-class button firing alongside the
-- global one, both insert. Duplicate instances split a class's register in two
-- and hand the member schedule an arbitrary one of them.
--
-- Duplicates may therefore already exist in any long-running database. On a
-- clean one every statement before the CREATE INDEX is a no-op.
--
-- ─── Merge policy (deliberate; it destroys rows, so it is stated in full) ────
--
--  * CANONICAL ROW = min(id) within each (classId, date, startTime) group.
--    ClassInstance carries no createdAt, so id is the only deterministic order
--    available — and cuid()s lead with a base36 timestamp, so lexicographic
--    min is also the oldest row in practice.
--
--  * ATTENDANCE. Every AttendanceRecord in the group is ranked per member by
--    (checkInTime, id) and the FIRST one survives — the member's real
--    check-in. The rest are duplicate check-ins that exist only because the
--    occurrence itself was duplicated, and they cannot survive the constraint
--    whichever instance we keep, because AttendanceRecord already carries
--    @@unique([memberId, classInstanceId]). The survivor is then repointed at
--    the canonical instance, so no attendance is lost to the merge — only
--    genuine same-member-same-occurrence duplicates are dropped.
--
--  * PACK CREDITS. A discarded attendance row may back a ClassPackRedemption.
--    The redemption row goes and one credit returns to the pack — EXCEPT on a
--    refunded pack, where the member already has their money back and a credit
--    as well would pay them twice. That is exactly the rule
--    lib/checkin.ts:restorePackCreditsForAttendance applies when the app
--    deletes an attendance record, so an undo through this migration and an
--    undo through the app agree. The pack's `status` is left alone in both
--    cases: resurrecting it would be a billing decision, not an undo.
--
--  * WAITLIST. Same shape, ranked per member by (joinedAt, position, id).
--
--  * CANCELLATION. If ANY row in the group was un-cancelled, the canonical row
--    ends up un-cancelled: the occurrence demonstrably ran. Cancelling a class
--    a member attended would be the more damaging error of the two.
--
--  * EVIDENCE. Before anything is destroyed, one AuditLog row per affected
--    tenant records the surplus instance ids and the discarded attendance /
--    waitlist ids — RULES §5, "record which rows, not just how many; a count
--    cannot restore anything". On a clean database no audit row is written.
--
-- ─── Why not NOT VALID ──────────────────────────────────────────────────────
--
-- The repo's NOT VALID → VALIDATE pattern (20260818200000_payment_money_constraints)
-- applies to CHECK and FK constraints, which Postgres can enforce forwards
-- without scanning history. A UNIQUE index has no such mode: it must scan and
-- it must be clean. Hence the merge above rather than a deferred validation.
-- CREATE UNIQUE INDEX CONCURRENTLY is likewise unavailable — it cannot run
-- inside a transaction block and Prisma wraps migrations in one. The table is
-- small (hundreds of rows per club), so the brief ACCESS EXCLUSIVE lock is
-- acceptable; if that ever stops being true, split this file and run the index
-- build concurrently by hand.

-- ── 1. Evidence first, while the rows still exist ───────────────────────────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT g.instance_id, g.keep_id, c."tenantId"
  FROM grp g
  JOIN "ClassInstance" ci ON ci.id = g.instance_id
  JOIN "Class" c ON c.id = ci."classId"
  WHERE g.n > 1
),
att_discard AS (
  SELECT r.id, r."tenantId"
  FROM (
    SELECT
      a.id,
      d."tenantId",
      row_number() OVER (PARTITION BY d.keep_id, a."memberId" ORDER BY a."checkInTime", a.id) AS rn
    FROM "AttendanceRecord" a
    JOIN dupgroup d ON d.instance_id = a."classInstanceId"
  ) r
  WHERE r.rn > 1
),
wl_discard AS (
  SELECT r.id, r."tenantId"
  FROM (
    SELECT
      w.id,
      d."tenantId",
      row_number() OVER (PARTITION BY d.keep_id, w."memberId" ORDER BY w."joinedAt", w.position, w.id) AS rn
    FROM "ClassWaitlist" w
    JOIN dupgroup d ON d.instance_id = w."classInstanceId"
  ) r
  WHERE r.rn > 1
),
per_tenant AS (
  SELECT
    "tenantId",
    count(DISTINCT keep_id)::int AS groups,
    coalesce(jsonb_agg(DISTINCT instance_id) FILTER (WHERE instance_id <> keep_id), '[]'::jsonb) AS surplus
  FROM dupgroup
  GROUP BY "tenantId"
)
INSERT INTO "AuditLog" (id, "userId", action, "entityType", "entityId", metadata, "tenantId")
SELECT
  gen_random_uuid()::text,
  NULL,
  'class.instances_deduplicated',
  'Tenant',
  t."tenantId",
  jsonb_build_object(
    'migration', '20260819090000_class_instance_unique_slot',
    'reason', 'ClassInstance had no unique constraint, so createMany skipDuplicates was a no-op and concurrent generation inserted duplicate occurrences',
    'duplicateGroups', t.groups,
    'surplusInstanceIds', t.surplus,
    'discardedAttendanceIds', coalesce((SELECT jsonb_agg(a.id) FROM att_discard a WHERE a."tenantId" = t."tenantId"), '[]'::jsonb),
    'discardedWaitlistIds', coalesce((SELECT jsonb_agg(w.id) FROM wl_discard w WHERE w."tenantId" = t."tenantId"), '[]'::jsonb)
  ),
  t."tenantId"
FROM per_tenant t;

-- ── 2. Return the credit behind each duplicate check-in we are about to drop ─
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT instance_id, keep_id FROM grp WHERE n > 1
),
att_ranked AS (
  SELECT
    a.id,
    row_number() OVER (PARTITION BY d.keep_id, a."memberId" ORDER BY a."checkInTime", a.id) AS rn
  FROM "AttendanceRecord" a
  JOIN dupgroup d ON d.instance_id = a."classInstanceId"
),
per_pack AS (
  SELECT r."memberPackId", count(*)::int AS cnt
  FROM "ClassPackRedemption" r
  JOIN att_ranked a ON a.id = r."attendanceRecordId"
  WHERE a.rn > 1
  GROUP BY r."memberPackId"
)
UPDATE "MemberClassPack" p
SET "creditsRemaining" = p."creditsRemaining" + per_pack.cnt
FROM per_pack
WHERE p.id = per_pack."memberPackId"
  AND p.status <> 'refunded';

-- ── 3. Drop those redemption rows (the attendance they point at is going) ────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT instance_id, keep_id FROM grp WHERE n > 1
),
att_ranked AS (
  SELECT
    a.id,
    row_number() OVER (PARTITION BY d.keep_id, a."memberId" ORDER BY a."checkInTime", a.id) AS rn
  FROM "AttendanceRecord" a
  JOIN dupgroup d ON d.instance_id = a."classInstanceId"
)
DELETE FROM "ClassPackRedemption" r
USING att_ranked a
WHERE a.id = r."attendanceRecordId" AND a.rn > 1;

-- ── 4. Drop the duplicate check-ins themselves ──────────────────────────────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT instance_id, keep_id FROM grp WHERE n > 1
),
att_ranked AS (
  SELECT
    a.id,
    row_number() OVER (PARTITION BY d.keep_id, a."memberId" ORDER BY a."checkInTime", a.id) AS rn
  FROM "AttendanceRecord" a
  JOIN dupgroup d ON d.instance_id = a."classInstanceId"
)
DELETE FROM "AttendanceRecord" a
USING att_ranked r
WHERE a.id = r.id AND r.rn > 1;

-- ── 5. Move every surviving check-in onto the canonical occurrence ──────────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT instance_id, keep_id FROM grp WHERE n > 1
)
UPDATE "AttendanceRecord" a
SET "classInstanceId" = d.keep_id
FROM dupgroup d
WHERE a."classInstanceId" = d.instance_id
  AND d.instance_id <> d.keep_id;

-- ── 6. Same for the waitlist: drop per-member duplicates… ───────────────────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT instance_id, keep_id FROM grp WHERE n > 1
),
wl_ranked AS (
  SELECT
    w.id,
    row_number() OVER (PARTITION BY d.keep_id, w."memberId" ORDER BY w."joinedAt", w.position, w.id) AS rn
  FROM "ClassWaitlist" w
  JOIN dupgroup d ON d.instance_id = w."classInstanceId"
)
DELETE FROM "ClassWaitlist" w
USING wl_ranked r
WHERE w.id = r.id AND r.rn > 1;

-- ── 7. …then move the survivors onto the canonical occurrence ───────────────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT instance_id, keep_id FROM grp WHERE n > 1
)
UPDATE "ClassWaitlist" w
SET "classInstanceId" = d.keep_id
FROM dupgroup d
WHERE w."classInstanceId" = d.instance_id
  AND d.instance_id <> d.keep_id;

-- ── 8. A group with any live row keeps a live canonical row ─────────────────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    ci."isCancelled",
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
live_group AS (
  SELECT DISTINCT keep_id FROM grp WHERE n > 1 AND "isCancelled" = false
)
UPDATE "ClassInstance" ci
SET "isCancelled" = false, "cancellationReason" = NULL
FROM live_group
WHERE ci.id = live_group.keep_id
  AND ci."isCancelled" = true;

-- ── 9. Drop the surplus occurrences ─────────────────────────────────────────
WITH grp AS (
  SELECT
    ci.id AS instance_id,
    min(ci.id) OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS keep_id,
    count(*)  OVER (PARTITION BY ci."classId", ci."date", ci."startTime") AS n
  FROM "ClassInstance" ci
),
dupgroup AS (
  SELECT instance_id, keep_id FROM grp WHERE n > 1
)
DELETE FROM "ClassInstance" ci
USING dupgroup d
WHERE ci.id = d.instance_id
  AND d.instance_id <> d.keep_id;

-- ── 10. The constraint the code has been assuming since it was written ──────
CREATE UNIQUE INDEX "ClassInstance_classId_date_startTime_key"
  ON "ClassInstance"("classId", "date", "startTime");
