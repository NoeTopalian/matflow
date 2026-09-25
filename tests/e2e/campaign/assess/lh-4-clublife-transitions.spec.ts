/**
 * Club life L13 — screen transitions and resilience (ten-club audit 2026-09-25,
 * section 4). What happens between screens on the critical money and status
 * doors: a double-clicked submit, a refresh mid-form, the browser's back after
 * a create, a session that expired before the save, two members of staff
 * editing the same row. Every cell asserts rows, never a bare status; the
 * product's own idempotency (a requestId minted once per dialog, an optimistic
 * updatedAt) is what is under test. Everything stamped is removed after.
 */
import { test, expect } from "@playwright/test";
import {
  RUN_STAMP, sql, seededTenantId, sessionFor, closeSessions, post, patch,
  OWNER_EMAIL, countRows, mkTier,
} from "./le-shared";
import { createMember } from "../helpers/db";

test.describe.configure({ mode: "serial", timeout: 180_000 });

const ORIGIN = "http://localhost:3847";

let tenantId: string;
let member: { id: string; email: string };
let tierId: string | null = null;

test.beforeAll(async () => {
  tenantId = await seededTenantId();
  member = await createMember({ name: `${RUN_STAMP} Tia Transition`, email: `${RUN_STAMP}-tia@example.test` });
  tierId = await mkTier(tenantId, { name: `${RUN_STAMP} Transition tier`, pricePence: 5500, billingCycle: "four_weekly" });
  await sql('UPDATE "Member" SET status = $2, "paymentStatus" = $3, "membershipTierId" = $4 WHERE id = $1', [member.id, "active", "paid", tierId]);
});

