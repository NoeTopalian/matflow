// Journey: the next-auth session context lives only where it is read (Round 8, 15 Nov 2026).
//   node run-journeys.mjs session-provider-scope            (R8_EXPECT=before records counts without asserting them)
// Counts GET /api/auth/session per step and checks behaviour on the synthetic club:
//   S1 dashboard load and client navigation (desktop) — no session request;
//   S2 Settings → Import (desktop and phone): the owner-only import panel renders, with no session request on mount;
//   S3 tab focus: on the import tab ONE re-read; on a page with no session reader none;
//   S4 cross-tab: signing out in another tab of the same browser makes the import panel re-read and disappear, and
//      the signed-out tab lands on /login;
//   S5 sign-out on the phone (More → Sign out) lands on /login and the dashboard then sends the browser to /login;
//   S6 a member's own authenticator setup (/login/totp/setup, the other session reader) renders with no session
//      request on mount, desktop and phone;
//   S7 revocation (the owner's sessionVersion bumped, as "sign out everywhere" does): on the next focus the import
//      panel re-reads and disappears, and the next navigation is sent to /login.
// Owner sign-in through the real form runs first (signIn/getSession without any provider).
import { createRequire } from "node:module";
import { state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn, chromium, BASE } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { devices } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const tenantId = club.tenantId ?? (await q(`select id from "Tenant" where slug = $1`, [club.slug]))[0].id;
const EXPECT = process.env.R8_EXPECT === "before" ? "before" : "after";
const L = ledger("session-provider-scope");
const LANE = "10.88.8.3";
const errors = [];
const sessionReads = (page) => {
  const c = { n: 0 };
  page.on("request", (r) => { if (new URL(r.url()).pathname === "/api/auth/session") c.n++; });
  return c;
};
const settle = (page, ms = 2500) => page.waitForTimeout(ms);
const watch = (page) => page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
const importPanel = (page) => page.getByRole("group", { name: "What are you importing?" });
const counts = {};
const record = (id, n, expected) => {
  counts[id] = n;
  if (EXPECT === "after" && expected !== undefined) return L.check("journey", `${id}: ${expected} session request(s)`, n === expected, { n, expected });
  return L.note("journey", `${id}: session requests`, { n });
};

