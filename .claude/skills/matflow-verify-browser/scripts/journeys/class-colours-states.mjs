// Booked member blocks in every state, every palette colour (synthetic data only), measured as Chromium paints them.
//   node run-journeys.mjs class-colours-states
// A booked block's text is informational (its class, its time, its state) and the block stays an active control (it
// opens the session sheet), so WCAG 1.4.3's "inactive component" exception does not apply: 4.5:1 for the name and for
// the state pill's word, in every state.
// Each palette colour is booked today twice, each in its own 15-minute slot (the schedule shows at most three
// same-time lanes): once upcoming, once ended. The three weakest colours (blue, purple, red) are also booked live,
// side by side. For every REAL block the journey reads
// its fill stops, its ink, its filter and its state pill's background, paints probe patches with exactly those in the
// same page, screenshots them and decodes the pixels (a CSS filter or a translucent pill cannot be read from styles).
// A cancelled pill is the same booked-pill style with another border colour, so it is covered by the live and ended
// pills here. Run between 03:45 and 19:00 London time (fourteen ended and fourteen upcoming slots must fit in today).
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, memberLogin, memberSignIn } from "../lib.mjs";

const require = createRequire(import.meta.url);
const { PNG } = require("pngjs");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("class-colours-states");
const TAG = randomUUID().slice(0, 4);
const PALETTE = [
  ["#3b82f6", "Blue"], ["#8b5cf6", "Purple"], ["#ec4899", "Pink"], ["#ef4444", "Red"], ["#f97316", "Orange"],
  ["#eab308", "Yellow"], ["#22c55e", "Green"], ["#14b8a6", "Teal"], ["#06b6d4", "Cyan"], ["#6366f1", "Indigo"],
  ["#93c5fd", "Light blue"], ["#1e3a8a", "Navy"], ["#94a3b8", "Grey"], ["#fde68a", "Light yellow"],
];
const london = (plusMin) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + plusMin * 60_000));
const londonDow = () => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "short" }).format(new Date()));
const lum = (rgb) => rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };

// Slots: ended i runs from (now - 225 + 15i) for 10 minutes; upcoming i from (now + 60 + 15i); live: now - 5 to now + 45.
const slot = (base, i) => [london(base + 15 * i), london(base + 15 * i + 10)];
const plan = [
  ...PALETTE.map(([hex, name], i) => ({ hex, name, kase: "ended", win: slot(-225, i) })),
  ...PALETTE.map(([hex, name], i) => ({ hex, name, kase: "upcoming", win: slot(60, i) })),
  ...PALETTE.filter(([, n]) => ["Blue", "Purple", "Red"].includes(n)).map(([hex, name]) => ({ hex, name, kase: "live", win: [london(-5), london(45)] })),
];
const first = plan[0].win[0], last = plan.filter((p) => p.kase === "upcoming").at(-1).win[1];
if (!(first < london(-200) && last > london(200) && first < last)) throw new Error(`run between 03:45 and 19:00 London time (slots ${first} to ${last})`);

