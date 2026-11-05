// Activity events: the things a club does that the timeline can now show (synthetic data only).
//   node run-journeys.mjs activity-events
// A member books a class and gives the booking up, in their own app, and the owner reads both on the timeline.
// The purchase rows (a membership start, a class pack, a shop order) are written by Stripe-driven code that a
// browser journey cannot drive without Stripe, so rows of exactly the shape those writers produce are placed in the
// log and read back (the writers themselves are exercised against the database in activity-events-db.test.ts).
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, bcrypt } from "../lib.mjs";
import { seedActivity, SLOW, noSideScroll, id, ready, changed, visit, watchNetwork, networkFaults } from "./activity-seed.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const { randomBytes } = require("node:crypto");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("activity-events");
const errors = [];

let main;
async function section(key, desc, fn, page = () => main) {
  try {
    L.check(key, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(key, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    const p = page();
    if (p && !p.isClosed()) {
      await shot(p, `activity-events-fail-${key}`);
      for (let i = 0; i < 3 && (await p.getByRole("dialog").count()); i++) await p.keyboard.press("Escape");
    }
  }
}

const rows = (page) => page.locator("tbody tr:has([data-entry-id])");
const row = (page, text) => rows(page).filter({ hasText: text });
const open = async (page, path) => {
  await visit(page, path);
  await ready(page);
};

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.10.1");
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  watchNetwork(main);
  await ownerSignIn(main, club);
  const s = await seedActivity(main, club, "Events Gi");
  const manager = await seedStaff(club, "manager", { name: "Morgan Manager" });

  // The member can sign in to their own app: a password of their own, onboarding and waiver done.
  const memberPass = randomBytes(18).toString("base64url");
  await q(`update "Member" set "passwordHash" = $2, "onboardingCompleted" = true, "waiverAccepted" = true, "waiverAcceptedAt" = now() where id = $1`, [s.mel.id, await bcrypt.hash(memberPass, 10)]);

  await section("member-books", "a member books the class in their app, and gives the booking up: one row each, none for a repeat", async () => {
    const mctx = await context(browser, "10.94.10.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const app = await mctx.newPage();
    try {
      await app.goto("/login");
      await app.getByLabel("Club code").fill(club.slug);
      await app.keyboard.press("Enter");
      await app.getByLabel("Email address").first().waitFor({ timeout: 60000 });
      await app.getByLabel("Email address").first().fill(s.mel.email);
      await app.getByLabel("Password").fill(memberPass);
      await app.getByRole("button", { name: "Sign in", exact: true }).click();
      await app.waitForURL(/\/member/, { timeout: 60000 });
      // The member app's own request, from the member's own session.
      const call = (method) => app.evaluate(async ([m, path]) => (await fetch(path, { method: m })).status, [method, `/api/member/class-subscriptions/${s.cls.id}`]);
      const statuses = [await call("POST"), await call("POST"), await call("DELETE"), await call("DELETE")];
      expect(statuses).toEqual([201, 201, 200, 200]);
      const written = await q(`select action, "userId", "entityType", "entityId", metadata from "AuditLog" where "tenantId" = $1 and action like 'class.booking.%' order by "createdAt"`, [s.tenantId]);
      expect(written.map((r) => r.action)).toEqual(["class.booking.created", "class.booking.cancelled"]);
      for (const r of written) {
        expect([r.userId, r.entityType, r.entityId]).toEqual([null, "Member", s.mel.id]);
        expect(r.metadata).toMatchObject({ memberId: s.mel.id, classId: s.cls.id, actorId: s.mel.id });
      }
      return { statuses, rows: written.length };
    } finally {
      await mctx.close();
    }
  });

  // Rows as the Stripe-driven writers produce them (lib/activity-events.ts shapes; the DB test runs the writers).
  const now = Date.now();
  const packId = id();
  await q(`insert into "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", "updatedAt") values ($1, $2, 'Ten classes', 10, 90, 8000, now())`, [packId, s.tenantId]);
  const seeded = [
    ["member.subscription.purchased", { memberId: s.mel.id, tierId: s.tierNew, stripeSubscriptionId: `sub_${id()}`, actorId: s.mel.id }, 3],
    ["class_pack.purchased", { memberId: s.mel.id, classPackId: packId, memberClassPackId: id(), credits: 10, amountPence: 8000, currency: "GBP" }, 2],
    ["order.paid", { memberId: s.mel.id, orderId: id(), orderRef: "ORD-JOURNEY", amountPence: 2500, currency: "GBP" }, 1],
  ];
  for (const [action, metadata, minutesAgo] of seeded) {
    await q(`insert into "AuditLog" (id, "tenantId", "userId", action, "entityType", "entityId", metadata, "createdAt") values ($1, $2, null, $3, 'Member', $4, $5::jsonb, $6)`, [id(), s.tenantId, action, s.mel.id, JSON.stringify(metadata), new Date(now - minutesAgo * 60_000)]);
  }

  await section("owner-reads", "the owner reads them as sentences with links: who booked what, who started which plan, who bought what", async () => {
    await open(main, `/dashboard/activity?types=all&memberId=${s.mel.id}`);
    const booked = row(main, `${s.mel.name} booked ${s.className}`);
    await expect(booked).toHaveCount(1);
    await expect(booked.getByRole("link", { name: s.className, exact: true })).toHaveAttribute("href", `/dashboard/timetable?classId=${s.cls.id}`);
    await expect(booked.getByText("Class booking", { exact: true })).toBeVisible();
    await expect(booked.getByTestId("activity-source")).toContainText("Member app");
    await expect(row(main, `${s.mel.name} cancelled their booking for ${s.className}`)).toHaveCount(1);
    const started = row(main, `${s.mel.name} started Adult Unlimited — awaiting first payment`);
    await expect(started).toHaveCount(1);
    await expect(started.getByText("Membership started", { exact: true })).toBeVisible();
    const pack = row(main, `${s.mel.name} bought Ten classes`);
    await expect(pack).toHaveCount(1);
    await expect(pack.getByTestId("activity-detail")).toContainText("10 classes · £80.00");
    await expect(pack.getByText("Class pack bought", { exact: true })).toBeVisible();
    await expect(row(main, `${s.mel.name} paid £25.00 for shop order ORD-JOURNEY`)).toHaveCount(1);
    // None of them offers Undo, and each says what to do instead.
    for (const r of [booked, started, pack]) {
      await expect(r.getByRole("button", { name: /^Undo:/ })).toHaveCount(0);
      await expect(r.getByRole("button", { name: /^Can't undo: / })).toHaveCount(1);
    }
    await booked.getByRole("button", { name: /^Can't undo: / }).click();
    await expect(main.getByRole("dialog", { name: "Why this can't be undone" })).toContainText("The member can cancel the booking from their app.");
    await main.keyboard.press("Escape");
    const text = await main.locator("table").innerText();
    expect(/sub_|\b[0-9a-f]{32}\b|class\.booking|class_pack/.test(text)).toBe(false);
    await shot(main, "activity-events-owner-1440");
    return { rows: await rows(main).count() };
  });

  await section("views-and-filters", "bookings are in Attendance and in the class's own history; the purchases are in Money and under their plan", async () => {
    await open(main, "/dashboard/activity?types=attendance");
    await expect(row(main, `${s.mel.name} booked ${s.className}`)).toHaveCount(1);
    await expect(row(main, "bought Ten classes")).toHaveCount(0);
    await open(main, "/dashboard/activity?types=money");
    await expect(row(main, `${s.mel.name} bought Ten classes`)).toHaveCount(1);
    await expect(row(main, `${s.mel.name} started Adult Unlimited`)).toHaveCount(1);
    await expect(row(main, "ORD-JOURNEY")).toHaveCount(1);
    await expect(row(main, "booked")).toHaveCount(0);
    // One class's history.
    await open(main, `/dashboard/activity?types=all&classId=${s.cls.id}`);
    await expect(row(main, `${s.mel.name} booked ${s.className}`)).toHaveCount(1);
    await expect(row(main, `${s.mel.name} cancelled their booking for ${s.className}`)).toHaveCount(1);
    await expect(row(main, `Sam Synthetic created ${s.className}`)).toHaveCount(1);
    await expect(row(main, "bought Ten classes")).toHaveCount(0);
    // What happened to one plan: the start on it, and the move onto it.
    await open(main, "/dashboard/activity?types=all");
    await changed(main, () => main.getByRole("combobox", { name: "Plan" }).selectOption({ label: "Adult Unlimited" }));
    await expect(row(main, `${s.mel.name} started Adult Unlimited — awaiting first payment`)).toHaveCount(1);
    await expect(row(main, `moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`)).toHaveCount(1);
    await expect(row(main, "booked")).toHaveCount(0);
    // The two new types can be ticked on their own.
    await open(main, "/dashboard/activity");
    await main.getByTestId("types-trigger").click();
    const sheet = main.getByRole("dialog", { name: "Activity types" });
    await expect(sheet.getByRole("checkbox", { name: "Class booking", exact: true })).toHaveAttribute("aria-checked", "true");
    await expect(sheet.getByRole("checkbox", { name: "Class pack bought", exact: true })).toHaveAttribute("aria-checked", "true");
    await main.keyboard.press("Escape");
    return { ok: true };
  });

  await section("member-history", "the member's own page shows what they did: the booking, the pack, the membership start", async () => {
    await visit(main, `/dashboard/members/${s.mel.id}`);
    const history = main.getByTestId("activity-embedded");
    await expect(history).toBeVisible(SLOW);
    for (const said of [`${s.mel.name} booked ${s.className}`, `${s.mel.name} bought Ten classes`, `${s.mel.name} started Adult Unlimited — awaiting first payment`]) {
      await expect(history.getByTestId("activity-card").filter({ hasText: said })).toHaveCount(1);
    }
    return { ok: true };
  });

  const mctx = await context(browser, "10.94.10.3");
  const mpage = await mctx.newPage();
  mpage.on("pageerror", (e) => errors.push(e.message));
  watchNetwork(mpage);
  await section(
    "manager",
    "a manager sees the same events: the plan and the pack as names, not links, and no undo",
    async () => {
      await staffSignIn(mpage, club, manager);
      await open(mpage, `/dashboard/activity?types=all&memberId=${s.mel.id}`);
      await expect(row(mpage, `${s.mel.name} booked ${s.className}`)).toHaveCount(1);
      const started = row(mpage, `${s.mel.name} started Adult Unlimited — awaiting first payment`);
      await expect(started).toHaveCount(1);
      await expect(started.getByRole("link", { name: "Adult Unlimited" })).toHaveCount(0);
      const pack = row(mpage, `${s.mel.name} bought Ten classes`);
      await expect(pack).toHaveCount(1);
      await expect(pack.getByRole("link", { name: "Ten classes" })).toHaveCount(0);
      await expect(mpage.getByRole("button", { name: /Undo|Since here/ })).toHaveCount(0);
      return { ok: true };
    },
    () => mpage,
  );

  await section("phone", "390 x 844: the new sentences read as cards without sideways scroll", async () => {
    const mobile = await context(browser, "10.94.10.4", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await open(phone, `/dashboard/activity?types=all&memberId=${s.mel.id}`);
      const cards = phone.getByTestId("activity-card").filter({ visible: true });
      await expect(cards.filter({ hasText: `${s.mel.name} booked ${s.className}` })).toHaveCount(1);
      await expect(cards.filter({ hasText: "Can't undo: The member can cancel the booking from their app." })).toHaveCount(1);
      await expect(cards.filter({ hasText: `${s.mel.name} bought Ten classes` })).toContainText("10 classes · £80.00");
      expect(await noSideScroll(phone)).toBe(true);
      await shot(phone, "activity-events-390");
      return { ok: true };
    } finally {
      await mobile.close();
    }
  });

  if (networkFaults.length) L.note("network", "timeline requests that failed on the wire between the test browser and the local proxy (retried once)", networkFaults);
  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "activity-events-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
