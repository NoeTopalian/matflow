// Round 8 experiment v2: navigation-link prefetch modes, measured per first navigation after a full page load.
//   R8_PROBE_PORT=<port> R8_APP=<worktree> NODE_OPTIONS=--require=<r8-dbprobe.cjs v2> R8_MODES=auto,off,intent,one
//   node run-journeys.mjs r8-nav
// Needs a build of exp/r8-nav-prefetch: the `r8nav` cookie picks the mode per browser context —
//   auto (today), off (no automatic prefetch), intent (prefetch on hover / focus / touch / pointer down),
//   one (automatic prefetch on the Home link only — present in both the desktop sidebar and the phone bar).
// Every navigation below starts from a fresh full page load (fresh browser context), so each is a FIRST navigation;
// one extra scenario measures a SUBSEQUENT navigation. For every navigation it records, from the click/Enter/tap:
//   shellMs   — the loading skeleton or the destination content is on screen (first visible feedback),
//   contentMs — the destination's own content marker is visible at the destination URL,
//   usableMs  — that marker passes Playwright's actionability check (trial click: visible, stable, receives events)
//               and the skeleton is gone,
// plus a per-request timeline (start/end relative to the click, prefetch / segment headers) and the server's own
// per-request query counts split into foreground and background (prefetch). Modes interleave in rotated order.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { chromium, state, q, ledger, context, ownerSignIn, OUT, BASE } from "../lib.mjs";
import { seedR8 } from "./data/r8-seed.mjs";

const require = createRequire(import.meta.url);
const { devices } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const PROBE = Number(process.env.R8_PROBE_PORT || 0);
if (!PROBE) throw new Error("R8_PROBE_PORT not set");
const ROUNDS = Number(process.env.R8_ROUNDS ?? 3);
const MODES = (process.env.R8_MODES ?? "auto,off,intent,one").split(",");
const L = ledger("r8-nav");
const LANE = "10.88.8.2";
const tenantId = club.tenantId ?? (await q(`select id from "Tenant" where slug = $1`, [club.slug]))[0].id;
const seed = await seedR8(q, club, tenantId);
L.note("seed", "fixture size", seed.size);

const get = async (p) => (await fetch(`http://127.0.0.1:${PROBE}${p}`)).json();
const resetServer = async () => { await get("/reqs?reset=1"); await get("/conns?reset=1"); await get("/snap?reset=1"); };
async function serverWindow() {
  const [reqs, conns, snap] = [await get("/reqs?reset=1"), await get("/conns?reset=1"), await get("/snap?reset=1")];
  const part = (rs) => ({ requests: rs.length, queries: rs.reduce((a, r) => a + r.q, 0), tx: rs.reduce((a, r) => a + r.tx, 0) });
  const fg = reqs.filter((r) => !r.prefetch), bg = reqs.filter((r) => r.prefetch);
  return {
    fg: part(fg), bg: part(bg), unattributedQueries: snap.unattributedQueries,
    fgPaths: fg.map((r) => `${r.method} ${r.path}${r.rsc ? " (rsc)" : ""} q=${r.q}`),
    bgPaths: bg.map((r) => `${r.path}${r.segment ? ` [seg ${r.segment}]` : ""} q=${r.q}`),
    connsCreated: conns.filter((c) => c.ev === "create").length,
    removes: conns.filter((c) => c.ev === "remove").map((c) => c.reason),
    rawConns: conns,
  };
}

