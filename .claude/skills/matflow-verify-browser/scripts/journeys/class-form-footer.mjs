// Journey: the class form's Cancel and Create/Save are pinned in the sheet's footer (audit F2, 24 Nov 2026).
// On a phone (390 x 844 and 375 x 667, touch), signed in as the owner, Timetable -> Add class:
//   K1 before anything is typed: Create class is fully on screen without scrolling the form, disabled, with the
//      reason ("Fill in: …") beside it;
//   K2 with the viewport cut by the on-screen keyboard's height (336 / 290 px) and the last field focused: Create class
//      and Cancel are still fully on screen, and the footer does not cover the focused field;
//   K3 a failed save (server error): the refusal is shown beside the buttons, on screen; the typed name is kept; one
//      request was sent;
//   K4 the retry, pressed twice in quick succession while it saves: exactly one request; the sheet closes; the class
//      exists.
// --browser=webkit runs it in Playwright's WebKit (not real iPhone Safari). Synthetic club; removes what it creates.
//   node journeys/class-form-footer.mjs [--browser=webkit]
import { createRequire } from "node:module";
import { chromium, state, q, ledger, shot, context, ownerSignIn, APP } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId;
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const BROWSER = arg("browser") ?? "chromium";
const engine = BROWSER === "webkit" ? createRequire(`${APP}/package.json`)("@playwright/test").webkit : chromium;
const L = ledger(`class-form-footer${BROWSER === "webkit" ? "-webkit" : ""}`);
const errors = [];
const B = BROWSER === "webkit" ? "wk" : "cr";

const inView = (loc) => loc.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { inView: r.width > 0 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && r.left >= -0.5 && r.right <= innerWidth + 0.5, onTop: !!top && (top === el || el.contains(top)), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], vh: innerHeight };
});

let browser;
const made = [];
try {
  browser = await engine.launch();
  const sc = await context(browser, "10.95.3.1", { timezoneId: "Europe/London" });
  const sp = await sc.newPage();
  await ownerSignIn(sp, club);
  const owner = await sc.storageState();
  await sc.close();

  for (const [vp, kb] of [[{ width: 390, height: 844 }, 336], [{ width: 375, height: 667 }, 290]]) {
    const T = `${B}@${vp.width}`;
    const ctx = await context(browser, `10.95.3.${vp.width === 390 ? 2 : 3}`, { viewport: vp, isMobile: true, hasTouch: true, storageState: owner, timezoneId: "Europe/London" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${T}: ${String(e).slice(0, 200)}`));
    try {
      await page.goto("/dashboard/timetable");
      await page.waitForLoadState("networkidle");
      await page.getByRole("button", { name: "Add class", exact: true }).filter({ visible: true }).first().tap();
      const sheet = page.getByRole("dialog", { name: "New class" });
      await sheet.waitFor({ timeout: 30000 });
      await page.waitForTimeout(450);
      const create = sheet.getByRole("button", { name: "Create class", exact: true });
      const cancel = sheet.getByRole("button", { name: "Cancel", exact: true });

      // K1
      const c1 = await inView(create);
      const disabled = await create.isDisabled();
      const reason = sheet.getByText(/^Fill in: /);
      const r1 = (await reason.count()) ? await inView(reason.first()) : null;
      L.check(`K1@${T}`, "before typing: Create class is on screen without scrolling the form, disabled, with its reason beside it on screen", c1.inView && disabled && !!r1?.inView, { c1, disabled, r1 });
      await shot(page, `f2-K1-${T}`);

      // Fill what is required: a name and one day.
      const name = `Footer Class ${T} ${Date.now() % 100000}`;
      await sheet.getByLabel("Class Name", { exact: true }).fill(name);
      await sheet.getByRole("button", { name: /Add day/ }).first().tap();
      await page.waitForTimeout(200);

      // K2: keyboard height off the viewport, last field focused.
      await page.setViewportSize({ width: vp.width, height: vp.height - kb });
      const last = sheet.locator("input:not([type=hidden]):not([type=checkbox]), textarea, select").last();
      await last.focus();
      await last.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      await page.waitForTimeout(250);
      const field = await inView(last);
      const footerTop = await sheet.getByTestId("class-form-footer").evaluate((el) => Math.round(el.getBoundingClientRect().top)).catch(() => null);
      const c2 = await inView(create), x2 = await inView(cancel);
      const fieldBottom = field.rect[1] + field.rect[3];
      L.check(`K2@${T}`, `keyboard approximated (viewport ${vp.height - kb} px), last field focused: Create class and Cancel are on screen and take a tap, and the footer does not cover the field`,
        c2.inView && c2.onTop && x2.inView && x2.onTop && field.inView && (footerTop === null || fieldBottom <= footerTop + 1), { c2, x2, field, footerTop });
      await shot(page, `f2-K2-${T}`);
      await page.setViewportSize(vp);

      // K3: a failed save.
      let posts = 0;
      page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/classes") posts++; });
      await page.route("**/api/classes", (r) => (r.request().method() === "POST" ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Something went wrong" }) }) : r.continue()));
      await create.tap();
      const err = sheet.getByTestId("class-form-save-error");
      const shown = await err.waitFor({ timeout: 30000 }).then(() => true, () => false);
      const e3 = shown ? await inView(err) : null;
      const kept = await sheet.getByLabel("Class Name", { exact: true }).inputValue();
      L.check(`K3@${T}`, "a failed save: the refusal shows on screen beside the buttons, the name is kept, one request was sent, nothing saved",
        shown && e3.inView && kept === name && posts === 1 && (await sheet.isVisible()), { shown, e3, kept: kept === name, posts });
      await shot(page, `f2-K3-${T}`);
      await page.unroute("**/api/classes");

      // K4: the retry, pressed twice while it saves.
      posts = 0;
      await page.route("**/api/classes", async (r) => { if (r.request().method() === "POST") await new Promise((res) => setTimeout(res, 1500)); await r.continue(); });
      await create.tap();
      await create.tap({ force: true, timeout: 2000 }).catch(() => {});
      const closed = await sheet.waitFor({ state: "detached", timeout: 60000 }).then(() => true, () => false);
      await page.unroute("**/api/classes");
      const rows = await q(`select id from "Class" where "tenantId" = $1 and name = $2`, [tenantId, name]);
      made.push(...rows.map((r) => r.id));
      L.check(`K4@${T}`, "the retry, pressed twice while saving: exactly one request, the sheet closes, the class exists once", posts === 1 && closed && rows.length === 1, { posts, closed, rows: rows.length });
    } catch (e) {
      L.check(`run@${T}`, "ran to the end", false, String(e).slice(0, 300));
      await shot(page, `f2-error-${T}`);
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser?.close().catch(() => {});
  for (const id of made) {
    for (const t of ["ClassSchedule", "ClassInstance"]) await q(`delete from "${t}" where "classId" = $1`, [id]).catch(() => {});
    await q(`delete from "Class" where id = $1 and "tenantId" = $2`, [id, tenantId]).catch(() => {});
  }
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
