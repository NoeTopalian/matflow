// Journey: headcount and movement (Sean's notes 3 and 4: T8a–d, plus D11 "one movement definition").
// Build under test: the integrated branch (the combined candidate, HEAD c79b3ee6 when written).
// "Net new members" is replayed from status events (lib/membership-movement.ts, lib/membership-report.ts): new,
// rejoined, left ("lost" in code: cancelled / completed course), net, tasters added, imported, and the active
// headcount at each club-month end. Since D11 the Reports "Joined this month (new + rejoined)" tile is that same
// movement: value = new + rejoined; lines New / Rejoined / Tasters added / Left, each a drill-through to exactly the
// members the events counted; net = new + rejoined − left. An import-day join date is not a join (IMPORT_DAY_MS).
// The Members view of the Net New Members card is a zero-based axis whose last point is today's Active members.
//
// Seed (the D11 worked example, tests/unit/movement-definition-d11.test.tsx):
//   Ana  added this month as active                    → new
//   Ben  added this month as a taster                  → tasters added (not in Joined or Net)
//   Cara cancelled months ago, reactivated this month  → rejoined
//   Dan  prepaid course ended this month               → left (completed course)
//   Eve  cancelled this month                          → left (cancelled)
//   Ivy  TeamUp create import this month, join date stamped on the import day → imported: in none of the four
// Status changes that a staff member makes go through the real routes from the signed-in page (POST /api/members,
// PATCH /api/members/[id]), so their MemberStatusEvent rows are written by production code. History that cannot be
// made through a route today (an event dated months ago; a TeamUp refresh ending a course; a TeamUp create import)
// is written with `q`, in the exact shape the writer would produce, and the ledger says so (N2).
//
// Expected numbers: movement and headcount as a DELTA — a fresh /api/reports read after this journey's own cleanup
// and before seeding, then a fresh read after seeding; the difference must be exactly the seed's movement, month by
// month. The screen, the drill-throughs and the CSV must then show the post-seed figures. (A delta is used because
// the fixture club's own history — Member 1, Member 2, rows other journeys left — is replayed by
// lib/membership-report.ts from join dates, the TeamUp ledger or back-fill, which this journey does not
// re-implement.) Churn and Active members still come from SQL (status + cancelledAt in the club month).
//
// Needs `fixture.mjs create` and `server.mjs start` (server on the integrated build, migration 20261017022302 applied).
//   node journeys/headcount-movement.mjs            (leaves its seed in place, like reporting-truth, so a following
//                                                    journey's SQL baseline and the 60-second reports cache agree)
//   HM_CLEANUP=1 node journeys/headcount-movement.mjs   (also deletes its seed at the end)
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, sleep } from "../lib.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("headcount-movement");
const tenantId = club.tenantId;
const errors = [];

