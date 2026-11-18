// Round 8: measured performance of the brief's surfaces on a Sean-sized SYNTHETIC club (test branch only).
//   R8_PROBE_PORT=<port> R8_APP=<worktree> NODE_OPTIONS=--require=<r8-dbprobe.cjs> node run-journeys.mjs r8-perf
// Seeds ~900 members (630 active), 4 plans, 15 classes (46 sessions a week), 12 weeks of sessions and ~8–9k
// attendance rows into the run's own fixture club, then for each surface records, per sample: time until usable,
// time until the network is quiet, document server time, request count, transferred bytes, every fetch with its
// server time, and from the server's own `pg` (preload): round trips, their summed time, new connections and their
// connect time, pool acquires, waits for a full pool, peak concurrent queries. Writes all samples to
// OUT/r8-perf-<runId>.json. Measures; asserts only that each surface became usable.
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { writeFileSync } from "node:fs";
import { chromium, state, q, ledger, context, ownerSignIn, OUT, BASE } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const require = createRequire(import.meta.url);
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const PROBE = Number(process.env.R8_PROBE_PORT || 0);
if (!PROBE) throw new Error("R8_PROBE_PORT not set (the server must run with the r8-dbprobe preload)");
const COLD = Number(process.env.R8_COLD ?? 3);
const WARM = Number(process.env.R8_WARM ?? 5);
const L = ledger("r8-perf");
const LANE = "10.88.8.1";
const tenantId = club.tenantId ?? (await q(`select id from "Tenant" where slug = $1`, [club.slug]))[0].id;

// ── Seed (one statement per table; ids derived from the tenant so a rerun on the same club is idempotent) ──
const zone = (await q(`select timezone from "Tenant" where id = $1`, [tenantId]))[0].timezone;
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const P = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${P.year}-${P.month}-${P.day}`;
const hourNow = Number(P.hour);
const hh = (h) => `${String(((h % 24) + 24) % 24).padStart(2, "0")}:00`;
const NOW_START = hh(hourNow), NOW_END = hh(Math.min(23, hourNow + 1)) === NOW_START ? "23:59" : hh(hourNow + 1);
const t0 = Date.now();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", "billingCycle", "updatedAt")
  select 'r8t-' || md5($1 || n), $1, (array['Adult Unlimited','Adult Off-Peak','Student Unlimited','Family Add-on'])[n], (array[8500,6500,6000,4000])[n], 'monthly', now()
  from generate_series(1,4) n on conflict do nothing`, [tenantId]);
await q(`insert into "Member" (id, "tenantId", name, email, status, "paymentStatus", "membershipTierId", "waiverAccepted", "waiverAcceptedAt", "joinedAt", "cancelledAt", "updatedAt")
  select 'r8m-' || md5($1 || i), $1, 'Perf Member ' || lpad(i::text, 4, '0'), $2 || '-pm' || i || '@example.test',
    case when i <= 630 then 'active' when i <= 780 then 'cancelled' when i <= 870 then 'inactive' else 'taster' end,
    case when i <= 600 then 'paid' when i <= 630 then 'overdue' when i <= 780 then 'cancelled' else 'paid' end,
    'r8t-' || md5($1 || (1 + i % 4)), true, now() - (i % 700) * interval '1 day', now() - (i % 700) * interval '1 day',
    case when i > 630 and i <= 780 then now() - (i % 120) * interval '1 day' end, now()
  from generate_series(1,900) i on conflict do nothing`, [tenantId, club.slug]);
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity")
  select 'r8c-' || md5($1 || c), $1, case when c = 0 then 'Perf Now' else 'Perf Class ' || lpad(c::text, 2, '0') end, 60, 40
  from generate_series(0,14) c on conflict do nothing`, [tenantId]);
// Classes 1–14: three sessions a week each; class 0 ("Perf Now"): every day at this hour (desk register + card).
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime", "startDate")
  select 'r8s-' || md5($1 || c || '-' || k), 'r8c-' || md5($1 || c), (c + 2 * k) % 7,
    lpad((6 + (c * 3 + k * 5) % 15)::text, 2, '0') || ':00', lpad((7 + (c * 3 + k * 5) % 15)::text, 2, '0') || ':00', date '${todayIso}' - 400
  from generate_series(1,14) c, generate_series(0,2) k
  union all
  select 'r8s-' || md5($1 || 'now-' || d), 'r8c-' || md5($1 || 0), d, $2, $3, date '${todayIso}' - 400 from generate_series(0,6) d
  on conflict do nothing`, [tenantId, NOW_START, NOW_END]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime")
  select 'r8i-' || md5(s.id || d::text), s."classId", d::timestamp, s."startTime", s."endTime"
  from "ClassSchedule" s join "Class" c on c.id = s."classId" and c."tenantId" = $1,
       generate_series(date '${todayIso}' - 84, date '${todayIso}', interval '1 day') d
  where extract(dow from d) = s."dayOfWeek" on conflict do nothing`, [tenantId]);
await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInTime", "checkInMethod")
  select 'r8a-' || md5(i.id || k), $1, 'r8m-' || md5($1 || (1 + (i.ord * 37 + k * 61) % 630)), i.id,
    i.date + (i."startTime" || ':00')::time, 'admin'
  from (select ci.*, row_number() over (order by ci.id) ord from "ClassInstance" ci join "Class" c on c.id = ci."classId" and c."tenantId" = $1
        where ci.date < date '${todayIso}') i, generate_series(1,14) k
  on conflict do nothing`, [tenantId]);
