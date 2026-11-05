// Activity: the five questions an owner must be able to answer on a phone (plan §2; synthetic data only).
//   node run-journeys.mjs activity-five-questions
// Every section runs at 390 x 844 as the club's owner, and counts the taps from the Activity page (or the record).
//   1. What happened in my club today?          2. What has this member done?
//   3. Who changed this class, price or setting? 4. Who paid, failed to pay or cancelled?
//   5. Tap any name and land on that exact record.
import { createRequire } from "node:module";
import { chromium, state, ledger, shot, context, ownerSignIn } from "../lib.mjs";
import { seedActivity, SLOW, noSideScroll, ready, changed } from "./activity-seed.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("activity-five-questions");
const errors = [];

let phone;
async function section(key, desc, fn) {
  try {
    L.check(key, desc, true, await fn());
  } catch (e) {
    const lines = String(e.message ?? e).split("\n");
    L.check(key, desc, false, [lines[0], lines.find((l) => /waiting for|Expected|Received/.test(l))?.trim()].filter(Boolean).join(" — "));
    process.exitCode = 1;
    if (phone && !phone.isClosed()) {
      await shot(phone, `activity-five-fail-${key}`);
      for (let i = 0; i < 3 && (await phone.getByRole("dialog").count()); i++) await phone.keyboard.press("Escape");
    }
  }
}

