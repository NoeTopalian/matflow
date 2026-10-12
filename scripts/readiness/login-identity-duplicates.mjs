// Read-only report of LEGACY login-identity duplicates (admin hub AH-01, 9 Oct 2026).
//
// A login address is one identity per club across User AND Member (see
// lib/login-email.ts claimLoginIdentity). Rows written before the claim lock —
// or before the 13 Sep 2026 lower-case backfill, which deliberately skipped
// collisions — can still share one canonical address (trim + lower-case):
//
//   cross-table   a User and a Member in one club on the same address
//   user-user     two staff rows that differ only by case/whitespace
//   member-member two member rows that differ only by case/whitespace
//
// For each club: counts, and per duplicate group the holder kinds and record
// ids plus a KEYED digest of the address (HMAC-SHA256 under a random key made
// for this run only — it tells groups apart inside one report and cannot be
// dictionary-reversed; it is not stable across runs). No address, name or other
// personal field is printed. Nothing is merged or changed: resolution is a
// human decision (docs/runbooks/ACCOUNT-EDITING.md, "What an email means").
//
//   node scripts/readiness/login-identity-duplicates.mjs --env .env.test
//   node scripts/readiness/login-identity-duplicates.mjs --env .env.test --tenant <slug>
//
// --env is REQUIRED (no default: this must never silently read .env, which is
// production). The connection is a READ ONLY transaction. Exit codes:
//   0 ran, no duplicates   3 ran, duplicates found   1 failed (nothing proven)
// The last line is always one JSON summary object.
import { createHmac, randomBytes } from "node:crypto";
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
// Production is read only by the operator, deliberately: it needs --production.
if (host.includes("ep-bold-wave") && !args.includes("--production")) {
  console.error("This env file points at PRODUCTION. Re-run with --production only if you are the operator and mean it.");
  finish(1, { ok: false, error: "production host without --production" });
}

const key = randomBytes(32);
const digest = (k) => createHmac("sha256", key).update(k).digest("hex").slice(0, 16);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 1 }) });

try {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const tenantFilter = slug ? (await tx.tenant.findUnique({ where: { slug }, select: { id: true } }))?.id ?? "__none__" : null;
    const groups = await tx.$queryRaw`
      WITH h AS (
        SELECT "tenantId", 'user'::text AS kind, "id", lower(btrim("email")) AS k, ("email" <> lower(btrim("email"))) AS noncanon FROM "User"
        UNION ALL
        SELECT "tenantId", 'member'::text AS kind, "id", lower(btrim("email")) AS k, ("email" <> lower(btrim("email"))) AS noncanon FROM "Member"
      )
      SELECT h."tenantId" AS "tenantId", t."slug" AS slug, h.k AS k,
             array_agg(h.kind ORDER BY h.kind, h."id") AS kinds,
             array_agg(h."id" ORDER BY h.kind, h."id") AS ids,
             bool_or(h.noncanon) AS noncanon
      FROM h JOIN "Tenant" t ON t."id" = h."tenantId"
      WHERE (${tenantFilter}::text IS NULL OR h."tenantId" = ${tenantFilter}::text)
      GROUP BY h."tenantId", t."slug", h.k
      HAVING count(*) > 1
      ORDER BY t."slug", h.k`;
    const noncanonical = await tx.$queryRaw`
      SELECT
        (SELECT count(*)::int FROM "User" WHERE "email" <> lower(btrim("email")) AND (${tenantFilter}::text IS NULL OR "tenantId" = ${tenantFilter}::text)) AS users,
        (SELECT count(*)::int FROM "Member" WHERE "email" <> lower(btrim("email")) AND (${tenantFilter}::text IS NULL OR "tenantId" = ${tenantFilter}::text)) AS members`;
    const tenants = await tx.$queryRaw`SELECT count(*)::int AS n FROM "Tenant" WHERE (${tenantFilter}::text IS NULL OR "id" = ${tenantFilter}::text)`;
    return { groups, noncanonical: noncanonical[0], tenantsScanned: tenants[0].n };
  });

  const perTenant = new Map();
  for (const g of rows.groups) {
    const kinds = g.kinds;
    const users = kinds.filter((k) => k === "user").length;
    const members = kinds.filter((k) => k === "member").length;
    const shape = users > 0 && members > 0 ? "cross-table" : users > 1 ? "user-user" : "member-member";
    const t = perTenant.get(g.tenantId) ?? { tenantId: g.tenantId, slug: g.slug, crossTable: 0, userUser: 0, memberMember: 0, groups: [] };
    if (shape === "cross-table") t.crossTable += 1;
    else if (shape === "user-user") t.userUser += 1;
    else t.memberMember += 1;
    t.groups.push({ addressDigest: digest(g.k), shape, holders: kinds.map((k, i) => ({ kind: k, id: g.ids[i] })), mixedCaseOrWhitespace: g.noncanon });
    perTenant.set(g.tenantId, t);
  }
  for (const t of perTenant.values()) {
    console.log(`club ${t.slug} (${t.tenantId}): cross-table ${t.crossTable}, user-user ${t.userUser}, member-member ${t.memberMember}`);
    for (const g of t.groups) {
      console.log(`  ${g.addressDigest} ${g.shape}${g.mixedCaseOrWhitespace ? " (non-canonical spelling)" : ""}: ${g.holders.map((h) => `${h.kind}:${h.id}`).join(", ")}`);
    }
  }
  const totals = {
    crossTable: [...perTenant.values()].reduce((a, t) => a + t.crossTable, 0),
    userUser: [...perTenant.values()].reduce((a, t) => a + t.userUser, 0),
    memberMember: [...perTenant.values()].reduce((a, t) => a + t.memberMember, 0),
  };
  const found = totals.crossTable + totals.userUser + totals.memberMember;
  console.log(`clubs scanned: ${rows.tenantsScanned}; clubs with duplicates: ${perTenant.size}; non-canonical stored addresses: users ${rows.noncanonical.users}, members ${rows.noncanonical.members}`);
  await prisma.$disconnect();
  finish(found > 0 ? 3 : 0, {
    ok: true,
    host,
    tenant: slug ?? "all",
    tenantsScanned: rows.tenantsScanned,
    clubsWithDuplicates: perTenant.size,
    duplicateGroups: totals,
    nonCanonicalStored: rows.noncanonical,
  });
} catch (e) {
  console.error("login-identity-duplicates failed:", String(e?.message ?? e).slice(0, 300));
  await prisma.$disconnect().catch(() => {});
  finish(1, { ok: false, error: "query failed" });
}
