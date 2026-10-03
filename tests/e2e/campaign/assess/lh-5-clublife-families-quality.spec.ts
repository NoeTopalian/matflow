/**
 * Lane L-H file 5 — families on the screens people use (Package B, 26 Sep 2026).
 *
 * lh-2 proved the family API on the wire (add, move, promote, check in, delete
 * probe). This file drives the SCREENS: a parent on a phone runs the whole
 * family from /member/profile ("My Family") and /member/family/[childId]; the
 * owner runs the staff Family card at phone and desktop widths. Where the
 * screen is a signature canvas or a class picker, the action goes through the
 * same route the screen calls and the SCREEN is asserted afterwards — each
 * cell says which.
 *
 * Every fixture is run-stamped and removed by teardownSeededClub. Nothing
 * here touches the seeded members. Screenshots for the contact sheet land in
 * .omc/sheets/<date>/families-*.png (git-ignored).
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  OWNER_EMAIL, PASSWORD, THROWAWAY_PASSWORD, PHONE, sessionFor, closeSessions,
  mkMember, mkKid, mkClass, mkSchedule, mkInstance, teardownSeededClub, sql, seededTenantId, RUN_STAMP,
  type LfMember,
} from "./lf-shared";
import { mkTier } from "./le-shared";

test.describe.configure({ mode: "serial", timeout: 180_000 });

const ORIGIN = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3847";
const SHEET_DIR = path.join(process.cwd(), ".omc", "sheets", new Date().toISOString().slice(0, 10));
const DESKTOP = { width: 1440, height: 900 };

// A real 1x1 PNG: the waiver route decodes the data URL and refuses anything
// that is not a PNG. Long enough for the schema's minimum.
const SIGNATURE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let tenantId: string;
let parent: LfMember;
let other: LfMember;
let kidA: LfMember;
let kidB: LfMember;
let otherKid: LfMember;
let tierId: string;
let classId: string;
let instanceId: string;
let parentCtx: BrowserContext;
let otherCtx: BrowserContext;
let ownerCtx: BrowserContext;
/** The child the parent adds from the portal in B-02; removed in B-08. */
let addedKidId: string | null = null;
/** The database clock when this lane began — B-09 counts mail queued since. */
let laneStartedAt: string;

