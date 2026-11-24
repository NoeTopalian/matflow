// Journey: menu and overlay audit (24 Nov 2026). Every overlay must meet three rules:
//   1. the control just opened is fully visible and reachable;
//   2. the screen behind it takes no taps or clicks while it is open;
//   3. closing it goes back exactly one level and keeps any unsaved draft.
// Driven by real taps, clicks and keys (never judged by screenshot: an invisible layer can intercept a visible button),
// at 320, 390, 768 and 1280 px wide, plus 200% zoom for the desktop menus.
//   C1 class editor: Category and Coach (last option), Escape, reduced viewport (keyboard stand-in)
//   C2 phone More menu -> destination
//   C3 timetable "+N more" -> class -> close
//   C4 unsaved form -> Discard changes? -> Keep editing / backdrop
//   C5 desktop menus near edges: account menu, Settings tabs, member "More actions"
//   A3 end to end: open a class, rename, Category + Coach, save, back on an interactive timetable
// Needs `fixture.mjs create` and `server.mjs start`. Seeds its own classes (synthetic names) and removes them.
//   node journeys/overlay-audit.mjs [--only=C1,C4] [--widths=390,1280]
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, seedStaff, OUT } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const tenantId = club.tenantId;
const L = ledger("overlay-audit");
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ONLY = arg("only")?.split(",");
const runs = (c) => !ONLY || ONLY.includes(c);

const VIEWPORTS = [
  { tag: "320", opts: { viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true } },
  { tag: "390", opts: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  { tag: "768", opts: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true } },
  { tag: "1280", opts: { viewport: { width: 1280, height: 800 } } },
].filter((v) => !arg("widths") || arg("widths").split(",").includes(v.tag));
// 200% browser zoom on a 1280 x 800 window: a 640 x 400 CSS viewport at two device pixels per CSS pixel.
const ZOOM = { tag: "1280@200%", opts: { viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 } };

// Result matrix: case -> viewport -> PASSED / REPRODUCED / NOT TESTED / N/A (with why).
const matrix = {};
const mark = (c, tag, result, why = "") => {
  const cell = (matrix[c] ??= {})[tag];
  // A failure anywhere in the cell wins; NOT TESTED never overwrites a measured result.
  if (!cell || result === "REPRODUCED" || (cell.result === "NOT TESTED" && result !== "NOT TESTED")) (matrix[c] ??= {})[tag] = { result, why };
};
const check = (c, tag, id, ok, saw) => { L.check(`${c}@${tag}`, id, ok, saw); mark(c, tag, ok ? "PASSED" : "REPRODUCED", ok ? "" : id); return ok; };
const notTested = (c, tag, id, why) => { L.note(`${c}@${tag}`, `NOT TESTED: ${id}`, why); mark(c, tag, "NOT TESTED", why); };
const na = (c, tag, why) => { L.note(`${c}@${tag}`, "not applicable at this width", why); (matrix[c] ??= {})[tag] ??= { result: "N/A", why }; };

/** Is the element's centre inside the window, and is the element (or its child) what a tap there would hit? */
const hit = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const inView = r.width > 0 && r.height > 0 && r.top >= -0.5 && r.left >= -0.5 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  const top = inView ? document.elementFromPoint(x, y) : null;
  return {
    inView, onTop: !!top && (top === el || el.contains(top)),
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vw: innerWidth, vh: innerHeight,
    topEl: top ? `${top.tagName}${top.getAttribute("aria-label") ? `[${top.getAttribute("aria-label")}]` : ""}.${String(top.className).slice(0, 50)}` : null,
  };
});
// Bring a control to the middle of its scroller, as a person scrolling to it would: "if needed" counts a control
// under the fixed bottom bar as already in view.
const CENTRE = (el) => el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  const dlg = a?.closest('[role="dialog"]');
  return { tag: a?.tagName ?? null, label: a?.getAttribute("aria-label") ?? a?.textContent?.trim().slice(0, 40) ?? null, dialog: dlg ? (document.getElementById(dlg.getAttribute("aria-labelledby") ?? "")?.textContent ?? "?") : null };
});
const scrolls = (page) => page.evaluate(() => ({ main: Math.round(document.querySelector("main")?.scrollTop ?? 0), win: Math.round(scrollY) }));
const touch = (v) => !!v.opts.hasTouch;
const press = (v, loc) => (touch(v) ? loc.tap() : loc.click());

