// Synthetic load-test clubs on the guarded target (a Neon child branch of the test branch; the shared test branch
// only with --allow-shared-test-branch and the SHARED_LIMITS). Synthetic data only: example.test addresses, slugs
// and addresses carrying the run stamp. Nothing here reads or writes a club the run did not create.
//
//   node scripts/loadtest/seed.mjs --members 5000 [--clubs 10] [--history-weeks 12] [--stamp <stamp>] [--s2-app-capacity 120]
//   node scripts/loadtest/seed.mjs --teardown --stamp <stamp>
//   node scripts/loadtest/seed.mjs --status --stamp <stamp>
//   add --child-branch (the configured throwaway child) or --allow-shared-test-branch (tiny smoke runs only)
//
// Each club: an owner and a manager (both with an authenticator enrolled, as a real elevated account must be), two
// coaches, two plans, a weekly timetable with class sessions for today and the next six days (and past sessions with
// attendance for Reports), two "class start" sessions open now for scenario S2, a kiosk token, and members (one big
// club holds a quarter of them). Members and coaches share one per-run password; owners and managers another.
// Sessions are minted for every account with the test branch's auth secret, exactly as the app's own TOTP step
// re-issues them, so k6 can browse without 5,000 sign-ins (S1 measures real sign-ins).
//
// Outputs, outside git, in %LOCALAPPDATA%/matflow-loadtest/<stamp>/: state.json (what was created: the teardown
// ledger) and k6-data.json (synthetic credentials and sessions for k6; never printed, never committed).
//
// Idempotent: seeding a stamp that is already seeded re-mints its sessions and changes nothing else; a partial seed
// is refused until --teardown. Reversible: --teardown deletes only tenants whose slug carries this stamp and that
// this run's state names, then proves that no row is left in any table with a tenantId column.
import { guardTarget, checkSharedLimits, ALLOW_SHARED_FLAG, GuardRefusal } from "./guard.mjs";
import { parseFlags, newStamp, STAMP_RE, slugPrefix, runDir, readJson, writeJson, authSecret, hashToken, prismaFor, SESSION_COOKIE, LANE_PREFIXES, scrub } from "./lib.mjs";
import { deleteTenant } from "../../.claude/skills/matflow-verify-browser/scripts/tenant-teardown.mjs";
import { randomBytes, randomInt } from "node:crypto";

const TZ = "Europe/London";
const DAY = 86400000;
const TIMETABLE = [
  { name: "Fundamentals Gi", category: "fundamentals", slots: [[1, "07:00", "08:00"], [3, "07:00", "08:00"], [5, "18:00", "19:00"]] },
  { name: "Advanced Gi", category: "gi", slots: [[1, "19:00", "20:30"], [3, "19:00", "20:30"]] },
  { name: "No-Gi", category: "nogi", slots: [[2, "19:00", "20:00"], [4, "19:00", "20:00"]] },
  { name: "Lunchtime", category: "gi", slots: [[1, "12:00", "13:00"], [2, "12:00", "13:00"], [3, "12:00", "13:00"], [4, "12:00", "13:00"], [5, "12:00", "13:00"]] },
  { name: "Competition", category: "competition", slots: [[2, "18:00", "19:00"], [4, "18:00", "19:00"]] },
  { name: "Open Mat", category: "open_mat", slots: [[6, "11:00", "13:00"], [0, "11:00", "13:00"]] },
];

/** The club's wall clock now: date parts, minutes past midnight and weekday (0 = Sunday). */
function londonNow(d = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, minutes: +p.hour * 60 + +p.minute };
}
/** A ClassInstance.date marker: UTC midnight of the club's calendar date (lib/class-time.ts). */
const marker = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const minutesOf = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };

/** Members per club: club 1 is the big club (weight 3), the rest share evenly. Sums to `members`. */
export function memberSplit(members, clubs) {
  const weights = Array.from({ length: clubs }, (_, i) => (i === 0 && clubs > 1 ? 3 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const counts = weights.map((w) => Math.floor((members * w) / total));
  for (let i = 0; counts.reduce((a, b) => a + b, 0) < members; i = (i + 1) % clubs) counts[i]++;
  return counts;
}

const base32 = (buf) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, val = 0, out = ""; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } return bits ? out + A[(val << (5 - bits)) & 31] : out; };

const SPEC = { members: "int", clubs: "int", "history-weeks": "int", stamp: "str", "s2-app-capacity": "int", teardown: "bool", status: "bool", "allow-shared-test-branch": "bool", "child-branch": "bool" };

