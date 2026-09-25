// Migration rehearsal on a SOURCE-SHAPED TeamUp export (ten-club audit
// 2026-09-25, section 8). Total BJJ's real file is not on disk and real member
// data must never enter a fixture, so the export is GENERATED from the plan
// catalogue in docs/runbooks/TEAMUP-MIGRATION.md: the 13 plans with their
// 24 Sep active counts (296), plus the shapes the real file has — kids on a
// parent's email, siblings, a kid whose email no adult uses, adults with no
// email, two adults on one address, holds, upgrade history, cancelled-only
// people, finished prepaid courses, deleted customers. Names and addresses are
// invented deterministically.
//
// The commit is the REAL route handler (app/api/admin/import/[id]/commit)
// against the test database; only the blob store is stubbed (the file is
// served from memory — locally there is no BLOB_READ_WRITE_TOKEN), mail is
// dark, and the owner gate is satisfied for the throwaway club.
//
// Cells: reconciliation against the catalogue · commit lands every person with
// every kid on a parent · the same file again creates nobody · a crash in the
// middle of a batch is recovered by re-running with no duplicates · three clubs
// importing at once.
import { vi, describe, it, afterAll, expect } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
// The owner gate answers for whichever club the calling task is running as: an
// AsyncLocalStorage store, so three concurrent commits each see their own club.
const gate = new AsyncLocalStorage<{ tenantId: string; userId: string }>();
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: vi.fn(async () => { const s = gate.getStore(); if (!s) throw new Error("no club in scope"); return { ok: true, tenantId: s.tenantId, userId: s.userId }; }) }));
const FILES = new Map<string, string>();
vi.mock("@vercel/blob", () => ({
  get: vi.fn(async (url: string) => (FILES.has(url) ? { statusCode: 200, stream: new Blob([FILES.get(url)!]).stream() } : null)),
  del: vi.fn(async () => {}),
}));
const crash = { remaining: 0 };
vi.mock("@/lib/member-status", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/member-status")>();
  return {
    ...mod,
    recordStatusEventsBulk: vi.fn((...args: Parameters<typeof mod.recordStatusEventsBulk>) => {
      if (crash.remaining > 0) { crash.remaining -= 1; throw new Error("simulated crash mid-batch"); }
      return mod.recordStatusEventsBulk(...args);
    }),
  };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { parseTeamUp } from "@/lib/importers/teamup";
import { POST as commit } from "@/app/api/admin/import/[id]/commit/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `tur${Date.now().toString(36)}`;
const TODAY = "2026-09-25";

// ── The catalogue (docs/runbooks/TEAMUP-MIGRATION.md, 24 Sep 2026) ──────────
const CATALOGUE: { plan: string; active: number; kids: boolean; cycle: "four_weekly" | "monthly"; pence: number }[] = [
  { plan: "Beginners Course 2026", active: 25, kids: false, cycle: "four_weekly", pence: 8800 },
  { plan: "Adults Advanced 2026", active: 50, kids: false, cycle: "four_weekly", pence: 9800 },
  { plan: "Beginners Once Per Week 2026", active: 9, kids: false, cycle: "four_weekly", pence: 5500 },
  { plan: "Advanced Once Per Week 2026", active: 11, kids: false, cycle: "four_weekly", pence: 5500 },
  { plan: "Advanced Unlimited Adult Classes", active: 27, kids: false, cycle: "four_weekly", pence: 8800 },
  { plan: "Advanced Unlimited Adult Classes (OLD)", active: 35, kids: false, cycle: "monthly", pence: 8800 },
  { plan: "Kids Unlimited 2026", active: 19, kids: true, cycle: "four_weekly", pence: 7500 },
  { plan: "Kids Once-A-Week 2026", active: 35, kids: true, cycle: "four_weekly", pence: 4900 },
  { plan: "Kids Unlimited Membership", active: 44, kids: true, cycle: "four_weekly", pence: 6600 },
  { plan: "Kids Once A Week Membership", active: 26, kids: true, cycle: "four_weekly", pence: 4500 },
  { plan: "Kids Unlimited Membership (OLD)", active: 11, kids: true, cycle: "monthly", pence: 6600 },
  { plan: "Kids Once A Week Membership (OLD)", active: 3, kids: true, cycle: "monthly", pence: 4500 },
  { plan: "Advanced Adult + Juniors & Comp Classes Once Per Week (OLD)", active: 1, kids: false, cycle: "monthly", pence: 5500 },
];
const HEADER = "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";

type Row = Partial<Record<"name" | "email" | "other" | "plan" | "type" | "status" | "proc" | "start" | "expiry" | "cancelled" | "first" | "completed" | "marketing" | "phone" | "dob" | "ecName" | "ecPhone" | "ecRel", string>>;
function row(o: Row): string {
  const v = (s?: string) => ((s ?? "").includes(",") ? `"${s}"` : (s ?? ""));
  return [o.name, o.email, o.other, o.plan, o.type ?? "recurring", o.status, o.proc ?? "Stripe", o.start, o.start, o.expiry, o.cancelled, o.first ?? "Yes", o.completed, "1 Invented Road", "", "Townsville", "", "TS1 1AA", "GB", o.marketing, o.phone, "", o.dob, o.ecName, o.ecPhone, o.ecRel].map(v).join(",");
}

/** Deterministic generator: same seed, same file. */
export function generateShapedExport(seed = 7) {
  let s = seed;
  const rnd = (n: number) => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s % n; };
  const FIRST = ["Alex", "Sam", "Jo", "Chris", "Pat", "Ash", "Morgan", "Taylor", "Jamie", "Casey", "Riley", "Drew", "Lee", "Kim", "Max", "Nat", "Rob", "Dan", "Amy", "Zoe", "Omar", "Priya", "Chen", "Fatima", "Luca"];
  const LAST = ["Smith", "Jones", "Brown", "Taylor", "Khan", "Patel", "Ali", "Evans", "Walker", "Wright", "Hughes", "Green", "Hall", "Wood", "Lewis", "Clark", "Hill", "Moore", "King", "Baker", "Okafor", "Rossi", "Nowak", "Sato", "Dubois"];
  const date = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const rows: string[] = [];
  const expected = { active: 0, hold: 0, perPlan: {} as Record<string, { active: number; hold: number }>, cancelledOnly: 0, completed: 0, deleted: 0, noEmail: 0, sharedEmailAdults: 0, parentsSynthesised: 0, kids: 0, adultsWithRows: 0, people: 0 };
  let n = 0;
  const email = () => `${STAMP}-p${++n}@example.test`;
  const adults: { name: string; email: string; last: string }[] = [];
  // Adult plans.
  for (const p of CATALOGUE.filter((c) => !c.kids)) {
    expected.perPlan[p.plan] = { active: p.active, hold: 0 };
    for (let i = 0; i < p.active; i++) {
      const last = LAST[rnd(LAST.length)];
      const name = `${FIRST[rnd(FIRST.length)]} ${last}`;
      const em = email();
      const start = date(2025 + rnd(2), 1 + rnd(9), 1 + rnd(28));
      rows.push(row({ name, email: em, plan: p.plan, status: "active", start, phone: `07000${String(100000 + n).slice(-6)}`, dob: date(1975 + rnd(30), 1 + rnd(12), 1 + rnd(28)), ecName: `EC ${last}`, ecPhone: "07000000000", ecRel: "Partner" }));
      if (rnd(10) < 4) rows.push(row({ name, email: em, other: p.plan, plan: "Beginners Course 2026", status: "upgraded", start: "2025-03-03", expiry: "2025-06-01", first: "Yes" }));
      adults.push({ name, email: em, last });
      expected.active += 1; expected.adultsWithRows += 1;
    }
  }
  // Four active adults with no email at all (placeholders, never dropped).
  for (let i = 0; i < 4; i++) {
    const p = CATALOGUE[1];
    rows.push(row({ name: `${FIRST[rnd(FIRST.length)]} Nomail${i}`, email: "", plan: p.plan, status: "active", start: "2026-05-04", dob: "1998-01-08" }));
    expected.active += 1; expected.perPlan[p.plan].active += 1; expected.noEmail += 1; expected.adultsWithRows += 1;
  }
  // Two adults on one address (partners): the second becomes non-contactable.
  {
    const p = CATALOGUE[0]; const em = email();
    rows.push(row({ name: "Sam Rice", email: em, plan: p.plan, status: "active", start: "2026-06-01", dob: "1992-11-10" }));
    rows.push(row({ name: "Jo Rice", email: em, plan: p.plan, status: "active", start: "2026-06-01", dob: "1994-02-02" }));
    expected.active += 2; expected.perPlan[p.plan].active += 2; expected.sharedEmailAdults += 1; expected.adultsWithRows += 2;
    adults.push({ name: "Sam Rice", email: em, last: "Rice" });
  }
  // Kids plans: 60% on an adult's email (siblings share), 40% on a family address no adult row uses.
  const usedKidNames = new Set<string>();
  let familyEmail = ""; let familyLeft = 0; let familyName = ""; let familyParentIsAdult = false; let familyAdult: { name: string; email: string; last: string } | null = null;
  for (const p of CATALOGUE.filter((c) => c.kids)) {
    expected.perPlan[p.plan] = { active: p.active, hold: 0 };
    for (let i = 0; i < p.active; i++) {
      if (familyLeft === 0) {
        familyLeft = 1 + rnd(3);
        familyParentIsAdult = rnd(10) < 6;
        if (familyParentIsAdult) { familyAdult = adults[rnd(adults.length)]; familyEmail = familyAdult.email; familyName = familyAdult.last; usedKidNames.add(`${familyEmail}|${familyAdult.name.split(" ")[0]}`); }
        else { familyAdult = null; familyEmail = email(); familyName = LAST[rnd(LAST.length)]; expected.parentsSynthesised += 1; }
      }
      familyLeft -= 1;
      const dob = date(2009 + rnd(11), 1 + rnd(12), 1 + rnd(28));
      // Siblings never share a first name: the parser folds rows by (email, name), so two
      // kids with one name on one address would be read as one child with two memberships.
      let first = FIRST[rnd(FIRST.length)];
      while (usedKidNames.has(`${familyEmail}|${first}`)) first = FIRST[rnd(FIRST.length)];
      usedKidNames.add(`${familyEmail}|${first}`);
      rows.push(row({ name: `${first} ${familyName}`, email: familyEmail, plan: p.plan, status: "active", start: date(2025 + rnd(2), 1 + rnd(9), 1 + rnd(28)), dob, ecName: familyAdult ? familyAdult.name : `Parent ${familyName}`, ecPhone: "07000000001", ecRel: rnd(2) ? "Mother" : "Father" }));
      expected.active += 1; expected.kids += 1;
    }
  }
  // Eight people on hold (five adults, three kids on a synthesised family).
  for (let i = 0; i < 5; i++) { const p = CATALOGUE[4]; rows.push(row({ name: `${FIRST[rnd(FIRST.length)]} Holder${i}`, email: email(), plan: p.plan, status: "hold", start: "2026-01-12", dob: "1990-02-02" })); expected.hold += 1; expected.perPlan[p.plan].hold += 1; expected.adultsWithRows += 1; }
  { const p = CATALOGUE[7]; const em = email(); expected.parentsSynthesised += 1; for (let i = 0; i < 3; i++) { rows.push(row({ name: `${FIRST[rnd(FIRST.length)]} Holdkid`, email: em, plan: p.plan, status: "hold", start: "2026-01-12", dob: date(2013 + i, 4, 4), ecName: "Parent Holdkid", ecPhone: "07000000002", ecRel: "Mother" })); expected.hold += 1; expected.perPlan[p.plan].hold += 1; expected.kids += 1; } }
  // 120 cancelled-only adults, 3 finished prepaid courses, 6 deleted customers.
  for (let i = 0; i < 120; i++) rows.push(row({ name: `${FIRST[rnd(FIRST.length)]} Gone${i}`, email: email(), plan: CATALOGUE[rnd(6)].plan, status: "cancelled", start: "2025-02-03", expiry: "2025-12-08", cancelled: "2025-12-08", marketing: i % 7 === 0 ? "No, do not send me any marketing messages" : "", dob: "1999-06-28" }));
  expected.cancelledOnly = 120;
  for (let i = 0; i < 3; i++) rows.push(row({ name: `${FIRST[rnd(FIRST.length)]} Course${i}`, email: email(), plan: "8 Week Beginners Course", type: "prepaid", status: "completed", proc: "", start: "2025-01-16", expiry: "2025-07-24", completed: "2025-07-25T01:01:35+01:00", dob: "2003-02-11" }));
  expected.completed = 3;
  for (let i = 0; i < 6; i++) rows.push(row({ name: "(Deleted Customer)", email: "", plan: "Kids Unlimited Membership (OLD)", status: "cancelled", start: "2024-12-01", expiry: "2025-08-31", cancelled: "2025-08-22" }));
  expected.deleted = 6;
  expected.people = expected.adultsWithRows + expected.kids + expected.parentsSynthesised + expected.cancelledOnly + expected.completed;
  return { csv: [HEADER, ...rows].join("\n"), expected, sourceRows: rows.length };
}