function londonNowWindow(): { date: string; start: string; end: string } {
  const fmt = (d: Date) => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)!.value;
    return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}` };
  };
  const now = new Date();
  const s = fmt(new Date(now.getTime() - 5 * 60_000));
  const e = fmt(new Date(now.getTime() + 55 * 60_000));
  return { date: s.date, start: s.time, end: e.time };
}

async function shot(page: Page, name: string) {
  fs.mkdirSync(SHEET_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHEET_DIR, `families-${name}.png`) }).catch(() => {});
}

async function post(ctx: BrowserContext, url: string, data: unknown) {
  return ctx.request.post(url, { headers: { Origin: ORIGIN }, data: data as never });
}
async function patch(ctx: BrowserContext, url: string, data: unknown) {
  return ctx.request.patch(url, { headers: { Origin: ORIGIN }, data: data as never });
}
// Mutating routes require an Origin (lib/csrf.ts). A raw request.delete() is
// refused by the CSRF guard before any authority check, which would make an
// authority assertion pass for the wrong reason.
async function del(ctx: BrowserContext, url: string) {
  return ctx.request.delete(url, { headers: { Origin: ORIGIN } });
}

test.beforeAll(async ({ browser }) => {
  laneStartedAt = (await sql<{ t: string }>("SELECT (now() AT TIME ZONE 'UTC')::text AS t"))[0].t;
  tenantId = await seededTenantId();
  parent = await mkMember({ accountType: "parent", name: `${RUN_STAMP} B Parent`, withPassword: true });
  other = await mkMember({ accountType: "parent", name: `${RUN_STAMP} B Other`, withPassword: true });
  await sql('UPDATE "Member" SET "waiverAccepted" = true, "waiverAcceptedAt" = now() WHERE id IN ($1, $2)', [parent.id, other.id]);
  kidA = await mkKid(parent.id, `${RUN_STAMP} Kid Ada`);
  kidB = await mkKid(parent.id, `${RUN_STAMP} Kid Ben`);
  otherKid = await mkKid(other.id, `${RUN_STAMP} Kid Omar`);
  tierId = await mkTier(tenantId, { name: `${RUN_STAMP} B Kids tier`, isKids: true });
  const { date, start, end } = londonNowWindow();
  classId = await mkClass(tenantId, `${RUN_STAMP} B Kids class`);
  await mkSchedule(classId, { dayOfWeek: new Date().getDay(), startTime: start, endTime: end });
  instanceId = await mkInstance(classId, { startTime: start, endTime: end, date: new Date(`${date}T12:00:00`) });

  parentCtx = await sessionFor(browser, ORIGIN, { email: parent.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true });
  otherCtx = await sessionFor(browser, ORIGIN, { email: other.email, password: THROWAWAY_PASSWORD, viewport: PHONE, isMobile: true });
  ownerCtx = await sessionFor(browser, ORIGIN, { email: OWNER_EMAIL, password: PASSWORD, viewport: DESKTOP, isMobile: false });
});

test.afterAll(async () => {
  // Each sql() opens its own connection to the remote branch; ~20 of them
  // outrun the default 30s hook budget.
  test.setTimeout(180_000);
  // Children first: deleting a parent sets the kid's parentMemberId to NULL,
  // which the `Member_kids_must_have_parent` CHECK refuses. Their dependants
  // go before them.
  const kids = await sql<{ id: string }>(
    'SELECT id FROM "Member" WHERE "tenantId" = $1 AND "parentMemberId" IN ($2, $3)', [tenantId, parent.id, other.id],
  ).catch(() => [] as { id: string }[]);
  const kidIds = kids.map((k) => k.id);
  if (kidIds.length) {
    for (const table of ["AttendanceRecord", "SignedWaiver", "MemberPhoto", "MemberStatusEvent", "MemberRank", "Payment"]) {
      await sql(`DELETE FROM "${table}" WHERE "memberId" = ANY($1)`, [kidIds]).catch(() => {});
    }
    await sql('DELETE FROM "AuditLog" WHERE "entityId" = ANY($1)', [kidIds]).catch(() => {});
    await sql('DELETE FROM "Member" WHERE id = ANY($1)', [kidIds]).catch(() => {});
  }
  for (const id of [parent.id, other.id]) {
    for (const table of ["AttendanceRecord", "SignedWaiver", "MemberStatusEvent", "Payment"]) {
      await sql(`DELETE FROM "${table}" WHERE "memberId" = $1`, [id]).catch(() => {});
    }
    await sql('DELETE FROM "AuditLog" WHERE "entityId" = $1', [id]).catch(() => {});
  }
  await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" = $1', [instanceId]).catch(() => {});
  await sql('DELETE FROM "MembershipTier" WHERE id = $1', [tierId]).catch(() => {});
  await teardownSeededClub();
  await closeSessions();
  const left = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "Member" WHERE "tenantId" = $1 AND name LIKE $2', [tenantId, `${RUN_STAMP} %`]);
  expect(Number(left[0].n), "run-stamped members survived teardown").toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// The parent on a phone
// ─────────────────────────────────────────────────────────────────────────────
test.describe("B · a parent runs the whole family from a phone", () => {
  test("B-01 SCREEN · My Family lists both children; a child's page shows belt, waiver and attendance tiles", async () => {
    const page = await parentCtx.newPage();
    await page.goto("/member/profile");
    await expect(page.getByText("My Family")).toBeVisible();
    await expect(page.getByText(kidA.name)).toBeVisible();
    await expect(page.getByText(kidB.name)).toBeVisible();
    await shot(page, "profile-family-375");

    await page.getByRole("button", { name: `View ${kidA.name}'s profile` }).click();
    await page.waitForURL(new RegExp(`/member/family/${kidA.id}`));
    await expect(page.getByText("Belt", { exact: true })).toBeVisible();
    await expect(page.getByText("Waiver", { exact: true })).toBeVisible();
    // Honest state: the waiver is unsigned and says so in words.
    await expect(page.getByText("Missing", { exact: true })).toBeVisible();
    await expect(page.getByText("This week", { exact: true })).toBeVisible();
    await expect(page.getByText("No classes attended yet.")).toBeVisible();
    await shot(page, "child-page-unsigned-375");
    await page.close();
  });

  test("B-02 SCREEN · Add a child from the portal: a kids row with a synthesised address and no password", async () => {
    const page = await parentCtx.newPage();
    await page.goto("/member/profile");
    // "Add a child" in the empty state, "Add another child" once one exists.
    await page.getByRole("button", { name: /Add (a|another) child/ }).click();
    await expect(page.getByRole("heading", { name: "Add a child" })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(`${RUN_STAMP} Kid Cleo`);
    await page.getByLabel("Date of birth (optional)").fill("2018-05-04");
    await shot(page, "add-child-modal-375");
    await page.getByRole("button", { name: "Add child" }).click();
    await expect(page.getByText(`${RUN_STAMP} Kid Cleo`)).toBeVisible();

    const rows = await sql<{ id: string; accountType: string; parentMemberId: string | null; email: string; passwordHash: string | null; dateOfBirth: Date | null; guardianConfirmedAt: Date | null; guardianSuggestedBy: string | null }>(
      'SELECT id, "accountType", "parentMemberId", email, "passwordHash", "dateOfBirth", "guardianConfirmedAt", "guardianSuggestedBy" FROM "Member" WHERE "tenantId" = $1 AND name = $2',
      [tenantId, `${RUN_STAMP} Kid Cleo`],
    );
    expect(rows, "exactly one child row").toHaveLength(1);
    addedKidId = rows[0].id;
    expect(rows[0].accountType).toBe("kids");
    expect(rows[0].parentMemberId).toBe(parent.id);
    expect(rows[0].email.endsWith("@no-login.matflow.local"), `synthesised address, got ${rows[0].email}`).toBe(true);
    expect(rows[0].passwordHash, "a child never has a password").toBeNull();
    expect(rows[0].dateOfBirth, "the date of birth landed").not.toBeNull();
    // 3 Oct 2026: a parent's own brand-new child is confirmed on creation — the
    // row claims no existing person. An import-inferred link stays suggested.
    expect(rows[0].guardianConfirmedAt, "the parent's own new child is confirmed").not.toBeNull();
    expect(rows[0].guardianSuggestedBy, "and records who made the link").toBe("member");
    await page.close();
  });

  test("B-03 SCREEN · Edit a child's name from the row menu", async () => {
    const page = await parentCtx.newPage();
    await page.goto("/member/profile");
    await page.getByRole("button", { name: `Actions for ${RUN_STAMP} Kid Cleo` }).click();
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Edit child" })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(`${RUN_STAMP} Kid Cleo Renamed`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(`${RUN_STAMP} Kid Cleo Renamed`)).toBeVisible();
    const rows = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [addedKidId]);
    expect(rows[0]?.name).toBe(`${RUN_STAMP} Kid Cleo Renamed`);
    await page.close();
  });

  test("B-04 ROUTE+SCREEN · signing for a child needs the parent's emergency contact first (refused in words), then signs; the page says Signed", async () => {
    const body = {
      childMemberId: kidA.id,
      signatureDataUrl: SIGNATURE_PNG,
      signerName: parent.name,
      agreedTo: true,
    };
    // Safeguarding pre-condition: a parent with no emergency contact on file
    // cannot sign for a child, and the refusal says what to do.
    const refused = await post(parentCtx, "/api/waiver/sign-for-child", body);
    expect(refused.status(), await refused.text()).toBe(400);
    expect(await refused.text()).toMatch(/emergency contact/i);
    expect(Number((await sql<{ n: string }>('SELECT count(*)::text AS n FROM "SignedWaiver" WHERE "memberId" = $1', [kidA.id]))[0].n)).toBe(0);

    await sql(
      'UPDATE "Member" SET "emergencyContactName" = $2, "emergencyContactPhone" = $3, "emergencyContactRelation" = $4 WHERE id = $1',
      [parent.id, "Gran Parent", "07700900123", "Grandparent"],
    );
    const res = await post(parentCtx, "/api/waiver/sign-for-child", body);
    expect(res.status(), await res.text()).toBe(201);
    const signed = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "SignedWaiver" WHERE "memberId" = $1', [kidA.id]);
    expect(Number(signed[0].n), "one signed waiver row for the child").toBe(1);
    const member = await sql<{ waiverAccepted: boolean }>('SELECT "waiverAccepted" FROM "Member" WHERE id = $1', [kidA.id]);
    expect(member[0].waiverAccepted).toBe(true);

    const page = await parentCtx.newPage();
    await page.goto(`/member/family/${kidA.id}`);
    await expect(page.getByText("Signed", { exact: true })).toBeVisible();
    await shot(page, "child-page-signed-375");
    await page.close();
  });

  test("B-05 ROUTE+SCREEN · the parent checks the child in (the sheet posts to /api/checkin); the child's page counts it", async () => {
    await sql('UPDATE "Member" SET "membershipTierId" = $2, "paymentStatus" = $3, "nextDueAt" = now() + interval \'10 days\' WHERE id = $1', [kidA.id, tierId, "paid"]);
    const res = await post(parentCtx, "/api/checkin", { classInstanceId: instanceId, onBehalfOfMemberId: kidA.id });
    expect(res.status(), await res.text()).toBe(201);
    const page = await parentCtx.newPage();
    await page.goto(`/member/family/${kidA.id}`);
    await expect(page.getByText("Recent classes")).toBeVisible();
    // The class appears under "Recent classes" (and again as "Next class"
    // while its window is open) — at least once is the assertion.
    await expect(page.getByText(`${RUN_STAMP} B Kids class`).first()).toBeVisible();
    // The "This week" tile reads 1: the number is the <p> after the label row.
    const thisWeek = page.locator("span", { hasText: /^This week$/ }).locator("xpath=../following-sibling::p[1]");
    await expect(thisWeek).toHaveText("1");
    await shot(page, "child-page-attended-375");
    await page.close();
  });

  test("B-06 REFUSED · another parent's child by direct id: the route is 404, the page is an error state, a PATCH changes nothing", async () => {
    const api = await otherCtx.request.get(`/api/member/children/${kidA.id}`);
    expect(api.status()).toBe(404);
    const before = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [kidA.id]);
    const p = await patch(otherCtx, `/api/member/children/${kidA.id}`, { name: "Hijacked" });
    expect(p.status()).toBe(404);
    const after = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [kidA.id]);
    expect(after[0].name).toBe(before[0].name);

    const page = await otherCtx.newPage();
    await page.goto(`/member/family/${kidA.id}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // UI-RULES §7: an HTTP error is never an empty page. The child's name must
    // not appear, something must say it could not be shown, and the parent
    // must have a way back inside their own shell. (Before app/member/
    // not-found.tsx this fell through to Next's bare white "404 | This page
    // could not be found." with no shell and no link — lh-5 B-06, 26 Sep 2026.)
    await expect(page.getByText(kidA.name)).toHaveCount(0);
    const honest = page.getByText(/couldn.t find|could not be found|not found/i).first();
    await expect(honest, "a 404 on a child page must be an error state, not a blank or a skeleton").toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("link", { name: /Back to profile/ }), "a way back, inside the member shell").toBeVisible();
    await expect(page.locator("nav").first(), "the member shell (its nav) is still around the 404").toBeVisible();
    await shot(page, "child-page-foreign-375");
    await page.close();
  });

  test("B-07 · guardian move: after the owner links the child to another parent, the old parent's stale tab is refused and their list no longer shows the child", async () => {
    const page = await parentCtx.newPage();
    await page.goto(`/member/family/${kidB.id}`);
    await expect(page.getByRole("heading", { name: kidB.name })).toBeVisible();

    const move = await post(ownerCtx, `/api/members/${other.id}/link-child`, { childMemberId: kidB.id });
    expect(move.status(), await move.text()).toBe(200);
    const row = await sql<{ parentMemberId: string | null }>('SELECT "parentMemberId" FROM "Member" WHERE id = $1', [kidB.id]);
    expect(row[0].parentMemberId).toBe(other.id);

    // The old parent's session, acting from the stale tab: refused.
    const stale = await patch(parentCtx, `/api/member/children/${kidB.id}`, { name: `${kidB.name} stale` });
    expect(stale.status()).toBe(404);
    const unchanged = await sql<{ name: string }>('SELECT name FROM "Member" WHERE id = $1', [kidB.id]);
    expect(unchanged[0].name).toBe(kidB.name);

    await page.goto("/member/profile");
    await expect(page.getByText("My Family")).toBeVisible();
    // The list loads after the card: wait for the child who stays before
    // asserting the absence of the one who moved (a count of 0 is trivially
    // true while the list is still loading).
    await expect(page.getByText(kidA.name)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(kidB.name)).toHaveCount(0);
    await page.close();

    // And the new guardian sees them.
    const p2 = await otherCtx.newPage();
    await p2.goto("/member/profile");
    await expect(p2.getByText(kidB.name)).toBeVisible({ timeout: 20_000 });
    await p2.close();
  });

  test("B-08 · Removing a child is the club's to do: the portal offers no control and the route refuses a parent", async () => {
    // 2 Oct 2026 — administrator-controlled families. This used to drive a
    // member-side Remove dialog. Removing a child is a relationship change, so
    // it belongs to an owner or a manager: the control is gone from the portal
    // and DELETE /api/member/children/[id] refuses a member. The old test is
    // kept as this stricter one rather than deleted, so the behaviour it covered
    // is still pinned.
    await sql('UPDATE "Member" SET "waiverAccepted" = true, "waiverAcceptedAt" = now(), "membershipTierId" = $2, "paymentStatus" = $3, "nextDueAt" = now() + interval \'10 days\' WHERE id = $1', [addedKidId, tierId, "paid"]);
    const checkin = await post(parentCtx, "/api/checkin", { classInstanceId: instanceId, onBehalfOfMemberId: addedKidId });
    expect(checkin.status(), await checkin.text()).toBe(201);

    const page = await parentCtx.newPage();
    await page.goto("/member/profile");
    const name = `${RUN_STAMP} Kid Cleo Renamed`;
    await page.getByRole("button", { name: `Actions for ${name}` }).click();

    await expect(
      page.getByRole("button", { name: "Remove" }),
      "a parent is not offered a control the server refuses",
    ).toHaveCount(0);
    await expect(page.getByText(/Ask your club to remove/)).toBeVisible();
    await shot(page, "no-member-remove-control-375");

    // And the route itself refuses, so hiding the button is not the only guard.
    // Through the file's own helper so an Origin header is sent: a raw
    // request.delete() is refused by the CSRF guard, which would make this pass
    // for the wrong reason rather than on the authority gate.
    const refused = await del(parentCtx, `/api/member/children/${addedKidId}`);
    expect(refused.status(), await refused.text()).toBe(403);

    const still = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "Member" WHERE id = $1', [addedKidId]);
    expect(Number(still[0].n), "the child survives a refused removal").toBe(1);
    const att = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "AttendanceRecord" WHERE "memberId" = $1', [addedKidId]);
    expect(Number(att[0].n), "and so does their attendance").toBe(1);

    // The owner may remove them, which is the point of the rule.
    // ?confirm=1 is the no-kids path. An unqualified DELETE is refused by
    // design: the route requires ?probe=1 to inspect, then an explicit
    // ?confirm=1 or ?strategy=... to act, because a legacy probe once deleted
    // children before anyone confirmed (app/api/members/[id]/route.ts:547).
    const byOwner = await del(ownerCtx, `/api/members/${addedKidId}?confirm=1`);
    expect([200, 204], await byOwner.text()).toContain(byOwner.status());
    const gone = await sql<{ n: string }>('SELECT count(*)::text AS n FROM "Member" WHERE id = $1', [addedKidId]);
    expect(Number(gone[0].n), "an administrator can do what the parent cannot").toBe(0);
    addedKidId = null;
    await page.close();
  });

  test("B-09 · a synthesised child address never authenticates and is never mailed", async ({ browser }) => {
    const ctx = await browser.newContext({ baseURL: ORIGIN, storageState: undefined, viewport: PHONE });
    await ctx.clearCookies();
    const page = await ctx.newPage();
    await page.goto("/login?club=totalbjj");
    await page.waitForSelector("input[type='email']", { timeout: 45_000 });
    await page.fill("input[type='email']", kidA.email);
    await page.fill("input[type='password']", THROWAWAY_PASSWORD);
    await page.click("button[type='submit']");
    await expect(page.getByText("Incorrect email or password.")).toBeVisible({ timeout: 20_000 });
    expect(page.url()).toContain("/login");
    await ctx.close();

    // Forgot-password for the synthesised address must not queue a message.
    const forgot = await ctx.request.post("/api/auth/forgot-password", { headers: { Origin: ORIGIN }, data: { email: kidA.email, tenantSlug: "totalbjj", club: "totalbjj" } }).catch(() => null);
    if (forgot) expect(forgot.status(), "forgot-password answers without leaking whether the address exists").toBeLessThan(500);
    // HARNESS: this counted EVERY EmailLog row on the shared test branch, ever,
    // so residue this lane did not write failed it for good — two
    // `payment_failed` rows from scripts/stripe-family-e2e.mjs (26 Sep, the
    // webhook path, reported separately) and one `kiosk_waiver` row written
    // before 6426e88 refused child addresses at kiosk-request. Scoped to mail
    // queued while this lane ran — every tenant, every template, still zero.
    const mailed = await sql<{ n: string }>(
      `SELECT count(*)::text AS n FROM "EmailLog" WHERE recipient LIKE '%@no-login.matflow.local' AND "createdAt" >= $1::timestamp`,
      [laneStartedAt],
    );
    expect(Number(mailed[0].n), "no message has been queued to a synthesised address during this lane").toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The owner at the desk: the Family card
// ─────────────────────────────────────────────────────────────────────────────
test.describe("B · the staff Family card at desktop and phone widths", () => {
  test("B-10 SCREEN · Add child dialog creates a linked kids row; Link existing moves a child; an under-13 is not offered Unlink", async ({ browser }) => {
    const page = await ownerCtx.newPage();
    await page.goto(`/dashboard/members/${parent.id}`);
    await expect(page.getByText("Family", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add child" }).click();
    await expect(page.getByRole("dialog", { name: new RegExp(`Add child to`) })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill(`${RUN_STAMP} Kid Dee`);
    await page.getByLabel("Date of birth").fill("2016-02-03");
    await shot(page, "staff-add-child-1440");
    await page.getByRole("dialog").getByRole("button", { name: "Add child" }).click();
    // The row is a link; the toast ("… added") also carries the name.
    await expect(page.getByRole("link", { name: new RegExp(`${RUN_STAMP} Kid Dee`) })).toBeVisible();
    const dee = await sql<{ id: string; parentMemberId: string | null; accountType: string }>(
      'SELECT id, "parentMemberId", "accountType" FROM "Member" WHERE "tenantId" = $1 AND name = $2', [tenantId, `${RUN_STAMP} Kid Dee`]);
    expect(dee).toHaveLength(1);
    expect(dee[0].parentMemberId).toBe(parent.id);
    expect(dee[0].accountType).toBe("kids");

    // An under-13 (kids) can never be left without a guardian, so the card no
    // longer offers Unlink for one (functional review round 3, F12) — it says
    // the way is to move them to another guardian. The route still refuses an
    // unlink in words (covered by the route tests).
    await expect(page.getByRole("button", { name: `Unlink ${RUN_STAMP} Kid Dee` })).toHaveCount(0);
    await expect(page.getByText(/open the other guardian and use Link existing/).first()).toBeVisible();
    const still = await sql<{ parentMemberId: string | null }>('SELECT "parentMemberId" FROM "Member" WHERE id = $1', [dee[0].id]);
    expect(still[0].parentMemberId, "the link is untouched").toBe(parent.id);
    await shot(page, "staff-kids-no-unlink-1440");

    // Link existing: search for the other family's child and move them here.
    await page.getByRole("button", { name: "Link existing" }).click();
    const link = page.getByRole("dialog", { name: "Link existing member as child" });
    await expect(link).toBeVisible();
    await link.getByLabel("Search name or email").fill(otherKid.name);
    await link.getByRole("button", { name: "Search" }).click();
    // The other family's child is offered with the consequence stated and a
    // "Move" action (before 26 Sep the dialog hid every linked child, so the
    // screen could not do what the route could).
    await expect(link.getByText(/Linked to another guardian/)).toBeVisible();
    await link.getByRole("button", { name: `Move ${otherKid.name}` }).click();
    await expect(page.getByRole("link", { name: new RegExp(otherKid.name) })).toBeVisible();
    const moved = await sql<{ parentMemberId: string | null }>('SELECT "parentMemberId" FROM "Member" WHERE id = $1', [otherKid.id]);
    expect(moved[0].parentMemberId).toBe(parent.id);
    await page.close();

    // The same card on a phone: nothing overflows, both actions reachable.
    const phone = await sessionFor(browser, ORIGIN, { email: OWNER_EMAIL, password: PASSWORD, viewport: PHONE, isMobile: true });
    const p = await phone.newPage();
    await p.goto(`/dashboard/members/${parent.id}`);
    await expect(p.getByText("Family", { exact: true })).toBeVisible();
    await p.getByText("Family", { exact: true }).scrollIntoViewIfNeeded();
    await expect(p.getByRole("button", { name: "Add child" })).toBeVisible();
    await expect(p.getByRole("button", { name: "Link existing" })).toBeVisible();
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, "the member profile does not scroll sideways on a phone").toBeLessThanOrEqual(1);
    // Every child's NAME is readable on the phone: the pills used to take the
    // whole row and the name truncated to nothing (contact sheet, 26 Sep).
    const rows = p.getByRole("link", { name: new RegExp(`${RUN_STAMP} Kid`) });
    expect(await rows.count(), "three children on the card").toBeGreaterThanOrEqual(3);
    for (let i = 0; i < (await rows.count()); i++) {
      const name = rows.nth(i).locator("span").first();
      const box = await name.boundingBox();
      expect(box?.width ?? 0, `child ${i + 1}'s name has room on a phone`).toBeGreaterThanOrEqual(80);
    }
    await shot(p, "staff-family-card-375");
    await p.close();
  });
});