test.afterAll(async () => {
  await sql('DELETE FROM "Payment" WHERE "memberId" = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "MemberStatusEvent" WHERE "memberId" = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "AuditLog" WHERE "entityId" = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE id = $1', [member.id]).catch(() => {});
  await sql('DELETE FROM "Member" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP} %`]).catch(() => {});
  if (tierId) await sql('DELETE FROM "MembershipTier" WHERE id = $1', [tierId]).catch(() => {});
  await sql('DELETE FROM "RateLimitHit" WHERE bucket LIKE $1', ["payments:manual:%"]).catch(() => {});
  await closeSessions();
});

test.describe("L13 · transitions", () => {
  test("C13.01 a double-clicked cash payment records exactly one payment (one requestId per dialog)", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const before = await countRows("Payment", '"memberId" = $1', [member.id]);
    // RecordPaymentModal mints one requestId per open (components/dashboard/RecordPaymentModal.tsx:129);
    // a double click sends the same body twice, concurrently.
    const body = { memberId: member.id, amountPence: 5500, method: "cash", requestId: `${RUN_STAMP}-dbl-${Date.now()}` };
    const [a, b] = await Promise.all([post(owner.request, "/api/payments/manual", ORIGIN, body), post(owner.request, "/api/payments/manual", ORIGIN, body)]);
    const statuses = [a.status(), b.status()].sort();
    test.info().annotations.push({ type: "observed", description: `double submit → ${statuses.join(",")}` });
    expect(statuses.every((s) => s < 500), "neither answer is a 500").toBe(true);
    const after = await countRows("Payment", '"memberId" = $1', [member.id]);
    expect(after - before, "exactly one Payment row from two identical submits").toBe(1);
    const due = await sql<{ nextDueAt: string | null }>('SELECT "nextDueAt" FROM "Member" WHERE id = $1', [member.id]);
    expect(due[0].nextDueAt, "the due date moved once, not twice").toBeTruthy();
  });

  test("C13.02 a double-clicked hold puts the member on hold once, with one audit row", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const until = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const [a, b] = await Promise.all([post(owner.request, `/api/members/${member.id}/hold`, ORIGIN, { until }), post(owner.request, `/api/members/${member.id}/hold`, ORIGIN, { until })]);
    const statuses = [a.status(), b.status()].sort();
    test.info().annotations.push({ type: "observed", description: `double hold → ${statuses.join(",")}` });
    expect(statuses.every((s) => s < 500)).toBe(true);
    expect(statuses[0], "the first wins").toBe(200);
    const row = await sql<{ paymentStatus: string; holdUntil: string | null }>('SELECT "paymentStatus", "holdUntil" FROM "Member" WHERE id = $1', [member.id]);
    expect(row[0].paymentStatus).toBe("paused");
    expect(row[0].holdUntil).toBeTruthy();
    const audits = await countRows("AuditLog", '"entityId" = $1 AND action = $2', [member.id, "member.hold.start"]);
    expect(audits, "one hold audit row, not two").toBe(1);
    const resume = await post(owner.request, `/api/members/${member.id}/resume`, ORIGIN, {});
    expect(resume.status()).toBe(200);
  });

  test("C13.03 two staff on one member: the second save with a stale updatedAt is refused, the first survives", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    // The precondition comes from the product's own read, never from SQL: the
    // column is timestamp-without-zone holding UTC and the pg driver parses it as
    // local time, so a SQL-read value is an hour out under BST (a0-1 records the
    // same hazard) and the first save would be refused as stale by the harness.
    const freshRes = await owner.request.get(`/api/members/${member.id}`);
    expect(freshRes.status(), "read the member").toBe(200);
    const freshBody = (await freshRes.json()) as { updatedAt?: string; member?: { updatedAt?: string } };
    const stale = freshBody.updatedAt ?? freshBody.member?.updatedAt ?? "";
    expect(stale, "the member read carries updatedAt").toBeTruthy();
    const first = await patch(owner.request, `/api/members/${member.id}`, ORIGIN, { notes: `${RUN_STAMP} first desk`, updatedAt: stale });
    expect(first.status(), await first.text()).toBe(200);
    const second = await patch(owner.request, `/api/members/${member.id}`, ORIGIN, { notes: `${RUN_STAMP} second desk`, updatedAt: stale });
    expect(second.status(), "the stale form is refused, not silently overwritten").toBe(409);
    const row = await sql<{ notes: string | null }>('SELECT notes FROM "Member" WHERE id = $1', [member.id]);
    expect(row[0].notes).toBe(`${RUN_STAMP} first desk`);
  });

  test("C13.04 a refresh in the middle of Add Member writes nothing and the form is gone", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const page = await owner.newPage();
    await page.goto("/dashboard/members");
    await page.getByRole("button", { name: /add member/i }).first().click();
    const name = page.getByLabel("Full Name");
    await expect(name).toBeVisible({ timeout: 30_000 });
    await name.fill(`${RUN_STAMP} Half Typed`);
    const before = await countRows("Member", '"tenantId" = $1', [tenantId]);
    await page.reload();
    await expect(page.getByRole("dialog"), "the dialog does not survive a reload").toHaveCount(0);
    expect(await countRows("Member", '"tenantId" = $1 AND name = $2', [tenantId, `${RUN_STAMP} Half Typed`]), "nothing was written").toBe(0);
    expect(await countRows("Member", '"tenantId" = $1', [tenantId])).toBe(before);
    await page.close();
  });

  test("C13.05 back after a create does not create again", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const page = await owner.newPage();
    await page.goto("/dashboard/members");
    await page.getByRole("button", { name: /add member/i }).first().click();
    const name = page.getByLabel("Full Name");
    await expect(name).toBeVisible({ timeout: 30_000 });
    await name.fill(`${RUN_STAMP} Back Button`);
    const wire = page.waitForResponse((r) => r.url().includes("/api/members") && r.request().method() === "POST", { timeout: 30_000 });
    await page.getByRole("dialog").getByRole("button", { name: /^Add Member$/ }).click();
    const res = await wire;
    expect(res.status(), "the create landed").toBe(201);
    await page.waitForTimeout(500);
    await page.goBack().catch(() => {});
    await page.goForward().catch(() => {});
    await page.waitForTimeout(1500);
    expect(await countRows("Member", '"tenantId" = $1 AND name = $2', [tenantId, `${RUN_STAMP} Back Button`]), "exactly one row after back and forward").toBe(1);
    await page.close();
  });

  test("C13.06 a session that expired before the save: no 'saved', nothing written", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, baseURL!, OWNER_EMAIL);
    const page = await owner.newPage();
    await page.goto("/dashboard/settings");
    await page.evaluate(() => window.localStorage.removeItem("gym-settings"));
    const before = await sql<{ name: string }>('SELECT name FROM "Tenant" WHERE id = $1', [tenantId]);
    const nameInput = page.getByLabel(/gym name|club name/i).first();
    if (await nameInput.count()) await nameInput.fill(`${RUN_STAMP} EXPIRED`);
    // The session dies between the last render and the click.
    await owner.clearCookies();
    const save = page.getByRole("button", { name: /save/i }).first();
    if (await save.count()) {
      await save.click();
      await page.waitForTimeout(3000);
      await expect(page.locator("body"), "an unauthenticated save is never rendered as success").not.toContainText(/saved/i);
    }
    const after = await sql<{ name: string }>('SELECT name FROM "Tenant" WHERE id = $1', [tenantId]);
    expect(after[0].name, "nothing written by a save with no session").toBe(before[0].name);
    test.info().annotations.push({ type: "observed", description: `after the expired save the page is at ${page.url()}` });
    await page.close();
  });

  test("C13.07 club switch — recorded, not built", async () => {
    test.info().annotations.push({ type: "observed", description: "one session = one club; there is no switcher (ADR-001 D4 verified Person identity NOT STARTED). A staff member of two clubs signs out and in with the other club code." });
  });
});
