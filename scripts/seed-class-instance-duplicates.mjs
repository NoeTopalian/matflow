/**
 * Seeds a deliberately duplicated ClassInstance group into a TEST database so
 * migration 20260819090000_class_instance_unique_slot's merge path can be
 * exercised against real rows rather than merely reviewed.
 *
 * Every id is prefixed `dedupe-fixture-` so `--clean` removes exactly what this
 * put in and nothing else. Read tests/integration/README.md first — never point
 * DATABASE_URL at production.
 *
 *   node scripts/seed-class-instance-duplicates.mjs          # seed
 *   node scripts/seed-class-instance-duplicates.mjs --verify # report state
 *   node scripts/seed-class-instance-duplicates.mjs --clean  # remove fixtures
 *
 * Shape seeded (one class occurrence, three rows for it):
 *
 *   keep     … id sorts first, isCancelled = TRUE   ← canonical
 *   surplus1 … isCancelled = FALSE
 *   surplus2 … isCancelled = FALSE
 *
 *   member A: attendance on `keep` (LATER check-in, backed by a pack credit)
 *             and on `surplus1` (EARLIER check-in)      → earliest must survive,
 *                                                         the later one is
 *                                                         dropped and its credit
 *                                                         returned
 *   member B: attendance on `surplus2` only              → must be repointed,
 *                                                         never dropped
 *   member A: waitlist on `keep` (later) and `surplus1` (earlier)
 *   member B: waitlist on `surplus2` only
 */
import { Client } from "pg";

const PROD_NEON_ENDPOINT = "ep-bold-wave-abt39t7x";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}
if (url.includes(PROD_NEON_ENDPOINT)) {
  console.error("REFUSING: DATABASE_URL points at the production Neon endpoint.");
  process.exit(1);
}

const P = "dedupe-fixture-";
const KEEP = `${P}inst-1-keep`;
const SUR1 = `${P}inst-2-surplus`;
const SUR2 = `${P}inst-3-surplus`;
const PACK = `${P}classpack`;
const MPACK = `${P}memberpack`;
const SLOT_DATE = "2031-03-04 00:00:00";
const SLOT_START = "18:00";

const mode = process.argv[2] ?? "--seed";
const c = new Client({ connectionString: url });
await c.connect();

async function pick() {
  const cls = await c.query(
    `SELECT id, "tenantId" FROM "Class" ORDER BY id LIMIT 1`,
  );
  if (cls.rows.length === 0) throw new Error("no Class rows in this database");
  const { id: classId, tenantId } = cls.rows[0];
  const members = await c.query(
    `SELECT id FROM "Member" WHERE "tenantId" = $1 ORDER BY id LIMIT 2`,
    [tenantId],
  );
  if (members.rows.length < 2) throw new Error(`tenant ${tenantId} has fewer than 2 members`);
  return { classId, tenantId, memberA: members.rows[0].id, memberB: members.rows[1].id };
}

async function clean() {
  await c.query(`DELETE FROM "ClassPackRedemption" WHERE id LIKE $1`, [`${P}%`]);
  await c.query(`DELETE FROM "AttendanceRecord" WHERE id LIKE $1`, [`${P}%`]);
  await c.query(`DELETE FROM "ClassWaitlist" WHERE id LIKE $1`, [`${P}%`]);
  await c.query(`DELETE FROM "MemberClassPack" WHERE id LIKE $1`, [`${P}%`]);
  await c.query(`DELETE FROM "ClassPack" WHERE id LIKE $1`, [`${P}%`]);
  await c.query(`DELETE FROM "ClassInstance" WHERE id LIKE $1`, [`${P}%`]);
  await c.query(`DELETE FROM "AuditLog" WHERE action = 'class.instances_deduplicated'`);
  console.log("fixtures removed");
}

async function verify() {
  const rows = await c.query(
    `SELECT id, "isCancelled" FROM "ClassInstance" WHERE id LIKE $1 ORDER BY id`,
    [`${P}%`],
  );
  console.log("\nClassInstance rows remaining:");
  console.table(rows.rows);

  const att = await c.query(
    `SELECT id, "memberId", "classInstanceId", "checkInTime" FROM "AttendanceRecord"
     WHERE id LIKE $1 ORDER BY id`,
    [`${P}%`],
  );
  console.log("AttendanceRecord rows remaining:");
  console.table(att.rows);

  const wl = await c.query(
    `SELECT id, "memberId", "classInstanceId", "joinedAt" FROM "ClassWaitlist"
     WHERE id LIKE $1 ORDER BY id`,
    [`${P}%`],
  );
  console.log("ClassWaitlist rows remaining:");
  console.table(wl.rows);

  const pack = await c.query(
    `SELECT id, "creditsRemaining", status FROM "MemberClassPack" WHERE id LIKE $1`,
    [`${P}%`],
  );
  console.log("MemberClassPack:");
  console.table(pack.rows);

  const red = await c.query(
    `SELECT id, "attendanceRecordId" FROM "ClassPackRedemption" WHERE id LIKE $1`,
    [`${P}%`],
  );
  console.log("ClassPackRedemption rows remaining:");
  console.table(red.rows);

  const audit = await c.query(
    `SELECT "tenantId", metadata FROM "AuditLog" WHERE action = 'class.instances_deduplicated'`,
  );
  console.log("AuditLog evidence rows:", audit.rows.length);
  for (const r of audit.rows) console.log(JSON.stringify(r.metadata, null, 2));

  const idx = await c.query(
    `SELECT indexname FROM pg_indexes
     WHERE tablename = 'ClassInstance' AND indexname = 'ClassInstance_classId_date_startTime_key'`,
  );
  console.log("unique index present:", idx.rows.length === 1);
}

