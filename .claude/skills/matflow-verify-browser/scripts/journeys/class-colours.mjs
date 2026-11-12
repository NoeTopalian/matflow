// Class colours (11 Nov 2026: grey, light yellow, navy, light blue) on screen (synthetic data only).
//   node run-journeys.mjs class-colours
// The staff timetable is light only; the member shell is dark by default and light when the club's background is
// light. Contrast floors measured on the real page: 4.5:1 for text, 3:1 for marks, edges and rings.
//   form (desktop): every swatch named, the class's own pressed with a tick; keyboard choice; with a #111111 club
//         accent the focus outline sits outside the selection ring; a failed save keeps the choice; the retry
//         stores it once; reload shows it;
//   form (phone): swatches stay 28x28 circles (never stretched to the touch 44 px);
//   staff week (desktop, phone): a pale dot ringed, chip text 4.5:1; a LIVE pale class's edge 3:1 against its tint;
//   member schedule (phone dark, phone light, desktop dark): a booked light-yellow block's text 4.5:1; its selection
//         ring 3:1 against the gap beside it and the shell; a live unbooked pale block's edge 3:1 against the shell.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { launchWithScrollbars, state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, contrast, focusRing, phoneNoSidewaysScroll, setAccent } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId;
const L = ledger("class-colours");
const TAG = randomUUID().slice(0, 6);
const SUNRISE = `Sunrise ${TAG}`;
const NOW_CLASS = `Live grey ${TAG}`;
const LIGHT_YELLOW = "#fde68a";
const GREY = "#94a3b8";

