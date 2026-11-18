// Journey: Round 11 keyboard and focus on the two sheets (PR #97, 16 Nov 2026).
// Member class sheet (desktop): a labelled modal dialog; focus moves in, Tab stays inside, Escape closes and focus
// returns to the class. A class opened from "+N more" keeps the panel open and focus returns to its row, by keyboard
// and by mouse (review of #97, M1). Member phone: the sheet locks and releases page scroll.
// Staff phone More sheet: while closed it is inert and hidden (Tab never enters it); open, it is a dialog that takes
// and keeps focus, slides in and out, locks scroll, and Escape returns focus to More.
// Needs `fixture.mjs create` and `server.mjs start`. Cleans up its own seeded rows.
//   node journeys/round11-overlay-focus.mjs
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, memberLogin, memberSignIn, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("round11-overlay-focus");
const tenantId = club.tenantId;
const errors = [];

const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
const today = new Date(`${p.year}-${p.month}-${p.day}T00:00:00.000Z`);
const hourNow = Number(p.hour);
const hh = (h) => `${String(h).padStart(2, "0")}:00`;
const FOLD_H = Math.min(21, Math.max(hourNow + 1, 10)); // not before 10:00 (sticky day header, member-booking-notice)
const SOLO_H = FOLD_H >= 14 ? FOLD_H - 3 : FOLD_H + 3;
const dayOfWeek = today.getUTCDay();

const member = await memberLogin(club);
const classes = [...[1, 2, 3, 4, 5].map((n) => ({ id: randomUUID(), name: `Fold ${n}`, h: FOLD_H })), { id: randomUUID(), name: "Solo Gi", h: SOLO_H }];

const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a?.tagName ?? null, label: a?.getAttribute("aria-label") ?? a?.textContent?.trim().slice(0, 40) ?? null, inDialog: !!a?.closest('[role="dialog"]'), inPanel: !!a?.closest('[data-testid="more-panel"]') };
});

