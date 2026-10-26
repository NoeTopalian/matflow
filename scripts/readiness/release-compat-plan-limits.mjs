// READ-ONLY pre-deployment compatibility check for PR #41 (class eligibility + plan allowance), 22 Oct 2026.
// Usage: node scripts/readiness/release-compat-plan-limits.mjs <env-file> <expected-host-substring> [VAR=DATABASE_URL]
// Opens ONE connection (URL parsed, TLS verification forced), runs ONE READ ONLY transaction with a statement timeout,
// and prints AGGREGATES and internal ids only — never names, emails, phones or card tokens. Reads only tables that
// exist before the migrations (the new ClassMembershipTier table and the new MembershipTier/Member columns are not
// read; their migration defaults are empty/NULL and are assessed in the release packet).
//
// What it answers, per tenant:
//  A. allowance enforcement that activates on deploy: tiers with maxClassesPerWeek set (the previous build's field,
//     now read as "N each calendar week" and enforced at every door) and how many active members sit on them;
//  B. classes with a roster (ClassRoster rows): roster eligibility refuses non-listed members at every door
//     (the old client-side acknowledgement no longer admits anyone);
//  C. existing bookings (ClassSubscription) by members NOT on a non-empty roster of that class — refused at
//     attendance after deploy (bookings themselves are preserved);
//  D. members with a live Stripe subscription (they gain a stored billing period on their next paid invoice;
//     until then a "billing" allowance, if ever chosen, reads "period unknown") and members with nextDueAt;
//  E. the billing-cycle mix of tiers (the webhook change stores the paid period; it changes no charge).
//  F. active classes an attendance-history import created (the live-class counts leave them out; expected 0).
import fs from "node:fs";
import pg from "pg";
import { parse as parsePg } from "pg-connection-string";
import { resolveDbTarget, TargetRefused } from "./db-target.mjs";

const envFile = process.argv[2];
const expectHost = process.argv[3];
const varName = process.argv[4] ?? "DATABASE_URL";
if (!envFile || !expectHost) { console.error("usage: node release-compat-plan-limits.mjs <env-file> <expected-host-substring> [VAR]"); process.exit(2); }
const env = Object.fromEntries(
  fs.readFileSync(envFile, "utf8").split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => {
    const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
  }),
);
const url = env[varName];
if (!url) { console.error(`no ${varName} in env file`); process.exit(2); }
let host;
// Production is admissible: this is a read-only baseline in the sense of db-role-inspect.mjs (SF-02) — aggregates and ids only.
try { host = resolveDbTarget(url, { expectHost, allowProduction: true }); } catch (e) { console.error(e instanceof TargetRefused ? e.message : String(e)); process.exit(2); }
const parsed = parsePg(url);
const client = new pg.Client({
  host: parsed.host, port: parsed.port ? Number(parsed.port) : 5432, user: parsed.user, password: parsed.password, database: parsed.database,
  ssl: { rejectUnauthorized: true }, application_name: "matflow-release-compat-readonly",
});
const out = { host: host.replace(/^[^.]*\./, "…."), at: new Date().toISOString(), tenants: {} };
await client.connect();
try {
  await client.query("BEGIN READ ONLY");
  await client.query("SET LOCAL statement_timeout = '20s'");
  const tenants = (await client.query(`select id, slug from "Tenant" order by slug`)).rows;
  for (const t of tenants) {
    const T = { slug: t.slug };
    // A. tiers whose allowance activates on deploy.
    T.tiersWithWeeklyLimit = (await client.query(
      `select mt.id, mt."maxClassesPerWeek" as "limit", mt."isActive",
              (select count(*)::int from "Member" m where m."membershipTierId" = mt.id and m."tenantId" = mt."tenantId" and m.status = 'active') as "activeMembers"
         from "MembershipTier" mt where mt."tenantId" = $1 and mt."maxClassesPerWeek" is not null order by mt.id`, [t.id])).rows;
    // B. classes with a roster.
    T.classesWithRoster = (await client.query(
      `select c.id, c."isActive", count(r.*)::int as "rosterSize"
         from "Class" c join "ClassRoster" r on r."classId" = c.id and r."tenantId" = c."tenantId"
        where c."tenantId" = $1 group by c.id, c."isActive" order by c.id`, [t.id])).rows;
    // C. bookings that roster eligibility would refuse at attendance.
    T.bookingsRefusedByRoster = (await client.query(
      `select s.id as "bookingId", s."classId", s."memberId"
         from "ClassSubscription" s
         join "Class" c on c.id = s."classId" and c."tenantId" = $1
        where exists (select 1 from "ClassRoster" r where r."classId" = s."classId" and r."tenantId" = $1)
          and not exists (select 1 from "ClassRoster" r where r."classId" = s."classId" and r."memberId" = s."memberId" and r."tenantId" = $1)
        order by s.id`, [t.id])).rows;
    T.bookingsTotal = (await client.query(
      `select count(*)::int as n from "ClassSubscription" s join "Class" c on c.id = s."classId" where c."tenantId" = $1`, [t.id])).rows[0].n;
    // D. billing-period provenance available after deploy.
    T.members = (await client.query(
      `select count(*)::int as total,
              count(*) filter (where status = 'active')::int as active,
              count(*) filter (where "stripeSubscriptionId" is not null)::int as "withStripeSubscription",
              count(*) filter (where "nextDueAt" is not null)::int as "withNextDueAt",
              count(*) filter (where "membershipTierId" is null)::int as "withoutTier"
         from "Member" where "tenantId" = $1`, [t.id])).rows[0];
    // E. tier billing cycles.
    T.tierCycles = (await client.query(
      `select "billingCycle", count(*)::int as n from "MembershipTier" where "tenantId" = $1 group by 1 order by 1`, [t.id])).rows;
    // F. classes an attendance-history import created that are active (integration review, 26 Oct 2026). Before #41
    // the class PATCH could reactivate one; the live-class counts (Reports, Analysis, AI report) leave them out, so a
    // non-zero here means those counts drop on deploy. Expected 0.
    T.activeImportedClasses = (await client.query(
      `select count(*)::int as n from "Class" where "tenantId" = $1 and "sourceImportJobId" is not null and "isActive"`, [t.id])).rows[0].n;
    out.tenants[t.id] = T;
  }
  await client.query("COMMIT");
} finally {
  await client.end().catch(() => {});
}
console.log(JSON.stringify(out, null, 1));
