// Journey: the timetable header has no "Generate 4 weeks" button, and Add class still opens the editor (24 Nov 2026).
// Owner at 1280 x 800 (desktop) and 390 x 844 (phone, touch): no control named "Generate…" anywhere on the timetable;
// "Add class" is visible, takes the tap or click, and opens the "New class" sheet; closing it leaves the timetable.
// The endpoint is not touched here. Synthetic club only.
//   node journeys/timetable-no-generate.mjs
import { chromium, state, ledger, shot, context, ownerSignIn } from "../lib.mjs";

const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("timetable-no-generate");
const errors = [];

const browser = await chromium.launch();
try {
  const sc = await context(browser, "10.91.1.1", { timezoneId: "Europe/London" });
  const sp = await sc.newPage();
  await ownerSignIn(sp, club);
  const owner = await sc.storageState();
  await sc.close();
  for (const [tag, opts] of [["1280", { viewport: { width: 1280, height: 800 } }], ["390", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }]]) {
    const ctx = await context(browser, `10.91.1.${tag === "1280" ? 2 : 3}`, { ...opts, storageState: owner, timezoneId: "Europe/London" });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(`${tag}: ${String(e).slice(0, 200)}`));
    try {
      await page.goto("/dashboard/timetable");
      await page.waitForLoadState("networkidle");
      const add = page.getByRole("button", { name: "Add class", exact: true }).filter({ visible: true }).first();
      await add.waitFor({ timeout: 60000 });
      const generate = await page.getByRole("button", { name: /^Generate/ }).count();
      const generateText = await page.getByText(/Generate 4 weeks/).count();
      L.check(`G1@${tag}`, 'the timetable has no "Generate 4 weeks" button (or text)', generate === 0 && generateText === 0, { generate, generateText });
      await (tag === "390" ? add.tap() : add.click());
      const sheet = page.getByRole("dialog", { name: "New class" });
      const opened = await sheet.waitFor({ timeout: 30000 }).then(() => true, () => false);
      const nameField = opened ? await sheet.getByLabel("Class Name", { exact: true }).isVisible() : false;
      L.check(`G2@${tag}`, "Add class opens the New class editor with its name field", opened && nameField, { opened, nameField });
      await shot(page, `no-generate-${tag}`);
      if (opened) {
        await page.keyboard.press("Escape");
        const closed = await sheet.waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
        L.check(`G2@${tag}`, "the untouched editor closes with Escape, back to the timetable", closed, { closed });
      }
    } catch (e) {
      L.check(`run@${tag}`, "ran to the end", false, String(e).slice(0, 300));
    } finally {
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  L.check("all", "no uncaught page errors", errors.length === 0, errors);
  console.log(`\n${L.summary()}  ledger ${L.path}`);
}