const browser = await chromium.launch();
const errors = [];
try {
  const ctx = await context(browser, "10.96.8.1", { viewport: { width: 1440, height: 900 }, timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await ownerSignIn(page, club);
  const day = londonDow();
  const ids = [];
  for (const { hex, name, kase, win: [s, e] } of plan) {
    const r = await page.evaluate(async ([n, d, c, st, en]) => {
      const res = await fetch("/api/classes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n, duration: 10, color: c, schedules: [{ dayOfWeek: d, startTime: st, endTime: en }] }) });
      return { status: res.status, body: await res.json() };
    }, [`${name} ${kase} ${TAG}`, day, hex, s, e]);
    if (r.status !== 201) throw new Error(`create ${name} ${kase}: ${r.status}`);
    ids.push(r.body.id);
  }
  const member = await memberLogin(club);
  for (const id of ids) await q(`insert into "ClassSubscription" (id, "memberId", "classId") values ($1, $2, $3) on conflict do nothing`, [randomUUID(), member.id, id]);

  const results = {};
  for (const [bg, shellName] of [["#111111", "dark"], ["#ffffff", "light"]]) {
    const saved = await page.evaluate(async (b) => (await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ bgColor: b }) })).status, bg);
    if (saved !== 200) throw new Error(`settings ${saved}`);
    const mctx = await context(browser, `10.96.8.${shellName === "dark" ? 2 : 3}`, { viewport: { width: 1440, height: 1400 }, timezoneId: "Europe/London" });
    const mp = await mctx.newPage();
    mp.on("pageerror", (e) => errors.push(e.message));
    await memberSignIn(mp, club, member);
    await mp.goto("/member/schedule");
    await mp.waitForFunction((b) => getComputedStyle(document.querySelector("[style*='--member-bg']") ?? document.body).getPropertyValue("--member-bg").trim().toLowerCase() === b, bg, { timeout: 30_000 });
    await mp.locator("button[data-booked]").first().waitFor({ timeout: 30_000 });
    await shot(mp, `class-colours-states-${shellName}`);

    // Every REAL booked block of this run: fill stops, ink, filter, and its state pill (if any).
    const blocks = await mp.evaluate((tag) => [...document.querySelectorAll("button[data-booked]")].filter((b) => b.textContent.includes(tag)).map((el) => {
      const cs = getComputedStyle(el);
      const name = el.querySelector("[data-block-part='name']")?.textContent ?? "";
      // The innermost span whose text is the state word: the pill itself, not a wrapper that holds only the pill.
      const pill = [...el.querySelectorAll("span")].filter((s) => /^(live|next|ended|cancelled)$/i.test(s.textContent.trim())).at(-1);
      return {
        name, state: el.getAttribute("data-session-state"), stops: cs.backgroundImage.match(/rgba?\([^)]*\)/g) ?? [], ink: cs.color, filter: cs.filter,
        pill: pill ? { word: pill.textContent.trim(), bg: getComputedStyle(pill).backgroundColor, ink: getComputedStyle(pill).color } : null,
      };
    }), TAG);
    const cases = [];
    for (const b of blocks) for (const [si, stop] of b.stops.entries()) {
      cases.push([b.name, b.state, `name stop${si}`, stop, null, b.filter, b.ink]);
      if (b.pill) cases.push([b.name, b.state, `pill "${b.pill.word}" stop${si}`, stop, b.pill.bg, b.filter, b.pill.ink]);
    }
    await mp.evaluate((cs) => {
      const host = document.createElement("div");
      host.id = "mf-probes";
      host.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;display:grid;grid-template-columns:repeat(40,24px);background:#808080;";
      cs.forEach(([, , , stop, layer, filter, ink]) => {
        for (const [kind, paint] of [["bg", stop], ["ink", ink]]) {
          const outer = document.createElement("div");
          outer.style.cssText = `width:24px;height:24px;background:${paint};filter:${filter};`;
          if (kind === "bg" && layer) { const inner = document.createElement("div"); inner.style.cssText = `width:24px;height:24px;background:${layer};`; outer.appendChild(inner); }
          host.appendChild(outer);
        }
      });
      document.body.appendChild(host);
    }, cases);
    const png = PNG.sync.read(await mp.locator("#mf-probes").screenshot());
    const at = (idx) => { const x = (idx % 40) * 24 + 12, y = Math.floor(idx / 40) * 24 + 12; const o = (png.width * y + x) * 4; return [png.data[o], png.data[o + 1], png.data[o + 2]]; };
    results[shellName] = {
      blocks: blocks.length,
      states: [...new Set(blocks.map((b) => b.state))],
      filters: [...new Set(blocks.map((b) => b.filter))],
      pillBgs: [...new Set(blocks.filter((b) => b.pill).map((b) => b.pill.bg))],
      measured: cases.map(([name, st, kase], i) => ({ name, state: st, kase, ratio: ratio(at(i * 2 + 1), at(i * 2)) })),
    };
    await mctx.close();
  }

  const under = [], worst = {};
  for (const [shell, r] of Object.entries(results)) for (const m of r.measured) {
    if (m.ratio < 4.5) under.push({ shell, ...m });
    const k = `${m.state} ${m.kase.replace(/ stop\d/, "").replace(/"[^"]*"/, "")}`;
    if (!worst[k] || m.ratio < worst[k].ratio) worst[k] = { shell, name: m.name, ratio: m.ratio };
  }
  const seen = Object.fromEntries(Object.entries(results).map(([s, r]) => [s, { blocks: r.blocks, states: r.states, filters: r.filters, pillBgs: r.pillBgs }]));
  L.check("S0", "every palette colour is on the page booked as upcoming and ended (blue, purple and red also live), on both shells", Object.values(results).every((r) => r.blocks >= plan.length && ["ended", "live"].every((s) => r.states.includes(s)) && (r.states.includes("upcoming") || r.states.includes("next"))), seen);
  L.note("S1", "worst measured ratio per state and part (pixels; both shells; every colour; both gradient stops)", { worst });
  L.check("S2", "every booked block's name and state pill reach 4.5:1 in every state, every colour, both shells", under.length === 0, { under: under.slice(0, 40), count: under.length });
  L.check("errors", "no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
