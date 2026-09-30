/**
 * Club life L6 — families (CLUBLIFE-CATALOGUE.md).
 *
 * A parent with a password of their own on the seeded club, children created
 * through the owner's door, the parent checking a child in from the portal,
 * and the desk moving children between parents, promoting one to an adult
 * and probing what deleting a parent would do. Rows are asserted, never bare
 * statuses; everything stamped is removed at the end.
 */
import { test, expect } from "@playwright/test";
import {
  RUN_STAMP, sql, seededTenantId, sessionFor, closeSessions, post, get, del,
  OWNER_EMAIL, THROWAWAY_PASSWORD, countRows, mkStaff, mkTier,
} from "./le-shared";
import { createMember } from "../helpers/db";

test.describe.configure({ mode: "serial", timeout: 180_000 });

const ORIGIN = "http://localhost:3847";

let tenantId: string;
let parent: { id: string; email: string };
let otherParent: { id: string; email: string };
let kidA: string;
let kidB: string;
let classId: string;
let instanceId: string;
let tierId: string;

function londonNow(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}` };
}

test.beforeAll(async () => {
  tenantId = await seededTenantId();
  const bcrypt = await import("bcryptjs");
  parent = await createMember({ name: `${RUN_STAMP} Priya Parent`, email: `${RUN_STAMP}-priya@example.test` });
  otherParent = await createMember({ name: `${RUN_STAMP} Omar Other`, email: `${RUN_STAMP}-omar@example.test` });
  await sql('UPDATE "Member" SET "passwordHash" = $2, "waiverAccepted" = true, "waiverAcceptedAt" = now() WHERE id IN ($1, $3)',
    [parent.id, bcrypt.default.hashSync(THROWAWAY_PASSWORD, 10), otherParent.id]);
  tierId = await mkTier(tenantId, { name: `${RUN_STAMP} Kids tier`, isKids: true });
  const { date, time } = londonNow();
  const cls = await sql<{ id: string }>(`INSERT INTO "Class" (id, "tenantId", name, duration, "isActive", "createdAt") VALUES (gen_random_uuid()::text, $1, $2, 60, true, now()) RETURNING id`, [tenantId, `${RUN_STAMP} Kids class`]);
  classId = cls[0].id;
  const inst = await sql<{ id: string }>(`INSERT INTO "ClassInstance" (id, "classId", date, "startTime", "endTime", "isCancelled") VALUES (gen_random_uuid()::text, $1, $2::date, $3, $3, false) RETURNING id`, [classId, date, time]);
  instanceId = inst[0].id;
});

test.afterAll(async () => {
  const ids = [parent.id, otherParent.id, kidA, kidB].filter(Boolean);
  for (const id of ids) {
    await sql('DELETE FROM "AttendanceRecord" WHERE "memberId" = $1', [id]).catch(() => {});
    await sql('DELETE FROM "MemberStatusEvent" WHERE "memberId" = $1', [id]).catch(() => {});
    await sql('DELETE FROM "AuditLog" WHERE "entityId" = $1', [id]).catch(() => {});
  }
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IN ($2, $3)', [tenantId, parent.id, otherParent.id]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP} %`]).catch(() => {});
  await sql('DELETE FROM "ClassInstance" WHERE "classId" = $1', [classId]).catch(() => {});
  await sql('DELETE FROM "Class" WHERE id = $1', [classId]).catch(() => {});
  await sql('DELETE FROM "MembershipTier" WHERE id = $1', [tierId]).catch(() => {});
  await closeSessions();
});

