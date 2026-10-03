// One-shot (3 Oct 2026): clear the DEMO data out of the `totalbjj` tenant in
// place, so Sean's real Total BJJ club IS this tenant — keeping its slug, its
// real logo and branding — with Sean as the only account on it.
//
// Why in place rather than rename-and-create: the tenant already carries the
// real Total BJJ logo and the Clean White branding. Wiping the fabricated rows
// and converting the owner gives Sean that, at the slug he wants, with no rename.
//
// What the seed made (scripts/seed-demo-rich.mjs) and what this removes, in the
// seed's own proven deletion order:
//   memberStatusEvent -> attendanceRecord -> payment -> order -> member
//   -> classInstance -> classSchedule -> class -> membershipTier
//   -> the three demo staff users (coach1, coach2, admin @demo.matflow)
// The OWNER user is kept and, with --owner-to-sean, converted:
//   email sean.coates@totalbjj.co.uk, name "Sean Coates", password from
//   $OWNER_TEMP_PASSWORD (never argv, never printed), TOTP cleared so Sean
//   enrols fresh.
//
// GUARDS — all must hold or it refuses, in ONE transaction (so a failure is a
// rollback, never a half-wipe):
//   1. tenant `totalbjj` exists and its id is the recorded demo id
//   2. every Member carries the seed marker `@demo.matflow`
//   3. the staff users are exactly {owner@totalbjj.com} ∪ {coach1,coach2,admin}@demo.matflow
//   4. zero rows in tables the seed did NOT create (signed waivers, waitlists,
//      announcements, products, tasks, initiatives, import jobs, disputes) —
//      anything there was added by a person and is reported, not deleted.
//      The default Location (one per club, backfilled by the 25 Sep migration)
//      is kept and reported; it is a venue, not demo data.
//
// Dry run by default (prints counts, writes nothing). Aggregates only; no names
// or addresses beyond the known marker set. Runs against DATABASE_URL in .env
// (production) — the operator runs it by hand.
//
//   node scripts/wipe-totalbjj-demo-data.mjs                                 # preview
//   node scripts/wipe-totalbjj-demo-data.mjs --confirm                       # wipe demo rows + demo staff
//   OWNER_TEMP_PASSWORD='...' node scripts/wipe-totalbjj-demo-data.mjs --confirm --owner-to-sean

import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcryptjs";
import "dotenv/config";

const SLUG = "totalbjj";
const DEMO_TENANT_ID = "cmucpxc4c0000uctgouza06aj";
const MARKER = "@demo.matflow";
const KEEP_OWNER_EMAIL = "owner@totalbjj.com";
const DEMO_STAFF = ["coach1", "coach2", "admin"].map((l) => `${l}${MARKER}`);
const SEAN = { email: "sean.coates@totalbjj.co.uk", name: "Sean Coates" };