// ── Club-zone months (lib/club-month.ts clubMonthWindow; same algorithm as reporting-truth) ─────────────────
const now = new Date();
const clubZone = (await q(`select timezone from "Tenant" where id = $1`, [tenantId]))[0]?.timezone || "Europe/London";
const zoneOffsetMs = (instant, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant);
  const read = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(read("year"), read("month") - 1, read("day"), read("hour") % 24, read("minute"), read("second")) - instant.getTime();
};
const zonedYearMonth = (instant) => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: clubZone, year: "numeric", month: "2-digit" }).formatToParts(instant);
  return { year: Number(parts.find((p) => p.type === "year").value), month: Number(parts.find((p) => p.type === "month").value) };
};
const clubMonthStart = (offset) => {
  const { year, month } = zonedYearMonth(now);
  const naive = Date.UTC(year, month - 1 + offset, 1);
  const first = zoneOffsetMs(new Date(naive), clubZone);
  return new Date(naive - zoneOffsetMs(new Date(naive - first), clubZone));
};
const monthKeyOf = (offset) => { const { year, month } = zonedYearMonth(now); const d = new Date(Date.UTC(year, month - 1 + offset, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
const monthStart = clubMonthStart(0);
const nextMonthStart = clubMonthStart(1);
const DAY = 86_400_000;
const midMonth = (offset) => new Date(clubMonthStart(offset).getTime() + 14 * DAY + 12 * 3_600_000); // safely inside that club month
const T_JOIN = midMonth(-8);    // Cara, Dan, Eve first became active (inside the 12-month window: offsets -11..0)
const T_CANCEL = midMonth(-4);  // Cara cancelled
const iso = (d) => d.toISOString(); // TIMESTAMP(3) WITHOUT TIME ZONE holding UTC: always send ISO "Z" strings

// ── Formatters and copy, in the source's exact formats (file:line in the combined worktree) ──────────────────
const fmtNum = (n) => Number(n).toLocaleString("en-GB");                                               // reports-primitives.tsx formatNumber
const signed = (n) => (n > 0 ? `+${fmtNum(n)}` : n < 0 ? `−${fmtNum(Math.abs(n))}` : "0");               // reports-primitives.tsx formatSigned
const fmtPct = (p, b) => (b <= 0 || p === null || !Number.isFinite(p) ? "—" : `${p.toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`);
const fmtRatio = (p, n, b) => (fmtPct(p, b) === "—" ? "—" : `${fmtPct(p, b)} (${fmtNum(n)} of ${fmtNum(b)})`);
const pct1 = (n, b) => (b > 0 ? Math.round((n / b) * 1000) / 10 : null);
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const DEFINITION = "New: first ever start. Rejoined: started again after leaving. Joined = new + rejoined. Left: cancelled, or finished a prepaid course. Net = new + rejoined − left. Tasters added are counted apart, and imports are never joins."; // membership-movement.ts:147-148
const JOINED_LABEL = "Joined this month (new + rejoined)";                                                 // membership-movement.ts:150, ReportsView.tsx:506
const CHURN_FORMULA = "Cancelled this month ÷ (active members now + cancelled this month)";               // ReportsView.tsx:234
const JOINED_LINES = [                                                                                      // ReportsView.tsx:491-496, 513
  { key: "new", label: "New", filter: "new-this-month" },
  { key: "rejoined", label: "Rejoined", filter: "rejoined-this-month" },
  { key: "tasterAdded", label: "Tasters added", filter: "tasters-this-month" },
  { key: "lost", label: "Left", filter: "lost-this-month" },
];
const joinedNet = (t) => `Net ${signed(t.net)} this month (new + rejoined − left)`;                          // ReportsView.tsx:524-526
const joinedTileDetail = (t) => `New ${fmtNum(t.new)} · Rejoined ${fmtNum(t.rejoined)} · Tasters added ${fmtNum(t.tasterAdded ?? 0)} · Left ${fmtNum(t.lost)} · Net ${signed(t.net)}`; // ReportsView.tsx:228-230
// Members headline for a movement slice: `${n} ${label with a lower-case first letter}` (MembersList.tsx:647-658, 863).
const drillHeadline = { "new-this-month": (n) => `${n} new this month`, "rejoined-this-month": (n) => `${n} rejoined this month`, "tasters-this-month": (n) => `${n} tasters added this month`, "lost-this-month": (n) => `${n} left this month` };
const tallyText = (m) => {                                                                                   // NetNewMembersCard.tsx:220-238
  const t = m.totals;
  const today = m.headcountByMonth.filter((h) => h.basis !== "none").at(-1);
  return `${m.window.from} – ${m.window.to}: ${fmtNum(t.new)} new · ${fmtNum(t.rejoined)} rejoined · ${fmtNum(t.lost)} left (${fmtNum(t.lostCancelled)} cancelled, ${fmtNum(t.lostCompleted)} completed course) · net ${signed(t.net)} · ${fmtNum(t.tasterAdded ?? 0)} tasters added`
    + (today && today.headcount !== null ? ` · ${fmtNum(today.headcount)} active members today` : "");
};
const split = (r) => `New ${r.new} · Rejoined ${r.rejoined} · Left ${r.lost} (cancelled ${r.lostCancelled}, completed course ${r.lostCompleted}) · Tasters added ${r.tasterAdded ?? 0}`; // ReportsView.tsx:318-319

// ── Seed definition ───────────────────────────────────────────────────────────────────────────────────────────
const NAMES = { ana: "HM Ana", ben: "HM Ben", cara: "HM Cara", dan: "HM Dan", eve: "HM Eve", ivy: "HM Ivy" };
const ALL_NAMES = Object.values(NAMES);
const emailFor = (key) => `${club.slug}-hm-${key}@example.test`; // SQL-seeded rows only; route-created rows get no address (no invite)
const cleanup = async () => {
  await q(`delete from "Member" where "tenantId" = $1 and (name = any($2) or email like $3)`, [tenantId, ALL_NAMES, `${club.slug}-hm-%@example.test`]);
};

// Status and cancelledAt in SQL (churn and Active members still use them: lib/reports.ts), plus the RETIRED joinedAt
// count, kept only as a note so the D11 change is visible in the ledger.
const TILE_SQL = `select
  count(*) filter (where "accountType" <> 'parent' and status = 'active')::int as active,
  count(*) filter (where "accountType" <> 'parent' and "joinedAt" >= $2::timestamp and "joinedAt" < $3::timestamp)::int as "joinedAtCount",
  count(*) filter (where "accountType" <> 'parent' and status = 'cancelled' and "cancelledAt" >= $2::timestamp and "cancelledAt" < $3::timestamp)::int as cancelled
from "Member" where "tenantId" = $1`;
const tiles = async () => (await q(TILE_SQL, [tenantId, iso(monthStart), iso(nextMonthStart)]))[0];

// The seed's expected movement, month by month (keys are club months), and its headcount at each month end.
const K = { join: monthKeyOf(-8), cancel: monthKeyOf(-4), now: monthKeyOf(0) };
const ZERO = { new: 0, rejoined: 0, lostCancelled: 0, lostCompleted: 0, imported: 0, otherIn: 0, otherOut: 0, tasterAdded: 0 };
const SEED_MOVES = {
  [K.join]: { ...ZERO, new: 3 },                                                                            // Cara, Dan, Eve first start
  [K.cancel]: { ...ZERO, lostCancelled: 1 },                                                                // Cara cancels
  [K.now]: { ...ZERO, new: 1, rejoined: 1, lostCancelled: 1, lostCompleted: 1, imported: 1, tasterAdded: 1 }, // Ana, Cara, Eve, Dan, Ivy, Ben
};
const seedHeadAt = (offset) => (offset < -8 ? 0 : offset < -4 ? 3 : offset < 0 ? 2 : 3); // -8..-5: Cara, Dan, Eve · -4..-1: Dan, Eve · now: Ana, Cara, Ivy
const SEED_TOTALS = { new: 4, rejoined: 1, lostCancelled: 2, lostCompleted: 1, lost: 3, net: 2, imported: 1, otherIn: 0, otherOut: 0, tasterAdded: 1 };
const SEED_NOW = { new: 1, rejoined: 1, tasterAdded: 1, lost: 2, net: 0, imported: 1 }; // this month: Joined +2 (Ana, Cara)
const SEED_JOINED = 2;
// Who each Joined-tile line must list, among the seed (the rest of each list is the fixture's own movers).
const SEED_IN = { "new-this-month": [NAMES.ana], "rejoined-this-month": [NAMES.cara], "tasters-this-month": [NAMES.ben], "lost-this-month": [NAMES.dan, NAMES.eve] };

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────
const tileLink = (page, name) => page.getByRole("link", { name: `${name} — see the members behind this number`, exact: true }); // ReportsView.tsx MetricCard aria-label
const pTexts = async (loc) => (await loc.locator("p").allInnerTexts()).map(norm);
const noHScroll = async (page) => page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
const membersHeadline = async (page) => {
  const h = page.getByTestId("members-headline").filter({ visible: true }).first();
  await h.waitFor({ timeout: 60000 });
  return norm(await h.innerText());
};
const listed = async (page, name) => (await page.getByText(name, { exact: true }).filter({ visible: true }).count()) > 0;
const api = (page, method, url, body) => page.evaluate(async ({ method, url, body }) => {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  let json = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, json };
}, { method, url, body });
// The Joined tile as rendered: value, label, the four lines (text and href), the net.
async function readJoinedTile(page) {
  const tile = page.getByTestId("reports-joined-tile").filter({ visible: true }).first();
  await tile.waitFor({ timeout: 90000 });
  await tile.scrollIntoViewIfNeeded();
  const lines = {};
  for (const l of JOINED_LINES) {
    const a = tile.getByTestId(`reports-joined-${l.filter}`);
    lines[l.filter] = { text: norm(await a.innerText()), href: await a.getAttribute("href") };
  }
  return {
    value: norm(await tile.getByTestId("reports-joined-value").innerText()),
    label: (await pTexts(tile)).find((t) => t === JOINED_LABEL) ?? (await pTexts(tile))[1] ?? null,
    lines,
    net: norm(await tile.getByTestId("reports-joined-net").innerText()),
  };
}
const expectedJoinedTile = (joined, cur) => ({
  value: fmtNum(joined),
  label: JOINED_LABEL,
  lines: Object.fromEntries(JOINED_LINES.map((l) => [l.filter, { text: `${l.label} ${fmtNum(cur[l.key] ?? 0)}`, href: `/dashboard/members?filter=${l.filter}&month=${K.now}` }])),
  net: joinedNet(cur),
});

// The 60-second reports cache (lib/reports.ts getReportsDataCached, stale-while-revalidate): poll /api/reports
// (same cache key as the page's default view) until its generatedAt is after `after`.
async function freshReport(page, after, label) {
  const deadline = Date.now() + 200_000;
  let last = null;
  while (Date.now() < deadline) {
    const r = await api(page, "GET", "/api/reports");
    if (r.status === 200 && r.json?.generatedAt && new Date(r.json.generatedAt).getTime() > after.getTime()) return r.json;
    last = { status: r.status, generatedAt: r.json?.generatedAt ?? null };
    await sleep(5000);
  }
  L.check("seed", `S0 a fresh report (${label}) arrived within 200 s`, false, { after: after.toISOString(), last });
  throw new Error(`no fresh report (${label})`);
}

function parseCsv(text) {
  const rows = []; let row = []; let cell = ""; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\r") continue;
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

// Read the Net New Members chart as drawn: axis ticks, dots (Members view), in SVG coordinates.
//
// recharts 3.8 DOM (read from node_modules/recharts/lib, not guessed): since 3.4 most chart pieces are rendered
// through ZIndexLayer, a React portal into <g class="recharts-zIndex-layer_N"> groups appended to the root
// <svg class="recharts-surface">. So a piece is NOT inside the group of the component that owns it:
//   y-axis   <g class="recharts-layer recharts-cartesian-axis recharts-yAxis yAxis"> sits in layer 500 and, with
//            tickLine={false} and axisLine={false}, is empty; its labels are portalled again to layer 2000 as
//            <g class="recharts-cartesian-axis-tick-labels recharts-yAxis-tick-labels">
//              <g class="recharts-layer recharts-cartesian-axis-tick-label">
//                <text class="recharts-text recharts-cartesian-axis-tick-value" x y …><tspan …>12</tspan></text>
//            (CartesianAxis.js Ticks/TickItem, Text.js). ".recharts-yAxis .recharts-cartesian-axis-tick-value"
//            therefore matches nothing — the cause of the empty ticks and of every value read from them.
//   x-axis   the same, ".recharts-xAxis-tick-labels".
//   dots     Dots.js → layer 600: <g class="recharts-layer recharts-line-dots"> holding one
//            <circle class="recharts-dot recharts-line-dot" cx cy r> per point with a numeric y (shape/Dot.js; a
//            null headcount draws no circle).
//   tooltip  Tooltip.js portals <div class="recharts-tooltip-wrapper …"> into the <div class="recharts-wrapper">
//            itself (RechartsWrapper.js innerRef), i.e. still inside data-testid="net-new-chart"; it is always
//            present, visibility:hidden until active, and the custom content renders only while active.
// The portal groups exist only after a second render (ZIndexLayer returns null until its portal is registered)
// and the ResponsiveContainer draws nothing until it has measured, hence waitForChart below.
// DO NOT revert these selectors to ".recharts-yAxis …" / ".recharts-xAxis …": that was the 23 Oct failure.
const chartEl = (page) => page.getByTestId("net-new-chart").filter({ visible: true }).first();
const readChart = (page) => chartEl(page).evaluate((el) => {
  const num = (s) => Number(String(s).replace(/[,\s]/g, "").replace("−", "-"));
  const svg = el.querySelector("svg.recharts-surface") ?? el.querySelector("svg");
  // A page (viewport) point → SVG user coordinates (the surface has viewBox 0 0 w h at w × h, so this is a shift).
  const toSvg = (px, py) => {
    const m = svg?.getScreenCTM?.();
    if (!m) return { x: NaN, y: NaN };
    const p = svg.createSVGPoint(); p.x = px; p.y = py;
    const q = p.matrixTransform(m.inverse());
    return { x: q.x, y: q.y };
  };
  const centre = (node) => { const b = node.getBoundingClientRect(); return { px: b.x + b.width / 2, py: b.y + b.height / 2 }; };
  const attr = (node, name) => { const v = node.getAttribute(name); return v === null || v === "" ? NaN : Number(v); };
  const ticks = (axis) => [...el.querySelectorAll(`.recharts-${axis}-tick-labels .recharts-cartesian-axis-tick-value`)].map((t) => {
    const c = centre(t);
    return { text: (t.textContent ?? "").trim(), x: attr(t, "x"), y: attr(t, "y"), cx: c.px, cy: c.py };
  });
  // Dots in data order. cx/cy are SVG coordinates (the attributes when the dot is a <circle>; otherwise — a custom
  // <path>/<g> dot — the centre of its drawn box mapped back into the SVG); px/py are the page point to hover.
  const dots = [...el.querySelectorAll(".recharts-line-dots .recharts-line-dot, .recharts-line-dots circle, .recharts-line-dots path")].map((d) => {
    const c = centre(d);
    let cx = attr(d, "cx"); let cy = attr(d, "cy");
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) { const s = toSvg(c.px, c.py); cx = s.x; cy = s.y; }
    return { tag: d.tagName.toLowerCase(), cx, cy, px: c.px, py: c.py };
  });
  const sb = svg?.getBoundingClientRect();
  return {
    view: el.getAttribute("data-view"),
    aria: el.getAttribute("aria-label"),
    y: ticks("yAxis").map((t) => ({ ...t, value: num(t.text) })),
    x: ticks("xAxis"),
    dots,
    texts: [...el.querySelectorAll("text")].map((t) => (t.textContent ?? "").trim()).filter(Boolean),
    box: sb ? { x: sb.x, y: sb.y, width: sb.width, height: sb.height } : null,
  };
});
// Value at an SVG y, from the lowest and highest numeric y-axis ticks (a linear axis).
const valueAt = (yTicks, cy) => {
  const t = yTicks.filter((k) => Number.isFinite(k.value) && Number.isFinite(k.y)).sort((a, b) => a.value - b.value);
  if (t.length < 2) return null;
  const lo = t[0]; const hi = t[t.length - 1];
  return lo.value + ((cy - lo.y) * (hi.value - lo.value)) / (hi.y - lo.y);
};
async function chooseView(page, label) {
  const btn = page.getByRole("group", { name: "Net new members view", exact: true }).getByRole("button", { name: label, exact: true }); // NetNewMembersCard.tsx:190-207
  await btn.click();
  await page.getByTestId("net-new-chart").filter({ visible: true }).first().waitFor({ timeout: 30000 });
  return btn.getAttribute("aria-pressed");
}
// Poll (up to 10 s) until the chart is drawn and still: the SVG has a size, both axes have their tick labels,
// `dots` dots exist when a count is given, and two reads 250 ms apart agree (measurement, portal registration and
// the line's entry animation can all move things for a moment). Returns the last read either way, so the checks
// report what was actually there.
async function waitForChart(page, dots = null) {
  await chartEl(page).scrollIntoViewIfNeeded().catch(() => {});
  const deadline = Date.now() + 10_000;
  let prev = null; let c = null;
  while (Date.now() < deadline) {
    c = await readChart(page);
    const ready = c.box !== null && c.box.width > 0 && c.box.height > 0 && c.y.length >= 2 && c.x.length >= 1
      && (dots === null || (c.dots.length === dots && c.dots.every((d) => Number.isFinite(d.cx) && Number.isFinite(d.cy))));
    const sig = ready ? JSON.stringify([c.box, c.y.map((t) => [t.text, t.y]), c.x.map((t) => [t.text, t.cx]), c.dots.map((d) => [d.cx, d.cy, d.px, d.py])]) : null;
    if (ready && sig === prev) return c;
    prev = sig;
    await sleep(250);
  }
  return c ?? readChart(page);
}
// A real touch with movement, through CDP: recharts 3 opens the tooltip on touchmove only (RechartsWrapper
// onTouchMove → touchEventAction), and page.touchscreen.tap sends touchstart/touchend with no move.
async function touchMoveAt(page, x, y) {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 4, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await cdp.detach().catch(() => {}); }
}
// Hover (or touch, on a touch context) at a page point and return the tooltip's text once it contains `needle`,
// with the input that produced it. Touch tries a tap (Chromium synthesises mouse events from it, as a phone does),
// then a CDP touch with movement, in turn; never the mouse.
async function tooltipAt(page, x, y, needle, touch = false) {
  const tip = chartEl(page).locator(".recharts-tooltip-wrapper");
  const read = async () => norm(await tip.first().innerText().catch(() => ""));
  // No mouse fallback on touch: a phone has no hover, so a touch check must be satisfied by touch input alone (review 23 Oct).
  const ways = touch ? ["tap", "touchmove"] : ["mouse"];
  for (let i = 0; i < 6; i++) {
    const via = ways[i % ways.length];
    if (via === "tap") await page.touchscreen.tap(x, y).catch(() => {});
    else if (via === "touchmove") await touchMoveAt(page, x, y).catch(() => {});
    else { await page.mouse.move(x - 6, y, { steps: 2 }); await page.mouse.move(x, y, { steps: 3 }); }
    await sleep(300);
    const text = await read();
    if (text.includes(needle)) return { text, via };
  }
  return { text: await read(), via: null };
}

const browser = await chromium.launch();
try {
  // ── Sign in (the seed's route writes need the owner's session) ─────────────────────────────────────────────
  const ctx = await context(browser, "10.96.0.1", { acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // ── Baseline: own rows out, then a report computed after that ──────────────────────────────────────────────
  await cleanup();
  const cleanedAt = new Date();
  const ledgerRows = (await q(`select count(*)::int as n from "ImportedMembership" where "tenantId" = $1 and "memberId" is not null`, [tenantId]))[0].n;
  const tileBefore = await tiles();
  const pre = await freshReport(page, cleanedAt, "before seeding");
  L.note("seed", "N1 baseline after this journey's own cleanup (fixture members and other journeys' rows)", {
    clubZone, monthKey: K.now, sql: tileBefore, ledgerRows, historySource: pre.membership?.historySource, joined: pre.churn?.joined,
    movementNow: pre.membership?.movementsByMonth?.find((m) => m.isCurrentMonth) ?? null, totals: pre.membership?.totals, generatedAt: pre.generatedAt,
  });

  // ── Seed ────────────────────────────────────────────────────────────────────────────────────────────────────
  // SQL rows: history dated months ago cannot be written through a route (recordStatusEvent clamps occurredAt to
  // [latest event, now]; the staff PATCH supplies none), so Cara, Dan and Eve's earlier history is inserted in the
  // shape POST /api/members + PATCH would have written then: reason staff_edit, changedById null.
  const ids = {};
  const insertMember = async (key, status, joined, cancelled = null) => {
    ids[key] = randomUUID();
    await q(`insert into "Member" (id, "tenantId", email, name, status, "paymentStatus", "accountType", "joinedAt", "cancelledAt", "updatedAt")
             values ($1, $2, $3, $4, $5, 'paid', 'adult', $6, $7, now())`,
      [ids[key], tenantId, emailFor(key), NAMES[key], status, iso(joined), cancelled ? iso(cancelled) : null]);
  };
  // createdAt = occurredAt for history "written at the time"; an import writes now with occurredAt = the export time.
  const insertEvent = async (key, from, to, at, reason = "staff_edit", sourceAction = null, writtenAt = at) => {
    await q(`insert into "MemberStatusEvent" (id, "tenantId", "memberId", "fromStatus", "toStatus", reason, "changedById", "occurredAt", "createdAt", "sourceJobId", "sourceAction")
             values ($1, $2, $3, $4, $5, $6, null, $7, $8, $9, $10)`,
      [randomUUID(), tenantId, ids[key], from, to, reason, iso(at), iso(writtenAt), sourceAction ? `hm-job-${randomUUID()}` : null, sourceAction]);
  };
  await insertMember("cara", "cancelled", T_JOIN, T_CANCEL);
  await insertEvent("cara", null, "active", T_JOIN);
  await insertEvent("cara", "active", "cancelled", T_CANCEL);
  await insertMember("dan", "active", T_JOIN);
  await insertEvent("dan", null, "active", T_JOIN);
  await insertMember("eve", "active", T_JOIN);
  await insertEvent("eve", null, "active", T_JOIN);

  // Routes, from the signed-in page (same origin, so the CSRF check passes as it does for the desk).
  const ana = await api(page, "POST", "/api/members", { name: NAMES.ana, status: "active", requestId: `hm-${randomUUID()}` });
  const ben = await api(page, "POST", "/api/members", { name: NAMES.ben, status: "taster", requestId: `hm-${randomUUID()}` });
  ids.ana = ana.json?.id; ids.ben = ben.json?.id;
  const caraBack = await api(page, "PATCH", `/api/members/${ids.cara}`, { status: "active" });
  const eveOut = await api(page, "PATCH", `/api/members/${ids.eve}`, { status: "cancelled" });
  L.check("seed", "S1 the routes accepted the seed: POST /api/members ×2 (201, active and taster), PATCH reactivate Cara and cancel Eve (200)",
    ana.status === 201 && ana.json?.status === "active" && ben.status === 201 && ben.json?.status === "taster" && caraBack.status === 200 && eveOut.status === 200,
    { ana: [ana.status, ana.json?.status ?? ana.json?.error], ben: [ben.status, ben.json?.status ?? ben.json?.error], cara: [caraBack.status, caraBack.json?.status ?? caraBack.json?.error], eve: [eveOut.status, eveOut.json?.status ?? eveOut.json?.error] });

  // Dan: a TeamUp refresh ending a prepaid course (lib/importers/teamup.ts draftFor → active→inactive, reason import,
  // sourceAction import_refresh). Ivy: a TeamUp create import whose file had no join date, so the import stamped
  // joinedAt on the import day (lib/membership-report.ts IMPORT_DAY_MS) and wrote none→active, reason import,
  // sourceAction import_create. Neither has a route without a real TeamUp file and import job, so both writes are
  // reproduced in SQL, dated within this club month.
  const danEnd = new Date(Math.max(monthStart.getTime() + 1000, Date.now() - 60_000));
  await q(`update "Member" set status = 'inactive', "updatedAt" = now() where id = $1 and "tenantId" = $2`, [ids.dan, tenantId]);
  await insertEvent("dan", "active", "inactive", danEnd, "import", "import_refresh", new Date());
  const importAt = new Date(Math.max(monthStart.getTime() + 2000, Date.now() - 120_000));
  await insertMember("ivy", "active", new Date(Math.max(monthStart.getTime() + 1000, importAt.getTime() - 3_600_000)));
  await insertEvent("ivy", null, "active", importAt, "import", "import_create", new Date());
  const seededAt = new Date();
  L.note("seed", "N2 seed method per member", {
    Ana: "route: POST /api/members {status: active} (no email, so no invite)",
    Ben: "route: POST /api/members {status: taster}",
    Cara: `SQL: member + events none→active (${K.join}) and active→cancelled (${K.cancel}), reason staff_edit; then route: PATCH /api/members/[id] {status: active}`,
    Dan: `SQL: member + event none→active (${K.join}); then SQL: active→inactive, reason import, sourceAction import_refresh (no route: a TeamUp refresh needs an import job)`,
    Eve: `SQL: member + event none→active (${K.join}); then route: PATCH /api/members/[id] {status: cancelled}`,
    Ivy: "SQL: member with joinedAt 1 h before the import + event none→active, reason import, sourceAction import_create (no route: a TeamUp create needs an import job)",
  });

  // The events as written, member by member, in replay order.
  const evRows = await q(
    `select m.name, e."fromStatus" as f, e."toStatus" as t, e.reason as r, e."sourceAction" as s, e."changedById" is not null as by
       from "MemberStatusEvent" e join "Member" m on m.id = e."memberId"
      where e."tenantId" = $1 and m.name = any($2) order by m.name, e."occurredAt", e."createdAt", e.id`, [tenantId, ALL_NAMES]);
  const evBy = Object.fromEntries(ALL_NAMES.map((n) => [n, evRows.filter((r) => r.name === n).map((r) => `${r.f ?? "none"}→${r.t} ${r.r}${r.s ? `/${r.s}` : ""}${r.by ? " (by owner)" : ""}`)]));
  const evExpected = {
    [NAMES.ana]: ["none→active staff_edit (by owner)"],
    [NAMES.ben]: ["none→taster staff_edit (by owner)"],
    [NAMES.cara]: ["none→active staff_edit", "active→cancelled staff_edit", "cancelled→active staff_edit (by owner)"],
    [NAMES.dan]: ["none→active staff_edit", "active→inactive import/import_refresh"],
    [NAMES.eve]: ["none→active staff_edit", "active→cancelled staff_edit (by owner)"],
    [NAMES.ivy]: ["none→active import/import_create"],
  };
  L.check("seed", "S2 status events in replay order: the route writes carry the owner (staff_edit), the SQL history is as planned",
    JSON.stringify(evBy) === JSON.stringify(evExpected), { saw: evBy, expected: evExpected });
  // Compared in SQL (pg reads TIMESTAMP WITHOUT TIME ZONE as local time, so no JS date maths on these columns).
  const mRows = await q(`select name, status, "accountType",
      ("joinedAt" >= $3::timestamp and "joinedAt" < $4::timestamp) as "joinedThisMonth",
      case when "cancelledAt" is null then 'none' when "cancelledAt" >= $3::timestamp and "cancelledAt" < $4::timestamp then 'this month' else 'earlier' end as cancelled
    from "Member" where "tenantId" = $1 and name = any($2) order by name`, [tenantId, ALL_NAMES, iso(monthStart), iso(nextMonthStart)]);
  const mBy = Object.fromEntries(mRows.map((r) => [r.name, `${r.status}/${r.accountType}/joined ${r.joinedThisMonth ? "this month" : "earlier"}/cancelled ${r.cancelled}`]));
  const mExpected = {
    [NAMES.ana]: "active/adult/joined this month/cancelled none",
    [NAMES.ben]: "taster/adult/joined this month/cancelled none",
    [NAMES.cara]: "active/adult/joined earlier/cancelled none",          // PATCH cleared cancelledAt on the way back in (D1 rejoin)
    [NAMES.dan]: "inactive/adult/joined earlier/cancelled none",
    [NAMES.eve]: "cancelled/adult/joined earlier/cancelled this month",  // PATCH stamped cancelledAt
    [NAMES.ivy]: "active/adult/joined this month/cancelled none",        // import-day join date: in the month, but not a join
  };
  L.check("seed", "S3 member rows: Ana active and Ben taster joined this month; Cara active with cancelledAt cleared; Dan inactive; Eve cancelled this month; Ivy's join date is in this month",
    JSON.stringify(mBy) === JSON.stringify(mExpected), { saw: mBy, expected: mExpected });

  // ── Expected figures ──────────────────────────────────────────────────────────────────────────────────────
  const E = await tiles();
  const post = await freshReport(page, seededAt, "after seeding");
  const M0 = pre.membership; const M = post.membership;
  const cur = M.movementsByMonth.find((m) => m.isCurrentMonth);
  const zero = { ...ZERO, lost: 0, net: 0 };
  const preCur = M0.movementsByMonth.find((m) => m.isCurrentMonth) ?? zero;
  const deltaMoves = Object.fromEntries(M.movementsByMonth.map((m) => {
    const p = M0.movementsByMonth.find((x) => x.month === m.month) ?? zero;
    return [m.month, Object.fromEntries(Object.keys(ZERO).map((k) => [k, (m[k] ?? 0) - (p[k] ?? 0)]))];
  }));
  const expectedMoves = Object.fromEntries(M.movementsByMonth.map((m) => [m.month, SEED_MOVES[m.month] ?? ZERO]));
  L.check("seed", "S4 movement, month by month (post − pre report): new 3 in the join month, Cara left in her cancel month; this month new 1 · rejoined 1 · left 1 cancelled + 1 completed · tasters added 1 · imported 1 (Ivy); no other moves",
    M.movementsByMonth.length === 12 && JSON.stringify(deltaMoves) === JSON.stringify(expectedMoves), { saw: deltaMoves, expected: expectedMoves });
  const deltaTotals = Object.fromEntries(Object.keys(SEED_TOTALS).map((k) => [k, (M.totals[k] ?? 0) - (M0.totals[k] ?? 0)]));
  L.check("seed", "S5 window totals move by the seed exactly (new 4, rejoined 1, left 3 = 2 cancelled + 1 completed, net +2, imported 1, tasters added 1) and nothing needed reconciling",
    JSON.stringify(deltaTotals) === JSON.stringify(SEED_TOTALS) && M.reconciled === M0.reconciled, { saw: deltaTotals, expected: SEED_TOTALS, reconciled: [M0.reconciled, M.reconciled] });
  const headDelta = M.headcountByMonth.map((h, i) => {
    const p = M0.headcountByMonth.find((x) => x.month === h.month);
    return { month: h.month, delta: (h.headcount ?? 0) - (p?.headcount ?? 0), expected: seedHeadAt(i - (M.headcountByMonth.length - 1)) };
  });
  const lastHead = M.headcountByMonth.at(-1);
  L.check("seed", "S6 headcount at each month end moves by the seed (3 from the join month, 2 from Cara's cancel, 3 now with Ivy), and today equals Active members",
    headDelta.every((h) => h.delta === h.expected) && lastHead?.isCurrentMonth && lastHead.headcount === E.active,
    { saw: headDelta.filter((h) => h.delta || h.expected), today: lastHead?.headcount, activeMembers: E.active });
  const seedNow = { new: cur.new - preCur.new, rejoined: cur.rejoined - preCur.rejoined, tasterAdded: (cur.tasterAdded ?? 0) - (preCur.tasterAdded ?? 0), lost: cur.lost - preCur.lost, net: cur.net - preCur.net, imported: cur.imported - preCur.imported };
  const seedJoined = post.churn.joined - pre.churn.joined;
  L.check("seed", "S7 D11: the report's Joined is the movement — churn.joined = new + rejoined this month, and the seed adds 2 (Ana new, Cara rejoined; not Ben, not Ivy)",
    post.churn.joined === cur.new + cur.rejoined && seedJoined === SEED_JOINED && JSON.stringify(seedNow) === JSON.stringify(SEED_NOW),
    { joined: post.churn.joined, newPlusRejoined: cur.new + cur.rejoined, seedJoined, seedNow, expected: { seedJoined: SEED_JOINED, seedNow: SEED_NOW } });
  L.check("seed", "S8 churn and Active members in the report equal SQL (status and cancelledAt in the club month)",
    post.churn.cancelled === E.cancelled && post.summary.activeMembers === E.active && E.cancelled - tileBefore.cancelled === 1,
    { report: { cancelled: post.churn.cancelled, active: post.summary.activeMembers }, sql: E, cancelledAddedBySeed: E.cancelled - tileBefore.cancelled });
  L.note("d11", "N3 D11 for the ledger: the retired joinedAt count would read this month vs the Joined tile now (the seed adds 3 by joinedAt — Ana, Ben, Ivy — and 2 by movement — Ana, Cara)", {
    retiredJoinedAt: { wholeClub: E.joinedAtCount, seed: E.joinedAtCount - tileBefore.joinedAtCount },
    joinedTile: { wholeClub: post.churn.joined, seed: seedJoined },
    movementNow: { new: cur.new, rejoined: cur.rejoined, tasterAdded: cur.tasterAdded ?? 0, left: cur.lost, net: cur.net, imported: cur.imported },
  });

  // ── Reports, desktop ──────────────────────────────────────────────────────────────────────────────────────
  await page.goto("/dashboard/reports");
  const tileExpected = expectedJoinedTile(post.churn.joined, cur);
  const joinedTile = await readJoinedTile(page);
  L.note("reports", "N4 report freshness (the page and /api/reports share the default cache key; the API read was fresh)",
    { asOf: norm(await page.getByTestId("reports-generated-at").first().innerText().catch(() => "")), apiGeneratedAt: post.generatedAt, seededAt: seededAt.toISOString() });
  L.check("reports", "R1 Joined tile: value = new + rejoined, label \"Joined this month (new + rejoined)\"",
    joinedTile.value === tileExpected.value && joinedTile.label === JOINED_LABEL && joinedTile.value === fmtNum(cur.new + cur.rejoined),
    { saw: { value: joinedTile.value, label: joinedTile.label }, expected: { value: tileExpected.value, label: JOINED_LABEL } });
  L.check("reports", "R2 Joined tile lines \"New N\", \"Rejoined N\", \"Tasters added N\", \"Left N\" equal this month's movement, each linking to its slice for the club month",
    JSON.stringify(joinedTile.lines) === JSON.stringify(tileExpected.lines), { saw: joinedTile.lines, expected: tileExpected.lines });
  L.check("reports", "R3 Joined tile net \"Net ±N this month (new + rejoined − left)\" = movement net",
    joinedTile.net === tileExpected.net, { saw: joinedTile.net, expected: tileExpected.net });
  const churnLink = tileLink(page, "Churn rate this month");
  const churnTile = await pTexts(churnLink);
  const churnBase = E.active + E.cancelled;
  const churnExpected = [fmtRatio(pct1(E.cancelled, churnBase), E.cancelled, churnBase), "Churn rate this month", churnBase > 0 ? CHURN_FORMULA : "No active or cancelled members this month"];
  const nextToChurn = await churnLink.evaluate((el) => el.nextElementSibling?.getAttribute("data-testid") ?? null);
  L.check("reports", "R4 churn beside it counts cancellations by cancelledAt (Eve in; Dan's completed course not), and the Joined tile is its next tile",
    JSON.stringify(churnTile) === JSON.stringify(churnExpected) && nextToChurn === "reports-joined-tile", { saw: churnTile, expected: churnExpected, nextTile: nextToChurn });

  const card = page.getByTestId("net-new-card");
  await card.scrollIntoViewIfNeeded();
  const tally = norm(await page.getByTestId("net-new-tally").innerText());
  L.check("reports", "R5 Net New Members tally: window, new · rejoined · left (cancelled, completed course) · net · tasters added · active members today",
    tally === tallyText(M), { saw: tally, expected: tallyText(M) });
  const definition = norm(await page.getByTestId("net-new-definition").innerText());
  const defExpected = `${DEFINITION} Calendar months in the club's timezone.`; // NetNewMembersCard.tsx:244-246
  L.check("reports", "R6 the definition is printed above the chart", definition === defExpected, { saw: definition, expected: defExpected });

  // Bars view: the current month's bar tooltip carries this month's movement rows.
  const barsPressed = await chooseView(page, "Bars");
  const bars = await waitForChart(page);
  const curTick = bars.x.find((t) => t.text === cur.label) ?? bars.x.at(-1);
  const barTip = curTick && bars.box ? (await tooltipAt(page, curTick.cx, bars.box.y + bars.box.height / 2, "Net:")).text : "";
  const barLines = [
    `Joined: ${fmtNum(cur.new + cur.rejoined)} (${fmtNum(cur.new)} new, ${fmtNum(cur.rejoined)} rejoined)`,           // NetNewMembersCard.tsx:130
    `Left: ${fmtNum(cur.lost)} (${fmtNum(cur.lostCancelled)} cancelled, ${fmtNum(cur.lostCompleted)} completed course)`, // NetNewMembersCard.tsx:133
    `Net: ${signed(cur.net)}`,                                                                                          // NetNewMembersCard.tsx:136
  ];
  L.check("reports", "R7 Bars view, this month's tooltip: Joined (new, rejoined) · Left (cancelled, completed course) · Net — the movement rows on screen",
    barsPressed === "true" && bars.view === "bars" && barTip.startsWith(cur.label) && barLines.every((l) => barTip.includes(l)),
    { saw: barTip, expected: [cur.label, ...barLines], tick: curTick?.text ?? null, view: bars.view });
  const netInTile = joinedTile.net.match(/^Net (\S+) this month/)?.[1] ?? null;
  const tipJoined = barTip.match(/Joined: (\S+)/)?.[1] ?? null;
  L.check("reports", "R8 the Joined tile equals the chart for this month: tile value = tooltip Joined, tile Net = tooltip Net",
    netInTile === signed(cur.net) && barTip.includes(`Net: ${netInTile}`) && tipJoined === joinedTile.value,
    { tile: { value: joinedTile.value, net: netInTile }, chart: { joined: tipJoined, net: barTip.match(/Net: (\S+)/)?.[1] ?? null } });
  await shot(page, "headcount-movement-bars");

  // Members view: a zero-based axis labelled "Active members"; the last point is today's Active members.
  const membersPressed = await chooseView(page, "Members");
  const points = M.movementsByMonth.findIndex((m) => m.basis !== "none");
  const shown = M.headcountByMonth.slice(points < 0 ? M.headcountByMonth.length : points);
  const chart = await waitForChart(page, shown.length);
  const subtitle = await card.getByText("Active members at month end, from zero", { exact: true }).count(); // net-new-series.ts:46
  L.check("chart", "H1 the Members view is shown: pressed, data-view=members, its subtitle, and an axis labelled \"Active members\"",
    membersPressed === "true" && chart.view === "members" && chart.aria === "Net new members, members view" && subtitle >= 1 && chart.texts.includes("Active members"),
    { pressed: membersPressed, view: chart.view, aria: chart.aria, subtitle, axisLabel: chart.texts.includes("Active members") });
  const ySorted = [...chart.y].sort((a, b) => a.value - b.value);
  const maxHead = Math.max(0, ...shown.map((h) => h.headcount ?? 0));
  L.check("chart", "H2 the headcount axis starts at zero: lowest tick \"0\", drawn at the bottom (largest y)",
    ySorted[0]?.text === "0" && ySorted[0].y === Math.max(...chart.y.map((t) => t.y)) && ySorted.at(-1).value >= maxHead,
    { ticks: chart.y.map((t) => t.text), maxHeadcount: maxHead });
  const drawn = chart.dots.map((d) => valueAt(chart.y, d.cy));
  const want = shown.map((h) => h.headcount ?? 0);
  L.check("chart", "H3 one dot per month with data, each at its month-end headcount (read from the dot's position on the axis)",
    drawn.length === want.length && drawn.every((v, i) => v !== null && Math.abs(v - want[i]) < 0.3),
    { drawn: drawn.map((v) => (v === null ? null : Math.round(v * 100) / 100)), expected: want });
  L.check("chart", "H4 the last point is today and equals the Active members tile",
    drawn.length > 0 && Math.abs(drawn.at(-1) - E.active) < 0.3 && want.at(-1) === E.active, { lastDrawn: drawn.at(-1), today: want.at(-1), activeMembers: E.active });
  // Hover the last dot itself (its page point); without one, this month's x tick at mid-height.
  const lastTick = chart.x.find((t) => t.text === cur.label) ?? chart.x.at(-1);
  const lastDot = chart.dots.at(-1);
  const headAt = lastDot ? [lastDot.px, lastDot.py] : lastTick && chart.box ? [lastTick.cx, chart.box.y + chart.box.height / 2] : null;
  const headTip = headAt ? (await tooltipAt(page, headAt[0], headAt[1], "Active members today")).text : "";
  L.check("chart", "H5 hovering the last point reads \"Active members today: N\" with N = Active members (NetNewMembersCard.tsx:125)",
    headTip.includes(`Active members today: ${fmtNum(E.active)}`), { saw: headTip, expected: `Active members today: ${fmtNum(E.active)}`, at: headAt });
  await shot(page, "headcount-movement-members-view");

  // ── CSV: the Joined rows and the movement rows equal the screen ────────────────────────────────────────────
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.getByRole("button", { name: "Export CSV" }).click()]);
  const csv = parseCsv(fs.readFileSync(await dl.path(), "utf8").replace(/^﻿/, ""));
  const healthRow = (metric) => csv.find((r) => r[0] === "Health" && r[1] === metric) ?? null;
  const csvJoined = {                                                                                        // ReportsView.tsx:384-388
    joined: healthRow(JOINED_LABEL),
    new: healthRow("New this month"), rejoined: healthRow("Rejoined this month"),
    tasters: healthRow("Tasters added this month"), left: healthRow("Left this month"),
  };
  // 24 Oct 2026: a month not wholly recorded says so on every movement row (ReportsView.tsx estimateLabel/withEstimate).
  const estimateWords = cur.basis === "mixed" ? "Partly estimated"
    : cur.basis === "estimated" ? (() => {
      const parts = [];
      if (M.historySource && M.historySource !== "none") parts.push("your TeamUp history");
      if ((M.fromJoinDates ?? 0) > 0) parts.push("join and cancellation dates");
      return parts.length > 0 ? `Estimated from ${parts.join(" and ")}` : "Estimated";
    })() : null;
  const est = (d) => (estimateWords ? `${d} · ${estimateWords}` : d);
  const csvJoinedExpected = {
    joined: ["Health", JOINED_LABEL, String(post.churn.joined), est(`${joinedTileDetail(cur)} · ${DEFINITION}`)],
    new: ["Health", "New this month", String(cur.new), est("First ever start")],
    rejoined: ["Health", "Rejoined this month", String(cur.rejoined), est("Started again after leaving")],
    tasters: ["Health", "Tasters added this month", String(cur.tasterAdded ?? 0), est("Not in Joined or Net")],
    left: ["Health", "Left this month", String(cur.lost), est("Cancelled, or finished a prepaid course")],
  };
  L.check("csv", "C1 CSV Joined rows = the tile: \"Joined this month (new + rejoined)\" with its New · Rejoined · Tasters added · Left · Net detail, then one row per line",
    JSON.stringify(csvJoined) === JSON.stringify(csvJoinedExpected), { saw: csvJoined, expected: csvJoinedExpected });
  const csvWindow = csv.find((r) => r[0] === "Membership movement");
  L.check("csv", "C2 CSV window row = the tally: window, net, \"New · Rejoined · Left (cancelled, completed course) · Tasters added\" (ReportsView.tsx:321)",
    csvWindow?.[1] === `${M.window.from} – ${M.window.to}` && csvWindow?.[2] === String(M.totals.net) && csvWindow?.[3]?.startsWith(`${split(M.totals)} · `),
    { saw: csvWindow, expected: [`${M.window.from} – ${M.window.to}`, M.totals.net, split(M.totals)] });
  const csvMonth = csv.filter((r) => r[0] === "Membership movement by month");
  const csvNow = csvMonth.find((r) => r[1] === cur.label);
  const monthsWithData = M.movementsByMonth.filter((m) => m.basis !== "none");
  L.check("csv", "C3 CSV has one movement row per month with data, and this month's row = the tooltip (net and split; Ivy as imported) (ReportsView.tsx:322-332)",
    csvMonth.length === monthsWithData.length && csvNow?.[2] === String(cur.net) && csvNow?.[3]?.startsWith(split(cur))
      && csvNow?.[3]?.includes(`Brought over by an import without dated history ${cur.imported}`)
      && monthsWithData.every((m) => csvMonth.some((r) => r[1] === m.label && r[2] === String(m.net) && r[3]?.startsWith(split(m)))),
    { rows: csvMonth.length, expectedRows: monthsWithData.length, thisMonth: csvNow, expectedSplit: split(cur), imported: cur.imported });
  const csvHead = csv.filter((r) => r[0] === "Active members at month end");
  const csvHeadNow = csvHead.at(-1);
  L.check("csv", "C4 CSV headcount rows = the Members view, the last \"Today, equals Active members\" = the tile (ReportsView.tsx:333-338)",
    csvHead.length === shown.length && csvHead.every((r, i) => r[1] === shown[i].label && r[2] === String(shown[i].headcount))
      && csvHeadNow?.[2] === String(E.active) && csvHeadNow?.[3]?.startsWith("Today, equals Active members"),
    { rows: csvHead.map((r) => `${r[1]}=${r[2]}`), expected: shown.map((h) => `${h.label}=${h.headcount}`), today: csvHeadNow });

  // ── Members drill-throughs: each Joined-tile line lists exactly the members its events counted ─────────────
  for (const [i, l] of JOINED_LINES.entries()) {
    await page.goto("/dashboard/reports");
    const tile = page.getByTestId("reports-joined-tile").filter({ visible: true }).first();
    await tile.waitFor({ timeout: 90000 });
    const link = tile.getByTestId(`reports-joined-${l.filter}`);
    await link.scrollIntoViewIfNeeded();
    await link.click();
    await page.waitForURL(new RegExp(`/dashboard/members\\?filter=${l.filter}`), { timeout: 60000 });
    const head = await membersHeadline(page);
    const rows = {};
    for (const n of ALL_NAMES) rows[n] = await listed(page, n);
    const want = Object.fromEntries(ALL_NAMES.map((n) => [n, SEED_IN[l.filter].includes(n)]));
    const expectedHead = drillHeadline[l.filter](cur[l.key] ?? 0);
    L.check("drill", `D${i + 1} "${l.label}" opens Members with "${expectedHead.replace(/^\d+/, "N")}" (= the tile line) listing, of the seed, exactly ${SEED_IN[l.filter].join(", ")} — Ivy (import) in none`,
      page.url().includes(`month=${K.now}`) && head === expectedHead && JSON.stringify(rows) === JSON.stringify(want),
      { url: new URL(page.url()).search, head, expectedHead, listed: rows, expected: want });
    if (l.filter === "new-this-month") await shot(page, "headcount-movement-drill-new");
  }
  await page.goto(`/dashboard/members?filter=churned-this-month&month=${K.now}`);
  const drillChurn = await membersHeadline(page);
  const churnRows = { eve: await listed(page, NAMES.eve), cara: await listed(page, NAMES.cara), dan: await listed(page, NAMES.dan) };
  L.check("drill", "D5 the churn drill-through lists the churn count, with Eve and without Cara (reactivated) or Dan (course ended)",
    drillChurn === `${E.cancelled} cancelled this month` && churnRows.eve && !churnRows.cara && !churnRows.dan, { saw: drillChurn, expected: `${E.cancelled} cancelled this month`, ...churnRows });

  // ── Phone width (390 px), same session ─────────────────────────────────────────────────────────────────────
  const phone = await context(browser, "10.96.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await p2.goto("/dashboard/reports");
  const pTile = await readJoinedTile(p2);
  L.check("mobile", "M1 at 390 px the Joined tile shows the same value, lines and net",
    JSON.stringify(pTile) === JSON.stringify(tileExpected), { saw: pTile, expected: tileExpected });
  await p2.getByTestId("net-new-card").scrollIntoViewIfNeeded();
  const pTally = norm(await p2.getByTestId("net-new-tally").innerText());
  L.check("mobile", "M2 at 390 px the tally reads the same", pTally === tallyText(M), { saw: pTally, expected: tallyText(M) });
  const pPressed = await chooseView(p2, "Members");
  const pChart = await waitForChart(p2, shown.length);
  const pDrawn = pChart.dots.map((d) => valueAt(pChart.y, d.cy));
  const pY = [...pChart.y].sort((a, b) => a.value - b.value);
  L.check("mobile", "M3 at 390 px the Members view starts at 0 and its last point equals Active members",
    pPressed === "true" && pY[0]?.text === "0" && pDrawn.length === shown.length && Math.abs((pDrawn.at(-1) ?? -1) - E.active) < 0.3,
    { ticks: pChart.y.map((t) => t.text), lastDrawn: pDrawn.at(-1), activeMembers: E.active, dots: pDrawn.length });
  const pLast = pChart.x.find((t) => t.text === cur.label) ?? pChart.x.at(-1);
  const pLastDot = pChart.dots.at(-1);
  const pAt = pLastDot ? [pLastDot.px, pLastDot.py] : pLast && pChart.box ? [pLast.cx, pChart.box.y + pChart.box.height / 2] : null;
  const pTouch = pAt ? await tooltipAt(p2, pAt[0], pAt[1], "Active members today", true) : { text: "", via: null };
  const pTip = pTouch.text;
  L.check("mobile", "M4 at 390 px touching the last point reads \"Active members today: N\"",
    pTip.includes(`Active members today: ${fmtNum(E.active)}`) && ["tap", "touchmove"].includes(pTouch.via), { saw: pTip, expected: `Active members today: ${fmtNum(E.active)}`, via: pTouch.via, at: pAt });
  const m1 = await noHScroll(p2);
  L.check("mobile", "M5 /dashboard/reports at 390 px has no horizontal page scroll", m1.scroll <= m1.width + 1, m1);
  await shot(p2, "headcount-movement-mobile-reports");
  await p2.goto(`/dashboard/members?filter=new-this-month&month=${K.now}`);
  const pDrill = await membersHeadline(p2);
  L.check("mobile", "M6 at 390 px the New drill-through headline equals the tile line", pDrill === drillHeadline["new-this-month"](cur.new), { saw: pDrill, expected: drillHeadline["new-this-month"](cur.new) });

  L.check("journey", "J2 no uncaught page errors", errors.length === 0, errors);
} catch (e) {
  L.check("journey", "J0 the journey ran to the end", false, String(e?.stack ?? e).slice(0, 500));
} finally {
  if (process.env.HM_CLEANUP === "1") await cleanup().catch((e) => console.log(`  (cleanup failed: ${String(e).slice(0, 120)})`));
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