test.describe("L6 · families", () => {
  test("C6.01 the owner adds two children to a parent: kids rows, linked, no login address of their own", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const a = await post(owner.request, "/api/members", ORIGIN, { name: `${RUN_STAMP} Kid Ava`, accountType: "kids", parentMemberId: parent.id, dateOfBirth: "2017-03-21" });
    expect(a.status(), await a.text()).toBe(201);
    kidA = ((await a.json()) as { id: string }).id;
    const b = await post(owner.request, "/api/members", ORIGIN, { name: `${RUN_STAMP} Kid Ben`, accountType: "kids", parentMemberId: parent.id, dateOfBirth: "2014-11-02" });
    expect(b.status(), await b.text()).toBe(201);
    kidB = ((await b.json()) as { id: string }).id;
    const rows = await sql<{ id: string; accountType: string; parentMemberId: string | null; email: string; passwordHash: string | null }>(
      'SELECT id, "accountType", "parentMemberId", email, "passwordHash" FROM "Member" WHERE id IN ($1, $2)', [kidA, kidB]);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.parentMemberId).toBe(parent.id);
      expect(r.accountType).toBe("kids");
      expect(r.passwordHash, "a kid never has a password").toBeNull();
      expect(r.email, "a kid's address is synthesised, not a real inbox").toMatch(/matflow\.local$/);
    }
  });

  // HARNESS FIX (30 Sep 2026): a manager may create a child since efc2889 (the
  // role does everything except Settings and Memberships; end-user round 2
  // found the desk could not). A coach is still refused.
  test("C6.02 a manager can create a child and a coach cannot; a child cannot be a parent", async ({ browser, baseURL }) => {
    const mgr = await mkStaff(tenantId, "manager");
    const mgrCtx = await sessionFor(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD);
    const r = await post(mgrCtx.request, "/api/members", ORIGIN, { name: `${RUN_STAMP} Kid Desk`, accountType: "kids", parentMemberId: parent.id });
    expect(r.status(), "a manager adds a child at the desk").toBe(201);
    const coach = await mkStaff(tenantId, "coach");
    const coachCtx = await sessionFor(browser, baseURL!, coach.email, THROWAWAY_PASSWORD);
    const c = await post(coachCtx.request, "/api/members", ORIGIN, { name: `${RUN_STAMP} Kid Nope`, accountType: "kids", parentMemberId: parent.id });
    expect(c.status(), "a coach cannot add a child").toBe(403);
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const nested = await post(owner.request, "/api/members", ORIGIN, { name: `${RUN_STAMP} Kid Nested`, accountType: "kids", parentMemberId: kidA });
    expect(nested.status(), "no nesting").toBe(400);
    expect(await countRows("Member", '"tenantId" = $1 AND "parentMemberId" = $2', [tenantId, kidA])).toBe(0);
  });

  test("C6.03 the parent checks a child in from the portal; someone else's child is a 404", async ({ browser, baseURL }) => {
    // The child needs what any self check-in needs: a signed (kids) waiver and coverage — here a desk membership.
    await sql('UPDATE "Member" SET "waiverAccepted" = true, "waiverAcceptedAt" = now(), "membershipTierId" = $2, "paymentStatus" = $3, "nextDueAt" = now() + interval \'10 days\' WHERE id = $1', [kidA, tierId, "paid"]);
    const p = await sessionFor(browser, baseURL!, parent.email, THROWAWAY_PASSWORD);
    const ok = await post(p.request, "/api/checkin", ORIGIN, { classInstanceId: instanceId, onBehalfOfMemberId: kidA });
    expect(ok.status(), await ok.text()).toBe(201);
    expect(await countRows("AttendanceRecord", '"memberId" = $1 AND "classInstanceId" = $2', [kidA, instanceId])).toBe(1);

    const other = await sessionFor(browser, baseURL!, otherParent.email, THROWAWAY_PASSWORD);
    const no = await post(other.request, "/api/checkin", ORIGIN, { classInstanceId: instanceId, onBehalfOfMemberId: kidB });
    expect(no.status(), "not their child").toBe(404);
    expect(await countRows("AttendanceRecord", '"memberId" = $1', [kidB])).toBe(0);
  });

  test("C6.04 unlink a child and link them to another parent: the row survives, only the link moves", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    // A child can never be left without a guardian: unlinking alone is
    // refused (the kids CHECK behind it), so a move is a link to the new
    // guardian. Both facts are pinned. unlink-child is a DELETE with a JSON
    // body (route.ts:14).
    const un = await owner.request.delete(`/api/members/${parent.id}/unlink-child`, { headers: { Origin: ORIGIN }, data: { childMemberId: kidB }, maxRedirects: 0 });
    expect(un.status(), await un.text()).toBe(409);
    expect(await un.text()).toMatch(/without a guardian/);
    let row = await sql<{ parentMemberId: string | null; accountType: string }>('SELECT "parentMemberId", "accountType" FROM "Member" WHERE id = $1', [kidB]);
    expect(row[0].parentMemberId, "still linked").toBe(parent.id);
    const link = await post(owner.request, `/api/members/${otherParent.id}/link-child`, ORIGIN, { childMemberId: kidB });
    expect(link.status(), await link.text()).toBe(200);
    row = await sql<{ parentMemberId: string | null; accountType: string }>('SELECT "parentMemberId", "accountType" FROM "Member" WHERE id = $1', [kidB]);
    expect(row[0].parentMemberId).toBe(otherParent.id);
    expect(await countRows("Member", 'id = $1', [kidB]), "same row, never recreated").toBe(1);
  });

  test("C6.05 promote a child to an adult: own account, no parent, kids count on the old parent drops", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const r = await post(owner.request, `/api/members/${kidB}/promote-to-adult`, ORIGIN, {});
    expect(r.status(), await r.text()).toBe(200);
    const row = await sql<{ parentMemberId: string | null; accountType: string }>('SELECT "parentMemberId", "accountType" FROM "Member" WHERE id = $1', [kidB]);
    expect(row[0]).toEqual({ parentMemberId: null, accountType: "adult" });
    expect(await countRows("Member", '"parentMemberId" = $1', [otherParent.id])).toBe(0);
    const again = await post(owner.request, `/api/members/${kidB}/promote-to-adult`, ORIGIN, {});
    expect(again.status(), "an adult cannot be promoted twice").not.toBe(200);
  });

  test("C6.06 deleting a parent with a child is not a one-click delete: the probe names the child and nothing is removed", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const probe = await del(owner.request, `/api/members/${parent.id}?probe=1`, ORIGIN);
    const body = (await probe.json().catch(() => ({}))) as { noKids?: boolean; hasKids?: boolean; kids?: { id: string }[] };
    expect(probe.status(), JSON.stringify(body)).toBe(200);
    expect(body.hasKids, "the probe says there are children").toBe(true);
    expect(body.kids?.map((k) => k.id)).toContain(kidA);
    expect(await countRows("Member", 'id = $1', [parent.id]), "the parent still exists").toBe(1);
    expect(await countRows("Member", 'id = $1', [kidA]), "so does the child").toBe(1);
    const parentView = await get(owner.request, `/api/members/${parent.id}`);
    expect(parentView.status()).toBe(200);
  });
});