try {
  for (const c of classes) {
    await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 30)`, [c.id, tenantId, c.name]);
    await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [randomUUID(), c.id, dayOfWeek, hh(c.h), hh(c.h + 1)]);
    await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [randomUUID(), c.id, today, hh(c.h), hh(c.h + 1)]);
  }

  const browser = await chromium.launch();
  try {
    // ── Member, desktop ──
    const ctx = await context(browser, "10.97.0.1");
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await memberSignIn(page, club, member);
    await page.goto("/member/schedule");
    const solo = page.getByRole("button", { name: /^Solo Gi, / }).first();
    await solo.waitFor({ timeout: 90000 });
    await solo.evaluate((el) => el.scrollIntoView({ block: "center" }));

    await solo.focus();
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Solo Gi" });
    const opened = await dialog.waitFor({ timeout: 15000 }).then(() => true, () => false);
    const modal = opened ? await dialog.getAttribute("aria-modal") : null;
    const first = await active(page);
    L.check("member", "K1 Enter on a class opens a modal dialog named by the class, with focus inside it", opened && modal === "true" && first.inDialog, { opened, modal, first });
    let escaped = 0;
    for (let i = 0; i < 15; i++) { await page.keyboard.press("Tab"); if (!(await active(page)).inDialog) escaped++; }
    await page.keyboard.press("Shift+Tab");
    if (!(await active(page)).inDialog) escaped++;
    L.check("member", "K2 Tab and Shift+Tab stay inside the class sheet (16 presses)", escaped === 0, { escaped });
    const closeName = await dialog.getByRole("button", { name: "Close class details", exact: true }).count();
    L.check("member", "K3 the sheet's icon-only close button is named 'Close class details'", closeName === 1, { closeName });
    await shot(page, "r11-member-sheet-open");
    await page.keyboard.press("Escape");
    const gone = await dialog.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
    const back = await active(page);
    L.check("member", "K4 Escape closes the sheet and focus returns to the class that opened it", gone && /^Solo Gi, /.test(back.label ?? ""), { gone, back });

    // "+N more": keyboard
    const more = page.getByTestId("schedule-more").first();
    const hasMore = await more.waitFor({ timeout: 15000 }).then(() => true, () => false);
    L.check("member", "K5 five classes at one time fold into '+N more'", hasMore, { hasMore });
    if (hasMore) {
      await more.evaluate((el) => el.scrollIntoView({ block: "center" }));
      await more.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByTestId("more-panel");
      await panel.waitFor({ timeout: 10000 });
      let row = await active(page);
      if (!row.inPanel) { await panel.getByRole("button", { name: /^Fold \d, / }).first().focus(); row = await active(page); }
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog", { name: /^Fold \d$/ });
      const sheetOpen = await sheet.waitFor({ timeout: 15000 }).then(() => true, () => false);
      const panelKept = await panel.isVisible();
      const inside = await active(page);
      L.check("member", "K6 Enter on a '+N more' row opens its sheet, focus moves in, and the panel stays open behind it", sheetOpen && panelKept && inside.inDialog, { sheetOpen, panelKept, inside });
      await page.keyboard.press("Escape");
      await sheet.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
      const after = await active(page);
      L.check("member", "K7 Escape returns focus to the same row, still inside the open panel (not to the page body)", after.inPanel && after.label === row.label, { row: row.label, after });

      // mouse
      const target = panel.getByRole("button", { name: /^Fold \d, / }).nth(1);
      await target.click();
      const sheet2 = page.getByRole("dialog", { name: /^Fold \d$/ });
      await sheet2.waitFor({ timeout: 15000 });
      await sheet2.getByRole("button", { name: "Close class details", exact: true }).click();
      await sheet2.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
      const panelAfterMouse = await panel.isVisible();
      L.check("member", "P1 by mouse: a row's sheet, closed with its Close button, leaves the '+N more' panel open", panelAfterMouse, { panelAfterMouse });
      await shot(page, "r11-member-more-panel-kept");
      await page.keyboard.press("Escape");
    }

    // ── Member, phone ──
    const mctx = await context(browser, "10.97.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
    const mp = await mctx.newPage();
    mp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await mp.goto("/member/schedule");
    const msolo = mp.getByRole("button", { name: /^Solo Gi, / }).first();
    await msolo.waitFor({ timeout: 90000 });
    await msolo.evaluate((el) => el.scrollIntoView({ block: "center" }));
    const ov0 = await mp.evaluate(() => document.body.style.overflow);
    await msolo.tap();
    const mdialog = mp.getByRole("dialog", { name: "Solo Gi" });
    await mdialog.waitFor({ timeout: 15000 });
    const ovOpen = await mp.evaluate(() => document.body.style.overflow);
    await shot(mp, "r11-member-sheet-phone");
    await mdialog.getByRole("button", { name: "Close class details", exact: true }).tap();
    await mdialog.waitFor({ state: "detached", timeout: 10000 }).catch(() => {});
    const ovClosed = await mp.evaluate(() => document.body.style.overflow);
    const mw = await mp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", "M1 member phone: the sheet locks page scroll while open and releases it on Close; no sideways scroll", ovOpen === "hidden" && ovClosed === ov0 && mw.scroll <= mw.width + 1, { ov0, ovOpen, ovClosed, ...mw });
    L.note("mobile", "N1 swipe-down to dismiss is not exercised here (no touch-drag in this harness); unit tests cover the handler", {});

    // ── Staff (owner), phone ──
    const sctx = await context(browser, "10.97.0.3", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const sp = await sctx.newPage();
    sp.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await ownerSignIn(sp, club);
    await sp.goto("/dashboard");
    await sp.waitForLoadState("networkidle");
    const moreBtn = sp.getByRole("button", { name: "More options" });
    await moreBtn.waitFor({ timeout: 60000 });
    const sheetEl = sp.locator('div[role="dialog"]').filter({ has: sp.locator('[aria-label="Sign out all devices"]') });
    const closedAttrs = await sheetEl.evaluate((el) => ({ inert: el.hasAttribute("inert"), hidden: el.getAttribute("aria-hidden") }));
    L.check("staff", "S1 the closed More sheet is inert and aria-hidden", closedAttrs.inert && closedAttrs.hidden === "true", closedAttrs);

    await sp.evaluate(() => (document.activeElement)?.blur?.());
    let entered = 0, reachedAt = null;
    for (let i = 1; i <= 80 && reachedAt === null; i++) {
      await sp.keyboard.press("Tab");
      const a = await sp.evaluate(() => ({ inSheet: !!document.activeElement?.closest('div[role="dialog"]'), label: document.activeElement?.getAttribute("aria-label") }));
      if (a.inSheet) entered++;
      if (a.label === "More options") reachedAt = i;
    }
    L.check("staff", "S2 Tab from the top of the page reaches More without ever entering the closed sheet", entered === 0 && reachedAt !== null, { entered, reachedAt });

    const ovS0 = await sp.evaluate(() => document.body.style.overflow);
    await moreBtn.focus();
    await sp.keyboard.press("Enter");
    await sp.waitForTimeout(450); // 300 ms slide
    const openAttrs = await sheetEl.evaluate((el) => { const r = el.getBoundingClientRect(); return { inert: el.hasAttribute("inert"), hidden: el.getAttribute("aria-hidden"), top: Math.round(r.top), bottom: Math.round(r.bottom), vh: window.innerHeight }; });
    const sIn = await sp.evaluate(() => !!document.activeElement?.closest('div[role="dialog"]'));
    const ovSOpen = await sp.evaluate(() => document.body.style.overflow);
    L.check("staff", "S3 Enter on More opens the sheet: not inert, on screen, focus inside, page scroll locked", !openAttrs.inert && openAttrs.hidden === null && openAttrs.top < openAttrs.vh && Math.abs(openAttrs.bottom - openAttrs.vh) <= 2 && sIn && ovSOpen === "hidden", { ...openAttrs, sIn, ovSOpen });
    let out = 0;
    for (let i = 0; i < 40; i++) { await sp.keyboard.press("Tab"); if (!(await sp.evaluate(() => !!document.activeElement?.closest('div[role="dialog"]')))) out++; }
    L.check("staff", "S4 Tab stays inside the open More sheet (40 presses)", out === 0, { out });
    await shot(sp, "r11-staff-more-open");
    await sp.keyboard.press("Escape");
    await sp.waitForTimeout(450);
    const shut = await sheetEl.evaluate((el) => { const r = el.getBoundingClientRect(); return { inert: el.hasAttribute("inert"), hidden: el.getAttribute("aria-hidden"), top: Math.round(r.top), vh: window.innerHeight }; });
    const focusBack = await sp.evaluate(() => document.activeElement?.getAttribute("aria-label"));
    const ovSClosed = await sp.evaluate(() => document.body.style.overflow);
    L.check("staff", "S5 Escape closes it: slides off screen, inert again, focus back on More, scroll released", shut.inert && shut.hidden === "true" && shut.top >= shut.vh - 1 && focusBack === "More options" && ovSClosed === ovS0, { ...shut, focusBack, ovS0, ovSClosed });

    await moreBtn.tap();
    await sp.waitForTimeout(450);
    await sp.getByRole("button", { name: "Close menu" }).tap();
    await sp.waitForTimeout(450);
    const tapShut = await sheetEl.evaluate((el) => el.hasAttribute("inert"));
    const sw = await sp.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("staff", "S6 by touch: More opens, Close menu closes; no sideways scroll", tapShut && sw.scroll <= sw.width + 1, { tapShut, ...sw });

    L.check("journey", "J1 no uncaught page errors", errors.length === 0, errors);
  } finally {
    await browser.close();
  }
} finally {
  const ids = classes.map((c) => c.id);
  await q(`delete from "ClassInstance" where "classId" = any($1)`, [ids]);
  await q(`delete from "ClassSchedule" where "classId" = any($1)`, [ids]);
  await q(`delete from "Class" where id = any($1) and "tenantId" = $2`, [ids, tenantId]);
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