if (mode === "--clean") {
  await clean();
  await c.end();
  process.exit(0);
}
if (mode === "--verify") {
  await verify();
  await c.end();
  process.exit(0);
}

const { classId, tenantId, memberA, memberB } = await pick();
console.log({ classId, tenantId, memberA, memberB });
await clean();

for (const [id, cancelled] of [[KEEP, true], [SUR1, false], [SUR2, false]]) {
  await c.query(
    `INSERT INTO "ClassInstance" (id, "classId", "date", "startTime", "endTime", "isCancelled", "cancellationReason")
     VALUES ($1, $2, $3::timestamp, $4, '19:00', $5, $6)`,
    [id, classId, SLOT_DATE, SLOT_START, cancelled, cancelled ? "seeded as cancelled" : null],
  );
}

// Member A checked in twice for the same occurrence — the collision case.
// The EARLIER row sits on a surplus instance, so "earliest wins" has to move a
// row rather than simply keep whatever was already canonical.
await c.query(
  `INSERT INTO "AttendanceRecord" (id, "memberId", "classInstanceId", "checkInTime", "checkInMethod", "tenantId")
   VALUES ($1, $2, $3, '2031-03-04 18:05:00'::timestamp, 'self', $4)`,
  [`${P}att-A-later-on-keep`, memberA, KEEP, tenantId],
);
await c.query(
  `INSERT INTO "AttendanceRecord" (id, "memberId", "classInstanceId", "checkInTime", "checkInMethod", "tenantId")
   VALUES ($1, $2, $3, '2031-03-04 17:55:00'::timestamp, 'kiosk', $4)`,
  [`${P}att-A-earlier-on-surplus`, memberA, SUR1, tenantId],
);
// Member B exists only on a surplus row — must survive by being repointed.
await c.query(
  `INSERT INTO "AttendanceRecord" (id, "memberId", "classInstanceId", "checkInTime", "checkInMethod", "tenantId")
   VALUES ($1, $2, $3, '2031-03-04 18:01:00'::timestamp, 'admin', $4)`,
  [`${P}att-B-on-surplus`, memberB, SUR2, tenantId],
);

// A pack credit behind the attendance row that is about to be discarded.
await c.query(
  `INSERT INTO "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", "updatedAt")
   VALUES ($1, $2, 'Dedupe fixture pack', 10, 90, 5000, CURRENT_TIMESTAMP)`,
  [PACK, tenantId],
);
await c.query(
  `INSERT INTO "MemberClassPack" (id, "tenantId", "memberId", "packId", "creditsRemaining", "expiresAt", status)
   VALUES ($1, $2, $3, $4, 5, '2032-01-01 00:00:00'::timestamp, 'active')`,
  [MPACK, tenantId, memberA, PACK],
);
await c.query(
  `INSERT INTO "ClassPackRedemption" (id, "memberPackId", "attendanceRecordId")
   VALUES ($1, $2, $3)`,
  [`${P}redemption`, MPACK, `${P}att-A-later-on-keep`],
);

// Waitlist mirrors the attendance shape.
await c.query(
  `INSERT INTO "ClassWaitlist" (id, "memberId", "classInstanceId", position, "joinedAt", status)
   VALUES ($1, $2, $3, 2, '2031-03-01 10:00:00'::timestamp, 'waiting')`,
  [`${P}wl-A-later-on-keep`, memberA, KEEP],
);
await c.query(
  `INSERT INTO "ClassWaitlist" (id, "memberId", "classInstanceId", position, "joinedAt", status)
   VALUES ($1, $2, $3, 1, '2031-02-28 10:00:00'::timestamp, 'waiting')`,
  [`${P}wl-A-earlier-on-surplus`, memberA, SUR1],
);
await c.query(
  `INSERT INTO "ClassWaitlist" (id, "memberId", "classInstanceId", position, "joinedAt", status)
   VALUES ($1, $2, $3, 3, '2031-03-02 10:00:00'::timestamp, 'waiting')`,
  [`${P}wl-B-on-surplus`, memberB, SUR2],
);

console.log("seeded 3 duplicate instances, 3 attendance rows, 3 waitlist rows, 1 redemption");
await verify();
await c.end();