async function mint(encode, secret, claims) {
  const now = Date.now();
  return encode({
    secret, salt: SESSION_COOKIE, maxAge: 30 * 24 * 60 * 60,
    token: { ...claims, sub: claims.id, totpPending: false, requireTotpSetup: false, mustChangePassword: false, brandFetchedAt: now, sessionVersionCheckedAt: now },
  });
}

async function seed(flags, target) {
  const stamp = flags.stamp ?? newStamp();
  if (!STAMP_RE.test(stamp)) throw new GuardRefusal(`stamp ${stamp} is not a load-test stamp`);
  const members = flags.members ?? 1000, clubs = flags.clubs ?? 10, historyWeeks = flags["history-weeks"] ?? 12, s2AppCapacity = flags["s2-app-capacity"] ?? 120;
  if (![members, clubs, historyWeeks, s2AppCapacity].every((n) => Number.isInteger(n) && n >= 0) || clubs < 1 || members < clubs) throw new GuardRefusal("--members and --clubs must be whole numbers with at least one member per club");
  checkSharedLimits({ shared: target.shared, members, clubs, secondsPerScenario: 0, vus: 0 });
  const dir = runDir(stamp), STATE = `${dir}/state.json`;
  const secret = authSecret(target.testEnv);
  const { encode } = await import("@auth/core/jwt");
  const bcrypt = (await import("bcryptjs")).default;
  const { prisma, bypass } = await prismaFor(target.ownerUrl);
  try {
    let state = readJson(STATE);
    const inDb = await bypass((tx) => tx.tenant.findMany({ where: { slug: { startsWith: slugPrefix(stamp) } }, select: { id: true, slug: true } }));
    if (state && state.endpoint !== target.endpoint) throw new GuardRefusal(`stamp ${stamp} was seeded on ${state.endpoint}, not ${target.endpoint}`);
    if (state?.status === "seeded") {
      if (state.members !== members || state.clubs.length !== clubs) throw new GuardRefusal(`stamp ${stamp} is seeded with ${state.members} members in ${state.clubs.length} clubs; tear it down to change that`);
      if (inDb.length !== clubs) throw new GuardRefusal(`state says ${clubs} clubs but the database has ${inDb.length}; run --teardown`);
      console.log(`stamp ${stamp} already seeded; re-minting its sessions only`);
    } else if (state || inDb.length) {
      throw new GuardRefusal(`stamp ${stamp} has a partial seed (${inDb.length} clubs in the database); run: node scripts/loadtest/seed.mjs --teardown --stamp ${stamp}`);
    } else {
      // The ledger first: the intent and the slugs, before any insert, so an interrupted seed is still torn down.
      const passwords = { member: randomBytes(15).toString("base64url"), staff: randomBytes(15).toString("base64url") };
      state = { stamp, endpoint: target.endpoint, shared: target.shared, status: "seeding", startedAt: new Date().toISOString(), members, historyWeeks, s2AppCapacity, passwords, clubs: Array.from({ length: clubs }, (_, i) => ({ slug: `${slugPrefix(stamp)}${String(i + 1).padStart(2, "0")}` })) };
      writeJson(STATE, state);
      const memberHash = await bcrypt.hash(passwords.member, 12);
      const staffHash = await bcrypt.hash(passwords.staff, 12);
      const split = memberSplit(members, clubs);
      const now = new Date();
      const today = londonNow(now);
      const todayMarker = marker(today.y, today.m, today.d);
      const t0 = Date.now();
      for (let ci = 0; ci < clubs; ci++) {
        const club = state.clubs[ci];
        const cc = String(ci + 1).padStart(2, "0");
        const kioskToken = randomBytes(32).toString("base64url");
        await bypass(async (tx) => {
          const t = await tx.tenant.create({ data: {
            name: `Load Test Club ${cc} (${stamp})`, slug: club.slug, onboardingCompleted: true, subscriptionStatus: "active", timezone: TZ,
            kioskTokenHash: hashToken(secret, kioskToken), kioskTokenIssuedAt: now, memberAppCheckin: true, contactEmail: `${club.slug}-desk@example.test`,
          } });
          club.tenantId = t.id;
          club.kioskToken = kioskToken;
          const staff = [["owner", "Owen Owner"], ["manager", "Mia Manager"], ["coach", "Cal Coach"], ["coach", "Cora Coach"]];
          club.staff = [];
          for (const [i, [role, name]] of staff.entries()) {
            const elevated = role !== "coach";
            const u = await tx.user.create({ data: {
              tenantId: t.id, email: `${club.slug}-${role}${i}@example.test`, name, role,
              passwordHash: elevated ? staffHash : memberHash,
              ...(elevated ? { totpEnabled: true, totpSecret: base32(randomBytes(20)) } : {}),
            } });
            club.staff.push({ id: u.id, role, email: u.email, name });
          }
          const unlimited = await tx.membershipTier.create({ data: { tenantId: t.id, name: "Unlimited", pricePence: 8000, billingCycle: "monthly" } });
          await tx.membershipTier.create({ data: { tenantId: t.id, name: "Twice a week", pricePence: 6000, billingCycle: "monthly", maxClassesPerWeek: 2 } });

          // Timetable: weekly schedules, sessions for today and the next six days, and past sessions for history.
          const pastInstances = [];
          const futureRows = [];
          for (const c of TIMETABLE) {
            const cls = await tx.class.create({ data: { tenantId: t.id, name: c.name, category: c.category, maxCapacity: 40, duration: 60, coachName: "Cal Coach" } });
            for (const [dow, start, end] of c.slots) await tx.classSchedule.create({ data: { classId: cls.id, dayOfWeek: dow, startTime: start, endTime: end, startDate: new Date(todayMarker.getTime() - (historyWeeks + 1) * 7 * DAY) } });
            for (let off = -historyWeeks * 7; off <= 6; off++) {
              const date = new Date(todayMarker.getTime() + off * DAY);
              for (const [dow, start, end] of c.slots) if (date.getUTCDay() === dow) {
                const row = { classId: cls.id, date, startTime: start, endTime: end };
                if (off < 0) pastInstances.push(row); else futureRows.push(row);
              }
            }
          }
          await tx.classInstance.createMany({ data: [...pastInstances, ...futureRows], skipDuplicates: true });
          // S2 "class start": sessions that started ten minutes ago, open until the end of the club's day.
          const startMin = Math.max(0, today.minutes - 10);
          const s2 = {};
          for (const [key, name, cap] of [["kiosk", "S2 Kiosk Class", 200], ["app", "S2 App Class", s2AppCapacity]]) {
            const cls = await tx.class.create({ data: { tenantId: t.id, name, category: "gi", maxCapacity: cap, duration: 60 } });
            const inst = await tx.classInstance.create({ data: { classId: cls.id, date: todayMarker, startTime: hhmm(startMin), endTime: "23:59" } });
            s2[key] = { instanceId: inst.id, capacity: cap };
          }
          club.s2 = s2;

          // Members: adult, active, waiver signed, on the unlimited plan, paid at the desk ("free": comped).
          const n = split[ci];
          const rows = Array.from({ length: n }, (_, k) => {
            const nn = String(k + 1).padStart(4, "0");
            return {
              tenantId: t.id, email: `${club.slug}-m${nn}@example.test`, name: `LT ${stamp.slice(-6)} C${cc} M${nn}`, passwordHash: memberHash,
              membershipTierId: unlimited.id, membershipType: "Unlimited", paymentStatus: "free", status: "active", accountType: "adult",
              waiverAccepted: true, waiverAcceptedAt: now, onboardingCompleted: true,
            };
          });
          for (let k = 0; k < rows.length; k += 2000) await tx.member.createMany({ data: rows.slice(k, k + 2000) });
          const created = await tx.member.findMany({ where: { tenantId: t.id }, select: { id: true, email: true, name: true }, orderBy: { email: "asc" } });
          club.memberCount = created.length;

          // Attendance history: about one class a week per member over the history weeks, for Reports and Activity.
          if (historyWeeks > 0 && created.length) {
            const past = await tx.classInstance.findMany({ where: { class: { tenantId: t.id }, date: { lt: todayMarker } }, select: { id: true, date: true, startTime: true } });
            const byWeek = new Map();
            for (const p of past) { const w = Math.floor((todayMarker.getTime() - p.date.getTime() - 1) / (7 * DAY)); (byWeek.get(w) ?? byWeek.set(w, []).get(w)).push(p); }
            const att = [];
            for (const m of created) for (const list of byWeek.values()) {
              if (randomInt(10) < 2) continue; // about 80% of weeks attended
              const p = list[randomInt(list.length)];
              att.push({ tenantId: t.id, memberId: m.id, classInstanceId: p.id, checkInTime: new Date(p.date.getTime() + minutesOf(p.startTime) * 60000), checkInMethod: randomInt(2) ? "admin" : "self" });
            }
            for (let k = 0; k < att.length; k += 5000) await tx.attendanceRecord.createMany({ data: att.slice(k, k + 5000), skipDuplicates: true });
            club.historyAttendance = att.length;
          }
        }, 600000);
        writeJson(STATE, state);
        console.log(`  club ${cc}: ${club.memberCount} members, ${club.historyAttendance ?? 0} past attendances (${Math.round((Date.now() - t0) / 1000)} s)`);
      }
      state.status = "seeded";
      state.seededAt = new Date().toISOString();
      writeJson(STATE, state);
    }

    // Sessions for k6: one per member and per staff account, minted as the app's own sign-in would leave them.
    const data = { stamp, cookieName: SESSION_COOKIE, memberPassword: state.passwords.member, coachPassword: state.passwords.member, clubs: [], members: [], staff: [] };
    for (const [ci, club] of state.clubs.entries()) {
      const t = await bypass((tx) => tx.tenant.findUnique({ where: { id: club.tenantId }, select: { id: true, name: true, slug: true, primaryColor: true, secondaryColor: true, textColor: true } }));
      const brand = { tenantId: t.id, tenantSlug: t.slug, tenantName: t.name, primaryColor: t.primaryColor, secondaryColor: t.secondaryColor, textColor: t.textColor };
      data.clubs.push({ slug: club.slug, kioskToken: club.kioskToken, s2: club.s2, memberCount: club.memberCount });
      const ms = await bypass((tx) => tx.member.findMany({ where: { tenantId: t.id }, select: { id: true, email: true, name: true, sessionVersion: true }, orderBy: { email: "asc" } }));
      for (const m of ms) data.members.push({ c: ci, email: m.email, name: m.name, token: await mint(encode, secret, { ...brand, id: m.id, email: m.email, name: m.name, role: "member", memberId: m.id, sessionVersion: m.sessionVersion, totpEnabled: false }) });
      const us = await bypass((tx) => tx.user.findMany({ where: { tenantId: t.id }, select: { id: true, email: true, name: true, role: true, sessionVersion: true, totpEnabled: true }, orderBy: { email: "asc" } }));
      for (const u of us) data.staff.push({ c: ci, role: u.role, email: u.email, token: await mint(encode, secret, { ...brand, id: u.id, email: u.email, name: u.name, role: u.role, memberId: null, sessionVersion: u.sessionVersion, totpEnabled: u.totpEnabled }) });
    }
    writeJson(`${dir}/k6-data.json`, data);
    console.log(`SEEDED stamp ${stamp}: ${data.clubs.length} clubs, ${data.members.length} members, ${data.staff.length} staff on ${target.shared ? "the SHARED test branch" : "child branch"} ${target.host}; k6 data in ${dir}/k6-data.json`);
    return stamp;
  } finally { await prisma.$disconnect(); }
}

