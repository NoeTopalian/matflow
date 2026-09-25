/**
 * Club life L5 — pausing, leaving, returning (CLUBLIFE-CATALOGUE.md).
 *
 * One throwaway member on the seeded club with a password of their own, one
 * class instance opening right now in the club's own timezone (self check-in
 * enforces the window), and the doors a real club uses: the owner's hold and
 * resume, the member's own check-in, the desk's status changes. Every cell
 * asserts rows, never a bare status. C5.03 documents the coverage finding
 * (a paid cash member cannot self check-in) rather than hiding it.
 */
import { test, expect } from "@playwright/test";
import {
  RUN_STAMP, sql, seededTenantId, sessionFor, closeSessions, post, patch,
  OWNER_EMAIL, THROWAWAY_PASSWORD, countRows, mkTier,
} from "./le-shared";
import { createMember } from "../helpers/db";

test.describe.configure({ mode: "serial", timeout: 180_000 });

const ORIGIN = "http://localhost:3847";

let tenantId: string;
let member: { id: string; email: string };
let classId: string;
let instanceId: string;
let tierId: string | null = null;

function londonNow(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour") === "24" ? "00" : get("hour")}:${get("minute")}` };
}

test.beforeAll(async () => {
  tenantId = await seededTenantId();
  member = await createMember({ name: `${RUN_STAMP} Holly Hold`, email: `${RUN_STAMP}-holly@example.test` });
  const bcrypt = await import("bcryptjs");
  await sql('UPDATE "Member" SET "passwordHash" = $2, "waiverAccepted" = true, "waiverAcceptedAt" = now(), status = $3, "paymentStatus" = $4 WHERE id = $1',
    [member.id, bcrypt.default.hashSync(THROWAWAY_PASSWORD, 10), "active", "paid"]);
  // A class whose only session opens now, in the club's timezone, so the
  // self path's time window admits and the hold gate is the only refusal.
  const { date, time } = londonNow();
  const cls = await sql<{ id: string }>(
    `INSERT INTO "Class" (id, "tenantId", name, duration, "isActive", "createdAt") VALUES (gen_random_uuid()::text, $1, $2, 60, true, now()) RETURNING id`,
    [tenantId, `${RUN_STAMP} Hold class`]);
  classId = cls[0].id;
  const inst = await sql<{ id: string }>(
    `INSERT INTO "ClassInstance" (id, "classId", date, "startTime", "endTime", "isCancelled") VALUES (gen_random_uuid()::text, $1, $2::date, $3, $3, false) RETURNING id`,
    [classId, date, time]);
  instanceId = inst[0].id;
});

test.afterAll(async () => {
  await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "ClassInstance" WHERE "classId" = $1', [classId]).catch(() => {});
  await sql('DELETE FROM "Class" WHERE id = $1', [classId]).catch(() => {});
  await sql('DELETE FROM "MemberStatusEvent" WHERE "memberId" = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "AuditLog" WHERE "entityId" = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE id = $1', [member.id]).catch(() => {});
  if (tierId) await sql('DELETE FROM "MembershipTier" WHERE id = $1', [tierId]).catch(() => {});
  await closeSessions();
});

async function selfCheckin(browser: import("@playwright/test").Browser, baseURL: string) {
  const ctx = await sessionFor(browser, baseURL, member.email, THROWAWAY_PASSWORD);
  const res = await post(ctx.request, "/api/checkin", ORIGIN, { classInstanceId: instanceId, checkInMethod: "self" });
  const body = await res.json().catch(() => ({}));
  return { status: res.status(), body: body as { error?: string; reason?: string } };
}

