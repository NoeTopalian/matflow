// scripts/seed-demo-rich.mjs
//
// Rich demo-data seed for a live MatFlow demo (Track H). Makes a dedicated
// demo tenant look ALIVE — every feature populated, not empty — for a
// Sean-style sales demo: members across every status, a believable trial ->
// conversion funnel, ~3 months of weighted attendance, classes/schedules/
// instances, membership tiers + a real payment ledger, and a minted public
// leaderboard token.
//
// SAFETY
//   * Refuses to run without --confirm.
//   * Refuses to ever target slug "totalbjj" — that tenant backs the e2e
//     suite (see project memory: e2e prod-DB hazard) and must stay untouched.
//   * Idempotent: WIPES then re-seeds the target tenant's own rows before
//     writing, so re-running never duplicates. Before wiping, it verifies
//     every existing Member/User on that tenant is one of THIS script's own
//     rows (email ends "@demo.matflow") — if a single row doesn't match, it
//     aborts rather than risk deleting anything real. This is why the
//     default target is a tenant dedicated to this script, never a shared
//     or production club tenant with real members.
//   * All writes run inside ONE Postgres transaction with
//     `set_config('app.bypass_rls', 'on', true)` — every tenant-scoped table
//     in this schema has RLS ENABLE + FORCE (see prisma/migrations/
//     20260503200000_activate_rls_enforcement and .../20260921150000_
//     attribution_and_leaderboard), which blocks INSERT/UPDATE/DELETE from a
//     plain connection with no `app.current_tenant_id` set. This mirrors
//     `withRlsBypass` in lib/prisma-tenant.ts (not imported directly — that
//     file is TypeScript and this is a plain-Node .mjs script per the
//     scripts/seed-operator-noe.mjs precedent) but is the exact same
//     technique, scoped to this script's own transaction.
//
// USAGE
//   node scripts/seed-demo-rich.mjs --confirm --slug matflow-demo
//   node scripts/seed-demo-rich.mjs                  (dry-run: prints the plan, writes nothing)
//   node scripts/seed-demo-rich.mjs --confirm         (uses default slug "matflow-demo")
//   node scripts/seed-demo-rich.mjs --confirm --slug matflow-demo --base-url https://matflow.studio
//
// Run from the matflow repo root. Reads DATABASE_URL from .env (same loader
// as scripts/seed-operator-noe.mjs) or the environment.

import fs from "node:fs";
import path from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// ─── .env loader (mirrors scripts/seed-operator-noe.mjs) ────────────────────
const envPath = path.resolve(".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  }
}