async function instrument(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const m = { reqs: new Map(), inFlight: 0, lastChange: Date.now(), errors: [], t0: 0 };
  page.on("pageerror", (e) => m.errors.push(String(e.message).slice(0, 200)));
  cdp.on("Network.requestWillBeSent", (e) => {
    if (!m.reqs.has(e.requestId)) { m.inFlight++; m.lastChange = Date.now(); }
    const h = Object.fromEntries(Object.entries(e.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const u = new URL(e.request.url);
    m.reqs.set(e.requestId, { path: u.pathname, rsc: u.searchParams.has("_rsc") || h.rsc === "1", prefetch: !!h["next-router-prefetch"], segment: h["next-router-segment-prefetch"] ?? null,
      type: e.type, wallStart: Date.now(), wallEnd: null, bytes: 0, done: false });
  });
  const end = (e, ok) => { const r = m.reqs.get(e.requestId); if (!r || r.done) return; r.done = true; r.wallEnd = Date.now(); if (ok) r.bytes = e.encodedDataLength ?? 0; m.inFlight--; m.lastChange = Date.now(); };
  cdp.on("Network.loadingFinished", (e) => end(e, true));
  cdp.on("Network.loadingFailed", (e) => end(e, false));
  m.reset = () => { m.reqs.clear(); m.inFlight = 0; m.lastChange = Date.now(); };
  m.quiet = async (ms = 1500, max = 90_000) => { const s = Date.now(); while (Date.now() - s < max) { if (m.inFlight <= 0 && Date.now() - m.lastChange >= ms) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  m.client = () => { const all = [...m.reqs.values()]; const fg = all.filter((r) => !r.prefetch), bg = all.filter((r) => r.prefetch); const sum = (rs) => rs.reduce((a, r) => a + (r.bytes || 0), 0); return { requests: all.length, fgRequests: fg.length, bgRequests: bg.length, fgBytes: sum(fg), bgBytes: sum(bg) }; };
  m.timeline = (t0) => [...m.reqs.values()].filter((r) => r.rsc || r.type === "Fetch" || r.type === "XHR" || r.type === "Document")
    .map((r) => ({ path: r.path, kind: r.prefetch ? `prefetch${r.segment ? ":" + r.segment : ""}` : r.rsc ? "rsc-nav" : r.type, start: r.wallStart - t0, end: r.wallEnd === null ? null : r.wallEnd - t0, kB: Math.round(r.bytes / 1024) }))
    .sort((a, b) => a.start - b.start);
  return m;
}

const browser = await chromium.launch();
const s0 = await context(browser, LANE);
const p0 = await s0.newPage();
await ownerSignIn(p0, club);
const storage = await s0.storageState();
await s0.close();

const out = { seed, rounds: ROUNDS, modes: MODES, samples: [] };
const FILE = `${OUT}/r8-nav2-${Date.now()}.json`;
const keep = (x) => { out.samples.push(x); writeFileSync(FILE, JSON.stringify(out, null, 2)); };
const skeleton = (p) => p.locator("main .animate-pulse").first();
// Destination content markers (each appears only once the destination page's own content has rendered).
const DEST = {
  "/dashboard/timetable": (p) => p.getByTestId("week-grid").locator("[data-cell-key] button").first(),
  "/dashboard/settings": (p) => p.getByTestId("settings-active-note").filter({ visible: true }).first(),
  "/dashboard/account": (p) => p.locator("main").getByRole("heading", { name: "My account", level: 1 }),
  "/dashboard": (p) => p.locator("main").getByRole("heading", { name: "Today's Classes" }),
  "phone:/dashboard/timetable": (p) => p.getByTestId("phone-day-grid").filter({ visible: true }).first(),
  "phone:/dashboard": (p) => p.locator("main").getByRole("heading", { name: "Today's Classes" }),
};

async function load(sc, page, m, url, mark) {
  await resetServer(); m.reset();
  const t = Date.now();
  let usableMs = null, err = null;
  try { await page.goto(url, { waitUntil: "commit" }); await mark(page).waitFor({ state: "visible", timeout: 90_000 }); usableMs = Date.now() - t; } catch (e) { err = String(e.message).split("\n")[0]; }
  const quiet = await m.quiet(1500, 90_000);
  const sample = { kind: "load", ...sc, url, usableMs, quietMs: quiet ? Date.now() - t - 1500 : null, err, client: m.client(), server: await serverWindow() };
  keep(sample);
  console.log(`${sc.mode.padEnd(6)} r${sc.round} ${sc.device} load ${url} usable=${usableMs} quiet=${sample.quietMs} fg=${sample.server.fg.requests}req/${sample.server.fg.queries}q bg=${sample.server.bg.requests}req/${sample.server.bg.queries}q conns+${sample.server.connsCreated}${err ? " ERR " + err : ""}`);
}

async function navigate(sc, page, m, how, link, dest, markKey, dwell = 0) {
  const mark = DEST[markKey];
  await m.quiet(1500, 90_000);
  await resetServer(); m.reset();
  const tHover = Date.now();
  let t;
  if (how === "mouse") { await link.hover(); if (dwell) await page.waitForTimeout(dwell); t = Date.now(); await link.click(); }
  else if (how === "keyboard") { await link.focus(); if (dwell) await page.waitForTimeout(dwell); t = Date.now(); await page.keyboard.press("Enter"); }
  else { t = Date.now(); await link.tap(); }
  const r = { shellMs: null, contentMs: null, usableMs: null, err: null };
  try {
    const shell = Promise.race([skeleton(page).waitFor({ state: "visible", timeout: 90_000 }), mark(page).waitFor({ state: "visible", timeout: 90_000 })]).then(() => (r.shellMs = Date.now() - t));
    await page.waitForURL((u) => u.pathname === dest, { timeout: 90_000 });
    await mark(page).waitFor({ state: "visible", timeout: 90_000 }); r.contentMs = Date.now() - t;
    await skeleton(page).waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
    await mark(page).click({ trial: true, timeout: 30_000 }); r.usableMs = Date.now() - t;
    await Promise.allSettled([shell]);
  } catch (e) { r.err = String(e.message).split("\n")[0]; }
  await m.quiet(1500, 90_000);
  const sample = { kind: "nav", ...sc, how, dwell, dest, ...r, hoverToClickMs: t - tHover, timeline: m.timeline(t), client: m.client(), server: await serverWindow() };
  keep(sample);
  console.log(`${sc.mode.padEnd(6)} r${sc.round} ${sc.device} ${sc.scenario} ${how}${dwell ? "+" + dwell : ""} → ${dest} shell=${r.shellMs} content=${r.contentMs} usable=${r.usableMs} fg=${sample.server.fg.requests}req/${sample.server.fg.queries}q bg=${sample.server.bg.requests}req/${sample.server.bg.queries}q${r.err ? " ERR " + r.err : ""}`);
}

const desktop = async (mode) => {
  const ctx = await context(browser, LANE, { storageState: storage });
  await ctx.addCookies([{ name: "r8nav", value: mode, url: BASE }]);
  const page = await ctx.newPage();
  return { ctx, page, m: await instrument(ctx, page), side: (name) => page.locator("aside").getByRole("link", { name, exact: true }) };
};
const phone = async (mode) => {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": LANE }, serviceWorkers: "block", storageState: storage });
  ctx.setDefaultTimeout(60000);
  await ctx.addCookies([{ name: "r8nav", value: mode, url: BASE }]);
  const page = await ctx.newPage();
  return { ctx, page, m: await instrument(ctx, page), bar: (name) => page.locator('nav[aria-label="Main navigation"]').getByRole("link", { name }) };
};

const ORDERS = MODES.map((_, i) => [...MODES.slice(i), ...MODES.slice(0, i)]);
const errors = {};
for (let round = 1; round <= ROUNDS; round++) {
  for (const mode of ORDERS[(round - 1) % ORDERS.length]) {
    const sc = (scenario, device) => ({ mode, round, scenario, device });
    // A: first navigation by mouse (300 ms on the link) to a link that "one" does NOT prefetch.
    { const d = await desktop(mode);
      await load(sc("A", "desktop"), d.page, d.m, "/dashboard/timetable", DEST["/dashboard/timetable"]);
      await navigate(sc("A", "desktop"), d.page, d.m, "mouse", d.side("Settings"), "/dashboard/settings", "/dashboard/settings", 300);
      // A2: a SUBSEQUENT navigation in the same tab.
      await navigate(sc("A2", "desktop"), d.page, d.m, "mouse", d.side("My account"), "/dashboard/account", "/dashboard/account", 300);
      (errors[mode] ??= []).push(...d.m.errors); await d.ctx.close(); }
    // B: first navigation by mouse to the link "one" DOES prefetch (Home).
    { const d = await desktop(mode);
      await load(sc("B", "desktop"), d.page, d.m, "/dashboard/timetable", DEST["/dashboard/timetable"]);
      await navigate(sc("B", "desktop"), d.page, d.m, "mouse", d.side("Dashboard"), "/dashboard", "/dashboard", 300);
      (errors[mode] ??= []).push(...d.m.errors); await d.ctx.close(); }
    // C: first navigation by keyboard (focus then Enter at once) to a non-prefetched link.
    { const d = await desktop(mode);
      await load(sc("C", "desktop"), d.page, d.m, "/dashboard/timetable", DEST["/dashboard/timetable"]);
      await navigate(sc("C", "desktop"), d.page, d.m, "keyboard", d.side("My account"), "/dashboard/account", "/dashboard/account", 0);
      (errors[mode] ??= []).push(...d.m.errors); await d.ctx.close(); }
    // D/E: phone, first tap to a non-prefetched link (Schedule) and to the prefetched one (Home).
    { const p = await phone(mode);
      await load(sc("D", "phone"), p.page, p.m, "/dashboard/settings", DEST["/dashboard/settings"]);
      await navigate(sc("D", "phone"), p.page, p.m, "touch", p.bar("Timetable"), "/dashboard/timetable", "phone:/dashboard/timetable");
      (errors[mode] ??= []).push(...p.m.errors); await p.ctx.close(); }
    { const p = await phone(mode);
      await load(sc("E", "phone"), p.page, p.m, "/dashboard/settings", DEST["/dashboard/settings"]);
      await navigate(sc("E", "phone"), p.page, p.m, "touch", p.bar("Dashboard"), "/dashboard", "phone:/dashboard");
      (errors[mode] ??= []).push(...p.m.errors); await p.ctx.close(); }
  }
}
await browser.close();
L.note("output", "samples file", FILE);
for (const mode of MODES) {
  const s = out.samples.filter((x) => x.mode === mode);
  L.check("journey", `${mode}: every page and navigation arrived and became usable`, s.every((x) => x.usableMs !== null && !x.err), { failed: s.filter((x) => x.usableMs === null || x.err).map((x) => `${x.kind} ${x.scenario} ${x.device} ${x.err}`) });
  L.check("journey", `${mode}: no page errors`, (errors[mode] ?? []).length === 0, { errors: errors[mode] });
}