test.describe("L5 · pause, leave, return", () => {
  test("C5.01 on hold with a date: the member's own check-in is refused, names the date, writes nothing", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const until = new Date(Date.now() + 21 * 86_400_000).toISOString();
    const hold = await post(owner.request, `/api/members/${member.id}/hold`, ORIGIN, { until });
    expect(hold.status(), await hold.text()).toBe(200);

    const r = await selfCheckin(browser, baseURL!);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.reason).toBe("on_hold");
    expect(r.body.error).toMatch(/on hold until/i);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [member.id])).toBe(0);
  });

  test("C5.12 resumed with nothing assigned (no tier, no Stripe, no pack): the portal refuses — a blank row is not a membership", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const resume = await post(owner.request, `/api/members/${member.id}/resume`, ORIGIN, {});
    expect(resume.status(), await resume.text()).toBe(200);
    const row = await sql<{ paymentStatus: string; holdUntil: Date | null }>('SELECT "paymentStatus", "holdUntil" FROM "Member" WHERE id = $1', [member.id]);
    expect(row[0]).toEqual({ paymentStatus: "paid", holdUntil: null });

    const r = await selfCheckin(browser, baseURL!);
    expect(r.status, JSON.stringify(r.body)).toBe(402);
    expect(r.body.error).toMatch(/No active membership/);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [member.id])).toBe(0);
  });

  test("C5.03 paying at the desk (a tier assigned, paid, not overdue): the member checks in — F-L5-1 fixed", async ({ browser, baseURL }) => {
    // A stamped tier of this lane's own (the seeded club may hold none at
    // the moment another lane runs); removed in afterAll.
    tierId = await mkTier(tenantId, { name: `${RUN_STAMP} Desk tier` });
    await sql('UPDATE "Member" SET "membershipTierId" = $2, "nextDueAt" = now() + interval \'10 days\' WHERE id = $1', [member.id, tierId]);
    const r = await selfCheckin(browser, baseURL!);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await countRows("AttendanceRecord", '"memberId" = $1 AND "classInstanceId" = $2', [member.id, instanceId])).toBe(1);
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [member.id]);
  });

  test("C5.13 the same desk member, overdue by the derived rule: refused, told to contact the gym", async ({ browser, baseURL }) => {
    await sql('UPDATE "Member" SET "nextDueAt" = now() - interval \'3 days\' WHERE id = $1', [member.id]);
    const r = await selfCheckin(browser, baseURL!);
    expect(r.status, JSON.stringify(r.body)).toBe(402);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [member.id])).toBe(0);
    await sql('UPDATE "Member" SET "nextDueAt" = NULL, "membershipTierId" = NULL WHERE id = $1', [member.id]);
  });

  test("C5.02 resumed with a Stripe-covered membership: the member checks in", async ({ browser, baseURL }) => {
    await sql('UPDATE "Member" SET "stripeSubscriptionId" = $2, "stripeCustomerId" = $3 WHERE id = $1', [member.id, `sub_${RUN_STAMP}`, `cus_${RUN_STAMP}`]);
    const r = await selfCheckin(browser, baseURL!);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await countRows("AttendanceRecord", '"memberId" = $1 AND "classInstanceId" = $2', [member.id, instanceId])).toBe(1);
  });

  test("C5.11 cancelling a member whose Stripe subscription Stripe does not know is refused honestly, not silently", async ({ browser, baseURL }) => {
    // The fake link from C5.02: the desk cancel reaches Stripe first, Stripe
    // has no such subscription, and the member is NOT flipped. The message
    // tells the owner what to do; only the status code (500) is a UX nit.
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const res = await patch(owner.request, `/api/members/${member.id}`, ORIGIN, { status: "cancelled" });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toMatch(/Cancel manually in Stripe/);
    const row = await sql<{ status: string }>('SELECT status FROM "Member" WHERE id = $1', [member.id]);
    expect(row[0].status, "nothing changed locally").toBe("active");
  });

  test("C5.04 + C5.05 cancelled at the desk: dated, one status event, and the member can no longer check in", async ({ browser, baseURL }) => {
    // Back to a cash member (no Stripe link) for the desk cancel.
    await sql('UPDATE "Member" SET "stripeSubscriptionId" = NULL, "stripeCustomerId" = NULL WHERE id = $1', [member.id]);
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const res = await patch(owner.request, `/api/members/${member.id}`, ORIGIN, { status: "cancelled" });
    expect(res.status(), await res.text()).toBe(200);
    const row = await sql<{ status: string; cancelledAt: Date | null }>('SELECT status, "cancelledAt" FROM "Member" WHERE id = $1', [member.id]);
    expect(row[0].status).toBe("cancelled");
    expect(row[0].cancelledAt).not.toBeNull();
    const events = await sql<{ fromStatus: string; toStatus: string; reason: string }>('SELECT "fromStatus", "toStatus", reason FROM "MemberStatusEvent" WHERE "memberId" = $1 ORDER BY "occurredAt"', [member.id]);
    expect(events).toEqual([{ fromStatus: "active", toStatus: "cancelled", reason: "staff_edit" }]);

    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [member.id]);
    const r = await selfCheckin(browser, baseURL!);
    expect(r.status, "a cancelled member is not admitted").not.toBe(201);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [member.id])).toBe(0);
  });

  test("C5.06 the member comes back: cancelledAt cleared, a second event, history intact, same row", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const res = await patch(owner.request, `/api/members/${member.id}`, ORIGIN, { status: "active" });
    expect(res.status(), await res.text()).toBe(200);
    const row = await sql<{ status: string; cancelledAt: Date | null }>('SELECT status, "cancelledAt" FROM "Member" WHERE id = $1', [member.id]);
    expect(row[0]).toEqual({ status: "active", cancelledAt: null });
    const events = await sql<{ fromStatus: string; toStatus: string }>('SELECT "fromStatus", "toStatus" FROM "MemberStatusEvent" WHERE "memberId" = $1 ORDER BY "occurredAt"', [member.id]);
    expect(events).toEqual([{ fromStatus: "active", toStatus: "cancelled" }, { fromStatus: "cancelled", toStatus: "active" }]);
    expect(await countRows("Member", 'email = $1', [member.email]), "still one row for the person").toBe(1);
  });

  test("C5.07 marked inactive: nothing about money changes", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const before = await sql<{ paymentStatus: string; cancelledAt: Date | null }>('SELECT "paymentStatus", "cancelledAt" FROM "Member" WHERE id = $1', [member.id]);
    const res = await patch(owner.request, `/api/members/${member.id}`, ORIGIN, { status: "inactive" });
    expect(res.status(), await res.text()).toBe(200);
    const after = await sql<{ status: string; paymentStatus: string; cancelledAt: Date | null }>('SELECT status, "paymentStatus", "cancelledAt" FROM "Member" WHERE id = $1', [member.id]);
    expect(after[0].status).toBe("inactive");
    expect(after[0].paymentStatus).toBe(before[0].paymentStatus);
    expect(after[0].cancelledAt).toEqual(before[0].cancelledAt);
  });
});