// ── Seed: synthetic classes every day of the week, so every width's "today" has them ──
const hh = (h) => `${String(h).padStart(2, "0")}:00`;
const seeded = [];
async function seedClass(name, h) {
  const id = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 30)`, [id, tenantId, name]);
  for (let d = 0; d < 7; d++) {
    await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [randomUUID(), id, d, hh(h), hh(h + 1)]);
  }
  seeded.push(id);
  return id;
}
async function cleanup() {
  for (const id of seeded) {
    for (const t of ["ClassSchedule", "ClassInstance"]) await q(`delete from "${t}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "AuditLog" where "tenantId" = $1 and "entityId" = $2`, [tenantId, id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]).catch((e) => console.log(`  (could not remove class ${id}: ${String(e).slice(0, 120)})`));
  }
}

const errors = [];
let browser;
try {
  // A run killed before its cleanup leaves its classes; take them first so names and lanes are as seeded.
  for (const r of await q(`select id from "Class" where "tenantId" = $1 and name like 'Ov %'`, [tenantId])) seeded.push(r.id);
  await cleanup();
  seeded.length = 0;
  await seedClass("Ov Main", 7);
  for (let n = 1; n <= 6; n++) await seedClass(`Ov Fold ${n}`, 18);
  const saveHours = { "320": 9, "390": 11, "768": 13, "1280": 15 };
  for (const v of VIEWPORTS) await seedClass(`Ov Save ${v.tag}`, saveHours[v.tag]);
  await seedStaff(club, "coach", { name: "Zara Coach" });

  browser = await chromium.launch();
  // One sign-in (an authenticator code per 30 s step); every width reuses the session.
  const signCtx = await context(browser, "10.98.0.1");
  const sp = await signCtx.newPage();
  await ownerSignIn(sp, club);
  const storageState = await signCtx.storageState();
  await signCtx.close();

  const memberRow = (await q(`select id from "Member" where "tenantId" = $1 and name = 'Member 1'`, [tenantId]))[0];
  let lane = 10;

  for (const v of [...VIEWPORTS, ZOOM]) {
    const zoom = v === ZOOM;
    const ctx = await context(browser, `10.98.0.${lane++}`, { ...v.opts, storageState, timezoneId: "Europe/London" });
    // Every click the page receives, for "nothing under the original tap fires".
    await ctx.addInitScript(() => {
      window.__clicks = [];
      document.addEventListener("click", (e) => {
        const t = e.target;
        window.__clicks.push({ at: Math.round(performance.now()), path: location.pathname, tag: t?.tagName, text: (t?.closest("a,button")?.textContent ?? "").trim().slice(0, 30) });
      }, true);
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${v.tag}: ${String(e).slice(0, 200)}`));
    const T = v.tag;
    const timetable = async () => {
      await page.goto("/dashboard/timetable");
      await page.waitForLoadState("networkidle");
      const chip = page.locator('button[aria-label^="Edit Ov Main, "]:visible').first();
      await chip.waitFor({ timeout: 90000 });
      return chip;
    };
    const editSheet = () => page.getByRole("dialog", { name: "Edit class" });
    const askDialog = () => page.getByRole("dialog", { name: "Discard your changes?" });

    // ── C1: class editor, Category and Coach ──
    if (!zoom && runs("C1")) {
      try {
        const chip = await timetable();
        await chip.evaluate(CENTRE);
        await press(v, chip);
        const sheet = editSheet();
        await sheet.waitFor({ timeout: 30000 });
        await page.waitForTimeout(400); // slide-in
        const nameInput = sheet.getByLabel("Class Name", { exact: true });
        const draft = `Ov Main draft ${T}`;
        await nameInput.fill(draft);
        for (const label of ["Category", "Coach"]) {
          const sel = sheet.locator(`select[aria-label="${label}"]`);
          await sel.evaluate(CENTRE);
          const h = await hit(sel);
          const opts = await sel.evaluate((s) => Array.from(s.options).map((o) => ({ v: o.value, t: o.text })));
          const last = opts[opts.length - 1];
          // The tap opens the native list (Chromium opens it even headless: the page then receives no keys until it
          // closes). End + Enter choose the last option inside the open list, as a keyboard user of the list would.
          await press(v, sel);
          const focused = await sel.evaluate((s) => document.activeElement === s);
          await page.keyboard.press("End");
          await page.keyboard.press("Enter");
          let value = await sel.inputValue();
          const viaList = value === last.v;
          if (!viaList) { await sel.selectOption(last.v); value = await sel.inputValue(); }
          const open = await sheet.isVisible();
          const kept = await nameInput.inputValue();
          check("C1", T, `${label}: the control is visible and takes the tap; its last option ("${last.t}") lands in ${label}; the sheet stays open; the unsaved name is kept`,
            h.inView && h.onTop && focused && value === last.v && open && kept === draft, { h, focused, last, value, viaList, open, kept, options: opts.length });
        }
        // Escape with the list OPEN closes only the list; the next Escape goes one level up (the dirty sheet asks).
        const coach = sheet.locator('select[aria-label="Coach"]');
        await page.evaluate(() => { window.__keys = 0; document.addEventListener("keydown", (e) => { if (e.key === "Escape") window.__keys++; }, true); });
        await press(v, coach);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        const askedOnFirst = await askDialog().count();
        const pageGotFirst = await page.evaluate(() => window.__keys);
        check("C1", T, "with the Coach list open, Escape closes only the list: the page never receives it, the sheet stays open, the name is kept, focus stays on Coach",
          askedOnFirst === 0 && pageGotFirst === 0 && (await sheet.isVisible()) && (await nameInput.inputValue()) === draft && (await active(page)).label === "Coach", { askedOnFirst, pageGotFirst });
        await page.keyboard.press("Escape");
        const asked = await askDialog().waitFor({ timeout: 10000 }).then(() => true, () => false);
        const sheetStill = await sheet.isVisible();
        if (asked) await askDialog().getByRole("button", { name: "Keep editing", exact: true }).click();
        await askDialog().waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(100);
        const back = await active(page);
        check("C1", T, "the next Escape (list closed) goes one level up: the sheet asks first, and Keep editing puts focus back on Coach with the name kept",
          asked && sheetStill && back.label === "Coach" && (await nameInput.inputValue()) === draft, { asked, sheetStill, back });
        notTested("C1", T, "the real iOS wheel picker and Android option sheet", "emulation opens Chromium's own list; the OS pickers on real phones are separate native UI (needs real device)");

        // Reduced visual viewport (stand-in for the on-screen keyboard): Save and Cancel still reachable.
        const vp = v.opts.viewport;
        await page.setViewportSize({ width: vp.width, height: Math.round(vp.height * 0.5) });
        await nameInput.focus();
        await page.waitForTimeout(300);
        const reach = {};
        for (const name of ["Save changes", "Cancel"]) {
          const b = sheet.getByRole("button", { name, exact: true });
          await b.evaluate(CENTRE);
          reach[name] = await hit(b);
        }
        check("C1", T, `with the viewport cut to half height (${Math.round(vp.height * 0.5)} px), Save changes and Cancel scroll into view and take a tap`,
          Object.values(reach).every((h) => h.inView && h.onTop), reach);
        notTested("C1", T, "Save and Cancel with the real on-screen keyboard open", "iPhone Safari and Android keyboards resize the visual viewport, not the layout viewport; emulation cannot reproduce that (needs real device)");
        await shot(page, `overlay-c1-short-${T}`);
        await page.setViewportSize(vp);
        await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
        const closed = await sheet.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
        await page.waitForTimeout(200);
        const afterCancel = await active(page);
        const chipHit = await hit(chip);
        check("C1", T, "Cancel closes the sheet at once, focus returns to the class that opened it, and the timetable takes taps again",
          closed && /^Edit Ov Main, /.test(afterCancel.label ?? "") && chipHit.onTop, { closed, afterCancel, chipHit });
      } catch (e) { check("C1", T, "case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-c1-error-${T}`); }
    }

    // ── C4: unsaved form -> Discard changes? -> Keep editing ──
    if (!zoom && runs("C4")) {
      try {
        const chip = await timetable();
        await chip.evaluate(CENTRE);
        await press(v, chip);
        const sheet = editSheet();
        await sheet.waitFor({ timeout: 30000 });
        await page.waitForTimeout(400);
        const nameInput = sheet.getByLabel("Class Name", { exact: true });
        const draft = `Ov Main unsaved ${T}`;
        await nameInput.fill(draft);
        await page.keyboard.press("Escape");
        const ask = askDialog();
        await ask.waitFor({ timeout: 10000 });
        await page.waitForTimeout(300);
        // Only the question takes input: the name field under it cannot be hit, Tab never leaves the question, typing changes nothing.
        const under = await hit(nameInput);
        let escaped = 0;
        for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); if ((await active(page)).dialog !== "Discard your changes?") escaped++; }
        await page.keyboard.type("zz");
        const unchanged = (await nameInput.inputValue()) === draft;
        const keepBtn = ask.getByRole("button", { name: "Keep editing", exact: true });
        const discardBtn = ask.getByRole("button", { name: "Discard changes", exact: true });
        const btns = { keep: await hit(keepBtn), discard: await hit(discardBtn) };
        check("C4", T, "while the question is open only it takes input: the form under it is covered, Tab stays in the question, typing reaches nothing",
          under.inView ? !under.onTop : true, { under: { inView: under.inView, onTop: under.onTop, topEl: under.topEl } });
        check("C4", T, "Tab stays inside the question (6 presses) and typed keys do not reach the form", escaped === 0 && unchanged, { escaped, unchanged });
        check("C4", T, "both answers are fully visible and take a tap", btns.keep.inView && btns.keep.onTop && btns.discard.inView && btns.discard.onTop, btns);
        await shot(page, `overlay-c4-ask-${T}`);
        await press(v, keepBtn);
        await ask.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(100);
        const back = await active(page);
        check("C4", T, "Keep editing closes only the question; focus is back inside the form and the draft is kept",
          back.dialog === "Edit class" && (await sheet.isVisible()) && (await nameInput.inputValue()) === draft, { back });

        // The question's backdrop: keeps editing, never discards.
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
        await ask.waitFor({ timeout: 10000 });
        await page.waitForTimeout(300);
        const box = await ask.boundingBox();
        // A point on the question's backdrop: above the question panel, left edge.
        await page.mouse.click(2, Math.max(2, Math.round((box?.y ?? 40) / 2)));
        const askGone = await ask.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
        check("C4", T, "tapping the question's backdrop does not discard: the question closes, the sheet and draft stay",
          askGone && (await sheet.isVisible()) && (await nameInput.inputValue()) === draft, { askGone, at: box });

        // The sheet's own backdrop also asks rather than discarding.
        await page.mouse.click(2, 2);
        const asked2 = await ask.waitFor({ timeout: 10000 }).then(() => true, () => false);
        check("C4", T, "tapping the sheet's backdrop with unsaved changes asks first", asked2 && (await sheet.isVisible()), { asked2 });
        if (asked2) {
          await press(v, ask.getByRole("button", { name: "Discard changes", exact: true }));
          const gone = await sheet.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
          await page.waitForTimeout(200);
          const after = await active(page);
          const chipHit = await hit(chip);
          const saved = (await q(`select name from "Class" where "tenantId" = $1 and name like 'Ov Main%'`, [tenantId])).map((r) => r.name);
          check("C4", T, "Discard changes closes the sheet, saves nothing, returns focus to the class, and the timetable takes taps",
            gone && saved.length === 1 && saved[0] === "Ov Main" && /^Edit Ov Main, /.test(after.label ?? "") && chipHit.onTop, { gone, saved, after, chipHit });
        }
      } catch (e) { check("C4", T, "case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-c4-error-${T}`); }
    }

    // ── C3: timetable "+N more" -> class -> close ──
    if (!zoom && runs("C3")) {
      try {
        await timetable();
        const more = page.locator('[data-testid="week-more"]:visible').first();
        await more.waitFor({ timeout: 30000 });
        await more.evaluate(CENTRE);
        const moreHit = await hit(more);
        check("C3", T, '"+N more" is visible and takes the tap', moreHit.inView && moreHit.onTop, moreHit);
        await press(v, more);
        const panel = page.getByTestId("more-panel");
        const hasPanel = await panel.waitFor({ timeout: 8000 }).then(() => true, () => false);
        let row;
        if (hasPanel) {
          row = panel.getByTestId("more-row").last();
        } else {
          // On the week, "+N more" opens that day as columns (WeekChip MoreChip): the class is then a chip in the Day view.
          await page.waitForLoadState("networkidle");
          L.note(`C3@${T}`, '"+N more" on the week opens the Day view (no list in place)', page.url());
          row = page.locator('button[aria-label^="Edit Ov Fold 6, "]:visible').first();
          await row.waitFor({ timeout: 30000 });
        }
        await row.evaluate(CENTRE);
        const rowLabel = await row.getAttribute("aria-label");
        const before = await scrolls(page);
        await press(v, row);
        const sheet = editSheet();
        await sheet.waitFor({ timeout: 30000 });
        await page.waitForTimeout(400);
        const shown = await sheet.getByLabel("Class Name", { exact: true }).inputValue();
        const above = await hit(sheet.getByLabel("Class Name", { exact: true }));
        check("C3", T, "the class pressed is the class that opens, drawn above the list and taking taps",
          !!rowLabel && rowLabel.startsWith(`Edit ${shown}, `) && above.inView && above.onTop, { rowLabel, shown, above });
        await shot(page, `overlay-c3-open-${T}`);
        await sheet.getByRole("button", { name: "Close", exact: true }).click();
        await sheet.waitFor({ state: "detached", timeout: 10000 });
        await page.waitForTimeout(250);
        const back = await active(page);
        const after = await scrolls(page);
        check("C3", T, "closing returns focus to the control that opened it and the timetable does not jump",
          back.label === rowLabel && Math.abs(after.main - before.main) <= 2 && Math.abs(after.win - before.win) <= 2, { back, rowLabel, before, after });
        if (hasPanel) {
          await page.keyboard.press("Escape");
          await panel.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
        }
        // No invisible layer left: a class on the timetable takes the next tap and opens.
        const chip = page.locator('button[aria-label^="Edit Ov Main, "]:visible').first();
        const exists = await chip.count();
        let opened = null, chipHit = null;
        if (exists) {
          await chip.evaluate(CENTRE);
          chipHit = await hit(chip);
          await press(v, chip);
          opened = await editSheet().waitFor({ timeout: 15000 }).then(() => true, () => false);
          if (opened) { await page.keyboard.press("Escape"); await editSheet().waitFor({ state: "detached", timeout: 10000 }).catch(() => {}); }
        }
        const layers = await page.evaluate(() => Array.from(document.querySelectorAll("body *")).filter((el) => {
          const s = getComputedStyle(el); const r = el.getBoundingClientRect();
          return (s.position === "fixed") && s.pointerEvents !== "none" && s.visibility !== "hidden" && r.width >= innerWidth * 0.9 && r.height >= innerHeight * 0.9 && !el.closest("[inert]");
        }).map((el) => `${el.tagName}.${String(el.className).slice(0, 60)}`));
        check("C3", T, "nothing invisible is left over the timetable: a class takes the next tap and opens; no full-screen fixed layer remains",
          (!exists || (chipHit?.onTop && opened)) && layers.length === 0, { exists, chipHit, opened, layers });
      } catch (e) { check("C3", T, "case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-c3-error-${T}`); }
    }

    // ── C2: phone More menu -> destination ──
    if (!zoom && runs("C2")) {
      try {
        await page.goto("/dashboard");
        await page.waitForLoadState("networkidle");
        const moreBtn = page.getByRole("button", { name: "More options" });
        if (!(await moreBtn.isVisible())) {
          na("C2", T, "the bottom navigation and its More menu exist below 768 px only (md:hidden)");
        } else {
          await press(v, moreBtn);
          const sheet = page.locator('div[role="dialog"]').filter({ has: page.locator('[aria-label="Sign out all devices"]') });
          await page.waitForTimeout(450); // slide
          const items = sheet.locator("a, button");
          const n = await items.count();
          const unreachable = [];
          for (let i = 0; i < n; i++) {
            const it = items.nth(i);
            const h = await hit(it);
            if (!(h.inView && h.onTop)) unreachable.push({ name: (await it.getAttribute("aria-label")) ?? (await it.textContent())?.trim(), rect: h.rect, topEl: h.topEl });
          }
          const sheetBox = await sheet.evaluate((el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return { top: Math.round(r.top), height: Math.round(r.height), vh: innerHeight, overflowY: s.overflowY }; });
          check("C2", T, `every item in the More menu (${n}) is fully on screen and takes a tap, including Close and Sign out all devices`, unreachable.length === 0, { unreachable, sheetBox });
          await shot(page, `overlay-c2-open-${T}`);
          const link = sheet.getByRole("link", { name: "Settings", exact: true });
          await link.evaluate(CENTRE).catch(() => {});
          const linkHit = await hit(link);
          await page.evaluate(() => { window.__clicks = []; });
          if (linkHit.inView && linkHit.onTop) await press(v, link);
          else await link.evaluate((a) => a.click()); // unreachable by touch: still check what follows navigation
          await page.waitForURL(/\/dashboard\/settings/, { timeout: 60000 });
          await page.waitForLoadState("networkidle");
          await page.waitForTimeout(800);
          const after = await page.evaluate(() => ({
            clicks: window.__clicks,
            backdrops: Array.from(document.querySelectorAll("div.fixed.inset-0")).filter((d) => getComputedStyle(d).pointerEvents !== "none" && d.getBoundingClientRect().height > 0).length,
            path: location.pathname,
          }));
          const state2 = await sheet.evaluate((el) => ({ inert: el.hasAttribute("inert"), hidden: el.getAttribute("aria-hidden"), top: Math.round(el.getBoundingClientRect().top), vh: innerHeight }));
          check("C2", T, "after navigating, the menu is closed (inert, off screen) and no backdrop is left",
            after.backdrops === 0 && state2.inert && state2.top >= state2.vh - 1, { backdrops: after.backdrops, state2 });
          check("C2", T, "the tap fired once, on the menu item; nothing on the destination received it",
            after.clicks.length === 1 && after.clicks[0].text === "Settings" && after.path === "/dashboard/settings", after.clicks);
          // First tap on the destination works.
          const tabs = page.locator(".staff-settings-rail button");
          const target = tabs.nth(1);
          await target.evaluate(CENTRE);
          const label = (await target.textContent())?.trim();
          await press(v, target);
          await page.waitForTimeout(400);
          const isActive = await target.evaluate((b) => !!b.querySelector("span.absolute"));
          check("C2", T, `the first tap on the destination works (Settings tab "${label}" becomes the open tab)`, isActive, { label, isActive });
          notTested("C2", T, "a delayed ghost click from the original tap", "iOS Safari and Android dispatch the compatibility click after touchend on real hardware; emulated taps do not (needs real device)");
        }
      } catch (e) { check("C2", T, "case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-c2-error-${T}`); }
    }

    // ── C5: desktop menus near screen edges (and the same menus at the other widths) ──
    if (runs("C5")) {
      // Account menu (top bar).
      try {
        await page.goto("/dashboard");
        await page.waitForLoadState("networkidle");
        const trigger = page.getByRole("button", { name: "Open account menu" });
        if (!(await trigger.isVisible())) {
          na("C5", T, "no account menu in the top bar at this width (the More menu carries sign-out)");
        } else {
          await trigger.click();
          const menu = page.getByRole("menu");
          await menu.waitFor({ timeout: 10000 });
          const lastItem = menu.getByRole("menuitem").last();
          const lastName = (await lastItem.textContent())?.trim();
          const mouseHit = await hit(lastItem);
          check("C5", T, `account menu by mouse: its last item ("${lastName}") is fully on screen and takes a click`, mouseHit.inView && mouseHit.onTop, mouseHit);
          await shot(page, `overlay-c5-account-${T}`);
          await page.keyboard.press("Escape");
          const closedByEsc = await menu.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
          const afterEsc = await active(page);
          check("C5", T, "account menu: Escape closes it and focus goes back to the button that opened it", closedByEsc && afterEsc.label === "Open account menu", { closedByEsc, afterEsc });
          // Keyboard only.
          await trigger.focus();
          await page.keyboard.press("Enter");
          await menu.waitFor({ timeout: 10000 });
          let reached = false;
          for (let i = 0; i < 8 && !reached; i++) {
            await page.keyboard.press("Tab");
            reached = await lastItem.evaluate((el) => document.activeElement === el).catch(() => false);
          }
          const kbHit = reached ? await hit(lastItem) : null;
          check("C5", T, "account menu by keyboard: Tab reaches its last item, which is on screen", reached && kbHit?.inView, { reached, kbHit });
          await page.keyboard.press("Escape");
          const kbClosed = await menu.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
          const kbBack = await active(page);
          check("C5", T, "account menu by keyboard: Escape from inside the menu closes it and focus goes back to the button that opened it", kbClosed && kbBack.label === "Open account menu", { kbClosed, kbBack });
        }
      } catch (e) { check("C5", T, "account menu case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-c5-error-account-${T}`); }

      // Settings tabs: the last tab.
      try {
        await page.goto("/dashboard/settings");
        await page.waitForLoadState("networkidle");
        const tabs = page.locator(".staff-settings-rail button");
        await tabs.first().waitFor({ timeout: 60000 });
        const last = tabs.last();
        const lastLabel = (await last.textContent())?.trim();
        await last.evaluate(CENTRE);
        const mh = await hit(last);
        await last.click();
        await page.waitForTimeout(300);
        const on = await last.evaluate((b) => !!b.querySelector("span.absolute"));
        check("C5", T, `Settings tabs by mouse: the last tab ("${lastLabel}") scrolls into view, takes a click and opens`, mh.inView && mh.onTop && on, { mh, on });
        // Keyboard: from the first tab, Tab along to the last; it must be on screen when focused.
        await tabs.first().focus();
        const count = await tabs.count();
        // From the start of the rail, as a keyboard user arriving on the page would be.
        await page.locator(".staff-settings-rail").evaluate((el) => { el.scrollLeft = 0; });
        await tabs.first().focus();
        for (let i = 1; i < count; i++) await page.keyboard.press("Tab");
        await page.waitForTimeout(700); // the rail scrolls to the focused tab smoothly
        const focusedLast = await last.evaluate((el) => document.activeElement === el);
        const kh = await hit(last);
        check("C5", T, `Settings tabs by keyboard: Tab reaches the last tab (${count} tabs) and it is on screen when focused`, focusedLast && kh.inView, { focusedLast, kh });
      } catch (e) { check("C5", T, "Settings tabs case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-c5-error-tabs-${T}`); }

      // Member profile "More actions" (the app's row-actions-style menu; tables have no per-row menus).
      try {
        if (!memberRow) throw new Error("the fixture has no Member 1");
        await page.goto(`/dashboard/members/${memberRow.id}`);
        await page.waitForLoadState("networkidle");
        const trigger = page.getByRole("button", { name: "More actions", exact: true });
        await trigger.waitFor({ timeout: 60000 });
        await trigger.evaluate(CENTRE);
        await trigger.click();
        const menu = trigger.locator("xpath=following-sibling::div[1]");
        await menu.waitFor({ timeout: 10000 });
        const items = menu.locator("a, button");
        const lastItem = items.last();
        const lastName = (await lastItem.textContent())?.trim();
        await lastItem.evaluate(CENTRE);
        const mh = await hit(lastItem);
        check("C5", T, `member "More actions" by mouse: its last item ("${lastName}") is fully on screen and takes a click`, mh.inView && mh.onTop, mh);
        await shot(page, `overlay-c5-actions-${T}`);
        await page.keyboard.press("Escape");
        const closedByEsc = await menu.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);
        const afterEsc = await active(page);
        check("C5", T, 'member "More actions": Escape closes the menu and focus goes back to "More actions"', closedByEsc && afterEsc.label === "More actions", { closedByEsc, afterEsc });
        if (!closedByEsc) { await trigger.click(); await menu.waitFor({ state: "detached", timeout: 3000 }).catch(() => {}); }
        // Keyboard only.
        await trigger.focus();
        await page.keyboard.press("Enter");
        await menu.waitFor({ timeout: 10000 });
        const n = await items.count();
        let reached = false;
        for (let i = 0; i < n + 2 && !reached; i++) {
          await page.keyboard.press("Tab");
          reached = await lastItem.evaluate((el) => document.activeElement === el).catch(() => false);
        }
        const kh = reached ? await hit(lastItem) : null;
        check("C5", T, 'member "More actions" by keyboard: Tab reaches its last item, which is on screen', reached && kh?.inView, { reached, kh, n });
        await page.keyboard.press("Escape");
        const kbClosed = await menu.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);
        const kbBack = await active(page);
        check("C5", T, 'member "More actions" by keyboard: Escape from inside the menu closes it and focus goes back to "More actions"', kbClosed && kbBack.label === "More actions", { kbClosed, kbBack });
        if (!kbClosed) await trigger.click().catch(() => {});
      } catch (e) { check("C5", T, "member More actions case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-c5-error-actions-${T}`); }
      if (!zoom) na("C5", `${T}:row-actions`, "no table in the staff app has a per-row actions menu (DataTable rows are links)");
    }

    // ── A3: the whole sequence, end to end, with a save ──
    if (!zoom && runs("A3")) {
      try {
        await page.goto("/dashboard/timetable");
        await page.waitForLoadState("networkidle");
        const chip = page.locator(`button[aria-label^="Edit Ov Save ${T}, "]:visible`).first();
        await chip.waitFor({ timeout: 90000 });
        await chip.evaluate(CENTRE);
        await press(v, chip);
        const sheet = editSheet();
        await sheet.waitFor({ timeout: 30000 });
        await page.waitForTimeout(400);
        const newName = `Ov Saved ${T}`;
        await sheet.getByLabel("Class Name", { exact: true }).fill(newName);
        const cat = sheet.locator('select[aria-label="Category"]');
        const catLast = await cat.evaluate((s) => s.options[s.options.length - 1].value);
        await cat.evaluate(CENTRE); await press(v, cat); await cat.selectOption(catLast);
        const coach = sheet.locator('select[aria-label="Coach"]');
        const coachLast = await coach.evaluate((s) => s.options[s.options.length - 1].value);
        await coach.evaluate(CENTRE); await press(v, coach); await coach.selectOption(coachLast);
        const save = sheet.getByRole("button", { name: "Save changes", exact: true });
        await save.evaluate(CENTRE);
        await press(v, save);
        const closed = await sheet.waitFor({ state: "detached", timeout: 60000 }).then(() => true, () => false);
        const row = (await q(`select name, "categoryId", "coachUserId" from "Class" where "tenantId" = $1 and name = $2`, [tenantId, newName]))[0];
        const savedChip = page.locator(`button[aria-label^="Edit ${newName}, "]:visible`).first();
        const shownNow = await savedChip.waitFor({ timeout: 30000 }).then(() => true, () => false);
        await page.waitForTimeout(300);
        const h = shownNow ? await hit(savedChip) : null;
        let reopened = false;
        if (h?.onTop) {
          await press(v, savedChip);
          reopened = await editSheet().waitFor({ timeout: 15000 }).then(() => true, () => false);
          if (reopened) { await page.keyboard.press("Escape"); await editSheet().waitFor({ state: "detached", timeout: 10000 }).catch(() => {}); }
        }
        check("A3", T, "open a class, rename it, choose the last Category and Coach, save: the sheet closes, the row is saved, and the timetable takes the next tap",
          closed && !!row && row.categoryId === catLast.replace(/^id:/, "") && row.coachUserId === coachLast && shownNow && h?.onTop && reopened, { closed, row, catLast, coachLast, shownNow, h, reopened });
        await shot(page, `overlay-a3-after-${T}`);
      } catch (e) { check("A3", T, "case ran to the end", false, String(e).slice(0, 300)); await shot(page, `overlay-a3-error-${T}`); }
    }
    await ctx.close();
  }
} finally {
  await browser?.close().catch(() => {});
  await cleanup();
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  fs.writeFileSync(`${OUT}/overlay-audit-matrix.json`, JSON.stringify(matrix, null, 2));
  console.log("\nMATRIX");
  for (const [c, cells] of Object.entries(matrix)) console.log(`${c}: ${Object.entries(cells).map(([t, r]) => `${t}=${r.result}`).join("  ")}`);
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
