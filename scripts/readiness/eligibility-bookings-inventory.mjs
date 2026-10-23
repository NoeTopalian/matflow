// Inventory of bookings (ClassSubscription rows) that the current eligibility
// rule — a class with a squad list admits only members on it AND a class with
// memberships ticked admits only members on one of them (owner decision,
// 20 Oct 2026) — would refuse at attendance. Read only. The rows are NOT
// changed: they stay until a migration policy is approved; attendance is
// refused on current eligibility, and the member's schedule and the register
// show the refusal reason.
//
//   node scripts/readiness/eligibility-bookings-inventory.mjs --env <file> [--tenant <slug>] [--production]
//
// --env never defaults to .env. Prints counts per class and a JSON summary;
// member ids are not printed, names are masked to initials.
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import dotenv from "dotenv";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const envFile = opt("--env");
const slug = opt("--tenant");

function finish(code, summary) {
  console.log(JSON.stringify(summary));
  process.exit(code);
}

if (!envFile) {
  console.error("--env <file> is required (this script never defaults to .env).");
  finish(1, { ok: false, error: "missing --env" });
}
dotenv.config({ path: envFile, override: true });
const url = process.env.DATABASE_URL ?? "";
if (!url) finish(1, { ok: false, error: "DATABASE_URL unset in env file" });
const host = url.replace(/^.*@/, "").replace(/[/?].*$/, "");
console.log(`env file: ${envFile}   db host: ${host}`);
if (host.includes("ep-bold-wave") && !args.includes("--production")) {
  console.error("This env file points at PRODUCTION. Re-run with --production only if you are the operator and mean it.");
  finish(1, { ok: false, error: "production host without --production" });
}

const initials = (name) => String(name ?? "").split(/\s+/).filter(Boolean).map((w) => w[0]).join("").toUpperCase() || "?";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });

try {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const tenantId = slug ? ((await tx.tenant.findUnique({ where: { slug }, select: { id: true } }))?.id ?? "__none__") : null;
    return tx.$queryRaw`
      SELECT c."tenantId", c."id" AS "classId", c."name" AS "className",
             m."id" AS "memberId", m."name" AS "memberName", m."membershipTierId",
             EXISTS (SELECT 1 FROM "ClassRoster" r WHERE r."classId" = c."id") AS "hasRoster",
             EXISTS (SELECT 1 FROM "ClassRoster" r WHERE r."classId" = c."id" AND r."memberId" = m."id") AS "onRoster",
             EXISTS (SELECT 1 FROM "ClassMembershipTier" t WHERE t."classId" = c."id") AS "hasTiers",
             EXISTS (SELECT 1 FROM "ClassMembershipTier" t WHERE t."classId" = c."id" AND t."tierId" = m."membershipTierId") AS "tierIncluded"
        FROM "ClassSubscription" s
        JOIN "Class" c ON c."id" = s."classId"
        JOIN "Member" m ON m."id" = s."memberId" AND m."tenantId" = c."tenantId"
       WHERE c."deletedAt" IS NULL
         AND (${tenantId}::text IS NULL OR c."tenantId" = ${tenantId})
    `;
  });

  const affected = rows.filter((r) => (r.hasRoster && !r.onRoster) || (r.hasTiers && !r.tierIncluded));
  const byClass = new Map();
  for (const r of affected) {
    const key = `${r.tenantId}:${r.classId}`;
    const entry = byClass.get(key) ?? { tenantId: r.tenantId, classId: r.classId, className: r.className, notOnRoster: 0, tierExcluded: 0, members: [] };
    if (r.hasRoster && !r.onRoster) entry.notOnRoster += 1;
    if (r.hasTiers && !r.tierIncluded) entry.tierExcluded += 1;
    entry.members.push(initials(r.memberName));
    byClass.set(key, entry);
  }
  for (const e of byClass.values()) {
    console.log(`${e.className} (${e.classId}): ${e.members.length} booking(s) refused at attendance — not on roster ${e.notOnRoster}, plan excluded ${e.tierExcluded}; members ${e.members.join(", ")}`);
  }
  finish(0, {
    ok: true,
    bookings: rows.length,
    affected: affected.length,
    classes: [...byClass.values()].map(({ members, ...e }) => ({ ...e, count: members.length })),
    note: "Rows unchanged. Attendance is refused on current eligibility; the member schedule and register show why. Cleanup needs an approved migration policy.",
  });
} finally {
  await prisma.$disconnect();
}