function commitReq(id: string) {
  return new Request(`https://test.local/api/admin/import/${id}/commit`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" });
}

async function mkClub(label: string) {
  return withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${label}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "x" } });
    for (const p of CATALOGUE) await tx.membershipTier.create({ data: { tenantId: t.id, name: p.plan, pricePence: p.pence, currency: "GBP", billingCycle: p.cycle, isKids: p.kids, isActive: !/\(OLD\)|Membership$/.test(p.plan) } });
    return { tenantId: t.id, userId: u.id };
  });
}
async function mkJob(tenantId: string, userId: string, csv: string) {
  const url = `https://blob.test.local/${STAMP}/${Math.random().toString(36).slice(2)}.csv`;
  FILES.set(url, csv);
  return withRlsBypass((tx) => tx.importJob.create({ data: { tenantId, createdById: userId, source: "teamup", fileName: "teamup-export.csv", fileBlobUrl: url, status: "preview" } }));
}
async function runCommit(club: { tenantId: string; userId: string }, csv: string) {
  const job = await mkJob(club.tenantId, club.userId, csv);
  const t = Date.now();
  const res = await gate.run(club, () => commit(commitReq(job.id), { params: Promise.resolve({ id: job.id }) }));
  const body = (await res.json()) as { ok?: boolean; imported?: number; skipped?: number; errors?: number; error?: string };
  const jobRow = await withRlsBypass((tx) => tx.importJob.findUnique({ where: { id: job.id }, select: { status: true, importedRows: true, skippedRows: true, errorRows: true, errorLog: true } }));
  return { status: res.status, body, job: jobRow, ms: Date.now() - t };
}
async function dbShape(tenantId: string) {
  return withRlsBypass(async (tx) => {
    const members = await tx.member.findMany({ where: { tenantId }, select: { id: true, accountType: true, parentMemberId: true, status: true, paymentStatus: true, email: true, membershipTier: { select: { name: true } } } });
    const perPlan: Record<string, { active: number; hold: number }> = {};
    for (const m of members) {
      const plan = m.membershipTier?.name; if (!plan) continue;
      perPlan[plan] ??= { active: 0, hold: 0 };
      if (m.status === "active" && m.paymentStatus === "paused") perPlan[plan].hold += 1;
      else if (m.status === "active") perPlan[plan].active += 1;
    }
    return { count: members.length, kidsWithoutParent: members.filter((m) => (m.accountType === "kids" || m.accountType === "junior") && !m.parentMemberId).length, kids: members.filter((m) => m.accountType === "kids" || m.accountType === "junior").length, cancelled: members.filter((m) => m.status === "cancelled").length, perPlan, duplicateEmails: members.length - new Set(members.map((m) => m.email)).size };
  });
}