const size = (await q(`select (select count(*) from "Member" where "tenantId" = $1)::int members,
  (select count(*) from "Member" where "tenantId" = $1 and status = 'active')::int active,
  (select count(*) from "MembershipTier" where "tenantId" = $1)::int tiers,
  (select count(*) from "Class" where "tenantId" = $1)::int classes,
  (select count(*) from "ClassSchedule" s join "Class" c on c.id = s."classId" where c."tenantId" = $1)::int schedules,
  (select count(*) from "ClassInstance" i join "Class" c on c.id = i."classId" where c."tenantId" = $1)::int instances,
  (select count(*) from "AttendanceRecord" where "tenantId" = $1)::int attendance`, [tenantId]))[0];
L.note("seed", `fixture size (seeded in ${Date.now() - t0} ms)`, size);

// ── Instruments ──
const snap = async (reset = true) => (await fetch(`http://127.0.0.1:${PROBE}/snap${reset ? "?reset=1" : ""}`)).json();
const dbSummary = (d) => ({
  queries: d.queries, queryMs: Math.round(d.queryMs), tx: d.tx, newConnections: d.newConnections, connectMs: Math.round(d.connectMs),
  acquires: d.acquires, acquireMs: Math.round(d.acquireMs), maxAcquireMs: Math.round(d.maxAcquireMs), queuedAcquires: d.queuedAcquires,
  queueMs: Math.round(d.queueMs), maxConcurrent: d.maxConcurrent, topShapes: d.shapes.slice(0, 12).map(([k, v]) => [v.n, Math.round(v.ms), k]),
});

