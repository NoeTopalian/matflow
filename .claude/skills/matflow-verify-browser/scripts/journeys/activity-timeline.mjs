// Activity timeline: the page, its filters, its failure states, Undo, and who may see what (synthetic data only).
//   node run-journeys.mjs activity-timeline
// Owner at 1440 (and 1280 / 1024 / 390 for layout), then the same club as a manager and as a coach.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, sleep } from "../lib.mjs";
import { seedActivity, SLOW, noSideScroll, clubDay, clubTime, id } from "./activity-seed.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("activity-timeline");
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
      await shot(p, `activity-fail-${key}`);
      await p.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      for (let i = 0; i < 3 && (await p.getByRole("dialog").count()); i++) await p.keyboard.press("Escape");
    }
  }
}

const isFeed = (r) => new URL(r.url()).pathname === "/api/activity";
/** The rows of the desktop table (the phone cards are in the page too, hidden). */
const rows = (page) => page.locator("tbody tr:not([data-section])");
const row = (page, text) => rows(page).filter({ hasText: text });
const headings = (page) => page.locator("tbody tr[data-section] th");
const longDate = (dayKey) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${dayKey}T12:00:00Z`));
const shiftDay = (dayKey, days) => {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.9.1", { permissions: ["clipboard-read", "clipboard-write"] });
  main = await ctx.newPage();
  main.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(main, club);
  const s = await seedActivity(main, club, "Timeline Gi");
  const today = clubDay(new Date(s.now), s.timeZone);
  const yesterday = shiftDay(today, -1);
  const manager = await seedStaff(club, "manager", { name: "Morgan Manager" });
  const coach = await seedStaff(club, "coach", { name: "Casey Coach" });
  // One thing only the owner may see that a manager could otherwise expect on the page: a staff account change.
  await q(`insert into "AuditLog" (id, "tenantId", "userId", action, "entityType", "entityId", metadata, "createdAt") values ($1, $2, $3, 'staff.update', 'User', $4, $5::jsonb, $6)`, [
    id(),
    s.tenantId,
    s.owner,
    coach.id,
    JSON.stringify({ changes: { name: { from: "Casey C", to: "Casey Coach" } } }),
    new Date(s.now - 2 * 60_000),
  ]);

  await section("default", "the page opens on Club activity: a Today heading, named sentences with links, club settings left out", async () => {
    await main.goto("/dashboard/activity");
    await expect(rows(main).first()).toBeVisible(SLOW);
    await expect(headings(main).first()).toHaveText("Today");
    await expect(main.getByTestId("activity-views").getByRole("button", { name: "Club activity", exact: true })).toHaveAttribute("aria-pressed", "true");
    const checkin = row(main, `${s.mel.name} checked in to ${s.sessionLabel}`).first();
    await expect(checkin.getByRole("link", { name: s.mel.name, exact: true })).toHaveAttribute("href", `/dashboard/members/${s.mel.id}`);
    await expect(checkin.getByRole("link", { name: s.sessionLabel, exact: true })).toHaveAttribute("href", `/dashboard/attendance?instance=${s.session}`);
    await expect(row(main, `moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`)).toHaveCount(1);
    // Club settings and staff accounts are not in the default view.
    await expect(rows(main).filter({ has: main.getByText("Club settings", { exact: true }) })).toHaveCount(0);
    await expect(rows(main).filter({ has: main.getByText("Staff accounts", { exact: true }) })).toHaveCount(0);
    await expect(main.getByTestId("activity-summary")).toContainText("Club activity");
    await expect(main.getByTestId("activity-status")).toHaveText("Showing 50 activities");
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    // No raw ids, no code words, in anything a person reads.
    const text = await main.locator("tbody").innerText();
    expect(/\bundefined\b|\bnull\b|[a-z]+\.[a-z_]+\.[a-z_]+|\b[0-9a-f]{32}\b/.test(text)).toBe(false);
    await shot(main, "activity-default-1440");
    return { rows: await rows(main).count(), firstHeading: "Today" };
  });

  await section("types-sheet", "Activity types: ticks are staged, Cancel and Escape discard, a group tick takes the whole group, one request on apply; keyboard only", async () => {
    const trigger = main.getByTestId("types-trigger");
    await expect(trigger).toContainText("Club activity");
    let requests = 0;
    const count = (r) => { if (isFeed(r)) requests++; };
    main.on("request", count);
    // Keyboard: open with Enter, Escape closes and returns focus to the trigger.
    await trigger.focus();
    await main.keyboard.press("Enter");
    const sheet = main.getByRole("dialog", { name: "Activity types" });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Everything", exact: true }).click();
    await expect(sheet.getByTestId("types-count")).toHaveText(/^(\d+) of \1 selected$/);
    await main.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toContainText("Club activity"); // discarded
    // Cancel discards too.
    await trigger.click();
    await sheet.getByRole("checkbox", { name: "Attendance: all" }).click();
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(trigger).toContainText("Club activity");
    expect(requests).toBe(0);
    // Untick everything: the button is disabled and says why.
    await trigger.click();
    for (const group of ["Attendance", "Memberships & money", "Members", "Classes", "Communication", "Staff & club"]) {
      const box = sheet.getByRole("checkbox", { name: `${group}: all` });
      if ((await box.getAttribute("aria-checked")) !== "false") await box.click();
      if ((await box.getAttribute("aria-checked")) !== "false") await box.click(); // mixed -> on -> off
      await expect(box).toHaveAttribute("aria-checked", "false");
    }
    await expect(sheet.getByRole("button", { name: "Show activity", exact: true })).toBeDisabled();
    await expect(sheet.getByText("Choose at least one activity type")).toBeVisible();
    // One group by keyboard: Space on the group's box ticks all of it; one type off makes it mixed.
    const attendance = sheet.getByRole("checkbox", { name: "Attendance: all" });
    await attendance.focus();
    await main.keyboard.press("Space");
    await expect(attendance).toHaveAttribute("aria-checked", "true");
    await sheet.getByRole("checkbox", { name: "Check-in removed", exact: true }).focus();
    await main.keyboard.press("Space");
    await expect(attendance).toHaveAttribute("aria-checked", "mixed");
    await sheet.getByRole("checkbox", { name: "Check-in removed", exact: true }).click();
    const applied = main.waitForResponse(isFeed);
    await sheet.getByRole("button", { name: "Show activity", exact: true }).click();
    await applied;
    await expect(sheet).toHaveCount(0);
    await expect(main).toHaveURL(/types=attendance$/);
    await expect(main.getByTestId("activity-views").getByRole("button", { name: "Attendance", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(row(main, "paid £45.00")).toHaveCount(0, SLOW);
    await expect(row(main, "checked in to").first()).toBeVisible();
    await sleep(600);
    main.off("request", count);
    expect(requests).toBe(1);
    return { requestsForTheWholeSheet: requests };
  });

  await section("member-picker", "Member: found by email with the arrow keys and Enter; only the id reaches the address; the header names them; clear restores the field", async () => {
    await main.goto("/dashboard/activity");
    await expect(rows(main).first()).toBeVisible(SLOW);
    const before = await main.getByTestId("activity-filters").boundingBox();
    const field = main.getByRole("combobox", { name: "Member" });
    await field.click();
    await expect(main.getByText("Type at least 2 characters")).toBeVisible();
    // The second member's address, typed in part: the address is how a front desk finds someone.
    await field.pressSequentially(s.other.email.slice(0, s.other.email.indexOf("@")), { delay: 20 });
    const option = main.getByRole("option").filter({ hasText: s.other.name });
    await expect(option).toHaveCount(1, SLOW);
    await shot(main, "activity-picker-1440");
    await main.keyboard.press("ArrowDown");
    await main.keyboard.press("ArrowUp");
    await main.keyboard.press("Enter");
    await expect(main).toHaveURL(new RegExp(`\\?memberId=${s.other.id}$`));
    expect(main.url()).not.toContain("example");
    await expect(main.getByRole("heading", { name: `Activity for ${s.other.name}` })).toBeVisible(SLOW);
    await expect(main.getByTestId("member-picked")).toContainText(s.other.name);
    await expect(row(main, `${s.other.name}'s payment of £30.00 failed`)).toHaveCount(1);
    await expect(rows(main).filter({ hasText: s.mel.name })).toHaveCount(0);
    // The card did not change height when the field became a name.
    const after = await main.getByTestId("activity-filters").boundingBox();
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5);
    await main.getByRole("link", { name: "Open profile" }).click();
    await expect(main).toHaveURL(new RegExp(`/dashboard/members/${s.other.id}$`), SLOW);
    // Back returns to the same filters and rows.
    await main.goBack();
    await expect(main).toHaveURL(new RegExp(`/dashboard/activity\\?memberId=${s.other.id}$`), SLOW);
    await expect(row(main, `${s.other.name}'s payment of £30.00 failed`)).toHaveCount(1, SLOW);
    await main.getByRole("button", { name: `Clear member filter: ${s.other.name}` }).click();
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    await expect(main.getByRole("combobox", { name: "Member" })).toBeFocused();
    return { cardHeight: after.height };
  });

  await section("plan-and-done-by", "Plan shows what happened to that plan; Done by shows one person's work; together they are an AND", async () => {
    await main.goto("/dashboard/activity?types=all");
    await expect(rows(main).first()).toBeVisible(SLOW);
    await main.getByRole("combobox", { name: "Plan" }).selectOption({ label: "Adult Unlimited" });
    await expect(main).toHaveURL(new RegExp(`tierId=${s.tierNew}`));
    await expect(main.getByText("Activity that names this plan.")).toBeVisible();
    await expect(row(main, `moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`)).toHaveCount(1, SLOW);
    await expect(row(main, "checked in to")).toHaveCount(0);
    await expect(main.getByTestId("activity-summary")).toContainText("Everything · Adult Unlimited");
    await main.getByRole("combobox", { name: "Plan" }).selectOption({ label: "Any plan" });
    await main.getByRole("combobox", { name: "Done by" }).selectOption({ label: "Sam Synthetic · owner" });
    await expect(main).toHaveURL(new RegExp(`userId=${s.owner}`));
    await expect(row(main, `cancelled ${s.other.name}'s membership`)).toHaveCount(1, SLOW);
    // Nothing a member or Stripe did.
    await expect(row(main, "checked in to")).toHaveCount(0);
    await expect(row(main, "paid £45.00")).toHaveCount(0);
    await expect(main.getByTestId("activity-summary")).toContainText("done by Sam Synthetic");
    await main.getByRole("button", { name: "Reset filters", exact: true }).click();
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    await expect(main.getByRole("button", { name: "Reset filters", exact: true })).toBeDisabled();
    return { ok: true };
  });

  await section("jump-to-date", "Jump to date: a day is where the list starts; Previous day steps back; Show older carries on; the card keeps its height", async () => {
    await main.goto("/dashboard/activity?types=attendance");
    await expect(headings(main).first()).toHaveText("Today", SLOW);
    const before = await main.getByTestId("activity-filters").boundingBox();
    const jump = main.getByTestId("jump-to-date");
    await jump.getByRole("button", { name: "Yesterday", exact: true }).click();
    await expect(main).toHaveURL(new RegExp(`day=${yesterday}`));
    await expect(headings(main).first()).toHaveText("Yesterday", SLOW);
    await expect(jump.getByRole("button", { name: "Yesterday", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(row(main, `${s.other.name} checked in to`).first()).toBeVisible();
    await expect(main.getByTestId("activity-summary")).toContainText("up to");
    const after = await main.getByTestId("activity-filters").boundingBox();
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5);
    // One day further back: nothing happened that day, so the list starts at the day the older rows are on.
    await jump.getByRole("button", { name: "Previous day" }).click();
    const dayBefore = shiftDay(yesterday, -1);
    await expect(main).toHaveURL(new RegExp(`day=${dayBefore}`));
    await expect(jump.getByLabel("Jump to date")).toHaveValue(dayBefore);
    const olderDay = clubDay(new Date(s.olderAt), s.timeZone);
    await expect(headings(main).first()).toHaveText(longDate(olderDay), SLOW);
    // Typing a date works the same way.
    await jump.getByLabel("Jump to date").fill(yesterday);
    await expect(main).toHaveURL(new RegExp(`day=${yesterday}`));
    await expect(headings(main).first()).toHaveText("Yesterday", SLOW);
    // Next day from yesterday is today, which is the absence of a day.
    await jump.getByRole("button", { name: "Next day" }).click();
    await expect(main).toHaveURL(/\/dashboard\/activity\?types=attendance$/);
    await expect(jump.getByRole("button", { name: "Next day" })).toBeDisabled();
    // Show older reaches the rest and moves focus to the first new row's link.
    await expect(rows(main)).toHaveCount(50, SLOW);
    await main.getByRole("button", { name: "Show older", exact: true }).click();
    await expect(main.getByTestId("activity-status")).toHaveText(/^\d+ more loaded$/, SLOW);
    expect(await rows(main).count()).toBeGreaterThan(50);
    expect(await main.evaluate(() => document.activeElement?.tagName)).toBe("A");
    await expect(main.getByText("That's everything. Activity is kept for one year.")).toBeVisible();
    return { rows: await rows(main).count() };
  });

  await section("views", "the view chips: Money is payments, failures and cancellations only; Everything adds settings and staff accounts", async () => {
    await main.goto("/dashboard/activity");
    await expect(rows(main).first()).toBeVisible(SLOW);
    const views = main.getByTestId("activity-views");
    await views.getByRole("button", { name: "Money", exact: true }).click();
    await expect(main).toHaveURL(/types=money$/);
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1, SLOW);
    await expect(row(main, `${s.other.name}'s payment of £30.00 failed`)).toHaveCount(1);
    await expect(row(main, "checked in to")).toHaveCount(0);
    // The failed payment is the one coloured icon on the page.
    await views.getByRole("button", { name: "Everything", exact: true }).click();
    await expect(main).toHaveURL(/types=all$/);
    await expect(rows(main).filter({ has: main.getByText("Club settings", { exact: true }) })).toHaveCount(1, SLOW);
    await expect(rows(main).filter({ has: main.getByText("Staff accounts", { exact: true }) })).toHaveCount(1);
    await views.getByRole("button", { name: "Club activity", exact: true }).click();
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    return { ok: true };
  });

  await section("staff-name", "a staff name inside a sentence's source filters to that person without leaving the page", async () => {
    await main.goto("/dashboard/activity?types=all");
    const settings = rows(main).filter({ has: main.getByText("Club settings", { exact: true }) });
    await expect(settings).toHaveCount(1, SLOW);
    const link = settings.getByTestId("activity-source").getByRole("link", { name: "Sam Synthetic", exact: true });
    const refetch = main.waitForResponse((r) => isFeed(r) && r.url().includes(`userId=${s.owner}`));
    await link.click();
    await refetch;
    await expect(main).toHaveURL(new RegExp(`userId=${s.owner}`));
    await expect(main.getByRole("combobox", { name: "Done by" })).toHaveValue(s.owner);
    await expect(row(main, "checked in to")).toHaveCount(0, SLOW);
    return { ok: true };
  });

  await section("undo", "owner: Since here only on Everything with no filter; undoing the phone edit strikes the row through in place and the undo is recorded", async () => {
    // With a member filter the row has Undo alone.
    await main.goto(`/dashboard/activity?types=all&memberId=${s.mel.id}`);
    const filtered = row(main, `updated ${s.mel.name}'s details`);
    await expect(filtered).toHaveCount(1, SLOW);
    await expect(filtered.getByRole("button", { name: /^Undo:/ })).toHaveCount(1);
    await expect(filtered.getByRole("button", { name: /^Undo everything/ })).toHaveCount(0);
    // On Everything with nothing filtered, Since here is offered and lists what it would undo, as sentences.
    await main.goto("/dashboard/activity?types=all");
    const edit = row(main, `updated ${s.mel.name}'s details`);
    await expect(edit).toHaveCount(1, SLOW);
    await expect(edit.getByTestId("activity-detail")).toContainText("Phone: 07700 900111 → 07700 900222");
    await edit.getByRole("button", { name: /^Undo everything Sam Synthetic did since/ }).click();
    const plan = main.getByTestId("undo-plan");
    await expect(plan).toBeVisible(SLOW);
    await expect(plan).toContainText(`updated ${s.mel.name}'s details`);
    await expect(main.getByRole("dialog").last()).toContainText("This covers everything Sam Synthetic has done across the club since");
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    // A row that cannot be undone says why, one keyboard press away.
    const cancelled = row(main, `cancelled ${s.other.name}'s membership`);
    const why = cancelled.getByRole("button", { name: /^Why this can't be undone/ });
    await why.focus();
    await main.keyboard.press("Enter");
    const reason = main.getByRole("dialog", { name: "Why this can't be undone" });
    await expect(reason).toBeVisible();
    const reasonText = (await reason.locator("p.text-sm").last().innerText()).trim();
    expect(reasonText.length).toBeGreaterThan(10);
    await main.keyboard.press("Escape");
    // Undo the phone edit.
    const scrollBefore = await main.evaluate(() => document.querySelector("main")?.scrollTop ?? window.scrollY);
    await edit.getByRole("button", { name: /^Undo:/ }).click();
    const confirm = main.getByRole("dialog").last();
    await expect(confirm).toContainText(`Undo: Sam Synthetic updated ${s.mel.name}'s details?`);
    const undone = main.waitForResponse((r) => r.request().method() === "POST" && /\/api\/audit-log\/[^/]+\/undo$/.test(new URL(r.url()).pathname));
    await confirm.getByRole("button", { name: "Undo this", exact: true }).click();
    expect((await undone).status()).toBe(200);
    await expect(main.getByRole("dialog")).toHaveCount(0, SLOW);
    const struck = rows(main).filter({ has: main.locator('[data-testid="activity-sentence"].line-through') });
    await expect(struck).toHaveCount(1, SLOW);
    await expect(struck).toContainText(`updated ${s.mel.name}'s details`);
    await expect(struck.getByRole("button", { name: /^Undo:/ })).toHaveCount(0);
    // The undo itself is on the page without touching a filter, and the address has not moved.
    await expect(rows(main).filter({ has: main.getByText("Undone changes", { exact: true }) })).toHaveCount(1, SLOW);
    await expect(main).toHaveURL(/\/dashboard\/activity\?types=all$/);
    const phoneNow = (await q(`select phone from "Member" where id = $1`, [s.mel.id]))[0].phone;
    expect(phoneNow).toBe("07700 900111");
    await shot(main, "activity-undone-1440");
    return { phoneNow, reason: reasonText, scrollBefore };
  });

  await section("failures", "a failed first load is an error with one retry, never an empty list; a slow answer to an old filter never overwrites the new one; a failed Show older keeps the rows", async () => {
    // 1) First page fails.
    let calls = 0;
    await main.route("**/api/activity?**", async (route) => {
      calls++;
      if (calls === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Couldn't load activity." }) });
      return route.continue();
    });
    await main.goto("/dashboard/activity?types=attendance");
    await expect(main.getByText("Couldn't load activity.").first()).toBeVisible(SLOW);
    await expect(main.getByText("Nothing matches these filters.")).toHaveCount(0);
    await shot(main, "activity-error-1440");
    const beforeRetry = calls;
    await main.getByRole("button", { name: /try again|retry/i }).first().click();
    await expect(rows(main).first()).toBeVisible(SLOW);
    await sleep(500);
    expect(calls - beforeRetry).toBe(1);
    await main.unrouteAll({ behavior: "wait" });

    // 2) The Attendance answer is held back; Money is chosen meanwhile; the late answer must not replace it.
    await main.goto("/dashboard/activity");
    await expect(rows(main).first()).toBeVisible(SLOW);
    await main.route("**/api/activity?**", async (route) => {
      if (route.request().url().includes("types=attendance")) await sleep(2500);
      return route.continue();
    });
    const views = main.getByTestId("activity-views");
    await views.getByRole("button", { name: "Attendance", exact: true }).click();
    await sleep(400); // past the debounce: the Attendance request is in flight
    await views.getByRole("button", { name: "Money", exact: true }).click();
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1, SLOW);
    await sleep(3000); // the held-back answer has arrived by now
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1);
    await expect(row(main, "checked in to")).toHaveCount(0);
    await main.unrouteAll({ behavior: "wait" });

    // 3) Show older fails: rows stay, an inline retry appears, and the retry works.
    await main.goto("/dashboard/activity?types=attendance");
    await expect(rows(main)).toHaveCount(50, SLOW);
    let olderCalls = 0;
    await main.route("**/api/activity?**", async (route) => {
      if (route.request().url().includes("cursor=") && ++olderCalls === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Couldn't load activity." }) });
      return route.continue();
    });
    await main.getByRole("button", { name: "Show older", exact: true }).click();
    await expect(main.getByText("Couldn't load older activity")).toBeVisible(SLOW);
    await expect(rows(main)).toHaveCount(50);
    await main.getByRole("alert").getByRole("button", { name: "Try again", exact: true }).click();
    await expect(main.getByTestId("activity-status")).toHaveText(/^\d+ more loaded$/, SLOW);
    await main.unrouteAll({ behavior: "wait" });

    // 4) Names could not be loaded: the plain log, with a notice, not an error.
    await main.route("**/api/activity?**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.enriched = false;
      body.entries = body.entries.map((e) => ({ ...e, parts: [{ text: e.plain }], detail: null }));
      return route.fulfill({ response, json: body });
    });
    await main.goto("/dashboard/activity?types=attendance");
    await expect(main.getByText("Names couldn't be loaded, so this is the plain log.")).toBeVisible(SLOW);
    await expect(rows(main)).toHaveCount(50);
    await shot(main, "activity-degraded-1440");
    await main.unrouteAll({ behavior: "wait" });
    return { retryRequests: 1 };
  });

  await section("empty", "a filter that matches nothing says so, names the filters and offers the two ways out", async () => {
    await main.goto(`/dashboard/activity?types=refund`);
    await expect(main.getByText("Nothing matches these filters.").filter({ visible: true })).toBeVisible(SLOW);
    await shot(main, "activity-empty-1440");
    await main.getByRole("button", { name: "Show everything", exact: true }).filter({ visible: true }).last().click();
    await expect(main).toHaveURL(/types=all$/);
    await expect(rows(main).first()).toBeVisible(SLOW);
    // A link with a type that no longer exists, and an id that is not a member here, never produce an error page.
    await main.goto(`/dashboard/activity?types=checkin,bogus_type`);
    await expect(main.getByText("This link included activity types that no longer exist.")).toBeVisible(SLOW);
    await expect(rows(main).first()).toBeVisible();
    await main.goto(`/dashboard/activity?memberId=${id()}`);
    await expect(main.getByTestId("member-picked")).toContainText("Removed member", SLOW);
    await expect(main.getByText("Nothing matches these filters.").filter({ visible: true })).toBeVisible();
    return { ok: true };
  });

  let copied = "";
  await section("copy-and-default", "Copy link writes the view out; Make this my default is kept on this device for this person only, and can be dropped", async () => {
    await main.goto("/dashboard/activity");
    await expect(rows(main).first()).toBeVisible(SLOW);
    await main.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(main.getByText("Link copied.")).toBeVisible();
    const plain = await main.evaluate(() => navigator.clipboard.readText());
    expect(new URL(plain).search).toBe("?types=club");
    // A view with owner-only types in it, for the manager to open later.
    await main.goto("/dashboard/activity?types=all");
    await expect(rows(main).first()).toBeVisible(SLOW);
    await main.getByRole("button", { name: "Copy link", exact: true }).click();
    copied = await main.evaluate(() => navigator.clipboard.readText());
    expect(new URL(copied).search).toBe("?types=all");
    // Save Money as the default.
    await main.getByTestId("activity-views").getByRole("button", { name: "Money", exact: true }).click();
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1, SLOW);
    await main.getByRole("button", { name: "Make this my default", exact: true }).click();
    await expect(main.getByText("Saved. Activity will open like this on this device.")).toBeVisible();
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    let requests = 0;
    const count = (r) => { if (isFeed(r)) requests++; };
    main.on("request", count);
    await main.reload();
    await expect(main.getByTestId("activity-views").getByRole("button", { name: "Money", exact: true })).toHaveAttribute("aria-pressed", "true", SLOW);
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1, SLOW);
    await sleep(600);
    main.off("request", count);
    expect(requests).toBe(1); // the saved default is read before the first request, not after it
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    return { copied: new URL(copied).search, firstLoadRequests: requests };
  });

  await section("widths", "no sideways scroll at 1440, 1280 and 1024; the four filters are one height; Undo stays inside the table", async () => {
    const out = {};
    for (const width of [1440, 1280, 1024]) {
      await main.setViewportSize({ width, height: 900 });
      await main.goto("/dashboard/activity?types=all");
      await expect(rows(main).first()).toBeVisible(SLOW);
      expect(await noSideScroll(main), `sideways scroll at ${width}`).toBe(true);
      const boxes = await Promise.all([main.getByTestId("types-trigger"), main.getByRole("combobox", { name: "Member" }), main.getByRole("combobox", { name: "Plan" }), main.getByRole("combobox", { name: "Done by" })].map((l) => l.boundingBox()));
      const heights = boxes.map((b) => b.height);
      expect(Math.max(...heights) - Math.min(...heights), `filter heights at ${width}: ${heights}`).toBeLessThanOrEqual(0.5);
      const table = await main.locator("table").first().boundingBox();
      const undo = await rows(main).getByRole("button", { name: /^Undo:/ }).first().boundingBox();
      expect(undo.x + undo.width, `Undo's right edge at ${width}`).toBeLessThanOrEqual(table.x + table.width + 1);
      await shot(main, `activity-all-${width}`);
      out[width] = heights[0];
    }
    await main.setViewportSize({ width: 1440, height: 900 });
    return out;
  });

  await section("accents", "a white, a yellow and a near-black club accent: the pressed view, the ticked boxes and the focus ring all stay visible", async () => {
    const original = (await q(`select "primaryColor" from "Tenant" where id = $1`, [s.tenantId]))[0].primaryColor;
    const seen = {};
    try {
      for (const accent of ["#ffffff", "#ffe14d", "#111111"]) {
        await q(`update "Tenant" set "primaryColor" = $2 where id = $1`, [s.tenantId, accent]);
        await main.goto("/dashboard/activity?types=money");
        const pressed = main.getByTestId("activity-views").getByRole("button", { name: "Money", exact: true });
        await expect(pressed).toHaveAttribute("aria-pressed", "true", SLOW);
        const idle = main.getByTestId("activity-views").getByRole("button", { name: "Attendance", exact: true });
        const style = (l) => l.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, border: c.borderTopColor, color: c.color }; });
        const [a, b] = [await style(pressed), await style(idle)];
        // Pressed differs from idle by fill or by border, and its label is not the same colour as its fill.
        expect(a.bg !== b.bg || a.border !== b.border, `${accent}: pressed looks like idle`).toBe(true);
        expect(a.color, `${accent}: label is the fill colour`).not.toBe(a.bg);
        await main.getByTestId("types-trigger").click();
        const sheet = main.getByRole("dialog", { name: "Activity types" });
        const ticked = sheet.getByRole("checkbox", { name: "Payment", exact: true });
        await expect(ticked).toHaveAttribute("aria-checked", "true");
        const box = await ticked.evaluate((el) => { const c = getComputedStyle(el); return { bg: c.backgroundColor, shadow: c.boxShadow, border: c.borderTopColor }; });
        expect(box.shadow, `${accent}: a ticked box needs its hairline`).not.toBe("none");
        await shot(main, `activity-accent-${accent.slice(1)}`);
        await main.keyboard.press("Escape");
        seen[accent] = { pressed: a, box };
      }
    } finally {
      await q(`update "Tenant" set "primaryColor" = $2 where id = $1`, [s.tenantId, original]);
    }
    return seen;
  });

  await section("club-time", "a browser in Bali reads the club's clock: the same times and the same Today as the club, and a line saying so", async () => {
    const away = await context(browser, "10.94.9.2", { timezoneId: "Asia/Makassar", storageState: await ctx.storageState() });
    const page = await away.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await page.goto("/dashboard/activity?types=attendance");
      await expect(rows(page).first()).toBeVisible(SLOW);
      await expect(headings(page).first()).toHaveText("Today");
      await expect(page.getByText(`Times are shown in club time (${s.timeZone}).`)).toBeVisible();
      const first = row(page, `${s.mel.name} checked in to ${s.sessionLabel}`).first();
      const shown = (await first.locator("td").first().innerText()).trim();
      const expected = clubTime(s.rows.checkin.at, s.timeZone);
      expect(shown).toBe(expected);
      // Yesterday's row sits under Yesterday at the club's time, whatever day it is in Bali.
      await page.getByTestId("jump-to-date").getByRole("button", { name: "Yesterday", exact: true }).click();
      await expect(headings(page).first()).toHaveText("Yesterday", SLOW);
      const y = (await rows(page).first().locator("td").first().innerText()).trim();
      expect(y).toBe(clubTime(s.yesterdayAt, s.timeZone));
      return { shown, expected, zone: s.timeZone };
    } finally {
      await away.close();
    }
  });

  await section("member-history", "the member page: History shows their check-in, payment and edit as cards with the day; See all activity opens the page for them", async () => {
    await main.goto(`/dashboard/members/${s.mel.id}`);
    const history = main.getByTestId("activity-embedded");
    await expect(history).toBeVisible(SLOW);
    await expect(history.getByTestId("activity-card").filter({ hasText: `${s.mel.name} paid £45.00` })).toHaveCount(1);
    await expect(history.getByTestId("activity-card").filter({ hasText: `${s.mel.name} checked in to` }).first()).toBeVisible();
    await expect(history.getByTestId("activity-card")).toHaveCount(20);
    // No Undo, no filters, no table inside the profile.
    await expect(history.getByRole("button")).toHaveCount(0);
    await expect(history.locator("table")).toHaveCount(0);
    expect(await noSideScroll(main)).toBe(true);
    await shot(main, "activity-member-history-1440");
    await history.getByRole("link", { name: "See all activity" }).click();
    await expect(main).toHaveURL(new RegExp(`/dashboard/activity\\?memberId=${s.mel.id}&types=all$`), SLOW);
    await expect(main.getByRole("heading", { name: `Activity for ${s.mel.name}` })).toBeVisible(SLOW);
    return { cards: 20 };
  });

  // ── Manager ────────────────────────────────────────────────────────────────
  const mctx = await context(browser, "10.94.9.3");
  const mpage = await mctx.newPage();
  mpage.on("pageerror", (e) => errors.push(e.message));
  await section(
    "manager",
    "a manager: the page opens; no Undo column; no owner-only rows or types; the owner's link drops them and says so; no values in edits; a plan is not a link; no link is refused; the undo routes refuse",
    async () => {
      await staffSignIn(mpage, club, manager);
      await mpage.goto("/dashboard/activity");
      await expect(rows(mpage).first()).toBeVisible(SLOW);
      await expect(mpage.getByRole("link", { name: "Activity", exact: true }).first()).toBeVisible();
      await expect(mpage.getByRole("columnheader", { name: "Undo" })).toHaveCount(0);
      await expect(mpage.getByRole("button", { name: /^Undo/ })).toHaveCount(0);
      // The owner's copied link (types=all).
      await mpage.goto(copied);
      await expect(rows(mpage).first()).toBeVisible(SLOW);
      await expect(rows(mpage).filter({ has: mpage.getByText("Club settings", { exact: true }) })).toHaveCount(0);
      await expect(rows(mpage).filter({ has: mpage.getByText("Staff accounts", { exact: true }) })).toHaveCount(0);
      await expect(rows(mpage).filter({ has: mpage.getByText("Undone changes", { exact: true }) })).toHaveCount(0);
      // Money is theirs to see.
      await expect(row(mpage, `${s.mel.name} paid £45.00`)).toHaveCount(1);
      // Asking for an owner-only type by name is dropped, and said.
      await mpage.goto("/dashboard/activity?types=checkin,staff,settings");
      await expect(mpage.getByText("Some activity types in this link are only visible to the owner.")).toBeVisible(SLOW);
      await expect(rows(mpage).filter({ has: mpage.getByText("Staff accounts", { exact: true }) })).toHaveCount(0);
      // The sheet lists none of them.
      await mpage.getByTestId("types-trigger").click();
      const sheet = mpage.getByRole("dialog", { name: "Activity types" });
      for (const hidden of ["Staff accounts", "Club settings", "Sign-in and security", "MatFlow support", "Data requests", "Undone changes", "Plans and packs (set-up)"]) {
        await expect(sheet.getByRole("checkbox", { name: hidden, exact: true })).toHaveCount(0);
      }
      await expect(sheet.getByRole("checkbox", { name: "Payment", exact: true })).toHaveCount(1);
      await mpage.keyboard.press("Escape");
      // An edit names the field, not what it held; a plan is a name, not a link.
      await mpage.goto(`/dashboard/activity?types=all&memberId=${s.mel.id}`);
      const edit = row(mpage, `updated ${s.mel.name}'s details`);
      await expect(edit).toHaveCount(1, SLOW);
      const editText = await edit.innerText();
      expect(editText).toContain("Phone");
      expect(/07700|→/.test(editText)).toBe(false);
      const moved = row(mpage, `moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`);
      await expect(moved).toHaveCount(1);
      await expect(moved.getByRole("link", { name: "Adult Unlimited" })).toHaveCount(0);
      // Every link the feed offers a manager opens for a manager.
      await mpage.goto("/dashboard/activity?types=all");
      await expect(rows(mpage).first()).toBeVisible(SLOW);
      const hrefs = [...new Set(await mpage.locator("tbody a").evaluateAll((as) => as.map((a) => a.getAttribute("href"))))].filter(Boolean);
      const refused = [];
      for (const href of hrefs) {
        const res = await mpage.request.get(href, { maxRedirects: 0 });
        const location = res.headers().location ?? "";
        if (res.status() >= 400 || /denied=1|\/login/.test(location)) refused.push(`${href} -> ${res.status()} ${location}`);
      }
      expect(refused, refused.join("; ")).toEqual([]);
      // The API says the same thing as the page.
      const api = await mpage.request.get("/api/activity?types=all&take=50");
      expect(api.status()).toBe(200);
      const body = await api.json();
      const serialised = JSON.stringify(body);
      expect(body.entries.some((e) => "undo" in e)).toBe(false);
      expect(body.entries.some((e) => ["staff", "settings", "sign_in", "support", "undo", "data_request", "plan_setup", "import", "other"].includes(e.type))).toBe(false);
      expect(/07700 900111|"metadata"|"ipAddress"|"operatorId"|example\.test/.test(serialised)).toBe(false);
      // Undo is the owner's, by every door.
      const one = await mpage.request.post(`/api/audit-log/${s.rows.plan.id}/undo`);
      const many = await mpage.request.post("/api/audit-log/undo-to", { data: { userId: s.owner, auditId: s.rows.plan.id, preview: true } });
      expect([one.status(), many.status()]).toEqual([403, 403]);
      // The owner's saved default (Money) is not this person's: they open on Club activity.
      await mpage.goto("/dashboard/activity");
      await expect(mpage.getByTestId("activity-views").getByRole("button", { name: "Club activity", exact: true })).toHaveAttribute("aria-pressed", "true", SLOW);
      await shot(mpage, "activity-manager-1440");
      return { linksChecked: hrefs.length, undo: [one.status(), many.status()] };
    },
    () => mpage,
  );

  await section(
    "shared-browser",
    "the owner's saved default does not follow the next person to sign in on the same browser",
    async () => {
      // The owner's browser still holds their saved Money default; sign the manager in there.
      const shared = await context(browser, "10.94.9.5", { storageState: await ctx.storageState() });
      const page = await shared.newPage();
      try {
        await page.goto("/dashboard/activity");
        await expect(page.getByTestId("activity-views").getByRole("button", { name: "Money", exact: true })).toHaveAttribute("aria-pressed", "true", SLOW);
        await shared.clearCookies();
        await staffSignIn(page, club, manager);
        await page.goto("/dashboard/activity");
        await expect(page.getByTestId("activity-views").getByRole("button", { name: "Club activity", exact: true })).toHaveAttribute("aria-pressed", "true", SLOW);
        const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("activity.")));
        return { storedKeys: stored.length };
      } finally {
        await shared.close();
      }
    },
  );

  // ── Coach ──────────────────────────────────────────────────────────────────
  await section("coach", "a coach: no Activity in the menu, the page turns them away, and the API refuses", async () => {
    const cctx = await context(browser, "10.94.9.4");
    const page = await cctx.newPage();
    try {
      await staffSignIn(page, club, coach);
      await page.goto("/dashboard");
      await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
      await page.goto("/dashboard/activity");
      await expect(page).toHaveURL(/\/dashboard\?denied=1$/, SLOW);
      const api = await page.request.get("/api/activity");
      expect(api.status()).toBe(403);
      const body = await api.text();
      expect(body).not.toContain(s.mel.name);
      return { page: "/dashboard?denied=1", api: api.status() };
    } finally {
      await cctx.close();
    }
  });

  // ── Phone ──────────────────────────────────────────────────────────────────
  await section("phone", "390 x 844: cards, no sideways scroll, the Filters sheet applies, every name can be tapped, a long class name wraps", async () => {
    // A class name long enough to need three lines on a phone.
    const longName = "Advanced No-Gi Competition Preparation and Open Mat for Returning Blue Belts";
    await q(`update "Class" set name = $2 where id = $1`, [s.cls.id, longName]);
    const mobile = await context(browser, "10.94.9.6", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await phone.goto("/dashboard/activity?types=club");
      const cards = phone.getByTestId("activity-card").filter({ visible: true });
      await expect(cards.first()).toBeVisible(SLOW);
      await expect(phone.locator("[data-section]").filter({ visible: true }).first()).toHaveText("Today");
      expect(await noSideScroll(phone)).toBe(true);
      // The long name wraps inside its card rather than widening the page.
      const long = cards.filter({ hasText: longName }).first();
      const box = await long.boundingBox();
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.height).toBeGreaterThan(90);
      // Every link in the first ten cards is the top thing at its own centre (nothing covers it).
      const covered = await phone.evaluate(() => {
        const out = [];
        const cards = [...document.querySelectorAll('[data-testid="activity-card"]')].filter((c) => c.getClientRects().length).slice(0, 10);
        for (const card of cards) {
          for (const a of card.querySelectorAll("a")) {
            a.scrollIntoView({ block: "center" });
            const r = a.getClientRects()[0];
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            if (hit !== a && !a.contains(hit)) out.push(a.textContent);
          }
        }
        return out;
      });
      expect(covered, `links covered: ${covered.join(", ")}`).toEqual([]);
      await shot(phone, "activity-default-390");
      // The Filters sheet: Done by, applied.
      await phone.getByTestId("filters-button").tap();
      const sheet = phone.getByRole("dialog", { name: "Filters" });
      await expect(sheet).toBeVisible();
      await shot(phone, "activity-filters-sheet-390");
      await sheet.getByRole("combobox", { name: "Done by" }).selectOption({ label: "Sam Synthetic · owner" });
      await sheet.getByRole("button", { name: "Show activity", exact: true }).tap();
      await expect(sheet).toHaveCount(0);
      await expect(phone).toHaveURL(new RegExp(`userId=${s.owner}`));
      await expect(phone.getByTestId("filters-button")).toContainText("Filters (1)");
      const chip = phone.getByRole("button", { name: "Remove filter: Done by Sam Synthetic" });
      await expect(chip).toBeVisible();
      await expect(cards.filter({ hasText: "checked in to" })).toHaveCount(0, SLOW);
      // The owner's Undo is on the card, apart from the sentence; a refusal is written out.
      await expect(cards.filter({ hasText: "Can't undo:" }).first()).toBeVisible();
      await chip.tap();
      await expect(phone).toHaveURL(/\/dashboard\/activity\?types=club$/);
      // Activity types on a phone is the same sheet, from inside Filters.
      await phone.getByTestId("filters-button").tap();
      await sheet.getByTestId("types-trigger").tap();
      await expect(phone.getByRole("dialog", { name: "Activity types" })).toBeVisible();
      await shot(phone, "activity-types-sheet-390");
      expect(await noSideScroll(phone)).toBe(true);
      return { longCardHeight: Math.round(box.height) };
    } finally {
      await mobile.close();
      await q(`update "Class" set name = $2 where id = $1`, [s.cls.id, s.className]);
    }
  });

  L.check("errors", "no uncaught browser errors", errors.length === 0, errors);
  if (errors.length) process.exitCode = 1;
} catch (e) {
  if (main && !main.isClosed()) await shot(main, "activity-timeline-failure");
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