/** Every public table with a "tenantId" column (the generic leftover sweep and the zero-rows proof use it). */
async function tenantTables(tx) {
  const rows = await tx.$queryRaw`select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenantId' and table_name <> 'Tenant' order by table_name`;
  return rows.map((r) => r.table_name);
}

async function rowsLeft(bypass, tenantIds, stamp) {
  return bypass(async (tx) => {
    const left = {};
    for (const table of await tenantTables(tx)) {
      const [{ n }] = await tx.$queryRawUnsafe(`select count(*)::int as n from "${table}" where "tenantId" = any($1::text[])`, tenantIds);
      if (n) left[table] = n;
    }
    const [{ n: tenants }] = await tx.$queryRawUnsafe(`select count(*)::int as n from "Tenant" where id = any($1::text[]) or slug like $2`, tenantIds, `${slugPrefix(stamp)}%`);
    if (tenants) left.Tenant = tenants;
    const [{ n: addresses }] = await tx.$queryRawUnsafe(`select ((select count(*) from "User" where email like $1) + (select count(*) from "Member" where email like $1))::int as n`, `${slugPrefix(stamp)}%`);
    if (addresses) left.accounts = addresses;
    return left;
  }, 120000);
}

async function teardown(flags, target) {
  const stamp = flags.stamp;
  if (!STAMP_RE.test(stamp ?? "")) throw new GuardRefusal("--teardown needs --stamp <the run's stamp>");
  const dir = runDir(stamp), STATE = `${dir}/state.json`;
  const state = readJson(STATE);
  if (state && state.endpoint !== target.endpoint) throw new GuardRefusal(`stamp ${stamp} was seeded on ${state.endpoint}, not ${target.endpoint}`);
  const { prisma, bypass } = await prismaFor(target.ownerUrl);
  try {
    // Ownership: the slug carries this run's stamp (random, never reused) AND, when the state survived, it is named
    // there. A tenant the state names whose slug no longer carries the stamp is refused, never deleted.
    const inDb = await bypass((tx) => tx.tenant.findMany({ where: { slug: { startsWith: slugPrefix(stamp) } }, select: { id: true, slug: true } }));
    for (const c of state?.clubs ?? []) if (c.tenantId) {
      const byId = await bypass((tx) => tx.tenant.findUnique({ where: { id: c.tenantId }, select: { slug: true } }));
      if (byId && byId.slug !== c.slug) throw new GuardRefusal(`tenant ${c.tenantId} now has slug ${byId.slug}, not ${c.slug}; ownership uncertain`);
    }
    const ids = inDb.map((t) => t.id);
    let deleted = 0;
    for (const t of inDb) {
      await bypass(async (tx) => {
        // Rows the app wrote during the run in tables the shared deletion does not know: delete what can be
        // deleted, child tables first by retrying after a foreign-key refusal, then the shared deletion.
        const tables = await tenantTables(tx);
        for (let pass = 0; pass < 4; pass++) for (const table of tables) {
          await tx.$executeRawUnsafe("savepoint sweep");
          try { await tx.$executeRawUnsafe(`delete from "${table}" where "tenantId" = $1`, t.id); await tx.$executeRawUnsafe("release savepoint sweep"); }
          catch { await tx.$executeRawUnsafe("rollback to savepoint sweep"); }
        }
        await deleteTenant(tx, t.id);
      }, 600000);
      deleted++;
      console.log(`  deleted ${t.slug}`);
    }
    // Rate-limit rows keyed by the run's lane addresses (198.18.0.0/15) or its slugs and addresses.
    const rl = await bypass((tx) => tx.$executeRawUnsafe(`delete from "RateLimitHit" where ${LANE_PREFIXES.map((_, i) => `bucket like $${i + 1}`).join(" or ")} or bucket like $${LANE_PREFIXES.length + 1}`, ...LANE_PREFIXES.map((p) => `%${p}%`), `%${stamp}%`), 120000);
    const left = await rowsLeft(bypass, [...new Set([...ids, ...(state?.clubs ?? []).map((c) => c.tenantId).filter(Boolean)])], stamp);
    const clean = Object.keys(left).length === 0;
    if (state) { state.status = clean ? "torn-down" : "teardown-incomplete"; state.tornDownAt = new Date().toISOString(); state.left = left; writeJson(STATE, state); }
    console.log(`${clean ? "TORN DOWN" : "TEARDOWN INCOMPLETE"} stamp ${stamp}: ${deleted} clubs deleted, ${rl} rate-limit rows removed; rows left: ${clean ? "0 in every tenant table" : JSON.stringify(left)}`);
    return clean;
  } finally { await prisma.$disconnect(); }
}