async function section(id, desc, fn) {
  try {
    L.check(id, desc, true, await fn());
  } catch (e) {
    L.check(id, desc, false, String(e.message ?? e).split("\n").filter((s) => s.trim()).slice(0, 6).join(" | "));
  }
}
const colourOf = async (id) => (await q(`select color from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]))[0]?.color;
/** WCAG contrast of two "r,g,b" strings. */
function ratio(a, b) {
  const lum = (s) => String(s).split(",").slice(0, 3).map(Number).map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}
/** Any CSS colour (rgb(), color(srgb …), a hex, a var already resolved) as "r,g,b", read back through a canvas. */
const bytesOf = (page, css) => page.evaluate((value) => {
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = "#000"; c.fillStyle = value; c.fillRect(0, 0, 1, 1);
  return Array.from(c.getImageData(0, 0, 1, 1).data.slice(0, 3)).join(",");
}, css);
const lastColour = (shadow) => (String(shadow).match(/rgba?\([^)]*\)|oklab\([^)]*\)|oklch\([^)]*\)|color\([^)]*\)/g) ?? []).at(-1) ?? "";
/** London "HH:MM", minutes from now. */
const london = (plusMin) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + plusMin * 60_000));
const londonDow = () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(new Date()));

// Booked block text against each gradient stop, composited over the shell; the weaker stop counts.
const bookedInk = (block) => block.evaluate((el) => {
  const name = el.querySelector("[data-block-part='name']");
  // Resolve --member-bg to a colour by painting it on a probe beside the block (the token may itself be a var()).
  const probe = document.createElement("div");
  probe.style.background = "var(--member-bg, #ffffff)";
  el.parentElement.appendChild(probe);
  const shellCss = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const px = (under, top) => { c.clearRect(0, 0, 1, 1); c.fillStyle = under; c.fillRect(0, 0, 1, 1); c.fillStyle = top; c.fillRect(0, 0, 1, 1); return Array.from(c.getImageData(0, 0, 1, 1).data.slice(0, 3)); };
  const lum = (rgb) => rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const stops = getComputedStyle(el).backgroundImage.match(/rgba?\([^)]*\)/g) ?? [];
  const text = px(shellCss, getComputedStyle(name).color);
  const each = stops.map((s) => Math.round(ratio(text, px(shellCss, s)) * 100) / 100);
  return { min: each.length ? Math.min(...each) : 0, each, stops, shell: shellCss };
});

const browser = await launchWithScrollbars();
const errors = [];
try {
  const ctx = await context(browser, "10.96.1.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(page, club);
  await setAccent(club, "#111111"); // UI-RULES §2a worst case for a focus ring drawn in the accent

  // A light-yellow class late today, and a grey class live NOW (started 5 min ago, 50 min long), through the API.
  const day = londonDow();
  const create = (name, colour, start, end) => page.evaluate(async ([n, d, c, s, e]) => {
    const r = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n, duration: 50, color: c, schedules: [{ dayOfWeek: d, startTime: s, endTime: e }] }) });
    return { status: r.status, body: await r.json() };
  }, [name, day, colour, start, end]);
  const sunrise = await create(SUNRISE, LIGHT_YELLOW, "23:00", "23:50");
  if (sunrise.status !== 201) throw new Error(`create returned ${sunrise.status}`);
  const classId = sunrise.body.id;
  // Saturated colours booked too: blue (the default) and red read 3.62 and 3.50 on the dark shell when the block's
  // second stop let the shell through; purple and indigo miss 4.5:1 with either ink on their own colour (review of 12 Nov
  // 2026). Run before 19:00 London time, or the earliest of these has ended and is measured greyed (saturate filter).
  const BOOKED_EXTRA = [["#3b82f6", `Booked blue ${TAG}`, "21:00", "21:50"], ["#ef4444", `Booked red ${TAG}`, "22:00", "22:50"], ["#8b5cf6", `Booked purple ${TAG}`, "20:00", "20:50"], ["#6366f1", `Booked indigo ${TAG}`, "19:00", "19:50"]];
  const extraIds = [];
  for (const [colour, name, start, end] of BOOKED_EXTRA) {
    const r = await create(name, colour, start, end);
    if (r.status !== 201) throw new Error(`create (${name}) returned ${r.status}`);
    extraIds.push(r.body.id);
  }
  const liveStart = london(-5);
  const liveEnd = london(45);
  const liveCan = liveStart < liveEnd; // not across midnight
  let liveId = null;
  if (liveCan) {
    const live = await create(NOW_CLASS, GREY, liveStart, liveEnd);
    if (live.status !== 201) throw new Error(`create (live) returned ${live.status}`);
    liveId = live.body.id;
  }

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
  await section("K2", "class card: the schedule pill's text reaches 4.5:1 (it used to be painted in the colour itself, 1.1:1)", async () => {
    const pill = page.locator("span.rounded-lg", { hasText: /^\w{3} 23:00$/ }).first();
    await expect(pill).toBeVisible();
    const ink = await contrast(pill);
    expect(ink).toBeGreaterThanOrEqual(4.5);
    await shot(page, "class-colours-desktop");
    return { ink };
  });
  if (liveCan) {
    await section("K3", "a LIVE grey class: its chip's left edge reaches 3:1 against the chip's own tint", async () => {
      const chip = page.locator(`button[aria-label^="Edit ${NOW_CLASS}, "]:visible`).first();
      await expect(chip).toHaveAttribute("data-session-state", "live", { timeout: 30_000 });
      const [edge, fill] = await chip.evaluate((el) => [getComputedStyle(el).borderLeftColor, getComputedStyle(el).backgroundColor]);
      const tint = await page.evaluate((f) => { // the rgba tint over the white page
        const m = f.match(/[\d.]+/g).map(Number); const a = m[3] ?? 1;
        return m.slice(0, 3).map((v) => Math.round(v * a + 255 * (1 - a))).join(",");
      }, fill);
      const r = ratio(await bytesOf(page, edge), tint);
      expect(r).toBeGreaterThanOrEqual(3);
      return { edge, tint, ratio: r };
    });
  } else {
    L.note("K3", "live checks skipped: the run is too close to midnight in London for a 50-minute session today", { liveStart, liveEnd });
  }

  // ── The form, desktop ──
  await page.locator(`button[aria-label^="Edit ${SUNRISE}, "]:visible`).first().click();
  const group = page.getByRole("group", { name: "Colour" });
  await section("K4", "the picker names every colour, presses the class's own with a tick, and says it in words", async () => {
    await expect(group).toBeVisible();
    const labels = await group.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    for (const name of ["Grey", "Light yellow", "Navy", "Light blue"]) expect(labels).toContain(`Class colour: ${name}`);
    expect(labels.slice(0, 2)).toEqual(["Class colour: Blue", "Class colour: Purple"]);
    const own = group.getByRole("button", { name: "Class colour: Light yellow" });
    await expect(own).toHaveAttribute("aria-pressed", "true");
    await expect(own.locator("svg")).toHaveCount(1);
    await expect(page.getByTestId("class-colour-name")).toHaveText("Light yellow");
    return labels.length;
  });
  await section("K5", "keyboard: Space chooses Grey; with a #111111 accent the focus outline is drawn outside the selection ring (offset ≥ 4 px), 3:1", async () => {
    const grey = group.getByRole("button", { name: "Class colour: Grey" });
    await grey.focus();
    await page.keyboard.press("Space");
    await expect(grey).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("class-colour-name")).toHaveText("Grey");
    const ring = await focusRing(grey);
    expect(ring.focusVisible).toBe(true);
    expect(ring.style).not.toBe("none");
    expect(ring.contrast).toBeGreaterThanOrEqual(3);
    const geometry = await grey.evaluate((el) => ({ offset: parseFloat(getComputedStyle(el).outlineOffset), selection: getComputedStyle(el).boxShadow, w: el.getBoundingClientRect().width, h: el.getBoundingClientRect().height }));
    expect(geometry.offset).toBeGreaterThanOrEqual(4); // the selection ring fills 2-4 px out
    expect(geometry.selection).not.toBe("none");
    expect([Math.round(geometry.w), Math.round(geometry.h)]).toEqual([28, 28]);
    return { focus: ring, geometry };
  });
  await section("K6", "a refused save says so beside the buttons and keeps Grey chosen; nothing is stored", async () => {
    await page.route(`**/api/classes/${classId}`, (r) => (r.request().method() === "PATCH" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong. Try again." }) }) : r.continue()));
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("class-form-save-error")).toBeVisible();
    await expect(group.getByRole("button", { name: "Class colour: Grey" })).toHaveAttribute("aria-pressed", "true");
    expect(await colourOf(classId)).toBe(LIGHT_YELLOW);
    await page.unroute(`**/api/classes/${classId}`);
    return "kept";
  });
  await section("K7", "the retry sends exactly one request and stores Grey; after a reload the chip's dot is ringed grey", async () => {
    let patches = 0;
    page.on("request", (r) => { if (r.method() === "PATCH" && new URL(r.url()).pathname === `/api/classes/${classId}`) patches++; });
    await page.getByRole("button", { name: "Save changes" }).click();
    const t0 = Date.now();
    await expect.poll(() => colourOf(classId), { timeout: 45_000 }).toBe(GREY);
    const savedMs = Date.now() - t0;
    expect(patches).toBe(1);
    await page.reload();
    const chip = page.locator(`button[aria-label^="Edit ${SUNRISE}, "]:visible`).first();
    await expect(chip).toBeVisible({ timeout: 30_000 });
    const dot = await chip.locator("span[aria-hidden='true'].rounded-full").first().evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ring: getComputedStyle(el).boxShadow }));
    expect(dot.bg).toBe("rgb(148, 163, 184)");
    expect(dot.ring).not.toBe("none");
    return { ...dot, savedMs, patches };
  });
  // Back to light yellow for the phone and member checks.
  await q(`update "Class" set color = $1 where id = $2 and "tenantId" = $3`, [LIGHT_YELLOW, classId, tenantId]);

  // ── Phone: the owner's timetable and the form ──
  const pctx = await context(browser, "10.96.1.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  const phone = await pctx.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(phone, club);
  await phone.goto("/dashboard/timetable");
  await section("K8", "phone timetable: no sideways scroll, and the light-yellow chip's text reaches 4.5:1", async () => {
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
  await section("K9", "phone form: every swatch is a 28x28 circle (not stretched to the touch 44 px), with no sideways scroll", async () => {
    await phone.locator(`button[aria-label^="Edit ${SUNRISE}, "]:visible`).first().click();
    const pgroup = phone.getByRole("group", { name: "Colour" });
    await expect(pgroup).toBeVisible({ timeout: 15_000 });
    const sizes = await pgroup.getByRole("button").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    for (const s of sizes) expect(s).toEqual([28, 28]);
    const docScroll = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(docScroll).toBe(false);
    await shot(phone, "class-colours-phone-form");
    return { swatches: sizes.length };
  });

  // ── Member schedule: booked light yellow; live grey unbooked ──
  const member = await memberLogin(club);
  for (const id of [classId, ...extraIds]) {
    await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3) on conflict do nothing`, [randomUUID(), member.id, id]);
  }
  const memberRuns = [
    ["K10", "phone, dark shell", "#111111", { width: 390, height: 844, isMobile: true, hasTouch: true }],
    ["K11", "phone, light shell", "#ffffff", { width: 390, height: 844, isMobile: true, hasTouch: true }],
    ["K12", "desktop, dark shell", "#111111", { width: 1440, height: 900 }],
  ];
  for (const [id, label, bg, vp] of memberRuns) {
    // Through the owner's settings save, as a club would: it revalidates the member branding cache
    // (app/api/me/gym, 60 s), which a direct database write does not.
    const saved = await page.evaluate(async (b) => (await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bgColor: b }) })).status, bg);
    if (saved !== 200) throw new Error(`settings PATCH bgColor ${bg} returned ${saved}`);
    const { width, height, ...rest } = vp;
    const mctx = await context(browser, `10.96.2.${memberRuns.findIndex((r) => r[0] === id) + 1}`, { viewport: { width, height }, ...rest, timezoneId: "Europe/London" });
    const mpage = await mctx.newPage();
    mpage.on("pageerror", (e) => errors.push(e.message));
    await memberSignIn(mpage, club, member);
    await mpage.goto("/member/schedule");
    await section(id, `member schedule, ${label}: booked light-yellow, blue, red, purple and indigo text 4.5:1 against every gradient stop; its selection ring 3:1 against the gap beside it and the shell; a live pale block's edge 3:1`, async () => {
      const block = mpage.locator("button[data-booked]").filter({ hasText: SUNRISE }).first();
      await expect(block).toBeVisible({ timeout: 30_000 });
      // The shell renders dark first and takes the club's background when /api/me/gym answers (app/member/layout.tsx):
      // measure only once the shell is the one this run set, or "light shell" silently measures the dark one.
      await expect.poll(() => mpage.evaluate(() => getComputedStyle(document.querySelector("[style*='--member-bg']") ?? document.body)
        .getPropertyValue("--member-bg").trim().toLowerCase()), { timeout: 30_000 }).toBe(bg);
      // A booked block is painted with a gradient (background-image), which the harness's measureInk does not
      // see: it would measure the ink against the shell behind the block. Measure against each gradient stop,
      // composited over the shell, and keep the weaker.
      const ink = await bookedInk(block);
      expect(ink.stops.length).toBeGreaterThanOrEqual(2);
      expect(ink.min).toBeGreaterThanOrEqual(4.5);
      const extra = {};
      for (const [, name] of BOOKED_EXTRA) {
        const b = mpage.locator("button[data-booked]").filter({ hasText: name }).first();
        await expect(b).toBeVisible({ timeout: 30_000 });
        const m = await bookedInk(b);
        extra[name.split(" ")[1]] = m.each;
        expect(m.stops.length, name).toBeGreaterThanOrEqual(2);
        expect(m.min, name).toBeGreaterThanOrEqual(4.5);
      }
      await block.click();
      const shadow = await block.evaluate((el) => getComputedStyle(el).boxShadow);
      const ringCss = lastColour(shadow);
      expect(ringCss).not.toBe("");
      const vars = await mpage.evaluate(() => {
        const host = document.querySelector("[style*='--member-elevated']") ?? document.body;
        const cs = getComputedStyle(host);
        return { gap: cs.getPropertyValue("--member-elevated").trim(), bg: cs.getPropertyValue("--member-bg").trim() };
      });
      const ring = await bytesOf(mpage, ringCss);
      const gap = await bytesOf(mpage, vars.gap);
      const shell = await bytesOf(mpage, vars.bg);
      const ringVsGap = ratio(ring, gap);
      const ringVsShell = ratio(ring, shell);
      expect(ringVsGap).toBeGreaterThanOrEqual(3);
      expect(ringVsShell).toBeGreaterThanOrEqual(3);
      let liveEdge = null;
      if (liveCan) {
        const liveBlock = mpage.locator("button[data-session-state='live']").filter({ hasText: NOW_CLASS }).first();
        await expect(liveBlock).toBeVisible({ timeout: 15_000 });
        const edgeCss = await liveBlock.evaluate((el) => getComputedStyle(el).borderLeftColor);
        liveEdge = ratio(await bytesOf(mpage, edgeCss), shell);
        expect(liveEdge).toBeGreaterThanOrEqual(3);
      }
      await shot(mpage, `class-colours-member-${id}`);
      return { ink, extra, ringVsGap, ringVsShell, liveEdge };
    });
    await mctx.close();
  }

  L.check("errors", "no uncaught page errors", errors.length === 0, errors.slice(0, 3));
} catch (e) {
  L.check("journey", "completed", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  // The fixture club goes back to its own colours whatever happened, so a later journey starts from them.
  await q(`update "Tenant" set "bgColor" = '#111111' where id = $1`, [tenantId]).catch(() => {});
  await setAccent(club, "#3b82f6").catch(() => {});
  await browser.close();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
}
