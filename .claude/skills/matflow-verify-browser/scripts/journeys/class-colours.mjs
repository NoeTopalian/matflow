// Class colours (11 Nov 2026: grey, light yellow, navy, light blue) on screen (synthetic data only).
//   node run-journeys.mjs class-colours
// The staff timetable is light only; the member shell is dark by default and light when the club's background is
// light. Contrast floors measured on the real page: 4.5:1 for text, 3:1 for marks, edges and rings.
//   form: every swatch named, the class's own pressed with a tick, keyboard choice, focus ring distinct from the
//         selection ring, a failed save keeps the choice, the retry stores it, reload shows it;
//   staff week (desktop) and phone: a pale class's dot ringed, schedule-pill text 4.5:1, no sideways scroll;
//   member schedule on a phone, dark and light shell: a booked light-yellow block's text 4.5:1, the selection ring
//   3:1 against the shell.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { launchWithScrollbars, state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, contrast, focusRing, phoneNoSidewaysScroll } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId;
const L = ledger("class-colours");
const TAG = randomUUID().slice(0, 6);
const SUNRISE = `Sunrise ${TAG}`;
const LIGHT_YELLOW = "#fde68a";
const GREY = "#94a3b8";

async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    L.check(id, desc, false, String(e.message ?? e).split("\n").slice(0, 3).join(" | "));
  }
}
const colourOf = async (id) => (await q(`select color from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]))[0]?.color;
/** WCAG contrast of two "r,g,b" or rgb() strings, computed here. */
function ratio(a, b) {
  const lum = (s) => (String(s).match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number).map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const browser = await launchWithScrollbars();
const errors = [];
try {
  const ctx = await context(browser, "10.96.1.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(page, club);

  // A light-yellow class today, through the app's create API from the signed-in page.
  const today = new Date().getDay();
  const created = await page.evaluate(async ([name, day, colour]) => {
    const r = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, duration: 60, color: colour, schedules: [{ dayOfWeek: day, startTime: "23:00", endTime: "23:30" }] }) });
    return { status: r.status, body: await r.json() };
  }, [SUNRISE, today, LIGHT_YELLOW]);
  if (created.status !== 201) throw new Error(`create returned ${created.status}`);
  const classId = created.body.id;

  await page.goto("/dashboard/timetable");
  await section("K1", "desktop week: the light-yellow chip's dot is ringed, and its text reaches 4.5:1", async () => {
    const chip = page.locator(`button[aria-label^="Edit ${SUNRISE}, "]:visible`).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    const dotShadow = await chip.locator("span[aria-hidden='true'].rounded-full").first().evaluate((el) => getComputedStyle(el).boxShadow);
    expect(dotShadow).not.toBe("none");
    const nameInk = await contrast(chip.locator("[data-chip-part='name']"));
    expect(nameInk).toBeGreaterThanOrEqual(4.5);
    return { dotShadow, nameInk };
  });
  await section("K2", "class card: its schedule pill's text reaches 4.5:1 (it used to be painted in the colour itself, 1.1:1)", async () => {
    const pill = page.locator("span.rounded-lg", { hasText: /^\w{3} 23:00$/ }).first();
    await expect(pill).toBeVisible();
    const ink = await contrast(pill);
    expect(ink).toBeGreaterThanOrEqual(4.5);
    await shot(page, "class-colours-desktop");
    return { ink };
  });

  // ── The form ──
  await page.locator(`button[aria-label^="Edit ${SUNRISE}, "]:visible`).first().click();
  const group = page.getByRole("group", { name: "Colour" });
  await section("K3", "the picker names every colour, presses the class's own with a tick, and says it in words", async () => {
    await expect(group).toBeVisible();
    const labels = await group.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    expect(labels).toContain("Class colour: Grey");
    expect(labels).toContain("Class colour: Light yellow");
    expect(labels).toContain("Class colour: Navy");
    expect(labels).toContain("Class colour: Light blue");
    expect(labels.slice(0, 2)).toEqual(["Class colour: Blue", "Class colour: Purple"]);
    const own = group.getByRole("button", { name: "Class colour: Light yellow" });
    await expect(own).toHaveAttribute("aria-pressed", "true");
    await expect(own.locator("svg")).toHaveCount(1);
    await expect(page.getByTestId("class-colour-name")).toHaveText("Light yellow");
    return labels.length;
  });
  await section("K4", "keyboard: focus Grey and press Space; the focus ring is an outline and the selection ring a separate box-shadow", async () => {
    const grey = group.getByRole("button", { name: "Class colour: Grey" });
    await grey.focus();
    await page.keyboard.press("Space");
    await expect(grey).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("class-colour-name")).toHaveText("Grey");
    const ring = await focusRing(grey);
    expect(ring.focusVisible).toBe(true);
    expect(ring.style).not.toBe("none");
    expect(ring.contrast).toBeGreaterThanOrEqual(3);
    const selection = await grey.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(selection).not.toBe("none");
    return { focus: ring, selection };
  });
  await section("K5", "a refused save says so beside the buttons and keeps Grey chosen; nothing is stored", async () => {
    await page.route(`**/api/classes/${classId}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong. Try again." }) }) : r.continue()));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("class-form-save-error")).toBeVisible();
    await expect(group.getByRole("button", { name: "Class colour: Grey" })).toHaveAttribute("aria-pressed", "true");
    expect(await colourOf(classId)).toBe(LIGHT_YELLOW);
    await page.unroute(`**/api/classes/${classId}`);
    return "kept";
  });
  await section("K6", "the retry sends exactly one request and stores Grey; after a reload the chip's dot is ringed grey", async () => {
    let patches = 0;
    page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${classId}`) patches++; });
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect.poll(() => colourOf(classId), { timeout: 15_000 }).toBe(GREY);
    expect(patches).toBe(1);
    await page.reload();
    const chip = page.locator(`button[aria-label^="Edit ${SUNRISE}, "]:visible`).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    const dot = await chip.locator("span[aria-hidden='true'].rounded-full").first().evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ring: getComputedStyle(el).boxShadow }));
    expect(dot.bg).toBe("rgb(148, 163, 184)");
    expect(dot.ring).not.toBe("none");
    return dot;
  });
  // Back to light yellow for the phone and member checks.
  await q(`update "Class" set color = $1 where id = $2 and "tenantId" = $3`, [LIGHT_YELLOW, classId, tenantId]);

  // ── Phone: the owner's timetable ──
  const pctx = await context(browser, "10.96.1.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  const phone = await pctx.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(phone, club);
  await phone.goto("/dashboard/timetable");
  await section("K7", "phone timetable: no sideways scroll, and the light-yellow chip's text reaches 4.5:1", async () => {
    const chip = phone.locator(`button[aria-label^="Edit ${SUNRISE}, "]:visible`).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    const sideways = await phoneNoSidewaysScroll(phone);
    expect(sideways.mainScrolls).toBe(false);
    expect(sideways.documentScrolls).toBe(false);
    const ink = await contrast(chip.locator("[data-chip-part='name']"));
    expect(ink).toBeGreaterThanOrEqual(4.5);
    await shot(phone, "class-colours-phone");
    return { ink, sideways };
  });

  // ── Member schedule, booked, on a phone: dark shell, then light shell ──
  const member = await memberLogin(club);
  await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3) on conflict do nothing`, [randomUUID(), member.id, classId]);
  for (const [id, shell, bg] of [["K8", "dark", "#111111"], ["K9", "light", "#ffffff"]]) {
    await q(`update "Tenant" set "bgColor" = $1 where id = $2`, [bg, tenantId]);
    const mctx = await context(browser, `10.96.1.${id === "K8" ? 3 : 4}`, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
    const mpage = await mctx.newPage();
    mpage.on("pageerror", (e) => errors.push(e.message));
    await memberSignIn(mpage, club, member);
    await mpage.goto("/member/schedule");
    await section(id, `member schedule, ${shell} shell: the booked light-yellow block's text reaches 4.5:1 and its selection ring 3:1 against the shell`, async () => {
      const block = mpage.locator("button[data-booked]").filter({ hasText: SUNRISE }).first();
      await expect(block).toBeVisible({ timeout: 30_000 });
      const ink = await contrast(block.locator("[data-block-part='name']"));
      expect(ink).toBeGreaterThanOrEqual(4.5);
      await block.click();
      const shadow = await block.evaluate((el) => getComputedStyle(el).boxShadow);
      const ringColour = (shadow.match(/rgba?\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)/g) ?? []).at(-1) ?? "";
      expect(ringColour).not.toBe("");
      // Whatever form the browser reports (a color-mix resolves to color(srgb …)), read it back as sRGB bytes.
      const [ringRgb, shellBg] = await mpage.evaluate((css) => {
        const c = document.createElement("canvas").getContext("2d");
        const bytes = (value) => { c.clearRect(0, 0, 1, 1); c.fillStyle = "#000"; c.fillStyle = value; c.fillRect(0, 0, 1, 1); return Array.from(c.getImageData(0, 0, 1, 1).data.slice(0, 3)).join(","); };
        return [bytes(css), bytes(getComputedStyle(document.querySelector("[style*='--member-bg']") ?? document.body).getPropertyValue("--member-bg").trim() || getComputedStyle(document.body).backgroundColor)];
      }, ringColour);
      const ringRatio = ratio(ringRgb, shellBg);
      expect(ringRatio).toBeGreaterThanOrEqual(3);
      await shot(mpage, `class-colours-member-${shell}`);
      return { ink, ringColour, ringRgb, shellBg, ringRatio: Math.round(ringRatio * 100) / 100 };
    });
    await mctx.close();
  }
  await q(`update "Tenant" set "bgColor" = '#111111' where id = $1`, [tenantId]);

  L.check("errors", "no uncaught page errors", errors.length === 0, errors.slice(0, 3));
} catch (e) {
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