async function status(flags, target) {
  const stamp = flags.stamp;
  if (!STAMP_RE.test(stamp ?? "")) throw new GuardRefusal("--status needs --stamp");
  const state = readJson(`${runDir(stamp)}/state.json`);
  const { prisma, bypass } = await prismaFor(target.ownerUrl);
  try {
    const inDb = await bypass((tx) => tx.tenant.findMany({ where: { slug: { startsWith: slugPrefix(stamp) } }, select: { id: true } }));
    const left = await rowsLeft(bypass, inDb.map((t) => t.id), stamp);
    console.log(JSON.stringify({ stamp, state: state?.status ?? null, clubsInDatabase: inDb.length, rows: left }));
  } finally { await prisma.$disconnect(); }
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/loadtest/seed.mjs");
if (isMain) {
  try {
    const flags = parseFlags(process.argv.slice(2), SPEC);
    const target = await guardTarget({ allowShared: !!flags["allow-shared-test-branch"], childBranch: !!flags["child-branch"] });
    if (target.shared) console.log(`NOTE: target is the SHARED test branch (${ALLOW_SHARED_FLAG}); smoke limits apply`);
    if (flags.teardown) process.exit((await teardown(flags, target)) ? 0 : 1);
    else if (flags.status) await status(flags, target);
    else await seed(flags, target);
  } catch (e) {
    console.error(e instanceof GuardRefusal ? e.message : `seed failed: ${scrub(e.stack ?? e.message)}`);
    process.exit(e instanceof GuardRefusal ? 3 : 1);
  }
}
