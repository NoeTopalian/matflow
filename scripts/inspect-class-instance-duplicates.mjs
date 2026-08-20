/**
 * One-off inspection for the ClassInstance uniqueness migration (task 3b).
 *
 * Reports, for whatever database DATABASE_URL points at:
 *   - how many (classId, date, startTime) groups hold more than one row,
 *   - how many surplus rows that is,
 *   - how many AttendanceRecord / ClassWaitlist rows hang off the surplus,
 *   - how many of those would COLLIDE on the merge target's unique key
 *     (AttendanceRecord @@unique([memberId, classInstanceId]),
 *      ClassWaitlist   @@unique([memberId, classInstanceId])).
 *
 * Read-only. Never point this at production; run it with DATABASE_URL set to
 * the value of TEST_DATABASE_URL from .env.test.
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

const client = new Client({ connectionString: url });
await client.connect();

const q = async (label, sql) => {
  const res = await client.query(sql);
  console.log(`\n--- ${label} ---`);
  console.table(res.rows);
  return res.rows;
};

await q("total ClassInstance rows", `SELECT count(*)::int AS rows FROM "ClassInstance"`);

await q(
  "duplicate groups on (classId, date, startTime)",
  `SELECT count(*)::int AS groups, coalesce(sum(n - 1), 0)::int AS surplus_rows
   FROM (
     SELECT count(*) AS n
     FROM "ClassInstance"
     GROUP BY "classId", "date", "startTime"
     HAVING count(*) > 1
   ) g`,
);

await q(
  "worst offenders (top 10 groups)",
  `SELECT "classId", "date", "startTime", count(*)::int AS n
   FROM "ClassInstance"
   GROUP BY "classId", "date", "startTime"
   HAVING count(*) > 1
   ORDER BY count(*) DESC
   LIMIT 10`,
);

// Surplus = every row in a duplicate group that is NOT the canonical MIN(id).
const surplusCte = `
  WITH canonical AS (
    SELECT "classId", "date", "startTime", min(id) AS keep_id, count(*) AS n
    FROM "ClassInstance"
    GROUP BY "classId", "date", "startTime"
    HAVING count(*) > 1
  ),
  surplus AS (
    SELECT ci.id AS loser_id, c.keep_id
    FROM "ClassInstance" ci
    JOIN canonical c
      ON ci."classId" = c."classId" AND ci."date" = c."date" AND ci."startTime" = c."startTime"
    WHERE ci.id <> c.keep_id
  )`;

await q(
  "AttendanceRecord rows on surplus instances, and how many collide on merge",
  `${surplusCte}
   SELECT
     count(*)::int AS attendance_on_surplus,
     count(*) FILTER (
       WHERE EXISTS (
         SELECT 1 FROM "AttendanceRecord" w
         WHERE w."classInstanceId" = s.keep_id AND w."memberId" = a."memberId"
       )
     )::int AS would_collide
   FROM surplus s
   JOIN "AttendanceRecord" a ON a."classInstanceId" = s.loser_id`,
);

await q(
  "ClassWaitlist rows on surplus instances, and how many collide on merge",
  `${surplusCte}
   SELECT
     count(*)::int AS waitlist_on_surplus,
     count(*) FILTER (
       WHERE EXISTS (
         SELECT 1 FROM "ClassWaitlist" w
         WHERE w."classInstanceId" = s.keep_id AND w."memberId" = cw."memberId"
       )
     )::int AS would_collide
   FROM surplus s
   JOIN "ClassWaitlist" cw ON cw."classInstanceId" = s.loser_id`,
);

await q(
  "ClassPackRedemption rows attached to attendance on surplus instances",
  `${surplusCte}
   SELECT count(*)::int AS redemptions_on_surplus
   FROM surplus s
   JOIN "AttendanceRecord" a ON a."classInstanceId" = s.loser_id
   JOIN "ClassPackRedemption" r ON r."attendanceRecordId" = a.id`,
);

await q(
  "isCancelled disagreement inside a duplicate group",
  `SELECT count(*)::int AS groups_with_mixed_cancellation
   FROM (
     SELECT "classId", "date", "startTime"
     FROM "ClassInstance"
     GROUP BY "classId", "date", "startTime"
     HAVING count(*) > 1 AND count(DISTINCT "isCancelled") > 1
   ) g`,
);

await client.end();