const browser = await chromium.launch();
try {
  // ── Sign in through the real form ──
  const s0 = await context(browser, LANE);
  const p0 = await s0.newPage(); watch(p0);
  await ownerSignIn(p0, club);
  L.check("journey", "S0 owner sign-in through /login reaches the dashboard", /\/dashboard/.test(p0.url()), { url: p0.url() });
  const storage = await s0.storageState();
  await s0.close();

  // ── S1 desktop: dashboard load + client navigation ──
  {
    const ctx = await context(browser, LANE, { storageState: storage });
    const page = await ctx.newPage(); watch(page);
    const c = sessionReads(page);
    await page.goto("/dashboard/timetable");
    await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
    await settle(page);
    record("S1a timetable load (desktop)", c.n, 0);
    c.n = 0;
    await page.locator("aside").getByRole("link", { name: "Members", exact: true }).click();
    await page.waitForURL(/\/dashboard\/members/);
    await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
    await settle(page);
    record("S1b client navigation timetable → members", c.n, 0);
    c.n = 0;
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
    await settle(page);
    record("S3b tab focus on a page with no session reader", c.n, 0);
    await ctx.close();
  }

  // ── S2/S3/S4 desktop: import tab, focus, cross-tab sign-out ──
  {
    const ctx = await context(browser, LANE, { storageState: storage });
    const a = await ctx.newPage(); watch(a);
    const c = sessionReads(a);
    await a.goto("/dashboard/settings?tab=import");
    await importPanel(a).waitFor({ timeout: 90_000 });
    await settle(a);
    L.check("journey", "S2a the owner sees the import panel (desktop)", await importPanel(a).isVisible(), {});
    record("S2a Settings → Import load (desktop)", c.n, 0);
    c.n = 0;
    await a.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle(a);
    record("S3a tab focus on the import tab", c.n, 1);
    L.check("journey", "S3a the import panel is still shown after the focus re-read", await importPanel(a).isVisible(), {});
    // Cross-tab: sign out in a second tab of the same browser.
    c.n = 0;
    const b = await ctx.newPage(); watch(b);
    await b.goto("/dashboard/timetable");
    await b.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
    await b.getByRole("button", { name: "Open account menu" }).click();
    await b.getByRole("menuitem", { name: "Sign out", exact: true }).click();
    await b.waitForURL(/\/login/, { timeout: 60_000 });
    L.check("journey", "S4a desktop sign-out (account menu) lands on /login", /\/login/.test(b.url()), { url: b.url() });
    const hidden = await importPanel(a).waitFor({ state: "hidden", timeout: 30_000 }).then(() => true, () => false);
    if (!hidden) await shot(a, "session-scope-cross-tab-still-shown");
    L.check("journey", "S4b the other tab's import panel re-reads the session and disappears after the sign-out", hidden && c.n >= 1, { reads: c.n, hidden });
    await b.goto("/dashboard/timetable");
    L.check("journey", "S4c after sign-out the dashboard sends the browser to /login", /\/login/.test(b.url()), { url: b.url() });
    await ctx.close();
  }

  // ── S2 phone: import tab; S5 phone sign-out ──
  {
    const ctx = await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": LANE }, serviceWorkers: "block", storageState: storage });
    ctx.setDefaultTimeout(60_000);
    const page = await ctx.newPage(); watch(page);
    const c = sessionReads(page);
    await page.goto("/dashboard/settings?tab=import");
    await importPanel(page).waitFor({ timeout: 90_000 });
    await settle(page);
    L.check("journey", "S2b the owner sees the import panel (phone)", await importPanel(page).isVisible(), {});
    record("S2b Settings → Import load (phone)", c.n, 0);
    await page.getByRole("button", { name: "More options" }).tap();
    await page.getByRole("button", { name: "Sign out" }).tap();
    await page.waitForURL(/\/login/, { timeout: 60_000 });
    L.check("journey", "S5a phone sign-out (More → Sign out) lands on /login", /\/login/.test(page.url()), { url: page.url() });
    await page.goto("/dashboard");
    L.check("journey", "S5b after phone sign-out the dashboard sends the browser to /login", /\/login/.test(page.url()), { url: page.url() });
    await ctx.close();
  }

  // ── S6 member's authenticator setup (the other session reader), desktop and phone ──
  {
    const member = await memberLogin(club, "Member 1");
    for (const device of ["desktop", "phone"]) {
      const ctx = device === "desktop" ? await context(browser, LANE)
        : await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": LANE }, serviceWorkers: "block" });
      ctx.setDefaultTimeout(60_000);
      const page = await ctx.newPage(); watch(page);
      await memberSignIn(page, club, member);
      const c = sessionReads(page);
      await page.goto("/login/totp/setup");
      const heading = page.getByRole("heading", { level: 1 }).first();
      const shown = await heading.waitFor({ timeout: 60_000 }).then(() => true, () => false);
      await settle(page);
      L.check("journey", `S6 the member's authenticator setup renders (${device})`, shown && /\/login\/totp\/setup/.test(page.url()), { url: page.url(), heading: shown ? await heading.innerText() : null });
      record(`S6 member authenticator setup load (${device})`, c.n, 0);
      await ctx.close();
    }
  }

  // ── S7 revocation ──
  {
    const ctx = await context(browser, LANE, { storageState: storage });
    const page = await ctx.newPage(); watch(page);
    const c = sessionReads(page);
    await page.goto("/dashboard/settings?tab=import");
    await importPanel(page).waitFor({ timeout: 90_000 });
    await settle(page);
    const owner = (await q(`select id from "User" where "tenantId" = $1 and email = $2`, [tenantId, club.owner.email]))[0];
    await q(`update "User" set "sessionVersion" = "sessionVersion" + 1 where id = $1 and "tenantId" = $2`, [owner.id, tenantId]);
    c.n = 0;
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const hidden = await importPanel(page).waitFor({ state: "hidden", timeout: 30_000 }).then(() => true, () => false);
    L.check("journey", "S7a after revocation the next focus re-reads the session and the import panel disappears", hidden && c.n >= 1, { reads: c.n, hidden });
    await page.goto("/dashboard/timetable");
    L.check("journey", "S7b after revocation the next navigation is sent to /login", /\/login/.test(page.url()), { url: page.url() });
    await ctx.close();
  }
} catch (e) {
  L.check("journey", "journey ran to the end", false, String(e.message ?? e).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await browser.close();
}
L.check("journey", "no uncaught page errors", errors.length === 0, { errors });
L.note("journey", `session request counts (${EXPECT})`, counts);
console.log(L.summary());
if (L.rows.some((r) => r.result === "FAIL")) process.exitCode = 1;