const browser = await chromium.launch();
try {
  // Set-up at desktop width (the class form), then everything is asked on the phone.
  const desk = await context(browser, "10.94.8.1");
  const main = await desk.newPage();
  await ownerSignIn(main, club);
  const s = await seedActivity(main, club, "Five Questions Gi");

  const mobile = await context(browser, "10.94.8.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await desk.storageState() });
  phone = await mobile.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  const cards = () => phone.getByTestId("activity-card").filter({ visible: true });
  const card = (text) => cards().filter({ hasText: text });
  const open = async (path) => {
    await phone.goto(path);
    await ready(phone);
  };

  await section("q1-today", "1. What happened today: Activity opens on today's rows under a Today heading, newest first (0 taps)", async () => {
    await open("/dashboard/activity");
    await expect(phone.locator("[data-section]").filter({ visible: true }).first()).toHaveText("Today");
    await expect(card(`${s.mel.name} checked in to ${s.sessionLabel}`).first()).toBeVisible();
    await expect(card(`updated ${s.mel.name}'s details`)).toHaveCount(1);
    // Newest first: the check-in (4 minutes ago) above the edit (6) above the plan move (8) above the payment (20).
    const order = await cards().evaluateAll((els) => els.map((el) => el.getAttribute("data-entry-id")));
    const at = (key) => order.indexOf(s.rows[key].id);
    expect([at("checkin"), at("edit"), at("plan"), at("paid")].every((i) => i >= 0)).toBe(true);
    expect(at("checkin") < at("edit") && at("edit") < at("plan") && at("plan") < at("paid")).toBe(true);
    // The card is Jump to date and Filters, and nothing else, on a phone.
    const filters = phone.getByTestId("activity-filters");
    await expect(filters.getByRole("button", { name: "Copy link", exact: true })).toBeHidden();
    await expect(filters.getByRole("button", { name: "Reset filters", exact: true })).toBeHidden();
    expect((await filters.boundingBox()).height).toBeLessThan(200);
    expect(await noSideScroll(phone)).toBe(true);
    await shot(phone, "activity-five-q1-today");
    return { taps: 0, first: await cards().first().getByTestId("activity-sentence").innerText() };
  });

  await section("q2-member", "2. What has this member done: the member page's History lists their check-in, payment and edit; See all activity opens the timeline for them (1 tap)", async () => {
    await phone.goto(`/dashboard/members/${s.mel.id}`);
    const history = phone.getByTestId("activity-embedded");
    await expect(history).toBeVisible(SLOW);
    await expect(history.getByTestId("activity-card").filter({ hasText: `${s.mel.name} checked in to` }).first()).toBeVisible();
    await expect(history.getByTestId("activity-card").filter({ hasText: `${s.mel.name} paid £45.00` })).toHaveCount(1);
    await expect(history.getByTestId("activity-card").filter({ hasText: `updated ${s.mel.name}'s details` })).toHaveCount(1);
    // Nothing about the other member is in this history.
    await expect(history.getByTestId("activity-card").filter({ hasText: s.other.name })).toHaveCount(0);
    await history.getByRole("link", { name: "See all activity" }).tap(); // tap 1
    await expect(phone).toHaveURL(new RegExp(`/dashboard/activity\\?memberId=${s.mel.id}&types=all$`), SLOW);
    await ready(phone);
    await expect(phone.getByRole("heading", { name: `Activity for ${s.mel.name}` })).toBeVisible();
    await expect(card(s.other.name)).toHaveCount(0);
    await expect(card(`${s.mel.name} paid £45.00`)).toHaveCount(1);
    expect(await noSideScroll(phone)).toBe(true);
    await shot(phone, "activity-five-q2-member");
    return { taps: 1 };
  });

  await section("q3-who-changed", "3. Who changed it: Staff changes names the staff member on the plan move, the class and the settings change (1 tap)", async () => {
    await open("/dashboard/activity");
    await changed(phone, () => phone.getByTestId("activity-views").getByRole("button", { name: "Staff changes", exact: true }).tap()); // tap 1
    await expect(phone).toHaveURL(/types=staff_changes/);
    const moved = card(`moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`);
    await expect(moved).toHaveCount(1);
    await expect(moved).toContainText("Sam Synthetic");
    await expect(card(`Sam Synthetic created ${s.className}`)).toHaveCount(1);
    // Check-ins and payments are not staff changes.
    await expect(card("checked in to")).toHaveCount(0);
    await expect(card("paid £45.00")).toHaveCount(0);
    const settings = cards().filter({ has: phone.getByText("Club settings", { exact: true }) });
    await expect(settings).toHaveCount(1);
    await expect(settings).toContainText("Sam Synthetic");
    await shot(phone, "activity-five-q3-staff-changes");
    return { taps: 1, settings: await settings.getByTestId("activity-sentence").innerText() };
  });

  await section("q4-money", "4. Who paid, failed or cancelled: Money shows the payment, the failed payment and the cancellation, with names and amounts (1 tap)", async () => {
    await open("/dashboard/activity");
    await changed(phone, () => phone.getByTestId("activity-views").getByRole("button", { name: "Money", exact: true }).tap()); // tap 1
    await expect(phone).toHaveURL(/types=money/);
    await expect(card(`${s.mel.name} paid £45.00`)).toHaveCount(1);
    const failed = card(`${s.other.name}'s payment of £30.00 failed`);
    await expect(failed).toHaveCount(1);
    await expect(failed.getByText("Payment failed or disputed", { exact: true })).toBeVisible();
    await expect(card(`cancelled ${s.other.name}'s membership`)).toHaveCount(1);
    await expect(card("checked in to")).toHaveCount(0);
    await shot(phone, "activity-five-q4-money");
    return { taps: 1, failed: await failed.getByTestId("activity-sentence").innerText() };
  });

  await section("q5-member-link", "5a. Tap a member's name: lands on that member's page (1 tap)", async () => {
    await open("/dashboard/activity");
    const row = card(`${s.mel.name} checked in to ${s.sessionLabel}`).first();
    await row.getByRole("link", { name: s.mel.name, exact: true }).tap();
    await expect(phone).toHaveURL(new RegExp(`/dashboard/members/${s.mel.id}$`), SLOW);
    await expect(phone.getByRole("heading", { name: s.mel.name }).first()).toBeVisible(SLOW);
    return { url: new URL(phone.url()).pathname };
  });

  await section("q5-session-link", "5b. Tap a session: lands on Attendance showing that session's check-ins (1 tap)", async () => {
    await open("/dashboard/activity");
    const row = card(`${s.mel.name} checked in to ${s.sessionLabel}`).first();
    await row.getByRole("link", { name: s.sessionLabel, exact: true }).tap();
    await expect(phone).toHaveURL(new RegExp(`/dashboard/attendance\\?instance=${s.session}$`), SLOW);
    await expect(phone.getByTestId("attendance-session")).toContainText(s.sessionLabel, SLOW);
    return { url: new URL(phone.url()).pathname + new URL(phone.url()).search };
  });

  await section("q5-payment-link", "5c. Tap a payment's amount: lands on that member's Payments with the payment marked (2 taps: Money, amount)", async () => {
    await open("/dashboard/activity?types=money");
    const row = card(`${s.mel.name} paid £45.00`);
    await expect(row).toHaveCount(1);
    await row.getByRole("link", { name: "£45.00", exact: true }).tap();
    await expect(phone).toHaveURL(new RegExp(`/dashboard/members/${s.mel.id}\\?tab=payments&paymentId=${s.payment}$`), SLOW);
    await expect(phone.locator('[aria-current="true"]').filter({ visible: true })).toHaveCount(1, SLOW);
    return { url: new URL(phone.url()).search };
  });

  await section("q5-class-link", "5d. Tap a class: lands on the timetable at that class (2 taps: Staff changes, class name)", async () => {
    // A real class change, so there is a class row to follow: pause it from the timetable (desktop), then read it on the phone.
    await main.goto("/dashboard/timetable");
    const paused = main.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${s.cls.id}`);
    await main.getByRole("button", { name: `Pause ${s.className}`, exact: true }).first().click();
    await main.getByRole("dialog").last().getByRole("button", { name: "Pause class", exact: true }).click();
    expect((await paused).status()).toBe(200);
    await open("/dashboard/activity?types=staff_changes");
    const row = card(`paused ${s.className}`);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Sam Synthetic");
    await row.getByRole("link", { name: s.className, exact: true }).tap();
    // A paused class has no sheet: its row under Paused and archived is the exact record, marked.
    await expect(phone.getByTestId(`inactive-class-${s.cls.id}`).filter({ visible: true })).toHaveAttribute("aria-current", "true", SLOW);
    return { landed: "timetable, the paused class marked" };
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (phone && !phone.isClosed()) await shot(phone, "activity-five-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