async function instrument(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  const m = { reqs: new Map(), inFlight: 0, lastChange: Date.now() };
  cdp.on("Network.requestWillBeSent", (e) => {
    if (!m.reqs.has(e.requestId)) { m.inFlight++; m.lastChange = Date.now(); }
    m.reqs.set(e.requestId, { url: e.request.url, method: e.request.method, type: e.type, start: e.timestamp, bytes: 0, done: false });
  });
  cdp.on("Network.responseReceived", (e) => {
    const r = m.reqs.get(e.requestId); if (!r) return;
    r.status = e.response.status; r.fromCache = e.response.fromDiskCache || e.response.fromServiceWorker;
    const t = e.response.timing; if (t) r.serverMs = Math.round(t.receiveHeadersEnd - t.sendEnd);
  });
  const end = (e, failed) => { const r = m.reqs.get(e.requestId); if (!r || r.done) return; r.done = true; r.end = e.timestamp; if (!failed) r.bytes = e.encodedDataLength ?? 0; else r.failed = true; m.inFlight--; m.lastChange = Date.now(); };
  cdp.on("Network.loadingFinished", (e) => end(e, false));
  cdp.on("Network.loadingFailed", (e) => end(e, true));
  m.reset = () => { m.reqs.clear(); m.inFlight = 0; m.lastChange = Date.now(); };
  m.quiet = async (ms = 1000, max = 90_000) => { const s = Date.now(); while (Date.now() - s < max) { if (m.inFlight <= 0 && Date.now() - m.lastChange >= ms) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };
  m.summary = (originTs) => {
    const all = [...m.reqs.values()];
    const base = originTs ?? Math.min(...all.map((r) => r.start));
    const api = all.filter((r) => /\/api\/|_rsc=|\?__flight/.test(r.url) || r.type === "Fetch" || r.type === "XHR")
      .map((r) => ({ path: new URL(r.url).pathname + (new URL(r.url).search.includes("_rsc") ? "?_rsc" : ""), method: r.method, status: r.status, serverMs: r.serverMs, bytes: r.bytes, startMs: Math.round((r.start - base) * 1000), endMs: r.end ? Math.round((r.end - base) * 1000) : null }));
    const doc = all.find((r) => r.type === "Document");
    const paths = api.map((a) => `${a.method} ${a.path}`);
    const dup = [...new Set(paths.filter((p, i) => paths.indexOf(p) !== i))];
    return { requests: all.length, bytes: all.reduce((s, r) => s + (r.bytes || 0), 0), jsBytes: all.filter((r) => r.type === "Script").reduce((s, r) => s + (r.bytes || 0), 0),
      docServerMs: doc?.serverMs ?? null, docBytes: doc?.bytes ?? null, api, duplicates: dup, failed: all.filter((r) => r.failed).length };
  };
  return m;
}

const browser = await chromium.launch();
const signIn = await context(browser, LANE);
const p0 = await signIn.newPage();
await ownerSignIn(p0, club);
const storage = await signIn.storageState();
await signIn.close();

const samples = [];
const FILE = `${OUT}/r8-perf-${Date.now()}.json`;
const save = () => writeFileSync(FILE, JSON.stringify({ size, zone, todayIso, nowStart: NOW_START, samples }, null, 2));
const keep = (x) => { samples.push(x); save(); };
const memberRow = (await q(`select id, name from "Member" where "tenantId" = $1 and name = 'Perf Member 0123'`, [tenantId]))[0];

const SURFACES = [
  { id: "timetable", url: "/dashboard/timetable", ready: (p) => p.getByTestId("week-grid").locator("[data-cell-key] button").first() },
  { id: "register", url: "/dashboard/checkin", ready: (p) => p.getByRole("button", { name: new RegExp(`${NOW_START} · Perf Now`) }).first() },
  { id: "members", url: "/dashboard/members", ready: (p) => p.getByText("Perf Member 0001", { exact: true }).first() },
  { id: "member-profile", url: `/dashboard/members/${memberRow.id}`, ready: (p) => p.getByRole("heading", { name: memberRow.name }).first() },
  { id: "reports", url: "/dashboard/reports", ready: (p) => p.getByTestId("reports-joined-tile").filter({ visible: true }).first() },
  { id: "analysis", url: "/dashboard/analysis", ready: (p) => p.getByLabel("Reporting period") },
  { id: "settings", url: "/dashboard/settings", ready: (p) => p.getByTestId("settings-active-note").filter({ visible: true }).first() },
];

async function measureLoad(surface, mode, i, ctx, page, m) {
  await m.quiet(500, 20_000);
  m.reset();
  await snap(true);
  const started = Date.now();
  let usableMs = null, error = null;
  try {
    await page.goto(surface.url, { waitUntil: "commit", timeout: 90_000 });
    await surface.ready(page).waitFor({ state: "visible", timeout: 90_000 });
    usableMs = Date.now() - started;
  } catch (e) { error = String(e.message ?? e).split("\n")[0]; }
  const quiet = await m.quiet(1000, 60_000);
  const quietMs = Date.now() - started - 1000;
  const net = m.summary();
  const db = dbSummary(await snap(true));
  const s = { surface: surface.id, kind: "load", mode, i, usableMs, quietMs: quiet ? quietMs : null, error, ...net, db };
  keep(s);
  console.log(`${surface.id} ${mode}#${i} usable=${usableMs}ms quiet=${s.quietMs}ms req=${net.requests} kB=${Math.round(net.bytes / 1024)} doc=${net.docServerMs}ms db=${db.queries}q/${db.queryMs}ms new=${db.newConnections}(${db.connectMs}ms) queued=${db.queuedAcquires}${error ? " ERROR " + error : ""}`);
  return s;
}

const serverCold = { done: false };
for (const surface of SURFACES) {
  for (let i = 1; i <= COLD; i++) {
    const ctx = await context(browser, LANE, { storageState: storage });
    const page = await ctx.newPage();
    const m = await instrument(ctx, page);
    const s = await measureLoad(surface, "cold", i, ctx, page, m);
    if (!serverCold.done) { s.firstAfterServerStart = true; serverCold.done = true; }
    await ctx.close();
  }
  const ctx = await context(browser, LANE, { storageState: storage });
  const page = await ctx.newPage();
  const m = await instrument(ctx, page);
  await measureLoad(surface, "prime", 0, ctx, page, m);
  for (let i = 1; i <= WARM; i++) await measureLoad(surface, "warm", i, ctx, page, m);

  // Interactions that are the surface's real work.
  if (surface.id === "register") {
    for (let i = 1; i <= WARM; i++) {
      await page.goto(surface.url);
      await surface.ready(page).click();
      const search = page.getByLabel("Search members");
      await search.waitFor({ timeout: 60_000 });
      await m.quiet(1000, 60_000);
      const who = `Perf Member ${String(200 + i).padStart(4, "0")}`;
      await search.fill(who);
      await page.getByRole("button", { name: new RegExp(`^${who}`) }).first().waitFor({ timeout: 30_000 });
      m.reset(); await snap(true);
      const t = Date.now();
      const posted = page.waitForResponse((r) => r.request().method() === "POST" && /\/api\//.test(r.url()), { timeout: 60_000 });
      await page.keyboard.press("Enter");
      let status = null, path = null;
      try { const r = await posted; status = r.status(); path = new URL(r.url()).pathname; } catch (e) { status = String(e.message).split("\n")[0]; }
      const markMs = Date.now() - t;
      await m.quiet(1000, 60_000);
      const db = dbSummary(await snap(true));
      const net = m.summary();
      keep({ surface: "register-mark", kind: "action", mode: "warm", i, markMs, status, path, ...net, db });
      console.log(`register-mark #${i} ${path} ${status} ${markMs}ms req=${net.requests} db=${db.queries}q/${db.queryMs}ms tx=${db.tx} queued=${db.queuedAcquires}`);
    }
  }
  if (surface.id === "members") {
    for (let i = 1; i <= WARM; i++) {
      const search = page.getByLabel("Search members").first();
      await search.fill("");
      m.reset(); await snap(true);
      const target = `Perf Member ${String(800 + i * 13).padStart(4, "0")}`;
      const t = Date.now();
      await search.fill(target);
      await page.getByText(target, { exact: true }).first().waitFor({ timeout: 30_000 }).catch(() => {});
      const shownMs = Date.now() - t;
      await m.quiet(750, 30_000);
      const db = dbSummary(await snap(true));
      const net = m.summary();
      keep({ surface: "members-search", kind: "action", mode: "warm", i, shownMs, target, ...net, db });
      console.log(`members-search #${i} "${target}" shown=${shownMs}ms req=${net.requests} db=${db.queries}q`);
    }
  }
  await ctx.close();
}

// ── Card check-in: the API the scanner calls, one fresh admitted member per sample ──
{
  const env = testEnv();
  const secret = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
  const key = createHmac("sha256", secret).update("matflow.card.v1").digest();
  const keyId = createHmac("sha256", key).update("matflow.card.keyid").digest().toString("base64url").slice(0, 6);
  const sign = (a) => { const body = Buffer.from(JSON.stringify({ ...a, purpose: "card", keyId, exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8").toString("base64url"); return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`; };
  const inst = (await q(`select i.id from "ClassInstance" i join "Class" c on c.id = i."classId" where c."tenantId" = $1 and c.name = 'Perf Now' and i.date = date '${todayIso}'`, [tenantId]))[0];
  const ctx = await context(browser, LANE, { storageState: storage });
  // The scanner's own POST, sent from the signed-in context with the page's origin (no page: the scan route navigates).
  for (let i = 1; i <= WARM + 1; i++) {
    const mem = (await q(`select id, "cardVersion" from "Member" where "tenantId" = $1 and name = $2`, [tenantId, `Perf Member ${String(300 + i).padStart(4, "0")}`]))[0];
    const token = sign({ tenantId, memberId: mem.id, cardVersion: mem.cardVersion });
    await snap(true);
    const t = Date.now();
    const res = await ctx.request.post("/api/checkin/card", { headers: { origin: BASE, "content-type": "application/json" }, data: { classInstanceId: inst.id, tokens: [token] } });
    const txt = await res.text();
    const r = { status: res.status(), ms: Date.now() - t, bytes: txt.length, outcome: (() => { try { const j = JSON.parse(txt); return j.results?.[0]?.status ?? j.results?.[0]?.outcome ?? j.error ?? null; } catch { return null; } })() };
    const db = dbSummary(await snap(true));
    keep({ surface: "card-checkin", kind: "action", mode: i === 1 ? "prime" : "warm", i, ...r, db });
    console.log(`card-checkin #${i} ${r.status} ${r.outcome} ${r.ms}ms db=${db.queries}q/${db.queryMs}ms tx=${db.tx} new=${db.newConnections} queued=${db.queuedAcquires}`);
  }
  await ctx.close();
}

await browser.close();
save();
L.note("output", "samples file", FILE);
for (const s of SURFACES) {
  const ok = samples.filter((x) => x.surface === s.id && x.kind === "load" && x.usableMs !== null).length;
  const all = samples.filter((x) => x.surface === s.id && x.kind === "load").length;
  L.check("journey", `${s.id} became usable in every sample`, ok === all, { ok, all });
}