const confirm = process.argv.includes("--confirm");
const ownerToSean = process.argv.includes("--owner-to-sean");
const tempPassword = process.env.OWNER_TEMP_PASSWORD;
if (ownerToSean && (!tempPassword || tempPassword.length < 12)) {
  console.error("--owner-to-sean needs OWNER_TEMP_PASSWORD (>= 12 chars) in the environment, never on the command line.");
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? "";
console.log(`database host: ${url.replace(/^.*@/, "").replace(/\/.*$/, "") || "(unset)"}`);
if (!url) { console.error("DATABASE_URL unset — aborting."); process.exit(1); }

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

// Tables the seed did NOT write. Counted defensively: a model missing from the
// client is skipped, not fatal.
// `location` deliberately NOT here: a venue holds no personal data, every club
// carries a default one, and the 25 Sep Locations work refuses deleting a default
// venue. It is kept and reported, never wiped.
const EXTRA_MODELS = ["signedWaiver", "classWaitlist", "announcement", "product", "task", "initiative", "importJob", "dispute"];

async function countExtras(tx, tenantId) {
  const out = {};
  for (const m of EXTRA_MODELS) {
    const model = tx[m];
    if (!model || typeof model.count !== "function") continue;
    try { out[m] = await model.count({ where: { tenantId } }); }
    catch { out[m] = "n/a"; }
  }
  return out;
}

try {
  const facts = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const tenant = await tx.tenant.findUnique({ where: { slug: SLUG }, select: { id: true, name: true, logoUrl: true } });
    if (!tenant) return { tenant: null };
    const id = tenant.id;
    const [members, strayMembers, users, classes, tiers, attendance, payments, orders, statusEvents] = await Promise.all([
      tx.member.count({ where: { tenantId: id } }),
      tx.member.count({ where: { tenantId: id, NOT: { email: { endsWith: MARKER } } } }),
      tx.user.findMany({ where: { tenantId: id }, select: { id: true, email: true, role: true, totpEnabled: true } }),
      tx.class.count({ where: { tenantId: id } }),
      tx.membershipTier.count({ where: { tenantId: id } }),
      tx.attendanceRecord.count({ where: { tenantId: id } }),
      tx.payment.count({ where: { tenantId: id } }),
      tx.order.count({ where: { tenantId: id } }),
      tx.memberStatusEvent.count({ where: { tenantId: id } }),
    ]);
    const extras = await countExtras(tx, id);
    const locations = await tx.location.count({ where: { tenantId: id } }).catch(() => "n/a");
    return { tenant, members, strayMembers, users, classes, tiers, attendance, payments, orders, statusEvents, extras, locations };
  });

  if (!facts.tenant) { console.error(`REFUSING: no tenant with slug '${SLUG}'.`); process.exit(2); }

  const emails = facts.users.map((u) => u.email.toLowerCase());
  const owner = facts.users.find((u) => u.role === "owner");
  const expectedUsers = new Set([KEEP_OWNER_EMAIL, ...DEMO_STAFF]);
  const unexpectedUsers = emails.filter((e) => !expectedUsers.has(e));
  const extrasNonZero = Object.entries(facts.extras).filter(([, n]) => typeof n === "number" && n > 0);

  console.log("");
  console.log(`tenant:          ${facts.tenant.name} (${facts.tenant.id})  logo: ${facts.tenant.logoUrl ? "kept" : "none"}`);
  console.log(`members:         ${facts.members}   (not '${MARKER}': ${facts.strayMembers})`);
  console.log(`staff users:     ${facts.users.length}   owner: ${owner ? `${owner.email} (totp ${owner.totpEnabled ? "on" : "off"})` : "NONE"}`);
  console.log(`classes/tiers:   ${facts.classes} / ${facts.tiers}`);
  console.log(`attendance:      ${facts.attendance}   payments: ${facts.payments}   orders: ${facts.orders}   status events: ${facts.statusEvents}`);
  console.log(`seed-foreign rows: ${JSON.stringify(facts.extras)}`);
  console.log(`locations (kept): ${facts.locations}   — venues, not demo data; rename in Settings → Locations if needed`);
  console.log("");

  const refusals = [];
  if (facts.tenant.id !== DEMO_TENANT_ID) refusals.push(`tenant id ${facts.tenant.id} is not the recorded demo id ${DEMO_TENANT_ID}`);
  if (facts.strayMembers > 0) refusals.push(`${facts.strayMembers} member(s) lack the demo marker — real rows may be present`);
  if (!owner) refusals.push("no owner user on the tenant");
  if (unexpectedUsers.length) refusals.push(`unexpected staff users: ${unexpectedUsers.length} (not the known owner + 3 demo staff)`);
  if (extrasNonZero.length) refusals.push(`rows the seed did not create: ${extrasNonZero.map(([k, n]) => `${k}=${n}`).join(", ")} — a person added these; decide before wiping`);
  if (refusals.length) {
    console.error("REFUSING:");
    for (const r of refusals) console.error("  - " + r);
    process.exit(2);
  }

  const toDeleteStaff = facts.users.filter((u) => DEMO_STAFF.includes(u.email.toLowerCase()));
  console.log(`would delete: ${facts.members} members, ${facts.attendance} attendance, ${facts.payments} payments, ${facts.orders} orders, ${facts.statusEvents} status events, ${facts.classes} classes (+ schedules/instances), ${facts.tiers} tiers, ${toDeleteStaff.length} demo staff users`);
  console.log(`would keep:   tenant, slug '${SLUG}', branding/logo, ${facts.locations} location(s), owner user${ownerToSean ? ` -> converted to ${SEAN.email} with TOTP cleared` : " (unchanged; pass --owner-to-sean to convert)"}`);

  if (!confirm) { console.log("\nDRY RUN — nothing written. Re-run with --confirm."); process.exit(0); }

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const id = facts.tenant.id;
    const classIds = (await tx.class.findMany({ where: { tenantId: id }, select: { id: true } })).map((c) => c.id);
    await tx.memberStatusEvent.deleteMany({ where: { tenantId: id } });
    await tx.attendanceRecord.deleteMany({ where: { tenantId: id } });
    await tx.payment.deleteMany({ where: { tenantId: id } });
    await tx.order.deleteMany({ where: { tenantId: id } });
    await tx.member.deleteMany({ where: { tenantId: id } });
    if (classIds.length) {
      await tx.classInstance.deleteMany({ where: { classId: { in: classIds } } });
      await tx.classSchedule.deleteMany({ where: { classId: { in: classIds } } });
    }
    await tx.class.deleteMany({ where: { tenantId: id } });
    await tx.membershipTier.deleteMany({ where: { tenantId: id } });
    await tx.user.deleteMany({ where: { tenantId: id, email: { in: DEMO_STAFF } } });
    if (ownerToSean) {
      await tx.user.update({
        where: { id: owner.id },
        data: {
          email: SEAN.email,
          name: SEAN.name,
          passwordHash: bcrypt.hashSync(tempPassword, 12),
          totpEnabled: false,
          totpSecret: null,
        },
      });
    }
  }, { timeout: 120_000 });

  const after = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const id = facts.tenant.id;
    return {
      members: await tx.member.count({ where: { tenantId: id } }),
      users: await tx.user.findMany({ where: { tenantId: id }, select: { email: true, role: true, totpEnabled: true } }),
      classes: await tx.class.count({ where: { tenantId: id } }),
      tiers: await tx.membershipTier.count({ where: { tenantId: id } }),
    };
  });
  console.log("");
  console.log(`DONE. members=${after.members} classes=${after.classes} tiers=${after.tiers}`);
  console.log(`staff now: ${after.users.map((u) => `${u.role}:${u.email} (totp ${u.totpEnabled ? "on" : "off"})`).join(" | ")}`);
  console.log(ownerToSean ? "Owner converted to Sean; password from OWNER_TEMP_PASSWORD; TOTP cleared — he enrols fresh." : "Owner unchanged.");
} finally {
  await prisma.$disconnect();
}