// ─── CLI args ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const CONFIRM = argv.includes("--confirm");
function flagValue(name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const SLUG = flagValue("--slug", "total-bjj-demo");
const BASE_URL = flagValue("--base-url", process.env.APP_BASE_URL || "https://matflow.studio");

// Branding — defaults approximate Total BJJ (a red-on-black BJJ palette). The
// lead can pass exact values at run time (--name / --primary / --secondary /
// --text / --bg) once the club's real colours/logo are to hand.
const CLUB_NAME = flagValue("--name", "Total BJJ");
const PRIMARY_COLOR = flagValue("--primary", "#dc2626");
const SECONDARY_COLOR = flagValue("--secondary", "#991b1b");
const TEXT_COLOR = flagValue("--text", "#ffffff");
const BG_COLOR = flagValue("--bg", "#0a0a0a");
const BRANDING = {
  name: CLUB_NAME,
  primaryColor: PRIMARY_COLOR,
  secondaryColor: SECONDARY_COLOR,
  textColor: TEXT_COLOR,
  bgColor: BG_COLOR,
  timezone: "Europe/London",
  currency: "GBP",
  country: "UK",
  subscriptionStatus: "active",
  subscriptionTier: "pro",
  onboardingCompleted: true,
};

if (SLUG === "totalbjj") {
  console.error("Refusing to target slug \"totalbjj\" — that tenant backs the e2e suite (see project memory:");
  console.error("e2e prod-DB hazard) and must stay untouched. Pick a different --slug.");
  process.exit(1);
}

const DEMO_EMAIL_SUFFIX = "@demo.matflow";
const DEMO_PASSWORD = "MatFlowDemo2026!"; // fixed + printed each run so the lead can always log back in.

// ─── Plan summary (printed on every run, dry or real) ────────────────────────
function printPlan() {
  console.log("");
  console.log("========================================================");
  console.log(" SEED-DEMO-RICH — plan");
  console.log("========================================================");
  console.log(` Target tenant slug: ${SLUG}`);
  console.log(` Club name / brand:  ${CLUB_NAME} (primary ${PRIMARY_COLOR}, bg ${BG_COLOR})`);
  console.log(" Will WIPE then reseed (idempotent, tenant-scoped, marker-checked):");
  console.log("   - ~55 members across active / taster / cancelled");
  console.log("   - a believable trial -> conversion funnel (MemberStatusEvent trail)");
  console.log("   - attribution: trialRunById, creditedToUserId, creditedToMemberId, creditedToLabel");
  console.log("   - 5 classes + schedules + ~110 class instances (past ~96d + next 14d)");
  console.log("   - ~90 days of weighted AttendanceRecord (some members train more than others)");
  console.log("   - 3 MembershipTiers + a Payment ledger (paid + overdue members, some failed payments)");
  console.log("   - a leaderboard display token, minted fresh, printed once at the end");
  console.log("========================================================");
  console.log("");
}

printPlan();

if (!CONFIRM) {
  console.log("DRY RUN — no --confirm passed. Nothing was written.");
  console.log(`Re-run with: node scripts/seed-demo-rich.mjs --confirm --slug ${SLUG}`);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL not set");
  process.exit(1);
}

const adapter = new PrismaPg({ connectionString: url });
const prisma = new PrismaClient({ adapter });

// ─── Token hashing (mirrors lib/token-hash.ts + lib/auth-secret.ts exactly —
// those are TypeScript and not importable from a plain .mjs script, so the
// same HMAC-SHA256 construction is reproduced here rather than duplicated
// logic that could drift silently) ────────────────────────────────────────
const AUTH_SECRET_VALUE = process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "";
function hashToken(raw) {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(raw).digest("hex");
}
function mintRawDisplayToken() {
  // Same shape as app/api/settings/display/route.ts's mintRawToken: 24 bytes -> 32 base64url chars.
  return randomBytes(24).toString("base64url");
}

// ─── Small helpers ───────────────────────────────────────────────────────────
function daysAgo(n, hourUTC = 10, minuteUTC = 0) {
  const d = new Date();
  d.setUTCHours(hourUTC, minuteUTC, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function weightedPick(options) {
  // options: [[value, weight], ...]
  const total = options.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [value, w] of options) {
    if (r < w) return value;
    r -= w;
  }
  return options[options.length - 1][0];
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function slugifyName(name) {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "")
    .trim()
    .split(/\s+/)
    .join(".");
}

// ─── Name pool (real-looking, culturally varied, distinct pairs so the
// leaderboard reads well — 60 entries, first 55 used) ────────────────────────
const NAME_POOL = [
  "Oliver Bennett", "Maya Thompson", "Liam Carter", "Sophie Walsh", "Noah Fischer",
  "Isla Robertson", "Ethan Murphy", "Ava Coleman", "Lucas Ferreira", "Grace Kowalski",
  "Mason Delacroix", "Chloe Andersson", "Leo Nakamura", "Ruby Whitfield", "Elijah Osei",
  "Freya Lindqvist", "James O'Sullivan", "Amara Okafor", "Benjamin Hartley", "Zara Malik",
  "Theo Papadopoulos", "Nadia Volkov", "Finn Callahan", "Priya Sharma", "Jack Donnelly",
  "Elena Marchetti", "Owen Blackwood", "Layla Hassan", "Harry Fitzgerald", "Ingrid Larsen",
  "Aiden McGrath", "Sienna Costa", "Felix Brandt", "Talia Rosenberg", "Callum Reid",
  "Mei Tanaka", "Nathan Voss", "Aaliyah Brooks", "Ryan Kowalczyk", "Ines Moreira",
  "Connor Hughes", "Yasmin Ali", "Dylan Novak", "Bianca Ferraro", "Josh Whitaker",
  "Anya Petrova", "Kian O'Brien", "Camille Dubois", "Rhys Jenkins", "Leila Amari",
  "Sebastian Wolfe", "Natasha Kim", "Cole Ashworth", "Esme Fontaine", "Marcus Bailey",
  "Willow Chen", "Adam Novotny", "Hana Suzuki", "Declan Ryan", "Freya Pallesen",
];

async function main() {
  console.log(`Connecting… target slug "${SLUG}"`);

  const summary = await prisma.$transaction(
    async (tx) => {
      // RLS bypass, transaction-local — mirrors lib/prisma-tenant.ts withRlsBypass.
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;

      // ── 1. Resolve or create the tenant ────────────────────────────────────
      let tenant = await tx.tenant.findUnique({ where: { slug: SLUG } });

      if (tenant) {
        // Safety: only wipe rows this script itself owns. If ANY member or
        // staff user on this tenant doesn't carry the demo marker, abort
        // rather than risk touching real data.
        const [strayMembers, strayUsers] = await Promise.all([
          tx.member.findMany({
            where: { tenantId: tenant.id, NOT: { email: { endsWith: DEMO_EMAIL_SUFFIX } } },
            select: { id: true, email: true },
            take: 5,
          }),
          tx.user.findMany({
            where: { tenantId: tenant.id, NOT: { email: { endsWith: DEMO_EMAIL_SUFFIX } } },
            select: { id: true, email: true },
            take: 5,
          }),
        ]);
        if (strayMembers.length > 0 || strayUsers.length > 0) {
          throw new Error(
            `Refusing to wipe tenant "${SLUG}" — it has rows that are NOT this script's own ` +
              `(emails must end "${DEMO_EMAIL_SUFFIX}"). Found stray members: ` +
              `${strayMembers.map((m) => m.email).join(", ") || "none"}; stray users: ` +
              `${strayUsers.map((u) => u.email).join(", ") || "none"}. ` +
              `Point --slug at a tenant dedicated to this script.`,
          );
        }

        console.log(`Tenant "${SLUG}" exists (${tenant.id}) — wiping this script's own rows before reseeding…`);
        const classIds = (await tx.class.findMany({ where: { tenantId: tenant.id }, select: { id: true } })).map(
          (c) => c.id,
        );

        await tx.memberStatusEvent.deleteMany({ where: { tenantId: tenant.id } });
        await tx.attendanceRecord.deleteMany({ where: { tenantId: tenant.id } });
        await tx.payment.deleteMany({ where: { tenantId: tenant.id } });
        await tx.order.deleteMany({ where: { tenantId: tenant.id } });
        await tx.member.deleteMany({ where: { tenantId: tenant.id } });
        if (classIds.length > 0) {
          await tx.classInstance.deleteMany({ where: { classId: { in: classIds } } });
          await tx.classSchedule.deleteMany({ where: { classId: { in: classIds } } });
        }
        await tx.class.deleteMany({ where: { tenantId: tenant.id } });
        await tx.membershipTier.deleteMany({ where: { tenantId: tenant.id } });
        await tx.user.deleteMany({ where: { tenantId: tenant.id } });

        tenant = await tx.tenant.update({
          where: { id: tenant.id },
          data: { ...BRANDING },
        });
      } else {
        console.log(`Tenant "${SLUG}" does not exist — creating it fresh.`);
        tenant = await tx.tenant.create({
          data: { slug: SLUG, ...BRANDING },
        });
      }

      const tenantId = tenant.id;

      // ── 2. Staff users ──────────────────────────────────────────────────────
      const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
      const staffSpecs = [
        { email: `owner${DEMO_EMAIL_SUFFIX}`, name: "Alex Rivera", role: "owner" },
        { email: `coach1${DEMO_EMAIL_SUFFIX}`, name: "Marco Silva", role: "coach" },
        { email: `coach2${DEMO_EMAIL_SUFFIX}`, name: "Priya Nair", role: "coach" },
        { email: `admin${DEMO_EMAIL_SUFFIX}`, name: "Sam Ahmed", role: "admin" },
      ];
      await tx.user.createMany({
        data: staffSpecs.map((s) => ({ tenantId, email: s.email, passwordHash, name: s.name, role: s.role })),
      });
      const staff = await tx.user.findMany({ where: { tenantId }, select: { id: true, email: true, role: true } });
      const staffByEmail = new Map(staff.map((u) => [u.email, u]));
      const owner = staffByEmail.get(`owner${DEMO_EMAIL_SUFFIX}`);
      const coaches = staff.filter((u) => u.role === "coach");
      const allStaffIds = staff.map((u) => u.id);
      console.log(`✅ ${staff.length} staff users`);

      // ── 3. Classes + schedules + instances ──────────────────────────────────
      const classSpecs = [
        {
          name: "Fundamentals BJJ", location: "Mat 1", duration: 60, maxCapacity: 20, color: "#3b82f6",
          coachName: "Marco Silva", coachUserId: coaches[0]?.id ?? null,
          schedules: [{ dayOfWeek: 1, startTime: "09:30", endTime: "10:30" }, { dayOfWeek: 3, startTime: "09:30", endTime: "10:30" }],
        },
        {
          name: "No-Gi", location: "Mat 1", duration: 60, maxCapacity: 20, color: "#8b5cf6",
          coachName: "Priya Nair", coachUserId: coaches[1]?.id ?? null,
          schedules: [{ dayOfWeek: 2, startTime: "18:00", endTime: "19:00" }, { dayOfWeek: 4, startTime: "18:00", endTime: "19:00" }],
        },
        {
          name: "Advanced BJJ", location: "Mat 1", duration: 75, maxCapacity: 18, color: "#ef4444",
          coachName: "Marco Silva", coachUserId: coaches[0]?.id ?? null,
          schedules: [{ dayOfWeek: 3, startTime: "19:00", endTime: "20:15" }],
        },
        {
          name: "Beginner Fundamentals", location: "Mat 2", duration: 60, maxCapacity: 16, color: "#22c55e",
          coachName: "Priya Nair", coachUserId: coaches[1]?.id ?? null,
          schedules: [{ dayOfWeek: 5, startTime: "18:00", endTime: "19:00" }],
        },
        {
          name: "Open Mat", location: "Main Mat", duration: 120, maxCapacity: null, color: "#6b7280",
          coachName: "Open Mat", coachUserId: null,
          schedules: [{ dayOfWeek: 6, startTime: "10:00", endTime: "12:00" }],
        },
      ];

      await tx.class.createMany({
        data: classSpecs.map((c) => ({
          tenantId, name: c.name, location: c.location, duration: c.duration, maxCapacity: c.maxCapacity,
          color: c.color, coachName: c.coachName, coachUserId: c.coachUserId, isActive: true,
        })),
      });
      const classes = await tx.class.findMany({ where: { tenantId }, select: { id: true, name: true } });
      const classIdByName = new Map(classes.map((c) => [c.name, c.id]));

      const scheduleRows = [];
      for (const c of classSpecs) {
        for (const s of c.schedules) {
          scheduleRows.push({ classId: classIdByName.get(c.name), dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime, startDate: daysAgo(96) });
        }
      }
      await tx.classSchedule.createMany({ data: scheduleRows });
      console.log(`✅ ${classes.length} classes, ${scheduleRows.length} weekly schedule slots`);

      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const pastStart = addDays(today, -96); // ~3 months back, covers a full prior calendar month + partial current
      const futureEnd = addDays(today, 14); // structure for the timetable — no attendance generated here

      const instanceRows = [];
      for (const c of classSpecs) {
        const classId = classIdByName.get(c.name);
        for (const s of c.schedules) {
          const cursor = new Date(pastStart);
          while (cursor.getUTCDay() !== s.dayOfWeek) cursor.setUTCDate(cursor.getUTCDate() + 1);
          while (cursor <= futureEnd) {
            instanceRows.push({ classId, date: new Date(cursor), startTime: s.startTime, endTime: s.endTime });
            cursor.setUTCDate(cursor.getUTCDate() + 7);
          }
        }
      }
      await tx.classInstance.createMany({ data: instanceRows, skipDuplicates: true });
      const instances = await tx.classInstance.findMany({
        where: { classId: { in: classes.map((c) => c.id) } },
        select: { id: true, classId: true, date: true, startTime: true },
      });
      console.log(`✅ ${instances.length} class instances (96d back + 14d forward)`);

      // ── 4. Membership tiers ──────────────────────────────────────────────────
      const tierSpecs = [
        { name: "Unlimited Adult", pricePence: 8000, billingCycle: "monthly", maxClassesPerWeek: null, isKids: false },
        { name: "3x Per Week", pricePence: 6000, billingCycle: "monthly", maxClassesPerWeek: 3, isKids: false },
        { name: "Kids BJJ", pricePence: 5000, billingCycle: "monthly", maxClassesPerWeek: null, isKids: true },
      ];
      await tx.membershipTier.createMany({
        data: tierSpecs.map((t) => ({ tenantId, ...t, currency: "GBP", isActive: true })),
      });
      const tiers = await tx.membershipTier.findMany({ where: { tenantId }, select: { id: true, name: true, pricePence: true } });
      const tierByName = new Map(tiers.map((t) => [t.name, t]));
      const unlimitedTier = tierByName.get("Unlimited Adult");
      const threeXTier = tierByName.get("3x Per Week");
      console.log(`✅ ${tiers.length} membership tiers`);

      // ── 5. Members — build in-memory specs first, then bulk-insert ──────────
      // Buckets (sum = 55):
      //   6  taster            — currently mid-trial, no conversion event yet
      //   14 trial-convert     — ran a trial, converted to active
      //   3  trial-lost        — ran a trial, cancelled before converting
      //   20 direct-active     — joined without a trial (walk-in / import-era)
      //   4  long-cancelled    — established member who later cancelled (churn)
      //   8  veteran-active    — long-tenured active member, no trial
      const names = [...NAME_POOL];
      let nameCursor = 0;
      const usedEmails = new Set();
      function nextIdentity() {
        const full = names[nameCursor % names.length];
        nameCursor++;
        let base = slugifyName(full);
        let email = `${base}${DEMO_EMAIL_SUFFIX}`;
        let n = 2;
        while (usedEmails.has(email)) {
          email = `${base}${n}${DEMO_EMAIL_SUFFIX}`;
          n++;
        }
        usedEmails.add(email);
        return { name: full, email };
      }

      const memberSpecs = [];

      for (let i = 0; i < 6; i++) {
        const { name, email } = nextIdentity();
        const joinedAt = daysAgo(randInt(2, 12));
        memberSpecs.push({ name, email, status: "taster", joinedAt, cancelledAt: null, trialRunByEmail: pick(coaches).email, convertedAt: null, bucket: "taster" });
      }
      for (let i = 0; i < 14; i++) {
        const { name, email } = nextIdentity();
        const joinedAt = daysAgo(randInt(10, 150));
        const convertedAt = addDays(joinedAt, randInt(1, 12));
        memberSpecs.push({ name, email, status: "active", joinedAt, cancelledAt: null, trialRunByEmail: pick(coaches).email, convertedAt, bucket: weightedPick([["heavy", 0.3], ["medium", 0.5], ["light", 0.2]]) });
      }
      for (let i = 0; i < 3; i++) {
        const { name, email } = nextIdentity();
        const joinedAt = daysAgo(randInt(20, 60));
        const cancelledAt = addDays(joinedAt, randInt(3, 14));
        memberSpecs.push({ name, email, status: "cancelled", joinedAt, cancelledAt, trialRunByEmail: pick(coaches).email, convertedAt: null, bucket: "light" });
      }
      for (let i = 0; i < 20; i++) {
        const { name, email } = nextIdentity();
        const joinedAt = daysAgo(randInt(15, 500));
        memberSpecs.push({ name, email, status: "active", joinedAt, cancelledAt: null, trialRunByEmail: null, convertedAt: null, bucket: weightedPick([["heavy", 0.3], ["medium", 0.5], ["light", 0.2]]) });
      }
      for (let i = 0; i < 4; i++) {
        const { name, email } = nextIdentity();
        const joinedAt = daysAgo(randInt(200, 600));
        const cancelledAt = daysAgo(randInt(10, 90));
        memberSpecs.push({ name, email, status: "cancelled", joinedAt, cancelledAt, trialRunByEmail: null, convertedAt: null, bucket: "light" });
      }
      for (let i = 0; i < 8; i++) {
        const { name, email } = nextIdentity();
        const joinedAt = daysAgo(randInt(300, 900));
        memberSpecs.push({ name, email, status: "active", joinedAt, cancelledAt: null, trialRunByEmail: null, convertedAt: null, bucket: weightedPick([["heavy", 0.4], ["medium", 0.45], ["light", 0.15]]) });
      }

      // Attribution: sign-up credit (independent of the trial funnel above).
      // ~65% get creditedToUserId (a staff member); ~5 get creditedToMemberId
      // ("brought a friend" — assigned after insert once ids exist); ~4 get
      // creditedToLabel="Instagram" with no user/member credit (organic lead).
      const shuffledForCredit = [...memberSpecs].sort(() => Math.random() - 0.5);
      const friendCreditCount = 5;
      const labelCreditCount = 4;
      const friendCreditTargets = new Set(shuffledForCredit.slice(0, friendCreditCount).map((m) => m.email));
      const labelCreditTargets = new Set(
        shuffledForCredit.slice(friendCreditCount, friendCreditCount + labelCreditCount).map((m) => m.email),
      );
      for (const m of memberSpecs) {
        if (friendCreditTargets.has(m.email)) {
          m.creditKind = "friend"; // resolved to an actual member id after insert
        } else if (labelCreditTargets.has(m.email)) {
          m.creditKind = "label";
          m.creditedToLabel = "Instagram";
        } else if (Math.random() < 0.65) {
          m.creditKind = "staff";
          m.creditedToUserId = pick(allStaffIds);
        } else {
          m.creditKind = "none";
        }
      }

      // Payments/tiers: only active, non-cancelled members carry a tier + a
      // live payment relationship. ~85% of those are paid, ~15% overdue.
      for (const m of memberSpecs) {
        if (m.status !== "active") {
          m.tier = null;
          m.membershipType = m.status === "taster" ? "Trial" : "Cancelled";
          m.paymentStatus = m.status === "taster" ? "pending" : "cancelled";
          m.nextDueAt = null;
          continue;
        }
        m.tier = weightedPick([[unlimitedTier, 0.55], [threeXTier, 0.45]]);
        m.membershipType = m.tier.name;
        m.overdue = Math.random() < 0.15;
        m.paymentStatus = m.overdue ? "overdue" : "paid";
        m.nextDueAt = m.overdue ? daysAgo(randInt(3, 20)) : addDays(today, randInt(3, 26));
      }

      const memberCreateData = memberSpecs.map((m) => ({
        tenantId,
        email: m.email,
        name: m.name,
        membershipType: m.membershipType,
        membershipTierId: m.tier?.id ?? null,
        status: m.status,
        cancelledAt: m.cancelledAt,
        paymentStatus: m.paymentStatus,
        nextDueAt: m.nextDueAt,
        joinedAt: m.joinedAt,
        trialRunById: m.trialRunByEmail ? staffByEmail.get(m.trialRunByEmail)?.id ?? null : null,
        creditedToUserId: m.creditKind === "staff" ? m.creditedToUserId : null,
        creditedToLabel: m.creditKind === "label" ? m.creditedToLabel : null,
      }));
      await tx.member.createMany({ data: memberCreateData });

      const insertedMembers = await tx.member.findMany({ where: { tenantId }, select: { id: true, email: true } });
      const memberIdByEmail = new Map(insertedMembers.map((m) => [m.email, m.id]));
      for (const m of memberSpecs) m.id = memberIdByEmail.get(m.email);

      // Resolve "brought a friend" now that every member has an id.
      const activeIds = memberSpecs.filter((m) => m.status !== "cancelled").map((m) => m.id);
      for (const m of memberSpecs) {
        if (m.creditKind !== "friend") continue;
        const candidates = activeIds.filter((id) => id !== m.id);
        if (candidates.length === 0) continue;
        const friendId = pick(candidates);
        await tx.member.update({ where: { id: m.id }, data: { creditedToMemberId: friendId } });
      }
      console.log(`✅ ${memberSpecs.length} members (${memberSpecs.filter((m) => m.status === "active").length} active, ` +
        `${memberSpecs.filter((m) => m.status === "taster").length} taster, ` +
        `${memberSpecs.filter((m) => m.status === "cancelled").length} cancelled)`);

      // ── 6. MemberStatusEvent trail — same shape as lib/member-status.ts's
      // recordStatusEvent (this script can't import that TS module from plain
      // Node, so the exact row shape is reproduced here). reason: "staff_edit"
      // throughout so these are NOT excluded from the conversion funnel — the
      // whole point is a believable, non-zero conversion rate on the demo.
      const statusEvents = [];
      for (const m of memberSpecs) {
        if (m.status === "taster") {
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: null, toStatus: "taster", reason: "staff_edit", changedById: staffByEmail.get(m.trialRunByEmail)?.id ?? owner.id, occurredAt: m.joinedAt });
        } else if (m.convertedAt) {
          // trial-convert: null -> taster -> active
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: null, toStatus: "taster", reason: "staff_edit", changedById: staffByEmail.get(m.trialRunByEmail)?.id ?? owner.id, occurredAt: m.joinedAt });
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: "taster", toStatus: "active", reason: "staff_edit", changedById: staffByEmail.get(m.trialRunByEmail)?.id ?? owner.id, occurredAt: m.convertedAt });
        } else if (m.status === "cancelled" && m.trialRunByEmail) {
          // trial-lost: null -> taster -> cancelled
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: null, toStatus: "taster", reason: "staff_edit", changedById: staffByEmail.get(m.trialRunByEmail)?.id ?? owner.id, occurredAt: m.joinedAt });
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: "taster", toStatus: "cancelled", reason: "staff_edit", changedById: owner.id, occurredAt: m.cancelledAt });
        } else if (m.status === "cancelled") {
          // long-cancelled: null -> active -> cancelled
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: null, toStatus: "active", reason: "staff_edit", changedById: owner.id, occurredAt: m.joinedAt });
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: "active", toStatus: "cancelled", reason: "staff_edit", changedById: owner.id, occurredAt: m.cancelledAt });
        } else {
          // direct-active / veteran-active: null -> active
          statusEvents.push({ tenantId, memberId: m.id, fromStatus: null, toStatus: "active", reason: "staff_edit", changedById: owner.id, occurredAt: m.joinedAt });
        }
      }
      await tx.memberStatusEvent.createMany({ data: statusEvents });
      console.log(`✅ ${statusEvents.length} MemberStatusEvent rows (conversion funnel trail)`);

      // ── 7. Attendance — ~3 months, weighted by member bucket ────────────────
      const BUCKET_PROB = { heavy: 0.55, medium: 0.3, light: 0.12, taster: 0.4 };
      const methodWeights = [["self", 0.4], ["qr", 0.3], ["admin", 0.2], ["kiosk", 0.1]];
      const attendanceRows = [];
      const pastInstances = instances.filter((i) => i.date <= today);

      for (const m of memberSpecs) {
        const prob = BUCKET_PROB[m.bucket] ?? 0.25;
        const windowEnd = m.cancelledAt ?? today;
        for (const inst of pastInstances) {
          if (inst.date < m.joinedAt || inst.date > windowEnd) continue;
          if (Math.random() >= prob) continue;
          const [h, min] = inst.startTime.split(":").map(Number);
          const jitterMin = randInt(-5, 10);
          const checkInTime = new Date(inst.date.getTime() + h * 3600000 + min * 60000 + jitterMin * 60000);
          const checkInMethod = weightedPick(methodWeights);
          attendanceRows.push({
            tenantId,
            memberId: m.id,
            classInstanceId: inst.id,
            checkInTime,
            checkInMethod,
            checkedInById: checkInMethod === "admin" ? pick(allStaffIds) : null,
          });
        }
      }
      // Chunked createMany — a few thousand rows in one INSERT is fine for
      // Postgres, but chunking keeps each round trip small and predictable.
      for (let i = 0; i < attendanceRows.length; i += 500) {
        await tx.attendanceRecord.createMany({ data: attendanceRows.slice(i, i + 500), skipDuplicates: true });
      }
      console.log(`✅ ${attendanceRows.length} attendance records (~96 days, weighted by member)`);

      // ── 8. Payment ledger ────────────────────────────────────────────────────
      const paymentRows = [];
      for (const m of memberSpecs) {
        if (!m.tier) continue;
        const price = m.tier.pricePence;
        if (m.paymentStatus === "paid") {
          const lastPaidAt = addDays(m.nextDueAt, -30);
          paymentRows.push({ tenantId, memberId: m.id, amountPence: price, currency: "GBP", status: "succeeded", description: `Monthly membership — ${m.tier.name}`, paidAt: lastPaidAt, createdAt: lastPaidAt });
          // one or two earlier historical payments for revenue depth
          const history = Math.random() < 0.6 ? 2 : 1;
          for (let h = 1; h <= history; h++) {
            const paidAt = addDays(lastPaidAt, -30 * h);
            if (paidAt < daysAgo(96)) break;
            paymentRows.push({ tenantId, memberId: m.id, amountPence: price, currency: "GBP", status: "succeeded", description: `Monthly membership — ${m.tier.name}`, paidAt, createdAt: paidAt });
          }
        } else {
          // overdue: paid fine historically, then a failed attempt near the due date
          const priorCycle = addDays(m.nextDueAt, -30);
          if (priorCycle >= daysAgo(96)) {
            paymentRows.push({ tenantId, memberId: m.id, amountPence: price, currency: "GBP", status: "succeeded", description: `Monthly membership — ${m.tier.name}`, paidAt: priorCycle, createdAt: priorCycle });
          }
          const failedAt = addDays(m.nextDueAt, randInt(-2, 2));
          paymentRows.push({ tenantId, memberId: m.id, amountPence: price, currency: "GBP", status: "failed", description: `Monthly membership — ${m.tier.name}`, paidAt: null, failureReason: "card_declined", createdAt: failedAt });
        }
      }
      await tx.payment.createMany({ data: paymentRows });
      console.log(`✅ ${paymentRows.length} payment ledger rows`);

      // ── 9. Leaderboard display token ─────────────────────────────────────────
      const rawToken = mintRawDisplayToken();
      const tokenHash = hashToken(rawToken);
      await tx.tenant.update({ where: { id: tenantId }, data: { displayTokenHash: tokenHash, displayTokenIssuedAt: new Date() } });
      console.log("✅ leaderboard display token minted");

      // ── 10. Self-check — query back what was actually written ───────────────
      const [memberCount, statusCounts, attendanceCount, paymentCount, tierCount, classCount, instanceCount, tenantCheck] =
        await Promise.all([
          tx.member.count({ where: { tenantId } }),
          tx.member.groupBy({ by: ["status"], where: { tenantId }, _count: { _all: true } }),
          tx.attendanceRecord.count({ where: { tenantId } }),
          tx.payment.count({ where: { tenantId } }),
          tx.membershipTier.count({ where: { tenantId } }),
          tx.class.count({ where: { tenantId } }),
          tx.classInstance.count({ where: { classId: { in: classes.map((c) => c.id) } } }),
          tx.tenant.findUnique({ where: { id: tenantId }, select: { displayTokenHash: true } }),
        ]);

      if (tenantCheck?.displayTokenHash !== tokenHash) {
        throw new Error("Self-check failed: stored displayTokenHash does not match the minted token.");
      }
      if (memberCount !== memberSpecs.length) {
        throw new Error(`Self-check failed: expected ${memberSpecs.length} members, found ${memberCount}.`);
      }

      return {
        tenantId,
        slug: SLUG,
        memberCount,
        statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])),
        attendanceCount,
        paymentCount,
        tierCount,
        classCount,
        instanceCount,
        trialsRun: memberSpecs.filter((m) => m.trialRunByEmail).length,
        conversions: memberSpecs.filter((m) => m.convertedAt).length,
        rawToken,
        ownerEmail: `owner${DEMO_EMAIL_SUFFIX}`,
      };
    },
    { maxWait: 20_000, timeout: 300_000 },
  );

  console.log("");
  console.log("========================================================");
  console.log(" SEED-DEMO-RICH — done (self-check passed)");
  console.log("========================================================");
  console.log(` Tenant:          ${summary.slug} (${summary.tenantId})`);
  console.log(` Members:         ${summary.memberCount} — ${JSON.stringify(summary.statusCounts)}`);
  console.log(` Trials run:      ${summary.trialsRun}, converted: ${summary.conversions}`);
  console.log(` Attendance rows: ${summary.attendanceCount}`);
  console.log(` Payment rows:    ${summary.paymentCount}`);
  console.log(` Tiers:           ${summary.tierCount}`);
  console.log(` Classes:         ${summary.classCount} (${summary.instanceCount} instances)`);
  console.log("--------------------------------------------------------");
  console.log(` Demo owner login: ${summary.ownerEmail} / ${DEMO_PASSWORD}`);
  console.log(`   Club code / slug: ${summary.slug}`);
  console.log("--------------------------------------------------------");
  console.log(" Leaderboard (TV display) — raw token shown ONCE, save it now:");
  console.log(`   ${BASE_URL}/leaderboard/${summary.rawToken}`);
  console.log("========================================================");
  console.log("");
}

main()
  .catch((e) => {
    console.error("");
    console.error("SEED-DEMO-RICH FAILED — no partial writes committed (single transaction rolled back).");
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
