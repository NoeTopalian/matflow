// Activity timeline: the page, its filters, its failure states, Undo, and who may see what (synthetic data only).
//   node run-journeys.mjs activity-timeline
// Owner at 1440 (and 1280 / 1024 / 390 for layout), then the same club as a manager and as a coach.
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, sleep, BASE } from "../lib.mjs";
import { seedActivity, SLOW, noSideScroll, clubDay, clubTime, id, isFeed, ready, changed } from "./activity-seed.mjs";

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

/** The real rows of the desktop table (not the day headings, not the loading skeleton; the phone cards are in the page too, hidden). */
const rows = (page) => page.locator("tbody tr:has([data-entry-id])");
const row = (page, text) => rows(page).filter({ hasText: text });
const typed = (page, label) => rows(page).filter({ has: page.getByText(label, { exact: true }) });
const headings = (page) => page.locator("tbody tr[data-section] th");
/** The empty state's title as drawn (the same words are also in the screen-reader status line). */
const emptyTitle = (page, text) => page.getByText(text, { exact: true }).and(page.locator(':not([data-testid="activity-status"])'));
const longDate = (dayKey) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${dayKey}T12:00:00Z`)).replace(",", "");
const shiftDay = (dayKey, days) => {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const open = async (page, path) => {
  await page.goto(path);
  await ready(page);
};
/** WCAG contrast of two computed colours ("rgb(…)" / "rgba(…)"), measured in the page so any colour syntax works. */
const contrast = (page, a, b) =>
  page.evaluate(
    ([one, two]) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const lum = (colour) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = colour;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, bl] = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
        return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
      };
      const [hi, lo] = [lum(one), lum(two)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    },
    [a, b],
  );

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
  const views = (page) => page.getByTestId("activity-views");
  const view = (page, name) => views(page).getByRole("button", { name, exact: true });

  await section("default", "the page opens on Club activity: a Today heading, named sentences with links, club settings left out, in a card like every other table", async () => {
    await open(main, "/dashboard/activity");
    await expect(headings(main).first()).toHaveText("Today");
    await expect(view(main, "Club activity")).toHaveAttribute("aria-pressed", "true");
    const checkin = row(main, `${s.mel.name} checked in to ${s.sessionLabel}`).first();
    await expect(checkin.getByRole("link", { name: s.mel.name, exact: true })).toHaveAttribute("href", `/dashboard/members/${s.mel.id}`);
    await expect(checkin.getByRole("link", { name: s.sessionLabel, exact: true })).toHaveAttribute("href", `/dashboard/attendance?instance=${s.session}`);
    await expect(row(main, `moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`)).toHaveCount(1);
    // Club settings and staff accounts are not in the default view.
    await expect(typed(main, "Club settings")).toHaveCount(0);
    await expect(typed(main, "Staff accounts")).toHaveCount(0);
    await expect(main.getByTestId("activity-summary")).toContainText("Club activity");
    await expect(main.getByTestId("activity-status")).toHaveText("Showing 50 activities");
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    // No raw ids, no code words, in anything a person reads.
    const text = await main.locator("table").innerText();
    expect(/\bundefined\b|\bnull\b|[a-z]+\.[a-z_]+\.[a-z_]+|\b[0-9a-f]{32}\b/.test(text)).toBe(false);
    // The table sits on a white card with a border; each day is the header of its own group of rows.
    const card = await main.locator("table").locator("xpath=ancestor::div[contains(@class,'sm:bg-sf-1')]").first().evaluate((el) => {
      const c = getComputedStyle(el);
      return { bg: c.backgroundColor, border: c.borderTopWidth };
    });
    expect(card).toEqual({ bg: "rgb(255, 255, 255)", border: "1px" });
    await expect(headings(main).first()).toHaveAttribute("scope", "rowgroup");
    await shot(main, "activity-default-1440");
    return { rows: await rows(main).count(), firstHeading: "Today" };
  });

  await section("types-sheet", "Activity types: ticks are staged, Cancel and Escape discard, a group tick takes the whole group, one request on apply; keyboard only", async () => {
    const trigger = main.getByTestId("types-trigger");
    await expect(trigger).toContainText("Club activity");
    let requests = 0;
    const count = (r) => {
      if (isFeed(r)) requests++;
    };
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
    await changed(main, () => sheet.getByRole("button", { name: "Show activity", exact: true }).click());
    await expect(sheet).toHaveCount(0);
    await expect(main).toHaveURL(/types=attendance$/);
    await expect(view(main, "Attendance")).toHaveAttribute("aria-pressed", "true");
    await expect(row(main, "paid £45.00")).toHaveCount(0);
    await expect(row(main, "checked in to").first()).toBeVisible();
    await sleep(600);
    main.off("request", count);
    expect(requests).toBe(1);
    return { requestsForTheWholeSheet: requests };
  });

  await section("member-picker", "Member: found by email with the arrow keys and Enter; named at once; only the id reaches the address; focus follows the pick and the clear", async () => {
    await open(main, "/dashboard/activity");
    const before = await main.getByTestId("activity-filters").boundingBox();
    const field = main.getByRole("combobox", { name: "Member" });
    await field.click();
    await expect(main.getByText("Type at least 2 characters")).toBeVisible();
    // The second member's address, typed in part: the address is how a front desk finds someone.
    await field.pressSequentially(s.other.email.slice(0, s.other.email.indexOf("@")), { delay: 20 });
    const option = main.getByRole("option").filter({ hasText: s.other.name });
    await expect(option).toHaveCount(1, SLOW);
    await expect(main.getByTestId("member-search-status")).toHaveText("1 member found");
    await shot(main, "activity-picker-1440");
    await main.keyboard.press("ArrowDown");
    await main.keyboard.press("ArrowUp");
    const answered = main.waitForResponse(isFeed);
    await main.keyboard.press("Enter");
    // Named at once, from the pick, before the rows have come back; and the keyboard is on the clear button.
    await expect(main.getByTestId("member-picked")).toContainText(s.other.name, { timeout: 1500 });
    await expect(main.getByRole("button", { name: `Clear member filter: ${s.other.name}` })).toBeFocused();
    await expect(main).toHaveURL(new RegExp(`\\?memberId=${s.other.id}$`));
    expect(main.url()).not.toContain("example");
    await answered;
    await ready(main);
    await expect(main.getByRole("heading", { name: `Activity for ${s.other.name}` })).toBeVisible();
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
    await ready(main);
    await expect(row(main, `${s.other.name}'s payment of £30.00 failed`)).toHaveCount(1);
    await changed(main, () => main.getByRole("button", { name: `Clear member filter: ${s.other.name}` }).click());
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    await expect(main.getByRole("combobox", { name: "Member" })).toBeFocused();
    return { cardHeight: after.height };
  });

  await section("plan-and-done-by", "Plan shows what happened to that plan; Done by shows one person's work; Reset puts everything back", async () => {
    await open(main, "/dashboard/activity?types=all");
    await changed(main, () => main.getByRole("combobox", { name: "Plan" }).selectOption({ label: "Adult Unlimited" }));
    await expect(main).toHaveURL(new RegExp(`tierId=${s.tierNew}`));
    await expect(main.getByText("Activity that names this plan.")).toBeVisible();
    await expect(row(main, `moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`)).toHaveCount(1);
    await expect(row(main, "checked in to")).toHaveCount(0);
    await expect(main.getByTestId("activity-summary")).toContainText("Everything · Adult Unlimited");
    await changed(main, () => main.getByRole("combobox", { name: "Plan" }).selectOption({ label: "Any plan" }));
    await changed(main, () => main.getByRole("combobox", { name: "Done by" }).selectOption({ label: "Sam Synthetic · Owner" }));
    await expect(main).toHaveURL(new RegExp(`userId=${s.owner}`));
    await expect(row(main, `cancelled ${s.other.name}'s membership`)).toHaveCount(1);
    // Nothing a member or Stripe did.
    await expect(row(main, "checked in to")).toHaveCount(0);
    await expect(row(main, "paid £45.00")).toHaveCount(0);
    await expect(main.getByTestId("activity-summary")).toContainText("done by Sam Synthetic");
    // "Show all activity types" is only about types; here they are all shown already, so it is not offered.
    await expect(main.getByRole("button", { name: "Show all activity types", exact: true })).toHaveCount(0);
    await changed(main, () => main.getByRole("button", { name: "Reset filters", exact: true }).click());
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    await expect(main.getByRole("button", { name: "Reset filters", exact: true })).toBeDisabled();
    return { ok: true };
  });

  await section("jump-to-date", "Jump to date: a day is where the list starts; Previous day steps back; Show older carries on; the card keeps its height", async () => {
    await open(main, "/dashboard/activity?types=attendance");
    await expect(headings(main).first()).toHaveText("Today");
    const before = await main.getByTestId("activity-filters").boundingBox();
    const jump = main.getByTestId("jump-to-date");
    await changed(main, () => jump.getByRole("button", { name: "Yesterday", exact: true }).click());
    await expect(main).toHaveURL(new RegExp(`day=${yesterday}`));
    await expect(headings(main).first()).toHaveText("Yesterday");
    await expect(jump.getByRole("button", { name: "Yesterday", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(row(main, `${s.other.name} checked in to`).first()).toBeVisible();
    await expect(main.getByTestId("activity-summary")).toContainText("up to");
    const after = await main.getByTestId("activity-filters").boundingBox();
    expect(Math.abs(after.height - before.height)).toBeLessThanOrEqual(0.5);
    // One day further back: nothing happened that day, so the list starts at the day the older rows are on.
    await changed(main, () => jump.getByRole("button", { name: "Previous day" }).click());
    const dayBefore = shiftDay(yesterday, -1);
    await expect(main).toHaveURL(new RegExp(`day=${dayBefore}`));
    await expect(jump.getByLabel("Jump to date")).toHaveValue(dayBefore);
    const olderDay = clubDay(new Date(s.olderAt), s.timeZone);
    await expect(headings(main).first()).toHaveText(longDate(olderDay));
    // Typing a date works the same way.
    await changed(main, () => jump.getByLabel("Jump to date").fill(yesterday));
    await expect(main).toHaveURL(new RegExp(`day=${yesterday}`));
    await expect(headings(main).first()).toHaveText("Yesterday");
    // Next day from yesterday is today, which is the absence of a day.
    await changed(main, () => jump.getByRole("button", { name: "Next day" }).click());
    await expect(main).toHaveURL(/\/dashboard\/activity\?types=attendance$/);
    await expect(jump.getByRole("button", { name: "Next day" })).toBeDisabled();
    // Show older reaches the rest and moves focus to the first new row's link.
    await expect(rows(main)).toHaveCount(50);
    await main.getByRole("button", { name: "Show older", exact: true }).click();
    await expect(main.getByTestId("activity-status")).toHaveText(/^\d+ more loaded$/, SLOW);
    expect(await rows(main).count()).toBeGreaterThan(50);
    expect(await main.evaluate(() => document.activeElement?.tagName)).toBe("A");
    await expect(main.getByText("That's everything. Activity is kept for one year.")).toBeVisible();
    return { rows: await rows(main).count() };
  });

  await section("views", "the view chips: Money is payments, failures and cancellations only; Everything adds settings and staff accounts", async () => {
    await open(main, "/dashboard/activity");
    await changed(main, () => view(main, "Money").click());
    await expect(main).toHaveURL(/types=money$/);
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1);
    await expect(row(main, `${s.other.name}'s payment of £30.00 failed`)).toHaveCount(1);
    await expect(row(main, "checked in to")).toHaveCount(0);
    // "Show all activity types" widens the types and nothing else.
    await changed(main, () => main.getByRole("button", { name: "Show all activity types", exact: true }).click());
    await expect(main).toHaveURL(/types=all$/);
    await expect(view(main, "Everything")).toHaveAttribute("aria-pressed", "true");
    await expect(typed(main, "Club settings")).toHaveCount(1);
    await expect(typed(main, "Staff accounts")).toHaveCount(1);
    await changed(main, () => view(main, "Club activity").click());
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    return { ok: true };
  });

  await section("staff-name", "a staff name inside a sentence's source filters to that person without leaving the page", async () => {
    await open(main, "/dashboard/activity?types=all");
    const settings = typed(main, "Club settings");
    await expect(settings).toHaveCount(1);
    const link = settings.getByTestId("activity-source").getByRole("link", { name: "Sam Synthetic", exact: true });
    const refetch = main.waitForResponse((r) => isFeed(r) && r.url().includes(`userId=${s.owner}`));
    await link.click();
    await refetch;
    await ready(main);
    await expect(main).toHaveURL(new RegExp(`userId=${s.owner}`));
    await expect(main.getByRole("combobox", { name: "Done by" })).toHaveValue(s.owner);
    await expect(row(main, "checked in to")).toHaveCount(0);
    return { ok: true };
  });

  await section("undo", "owner: Since here only on Everything with no filter; undoing the phone edit strikes the row through in place and the undo is recorded", async () => {
    // With a member filter the row has Undo alone.
    await open(main, `/dashboard/activity?types=all&memberId=${s.mel.id}`);
    const filtered = row(main, `updated ${s.mel.name}'s details`);
    await expect(filtered).toHaveCount(1);
    await expect(filtered.getByRole("button", { name: /^Undo:/ })).toHaveCount(1);
    await expect(filtered.getByRole("button", { name: /^Since here/ })).toHaveCount(0);
    // On Everything with nothing filtered, Since here is offered and lists what it would undo, as sentences.
    await open(main, "/dashboard/activity?types=all");
    const edit = row(main, `updated ${s.mel.name}'s details`);
    await expect(edit).toHaveCount(1);
    await expect(edit.getByTestId("activity-detail")).toContainText("Phone: 07700 900111 → 07700 900222");
    // The button says "Since here", and that is how its spoken name starts.
    await expect(edit.getByRole("button", { name: /^Since here: undo everything Sam Synthetic did since/ })).toHaveText("Since here");
    await edit.getByRole("button", { name: /^Since here/ }).click();
    const plan = main.getByTestId("undo-plan");
    await expect(plan).toBeVisible(SLOW);
    await expect(plan).toContainText(`updated ${s.mel.name}'s details`);
    await expect(main.getByRole("dialog").last()).toContainText("This covers everything Sam Synthetic has done across the club since");
    await expect(main.getByRole("dialog", { name: /^Undo everything Sam Synthetic did since \d\d:\d\d\?$/ })).toBeVisible();
    await main.keyboard.press("Escape");
    await expect(main.getByRole("dialog")).toHaveCount(0);
    // A row that cannot be undone says why, one keyboard press away.
    const cancelled = row(main, `cancelled ${s.other.name}'s membership`);
    const why = cancelled.getByRole("button", { name: /^Can't undo: / });
    await expect(why).toHaveText("Can't undo");
    await why.focus();
    await main.keyboard.press("Enter");
    const reason = main.getByRole("dialog", { name: "Why this can't be undone" });
    await expect(reason).toBeVisible();
    const reasonText = (await reason.locator("p.text-sm").last().innerText()).trim();
    expect(reasonText.length).toBeGreaterThan(10);
    await main.keyboard.press("Escape");
    // Undo the phone edit.
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
    await expect(typed(main, "Undone changes")).toHaveCount(1, SLOW);
    await expect(main).toHaveURL(/\/dashboard\/activity\?types=all$/);
    const phoneNow = (await q(`select phone from "Member" where id = $1`, [s.mel.id]))[0].phone;
    expect(phoneNow).toBe("07700 900111");
    await shot(main, "activity-undone-1440");
    return { phoneRestored: phoneNow === "07700 900111", reason: reasonText };
  });

  await section("failures", "a failed first load is an error with one retry, never an empty list; a slow answer to an old filter never overwrites the new one; a failed Show older keeps the rows; names that cannot be loaded leave the plain log", async () => {
    // 1) First page fails.
    let calls = 0;
    await main.route("**/api/activity?**", async (route) => {
      calls++;
      if (calls === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Couldn't load activity." }) });
      return route.continue().catch(() => {});
    });
    await main.goto("/dashboard/activity?types=attendance");
    await expect(main.getByText("Couldn't load activity.").first()).toBeVisible(SLOW);
    await expect(main.getByText("Nothing matches these filters.")).toHaveCount(0);
    await expect(rows(main)).toHaveCount(0);
    await shot(main, "activity-error-1440");
    const beforeRetry = calls;
    await main.getByRole("button", { name: "Try again", exact: true }).first().click();
    await ready(main);
    await sleep(500);
    expect(calls - beforeRetry).toBe(1);
    await main.unrouteAll({ behavior: "wait" });

    // 2) The Attendance answer is held back; Money is chosen meanwhile; the late answer must not replace it.
    await open(main, "/dashboard/activity");
    await main.route("**/api/activity?**", async (route) => {
      if (route.request().url().includes("types=attendance")) await sleep(6000);
      return route.continue().catch(() => {}); // the page has aborted the held-back request by then
    });
    await view(main, "Attendance").click();
    await sleep(500); // past the pause before asking: the Attendance request is in flight
    await changed(main, () => view(main, "Money").click());
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1);
    await sleep(6500); // the held-back answer would have arrived by now
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1);
    await expect(row(main, "checked in to")).toHaveCount(0);
    await expect(view(main, "Money")).toHaveAttribute("aria-pressed", "true");
    await main.unrouteAll({ behavior: "wait" });

    // 3) Show older fails: rows stay, an inline retry appears, and the retry works.
    await open(main, "/dashboard/activity?types=attendance");
    await expect(rows(main)).toHaveCount(50);
    let olderCalls = 0;
    await main.route("**/api/activity?**", async (route) => {
      if (route.request().url().includes("cursor=") && ++olderCalls === 1) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Couldn't load activity." }) });
      return route.continue().catch(() => {});
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
    await open(main, "/dashboard/activity?types=attendance");
    await expect(main.getByText("Names couldn't be loaded, so this is the plain log.")).toBeVisible();
    await expect(rows(main)).toHaveCount(50);
    await expect(main.locator("table a")).toHaveCount(0);
    await shot(main, "activity-degraded-1440");
    await main.unrouteAll({ behavior: "wait" });
    return { retryRequests: 1 };
  });

  await section("links", "a filter that matches nothing says so and offers the two ways out; a mangled link is the page without that filter, never an error", async () => {
    await open(main, "/dashboard/activity?types=refund");
    await expect(emptyTitle(main, "Nothing matches these filters.")).toBeVisible();
    await expect(main.getByTestId("activity-status")).toHaveText("Nothing matches these filters.");
    await shot(main, "activity-empty-1440");
    await changed(main, () => main.getByRole("button", { name: "Show everything", exact: true }).click());
    await expect(main).toHaveURL(/types=all$/);
    await expect(rows(main).first()).toBeVisible();
    // A type that no longer exists is left out, and the page says so (it never asks the server for it).
    const asked = main.waitForRequest(isFeed);
    await main.goto("/dashboard/activity?types=checkin,bogus_type");
    expect(new URL((await asked).url()).searchParams.get("types")).toBe("checkin");
    await ready(main);
    await expect(main.getByText("This link included activity types that no longer exist.")).toBeVisible();
    await expect(rows(main).first()).toBeVisible();
    // An id that is not a member here: an empty timeline that says whose it was meant to be.
    await open(main, `/dashboard/activity?memberId=${id()}`);
    await expect(main.getByTestId("member-picked")).toContainText("Removed member");
    await expect(emptyTitle(main, "Nothing matches these filters.")).toBeVisible();
    // A day that is not a date, an id that is not an id: not filters at all.
    await open(main, "/dashboard/activity?day=abc&memberId=a%20b");
    await expect(main.getByTestId("activity-summary")).not.toContainText(/Invalid|member|up to/);
    await expect(headings(main).first()).toHaveText("Today");
    await changed(main, () => main.getByTestId("jump-to-date").getByRole("button", { name: "Previous day" }).click());
    await expect(main).toHaveURL(new RegExp(`day=${yesterday}`));
    await expect(headings(main).first()).toHaveText("Yesterday");
    return { ok: true };
  });

  let copied = "";
  await section("copy-and-default", "Copy link writes the view out; Make this my default is kept on this device for this person and is read before the first request", async () => {
    await open(main, "/dashboard/activity");
    await main.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(main.getByText("Link copied.")).toBeVisible();
    const plain = await main.evaluate(() => navigator.clipboard.readText());
    expect(new URL(plain).search).toBe("?types=club");
    // A view with owner-only types in it, for the manager to open later.
    await open(main, "/dashboard/activity?types=all");
    await main.getByRole("button", { name: "Copy link", exact: true }).click();
    copied = await main.evaluate(() => navigator.clipboard.readText());
    expect(new URL(copied).search).toBe("?types=all");
    // Save Money as the default.
    await changed(main, () => view(main, "Money").click());
    await main.getByRole("button", { name: "Make this my default", exact: true }).click();
    await expect(main.getByText("Saved. Activity will open like this on this device.")).toBeVisible();
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    let requests = 0;
    const count = (r) => {
      if (isFeed(r)) requests++;
    };
    main.on("request", count);
    await main.reload();
    await ready(main);
    await expect(view(main, "Money")).toHaveAttribute("aria-pressed", "true");
    await expect(row(main, `${s.mel.name} paid £45.00`)).toHaveCount(1);
    await sleep(600);
    main.off("request", count);
    expect(requests).toBe(1); // the saved default is read before the first request, not after it
    await expect(main).toHaveURL(/\/dashboard\/activity$/);
    // With a default saved, a copied link still says what it shows.
    await main.getByRole("button", { name: "Copy link", exact: true }).click();
    expect(new URL(await main.evaluate(() => navigator.clipboard.readText())).search).toBe("?types=money");
    return { copied: new URL(copied).search, firstLoadRequests: requests };
  });

  // ── Manager ────────────────────────────────────────────────────────────────
  const mctx = await context(browser, "10.94.9.3");
  const mpage = await mctx.newPage();
  mpage.on("pageerror", (e) => errors.push(e.message));
  await section(
    "manager",
    "a manager: the page opens; no Undo; no owner-only rows or types by any link; no values in edits; a plan is not a link; every link opens; the undo routes refuse them by role",
    async () => {
      await staffSignIn(mpage, club, manager);
      await open(mpage, "/dashboard/activity");
      await expect(mpage.getByRole("link", { name: "Activity", exact: true }).first()).toBeVisible();
      await expect(view(mpage, "Club activity")).toHaveAttribute("aria-pressed", "true");
      await expect(mpage.getByRole("columnheader", { name: "Undo" })).toHaveCount(0);
      await expect(mpage.getByRole("button", { name: /Undo|Since here/ })).toHaveCount(0);
      // The owner's copied link (types=all).
      await open(mpage, new URL(copied).pathname + new URL(copied).search);
      await expect(typed(mpage, "Club settings")).toHaveCount(0);
      await expect(typed(mpage, "Staff accounts")).toHaveCount(0);
      await expect(typed(mpage, "Undone changes")).toHaveCount(0);
      // Money is theirs to see.
      await expect(row(mpage, `${s.mel.name} paid £45.00`)).toHaveCount(1);
      // Asking for an owner-only type by name: it is left out, and said; the request never carries it.
      const asked = mpage.waitForRequest(isFeed);
      await mpage.goto("/dashboard/activity?types=checkin,staff,settings");
      expect(new URL((await asked).url()).searchParams.get("types")).toBe("checkin");
      await ready(mpage);
      await expect(mpage.getByText("Some activity types in this link are only visible to the owner.")).toBeVisible();
      await expect(typed(mpage, "Staff accounts")).toHaveCount(0);
      // The sheet lists none of them.
      await mpage.getByTestId("types-trigger").click();
      const sheet = mpage.getByRole("dialog", { name: "Activity types" });
      for (const hidden of ["Staff accounts", "Club settings", "Sign-in and security", "MatFlow support", "Data requests", "Undone changes", "Plans and packs (set-up)"]) {
        await expect(sheet.getByRole("checkbox", { name: hidden, exact: true })).toHaveCount(0);
      }
      await expect(sheet.getByRole("checkbox", { name: "Payment", exact: true })).toHaveCount(1);
      await mpage.keyboard.press("Escape");
      // An edit names the field, not what it held; a plan is a name, not a link.
      await open(mpage, `/dashboard/activity?types=all&memberId=${s.mel.id}`);
      const edit = row(mpage, `updated ${s.mel.name}'s details`);
      await expect(edit).toHaveCount(1);
      const editText = await edit.innerText();
      expect(editText).toContain("Phone");
      expect(/07700|→/.test(editText)).toBe(false);
      const moved = row(mpage, `moved ${s.mel.name} from Twice a week (OLD) to Adult Unlimited`);
      await expect(moved).toHaveCount(1);
      await expect(moved.getByRole("link", { name: "Adult Unlimited" })).toHaveCount(0);
      // The API says the same thing as the page.
      const api = await mpage.request.get("/api/activity?types=all&take=50");
      expect(api.status()).toBe(200);
      const body = await api.json();
      const serialised = JSON.stringify(body);
      expect(body.entries.length).toBeGreaterThan(5);
      expect(body.entries.some((e) => "undo" in e)).toBe(false);
      expect(body.entries.some((e) => ["staff", "settings", "sign_in", "support", "undo", "data_request", "plan_setup", "import", "other"].includes(e.type))).toBe(false);
      expect(/07700 900111|"metadata"|"ipAddress"|"operatorId"|example\.test/.test(serialised)).toBe(false);
      // Undo is the owner's. The request is same-origin (as the page's own would be), so the refusal is the role's.
      const post = (path, data) => mpage.request.post(path, { headers: { Origin: BASE }, data });
      const one = await post(`/api/audit-log/${s.rows.plan.id}/undo`);
      const many = await post("/api/audit-log/undo-to", { userId: s.owner, auditId: s.rows.plan.id, preview: true });
      expect([one.status(), many.status()]).toEqual([403, 403]);
      const refusals = [await one.text(), await many.text()];
      for (const text of refusals) expect(text).toContain("permission");
      // Every link the feed offers a manager opens for a manager (followed in the browser: a refusal is a redirect inside the page).
      await open(mpage, "/dashboard/activity?types=all");
      const hrefs = [...new Set(await mpage.locator("table a").evaluateAll((as) => as.map((a) => a.getAttribute("href"))))].filter(Boolean);
      const refused = [];
      for (const href of hrefs) {
        await mpage.goto(href);
        await mpage.waitForLoadState("domcontentloaded");
        await sleep(1500); // a refusal arrives as a redirect once the page has streamed
        if (/denied=1|\/login/.test(mpage.url())) refused.push(`${href} -> ${new URL(mpage.url()).pathname}${new URL(mpage.url()).search}`);
      }
      expect(refused, refused.join("; ")).toEqual([]);
      // The check above can see a refusal: a page managers may not open does turn them away.
      await mpage.goto("/dashboard/memberships");
      await expect(mpage).toHaveURL(/denied=1/, SLOW);
      await open(mpage, "/dashboard/activity");
      await shot(mpage, "activity-manager-1440");
      return { linksFollowed: hrefs.length, undo: [one.status(), many.status()] };
    },
    () => mpage,
  );

  await section("shared-browser", "the owner's saved default does not follow the next person to sign in on the same browser, and can be dropped", async () => {
    // The owner's browser still holds their saved Money default; sign the manager in there.
    const shared = await context(browser, "10.94.9.5", { storageState: await ctx.storageState() });
    const page = await shared.newPage();
    try {
      await open(page, "/dashboard/activity");
      await expect(view(page, "Money")).toHaveAttribute("aria-pressed", "true");
      await shared.clearCookies();
      await staffSignIn(page, club, manager);
      await open(page, "/dashboard/activity");
      await expect(view(page, "Club activity")).toHaveAttribute("aria-pressed", "true");
      const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("activity.")));
      expect(stored).toHaveLength(1); // the owner's is still there, untouched and unread
    } finally {
      await shared.close();
    }
    // The owner drops it.
    await open(main, "/dashboard/activity");
    await changed(main, () => main.getByRole("button", { name: "Use MatFlow's default", exact: true }).click());
    await expect(view(main, "Club activity")).toHaveAttribute("aria-pressed", "true");
    expect(await main.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("activity.")).length)).toBe(0);
    return { ok: true };
  });

  await section("widths", "no sideways scroll at 1440, 1280 and 1024; the four filters are one height; Undo stays inside the table's card", async () => {
    const out = {};
    for (const width of [1440, 1280, 1024]) {
      await main.setViewportSize({ width, height: 900 });
      await open(main, "/dashboard/activity?types=all");
      expect(await noSideScroll(main), `sideways scroll at ${width}`).toBe(true);
      const boxes = await Promise.all([main.getByTestId("types-trigger"), main.getByRole("combobox", { name: "Member" }), main.getByRole("combobox", { name: "Plan" }), main.getByRole("combobox", { name: "Done by" })].map((l) => l.boundingBox()));
      const heights = boxes.map((b) => b.height);
      expect(Math.max(...heights) - Math.min(...heights), `filter heights at ${width}: ${heights}`).toBeLessThanOrEqual(0.5);
      const card = await main.locator("table").locator("xpath=ancestor::div[contains(@class,'sm:bg-sf-1')]").first().boundingBox();
      const undo = await rows(main).getByRole("button", { name: /^Undo:/ }).first().boundingBox();
      expect(undo.x + undo.width, `Undo's right edge at ${width}`).toBeLessThanOrEqual(card.x + card.width);
      await shot(main, `activity-all-${width}`);
      out[width] = heights[0];
    }
    await main.setViewportSize({ width: 1440, height: 900 });
    return out;
  });

  await section("accents", "a white, a yellow and a near-black club accent: the pressed view, a ticked box and the keyboard focus ring all stay visible", async () => {
    const seen = {};
    const style = (l) =>
      l.evaluate((el) => {
        const c = getComputedStyle(el);
        return { bg: c.backgroundColor, border: c.borderTopColor, color: c.color, outline: c.outlineColor, outlineWidth: c.outlineWidth, shadow: c.boxShadow };
      });
    try {
      for (const accent of ["#ffffff", "#ffe14d", "#111111"]) {
        // The accent as the owner's own browser applies it the moment they change it in Settings.
        await main.evaluate((value) => localStorage.setItem("gym-settings", JSON.stringify({ primaryColor: value })), accent);
        await open(main, "/dashboard/activity?types=money");
        const applied = await main.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--color-primary").trim());
        expect(applied.toLowerCase(), "the accent under test is the one applied").toBe(accent);
        const pressed = view(main, "Money");
        await expect(pressed).toHaveAttribute("aria-pressed", "true");
        const [a, b] = [await style(pressed), await style(view(main, "Attendance"))];
        // Pressed is told from idle by something that shows on a white card: its edge against the card, or its fill.
        const edge = await contrast(main, a.border, "rgb(255, 255, 255)");
        const fill = await contrast(main, a.bg, "rgb(255, 255, 255)");
        expect(Math.max(edge, fill), `${accent}: the pressed chip's edge ${edge.toFixed(2)} and fill ${fill.toFixed(2)} against the card`).toBeGreaterThanOrEqual(3);
        expect(a.bg !== b.bg || a.border !== b.border, `${accent}: pressed looks like idle`).toBe(true);
        expect(await contrast(main, a.color, a.bg), `${accent}: the label on its fill`).toBeGreaterThanOrEqual(4.5);
        // The keyboard focus ring, on a control sitting on the white card.
        await main.getByTestId("types-trigger").focus();
        await main.keyboard.press("Shift+Tab");
        await main.keyboard.press("Tab");
        const ring = await style(main.getByTestId("types-trigger"));
        expect(ring.outlineWidth).toBe("2px");
        const ringContrast = await contrast(main, ring.outline, "rgb(255, 255, 255)");
        expect(ringContrast, `${accent}: the focus ring ${ring.outline} against the card`).toBeGreaterThanOrEqual(3);
        // A ticked box in the sheet.
        await main.keyboard.press("Enter");
        const sheet = main.getByRole("dialog", { name: "Activity types" });
        const ticked = sheet.getByRole("checkbox", { name: "Payment", exact: true });
        await expect(ticked).toHaveAttribute("aria-checked", "true");
        const box = await style(ticked);
        expect(box.shadow, `${accent}: a ticked box keeps its hairline`).not.toBe("none");
        await shot(main, `activity-accent-${accent.slice(1)}`);
        await main.keyboard.press("Escape");
        await expect(sheet).toHaveCount(0);
        seen[accent] = { pressedEdge: Number(edge.toFixed(2)), pressedFill: Number(fill.toFixed(2)), focusRing: Number(ringContrast.toFixed(2)) };
      }
    } finally {
      await main.evaluate(() => localStorage.removeItem("gym-settings"));
    }
    return seen;
  });

  await section("club-time", "a browser in Bali reads the club's clock: the same times and the same Today as the club, and a line saying so", async () => {
    const away = await context(browser, "10.94.9.2", { timezoneId: "Asia/Makassar", storageState: await ctx.storageState() });
    const page = await away.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      await open(page, "/dashboard/activity?types=attendance");
      await expect(headings(page).first()).toHaveText("Today");
      await expect(page.getByText(`Times are shown in club time (${s.timeZone}).`)).toBeVisible();
      const first = row(page, `${s.mel.name} checked in to ${s.sessionLabel}`).first();
      const shown = (await first.locator("td").first().innerText()).trim();
      const expected = clubTime(s.rows.checkin.at, s.timeZone);
      expect(shown).toBe(expected);
      // Yesterday's row sits under Yesterday at the club's time, whatever day it is in Bali.
      await changed(page, () => page.getByTestId("jump-to-date").getByRole("button", { name: "Yesterday", exact: true }).click());
      await expect(headings(page).first()).toHaveText("Yesterday");
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
    await ready(main);
    await expect(main.getByRole("heading", { name: `Activity for ${s.mel.name}` })).toBeVisible();
    return { cards: 20 };
  });

  // ── Coach ──────────────────────────────────────────────────────────────────
  await section("coach", "a coach: no Activity in the menu, the page turns them away, the API refuses, and a member's page has no History", async () => {
    const cctx = await context(browser, "10.94.9.4");
    const page = await cctx.newPage();
    try {
      await staffSignIn(page, club, coach);
      await page.goto("/dashboard");
      await expect(page.getByRole("link", { name: "Dashboard", exact: true }).first()).toBeVisible(SLOW);
      await expect(page.getByRole("link", { name: "Activity", exact: true })).toHaveCount(0);
      await page.goto("/dashboard/activity");
      await expect(page).toHaveURL(/\/dashboard\?denied=1$/, SLOW);
      const api = await page.request.get("/api/activity");
      expect(api.status()).toBe(403);
      expect(await api.text()).not.toContain(s.mel.name);
      await page.goto(`/dashboard/members/${s.mel.id}`);
      await expect(page.getByRole("heading", { name: s.mel.name }).first()).toBeVisible(SLOW);
      await sleep(1500);
      await expect(page.getByTestId("activity-embedded")).toHaveCount(0);
      await expect(page.getByTestId("activity-embedded-loading")).toHaveCount(0);
      return { page: "/dashboard?denied=1", api: api.status() };
    } finally {
      await cctx.close();
    }
  });

  // ── Phone ──────────────────────────────────────────────────────────────────
  await section("phone", "390 x 844: cards, no sideways scroll, a long class name wraps, every name can be tapped, the Filters sheet applies, the types sheet on top of it works by keyboard, Show older moves focus", async () => {
    // A class name long enough to need three lines on a phone.
    const longName = "Advanced No-Gi Competition Preparation and Open Mat for Returning Blue Belts";
    await q(`update "Class" set name = $2 where id = $1`, [s.cls.id, longName]);
    const mobile = await context(browser, "10.94.9.6", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    try {
      await open(phone, "/dashboard/activity");
      const cards = phone.getByTestId("activity-card").filter({ visible: true });
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
        const shown = [...document.querySelectorAll('[data-testid="activity-card"]')].filter((c) => c.getClientRects().length).slice(0, 10);
        for (const card of shown) {
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
      await phone.evaluate(() => window.scrollTo(0, 0));
      await shot(phone, "activity-default-390");
      // The Filters sheet: Done by, applied; Copy link and the default live here on a phone.
      await phone.getByTestId("filters-button").tap();
      const sheet = phone.getByRole("dialog", { name: "Filters" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByRole("button", { name: "Copy link", exact: true })).toBeVisible();
      await shot(phone, "activity-filters-sheet-390");
      await sheet.getByRole("combobox", { name: "Done by" }).selectOption({ label: "Sam Synthetic · Owner" });
      await changed(phone, () => sheet.getByRole("button", { name: "Show activity", exact: true }).tap());
      await expect(sheet).toHaveCount(0);
      await expect(phone).toHaveURL(new RegExp(`userId=${s.owner}`));
      await expect(phone.getByTestId("filters-button")).toContainText("Filters (1)");
      const chip = phone.getByRole("button", { name: "Remove filter: Done by Sam Synthetic" });
      await expect(chip).toBeVisible();
      await expect(cards.filter({ hasText: "checked in to" })).toHaveCount(0);
      // The owner's Undo is on the card, apart from the sentence; a refusal is written out.
      await expect(cards.filter({ hasText: "Can't undo:" }).first()).toBeVisible();
      await changed(phone, () => chip.tap());
      await expect(phone).toHaveURL(/\/dashboard\/activity$/);
      // Activity types opens on top of Filters. By keyboard: Tab leaves the first control and reaches a tick box.
      await phone.getByTestId("filters-button").tap();
      await sheet.getByTestId("types-trigger").tap();
      const types = phone.getByRole("dialog", { name: "Activity types" });
      await expect(types).toBeVisible();
      const reached = [];
      for (let i = 0; i < 6; i++) {
        await phone.keyboard.press("Tab");
        reached.push(await phone.evaluate(() => document.activeElement?.getAttribute("role") ?? document.activeElement?.tagName));
      }
      expect(reached, `Tab reached: ${reached.join(", ")}`).toContain("checkbox");
      expect(await phone.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')?.textContent?.includes("Choose which activity to show"))).toBe(true);
      await shot(phone, "activity-types-sheet-390");
      // Attendance only, applied from the top sheet; then the Filters sheet beneath is closed.
      await types.getByRole("button", { name: "Club activity", exact: true }).tap();
      for (const group of ["Memberships & money", "Members", "Classes", "Communication", "Staff & club"]) {
        const groupBox = types.getByRole("checkbox", { name: `${group}: all` });
        if ((await groupBox.getAttribute("aria-checked")) !== "false") await groupBox.tap();
        if ((await groupBox.getAttribute("aria-checked")) !== "false") await groupBox.tap();
      }
      await changed(phone, () => types.getByRole("button", { name: "Show activity", exact: true }).tap());
      await expect(types).toHaveCount(0);
      await sheet.getByRole("button", { name: "Show activity", exact: true }).tap();
      await expect(sheet).toHaveCount(0);
      await expect(phone).toHaveURL(/types=attendance$/);
      // Show older on a phone: the first new card (or its first link) takes the focus.
      await expect(cards).toHaveCount(50);
      await phone.getByRole("button", { name: "Show older", exact: true }).tap();
      await expect(phone.getByTestId("activity-status")).toHaveText(/^\d+ more loaded$/, SLOW);
      const focus = await phone.evaluate(() => {
        const el = document.activeElement;
        const card = el?.closest('[data-testid="activity-card"]');
        return { inCard: !!card, shown: !!card && card.getClientRects().length > 0 };
      });
      expect(focus).toEqual({ inCard: true, shown: true });
      expect(await noSideScroll(phone)).toBe(true);
      return { longCardHeight: Math.round(box.height), tabReached: reached };
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
