/**
 * Club life L8 — the door: venue eligibility (ADR-001 D2 slice 2).
 *
 * Two venues on the seeded club, a member on a tier bound to one of them, a
 * class at each venue and one with no venue, all opening now in the club's
 * timezone. The member-decided paths refuse the wrong venue and name both;
 * the desk overrides. Everything stamped is removed after.
 */
import { test, expect } from "@playwright/test";
import {
  RUN_STAMP, sql, seededTenantId, sessionFor, closeSessions, post, patch, del,
  OWNER_EMAIL, THROWAWAY_PASSWORD, countRows,
} from "./le-shared";
import { createMember } from "../helpers/db";

test.describe.configure({ mode: "serial", timeout: 180_000 });

const ORIGIN = "http://localhost:3847";

let tenantId: string;
let member: { id: string; email: string };
let north: string;
let south: string;
let tierId: string;
const classes: { id: string; instanceId: string; venue: string | null }[] = [];

function londonNow(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}` };
}

async function classAt(venue: string | null, label: string) {
  const { date, time } = londonNow();
  const cls = await sql<{ id: string }>(`INSERT INTO "Class" (id, "tenantId", name, duration, "isActive", "locationId", "createdAt") VALUES (gen_random_uuid()::text, $1, $2, 60, true, $3, now()) RETURNING id`, [tenantId, `${RUN_STAMP} ${label}`, venue]);
  const inst = await sql<{ id: string }>(`INSERT INTO "ClassInstance" (id, "classId", date, "startTime", "endTime", "isCancelled") VALUES (gen_random_uuid()::text, $1, $2::date, $3, $3, false) RETURNING id`, [cls[0].id, date, time]);
  classes.push({ id: cls[0].id, instanceId: inst[0].id, venue });
  return classes[classes.length - 1];
}

test.beforeAll(async ({ browser, baseURL }) => {
  tenantId = await seededTenantId();
  const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
  const n = await post(owner.request, "/api/locations", ORIGIN, { name: `${RUN_STAMP} Northside` });
  const s = await post(owner.request, "/api/locations", ORIGIN, { name: `${RUN_STAMP} Southside` });
  expect(n.status(), await n.text()).toBe(201);
  expect(s.status(), await s.text()).toBe(201);
  north = ((await n.json()) as { id: string }).id;
  south = ((await s.json()) as { id: string }).id;
  const tier = await post(owner.request, "/api/memberships", ORIGIN, { name: `${RUN_STAMP} Northside Unlimited`, pricePence: 5500, currency: "GBP", billingCycle: "four_weekly", isKids: false, locationId: north });
  expect(tier.status(), await tier.text()).toBe(201);
  tierId = ((await tier.json()) as { id: string }).id;
  member = await createMember({ name: `${RUN_STAMP} Nora North`, email: `${RUN_STAMP}-nora@example.test` });
  const bcrypt = await import("bcryptjs");
  await sql('UPDATE "Member" SET "passwordHash" = $2, "waiverAccepted" = true, "waiverAcceptedAt" = now(), "membershipTierId" = $3, "paymentStatus" = $4, "nextDueAt" = now() + interval \'10 days\' WHERE id = $1',
    [member.id, bcrypt.default.hashSync(THROWAWAY_PASSWORD, 10), tierId, "paid"]);
  await classAt(south, "South class");
  await classAt(north, "North class");
  await classAt(null, "Anywhere class");
});

test.afterAll(async ({ browser, baseURL }) => {
  await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [member.id]).catch(() => {});
  for (const c of classes) {
    await sql('DELETE FROM "ClassInstance" WHERE "classId" = $1', [c.id]).catch(() => {});
    await sql('DELETE FROM "Class" WHERE id = $1', [c.id]).catch(() => {});
  }
  await sql('DELETE FROM "Member" WHERE id = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "MembershipTier" WHERE id = $1', [tierId]).catch(() => {});
  try {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    for (const id of [north, south]) await del(owner.request, `/api/locations/${id}`, ORIGIN);
  } catch {}
  await sql('DELETE FROM "Location" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP} %`]).catch(() => {});
  await closeSessions();
});

async function selfCheckin(browser: import("@playwright/test").Browser, baseURL: string, instanceId: string) {
  const ctx = await sessionFor(browser, baseURL, member.email, THROWAWAY_PASSWORD);
  const res = await post(ctx.request, "/api/checkin", ORIGIN, { classInstanceId: instanceId, checkInMethod: "self" });
  const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
  return { status: res.status(), body };
}

test.describe("L8 · the door — venue eligibility", () => {
  test("C8.01 a Northside member at a Southside class is refused, both venues named, nothing written", async ({ browser, baseURL }) => {
    const r = await selfCheckin(browser, baseURL!, classes[0].instanceId);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.reason).toBe("venue_not_covered");
    expect(r.body.error).toMatch(/Southside/);
    expect(r.body.error).toMatch(/Northside/);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [member.id])).toBe(0);
  });

  test("C8.02 the same member at their own venue, and at a class with no venue, checks in", async ({ browser, baseURL }) => {
    const a = await selfCheckin(browser, baseURL!, classes[1].instanceId);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await selfCheckin(browser, baseURL!, classes[2].instanceId);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [member.id])).toBe(2);
  });

  test("C8.03 the desk can mark the same member at the other venue", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const r = await post(owner.request, "/api/checkin", ORIGIN, { memberId: member.id, classInstanceId: classes[0].instanceId, checkInMethod: "admin" });
    expect(r.status(), await r.text()).toBe(201);
    expect(await countRows("AttendanceRecord", '"memberId" = $1 AND "classInstanceId" = $2', [member.id, classes[0].instanceId])).toBe(1);
  });

  test("C8.04 a tier moved to every venue admits everywhere; a tier moved to a venue outside the club is refused", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const bad = await patch(owner.request, `/api/memberships/${tierId}`, ORIGIN, { locationId: "loc_not_ours" });
    expect(bad.status(), "a foreign venue is refused, not dropped").toBe(400);
    const open = await patch(owner.request, `/api/memberships/${tierId}`, ORIGIN, { locationId: null });
    expect(open.status(), await open.text()).toBe(200);
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [member.id]);
    const r = await selfCheckin(browser, baseURL!, classes[0].instanceId);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});
