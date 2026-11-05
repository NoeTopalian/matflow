// Deep links: a class, session or payment link opens that exact record (synthetic data only).
//   node run-journeys.mjs deeplinks
// The Activity timeline will name classes, sessions and payments as links. This journey proves the three
// destinations: /dashboard/timetable?classId=, /dashboard/attendance?instance= and
// /dashboard/members/<id>?tab=payments&paymentId= — for a record that exists, one that is paused, one with
// nothing in it and one that does not exist; at desktop and phone width; and that the links back work.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("deeplinks");
const errors = [];
const id = () => randomUUID().replace(/-/g, ""); // record ids are letters and digits only
const noSideScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// Every page here crosses to the test database; the first assertion after a navigation waits for that.
const SLOW = { timeout: 30_000 };

let main;
async function section(key, desc, fn) {
  try {
    L.check(key, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(key, desc, false, [lines[0], lines.find((l) => /waiting for/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (main && !main.isClosed()) {
      await shot(main, `deeplinks-fail-${key}`);
      for (let i = 0; i < 3 && (await main.getByRole("dialog").count()); i++) await main.keyboard.press("Escape");
    }
  }
}

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.7.1");
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);

  const tenantId = club.tenantId;
  const members = await q(`select id, name from "Member" where "tenantId" = $1 order by name`, [tenantId]);
  if (members.length < 2) throw new Error("fixture has fewer than two members");

  // A class through the real form, so the page under test has a real row.
  await main.goto("/dashboard/timetable");
  await main.getByRole("button", { name: "Add class", exact: true }).first().click();
  await main.getByLabel("Class Name", { exact: true }).fill("Deep Link Gi");
  await main.getByRole("button", { name: "Add day", exact: true }).click();
  await main.getByLabel("Day of the week").first().selectOption("1");
  const created = main.waitForResponse((r) => new URL(r.url()).pathname === "/api/classes" && r.request().method() === "POST" && !r.url().includes("dryRun"));
  await main.getByRole("button", { name: "Create class", exact: true }).click();
  const cls = await (await created).json();
  await expect(main.getByRole("dialog")).toHaveCount(0);

  await section("class-active", "timetable?classId= opens that class's edit sheet and removes the param", async () => {
    await main.goto(`/dashboard/timetable?classId=${cls.id}`);
    await expect(main.getByRole("dialog")).toHaveCount(1, SLOW);
    await expect(main.getByLabel("Class Name", { exact: true })).toHaveValue("Deep Link Gi");
    await expect(main).toHaveURL(/\/dashboard\/timetable$/);
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    // The param is gone from this history entry, so a reload does not reopen the sheet.
    await main.reload();
    await expect(main.getByRole("button", { name: "Add class", exact: true }).first()).toBeVisible(SLOW);
    await expect(main.getByRole("dialog")).toHaveCount(0);
    return { url: new URL(main.url()).pathname + new URL(main.url()).search };
  });

  // One session with two check-ins, one with none (a day marker is 00:00 UTC of the club's date).
  const day = new Date("2026-11-03T00:00:00.000Z");
  const full = id();
  const empty = id();
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $3, $4, '19:00', '20:00'), ($2, $3, $4, '06:30', '07:30')`, [full, empty, cls.id, day]);
  for (const m of members.slice(0, 2)) {
    await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [id(), tenantId, m.id, full]);
  }

  await section("session", "attendance?instance= shows that session's check-ins, names it, and links back to the whole list", async () => {
    await main.goto(`/dashboard/attendance?instance=${full}`);
    const chip = main.getByTestId("attendance-session");
    await expect(chip).toContainText("Session: Deep Link Gi · Tue 3 Nov, 19:00", SLOW);
    await expect(main.getByText("2 check-ins for this session")).toBeVisible();
    // The club-wide stat cards are not shown under a one-session heading.
    await expect(main.getByText("Top Class")).toHaveCount(0);
    // The link back sits on the label's line, not above it.
    const [labelBox, linkBox] = await Promise.all([chip.locator("span").first().boundingBox(), main.getByRole("link", { name: "Show all attendance" }).boundingBox()]);
    const centre = (b) => b.y + b.height / 2;
    expect(Math.abs(centre(labelBox) - centre(linkBox))).toBeLessThanOrEqual(3);
    for (const m of members.slice(0, 2)) await expect(main.locator("tbody").getByText(m.name, { exact: true })).toHaveCount(1);
    await expect(main.locator("tbody tr")).toHaveCount(2);
    // Keyboard: the way back is a link reachable and operable without a pointer.
    const back = main.getByRole("link", { name: "Show all attendance" });
    await back.focus();
    await main.keyboard.press("Enter");
    await expect(main).toHaveURL(/\/dashboard\/attendance$/, SLOW);
    await expect(main.getByTestId("attendance-session")).toHaveCount(0, SLOW);
    await expect(main.getByText("Top Class")).toHaveCount(1);
    return { chip: "Session: Deep Link Gi · Tue 3 Nov, 19:00", rows: 2 };
  });

  await section("session-empty", "a session nobody was checked in to says so, not 'no records found'", async () => {
    await main.goto(`/dashboard/attendance?instance=${empty}`);
    await expect(main.getByTestId("attendance-session")).toContainText("Deep Link Gi · Tue 3 Nov, 06:30", SLOW);
    await expect(main.getByText("No one was checked in to this session.").first()).toBeVisible();
    await expect(main.getByText("No attendance records found")).toHaveCount(0);
    return { message: "No one was checked in to this session." };
  });

  await section("session-unknown", "an id that is not this club's session says so and shows the recent list", async () => {
    await main.goto(`/dashboard/attendance?instance=${id()}`);
    await expect(main.getByRole("status").filter({ hasText: "That session can't be found." })).toBeVisible(SLOW);
    await expect(main.getByTestId("attendance-session")).toHaveCount(0);
    await expect(main.locator("tbody tr")).toHaveCount(2); // the two recent check-ins
    return { note: "That session can't be found." };
  });

  await shot(main, "deeplinks-attendance-desktop");

  await section("class-paused", "a paused class has no sheet: its row under Paused and archived is marked and in view", async () => {
    await main.goto("/dashboard/timetable");
    const paused = main.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${cls.id}`);
    await main.getByRole("button", { name: "Pause Deep Link Gi", exact: true }).first().click();
    await main.getByRole("dialog").last().getByRole("button", { name: "Pause class", exact: true }).click();
    expect((await paused).status()).toBe(200);
    await main.goto(`/dashboard/timetable?classId=${cls.id}`);
    const row = main.getByTestId(`inactive-class-${cls.id}`);
    await expect(row).toHaveAttribute("aria-current", "true", SLOW);
    await expect(row).toBeInViewport();
    await expect(main.getByRole("dialog")).toHaveCount(0);
    await expect(main).toHaveURL(/\/dashboard\/timetable$/);
    return { marked: true };
  });

  await section("class-unknown", "an id that is no longer a class says so", async () => {
    await main.goto(`/dashboard/timetable?classId=${id()}`);
    await expect(main.getByText("That class isn't on the timetable any more.")).toBeVisible(SLOW);
    await expect(main.getByRole("dialog")).toHaveCount(0);
    return { message: "That class isn't on the timetable any more." };
  });

  // Two payments for the first member.
  const member = members[0];
  const pay1 = id();
  const pay2 = id();
  await q(
    `insert into "Payment" (id, "tenantId", "memberId", "amountPence", currency, status, description, "paidAt") values
     ($1, $3, $4, 6500, 'GBP', 'succeeded', 'October membership', $5), ($2, $3, $4, 4500, 'GBP', 'succeeded', 'Grading fee', $6)`,
    [pay1, pay2, tenantId, member.id, new Date("2026-10-01T09:00:00.000Z"), new Date("2026-11-03T09:00:00.000Z")],
  );

  await section("payment", "members/<id>?tab=payments&paymentId= opens Payments with that payment marked; the others stay", async () => {
    await main.goto(`/dashboard/members/${member.id}?tab=payments&paymentId=${pay2}`);
    const marked = main.locator('tbody tr[aria-current="true"]');
    await expect(marked).toHaveCount(1, SLOW);
    await expect(marked).toContainText("Grading fee");
    await expect(marked).toBeInViewport();
    await expect(main.locator("tbody").getByText("October membership")).toHaveCount(1);
    await expect(main.getByText("That payment isn't among this member's latest payments.")).toHaveCount(0);
    // The mark must be visible, not a hairline: its outline is the --tx-2 text colour, not the faint focus grey.
    const outline = await marked.evaluate((el) => getComputedStyle(el).outlineColor);
    const tx2 = await main.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--tx-2)";
      document.body.append(probe);
      const c = getComputedStyle(probe).color;
      probe.remove();
      return c;
    });
    expect(outline).toBe(tx2);
    return { marked: "Grading fee", listed: 2, outline };
  });

  await section("payment-unknown", "a payment that is not in the member's list says so and marks nothing", async () => {
    await main.goto(`/dashboard/members/${member.id}?tab=payments&paymentId=${id()}`);
    await expect(main.getByText("That payment isn't among this member's latest payments.")).toBeVisible(SLOW);
    await expect(main.locator('[aria-current="true"]')).toHaveCount(0);
    await expect(main.locator("tbody").getByText("Grading fee")).toHaveCount(1);
    return { note: "That payment isn't among this member's latest payments." };
  });

  await shot(main, "deeplinks-payment-desktop");

  await section("phone", "390 x 844: the session view and the marked payment card read without sideways scroll", async () => {
    const mobile = await context(browser, "10.94.7.2", { viewport: { width: 390, height: 844 }, isMobile: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto(`/dashboard/attendance?instance=${full}`);
      await expect(phone.getByTestId("attendance-session")).toContainText("Deep Link Gi · Tue 3 Nov, 19:00", SLOW);
      await expect(phone.getByRole("link", { name: "Show all attendance" })).toBeVisible();
      const a = await noSideScroll(phone);
      await shot(phone, "deeplinks-attendance-phone");
      await phone.goto(`/dashboard/members/${member.id}?tab=payments&paymentId=${pay2}`);
      const card = phone.locator('[aria-current="true"]').filter({ hasText: "Grading fee" }).filter({ visible: true });
      await expect(card).toHaveCount(1, SLOW);
      await expect(card).toBeInViewport();
      const b = await noSideScroll(phone);
      await shot(phone, "deeplinks-payment-phone");
      expect(a && b).toBe(true);
      return { attendanceNoSideScroll: a, paymentNoSideScroll: b };
    } catch (e) {
      await shot(phone, "deeplinks-fail-phone").catch(() => {});
      throw e;
    } finally {
      await mobile.close();
    }
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "deeplinks-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