const clubs: { tenantId: string; userId: string }[] = [];

describe.skipIf(!HAS_DB)("TeamUp migration rehearsal on the catalogue-shaped export", () => {
  const { csv, expected, sourceRows } = generateShapedExport();

  afterAll(async () => {
    for (const c of clubs) {
      await withRlsBypass(async (tx) => {
        await tx.memberStatusEvent.deleteMany({ where: { tenantId: c.tenantId } });
        await tx.member.deleteMany({ where: { tenantId: c.tenantId, parentMemberId: { not: null } } });
        await tx.member.deleteMany({ where: { tenantId: c.tenantId } });
        await tx.importJob.deleteMany({ where: { tenantId: c.tenantId } });
        await tx.membershipTier.deleteMany({ where: { tenantId: c.tenantId } });
        await tx.emailLog.deleteMany({ where: { tenantId: c.tenantId } });
        await tx.user.deleteMany({ where: { tenantId: c.tenantId } });
        await tx.tenant.delete({ where: { id: c.tenantId } });
      });
    }
  });

  it("the preview reconciles to the catalogue: 296 active, 8 on hold, per-plan counts exact, nothing dropped but deleted customers", () => {
    const r = parseTeamUp(csv, { today: TODAY });
    expect(r.summary.sourceRows).toBe(sourceRows);
    expect(r.summary.deletedRows).toBe(expected.deleted);
    expect(r.summary.currentActive).toBe(expected.active);
    expect(r.summary.currentActive).toBe(296 + 4 + 2); // catalogue 296 + the four no-email adults + the two partners on one address
    expect(r.summary.currentOnHold).toBe(expected.hold);
    for (const [plan, c] of Object.entries(expected.perPlan)) expect(r.summary.planCounts[plan], plan).toEqual(c);
    expect(r.summary.noEmail).toBe(expected.noEmail);
    expect(r.summary.sharedEmailAdults).toBe(expected.sharedEmailAdults);
    expect(r.summary.parentsSynthesised).toBe(expected.parentsSynthesised);
    expect(r.summary.kids).toBe(expected.kids);
    expect(r.summary.kidsWithoutParent).toBe(0);
    expect(r.summary.historicalOnly).toBe(expected.cancelledOnly + expected.completed);
    // summary.people counts people found in the file; the payers synthesised from
    // emergency contacts are drafts on top of that, and the commit lands both.
    expect(r.summary.people + r.summary.parentsSynthesised).toBe(expected.people);
    expect(r.errors, "no row is an error").toHaveLength(0);
    expect(r.drafts.every((d) => !d.nextDueAt), "no due date is ever derived into nextDueAt").toBe(true);
  });

  it("commit lands every person, every kid on a parent, per-plan counts match the catalogue, no duplicates", async () => {
    const club = await mkClub("a"); clubs.push(club);
    const r = await runCommit(club, csv);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.errors, JSON.stringify(r.job?.errorLog).slice(0, 400)).toBe(0);
    expect(r.body.imported).toBe(expected.people);
    const shape = await dbShape(club.tenantId);
    expect(shape.count).toBe(expected.people);
    expect(shape.kidsWithoutParent).toBe(0);
    expect(shape.kids).toBe(expected.kids);
    expect(shape.cancelled).toBe(expected.cancelledOnly);
    expect(shape.duplicateEmails).toBe(0);
    for (const [plan, c] of Object.entries(expected.perPlan)) expect(shape.perPlan[plan], plan).toEqual(c);
    console.log(JSON.stringify({ cell: "commit", people: expected.people, ms: r.ms }));
  }, 300_000);

  it("the same file committed again creates nobody", async () => {
    const club = clubs[0];
    const before = await dbShape(club.tenantId);
    const r = await runCommit(club, csv);
    expect(r.status).toBe(200);
    expect(r.body.imported).toBe(0);
    expect(r.body.errors).toBe(0);
    const after = await dbShape(club.tenantId);
    expect(after.count).toBe(before.count);
    expect(after.duplicateEmails).toBe(0);
  }, 300_000);

  it("a crash in the middle of a batch is reported, and a re-run completes the import with no duplicates", async () => {
    const club = await mkClub("b"); clubs.push(club);
    crash.remaining = 1; // the first adult batch that inserts rows throws after its createMany, inside the transaction → rolled back
    const first = await runCommit(club, csv);
    crash.remaining = 0;
    expect(first.status).toBe(200);
    expect(first.body.errors, "the failed batch is reported, not hidden").toBeGreaterThan(0);
    expect((first.body.imported ?? 0) + (first.body.errors ?? 0)).toBeGreaterThanOrEqual(expected.people - 25);
    const mid = await dbShape(club.tenantId);
    expect(mid.count).toBeLessThan(expected.people);
    const second = await runCommit(club, csv);
    expect(second.status).toBe(200);
    expect(second.body.errors).toBe(0);
    const after = await dbShape(club.tenantId);
    expect(after.count, "the re-run completes the import").toBe(expected.people);
    expect(after.duplicateEmails).toBe(0);
    expect(after.kidsWithoutParent).toBe(0);
    console.log(JSON.stringify({ cell: "crash-recovery", firstImported: first.body.imported, firstErrors: first.body.errors, secondImported: second.body.imported }));
  }, 300_000);

  it("three clubs importing at once each land their own people, and nothing crosses", async () => {
    const trio = await Promise.all([mkClub("c1"), mkClub("c2"), mkClub("c3")]);
    clubs.push(...trio);
    // Each commit runs inside its own club's gate scope; the route reads the job by id inside
    // the tenant it was created in — a foreign tenant would 404.
    const t0 = Date.now();
    const results = await Promise.all(trio.map(async (club) => {
      const job = await mkJob(club.tenantId, club.userId, csv);
      const res = await gate.run(club, () => commit(commitReq(job.id), { params: Promise.resolve({ id: job.id }) }));
      return { club, body: (await res.json()) as { imported?: number; errors?: number }, status: res.status };
    }));
    const wall = Date.now() - t0;
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body.errors).toBe(0);
      expect(r.body.imported).toBe(expected.people);
      const shape = await dbShape(r.club.tenantId);
      expect(shape.count).toBe(expected.people);
      expect(shape.kidsWithoutParent).toBe(0);
    }
    console.log(JSON.stringify({ cell: "concurrent-3", people: expected.people, wallMs: wall }));
  }, 600_000);
});
