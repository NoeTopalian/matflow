// Browser-verification helpers. TEST branch only (env.mjs refuses anything else). Playwright, pg, bcrypt and otplib
// are loaded from the worktree under test (MF_APP), so nothing is installed here.
//
// Importing this module joins the journey lock (harness.mjs joinLock): a journey or fixture.mjs started by the
// runner runs under the runner's lock; one started by hand takes the lock for its lifetime or refuses while a run
// holds it. Fixture state is per run: DATA/runs/<runId>/fixture-state.json, never in git.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { APP, OUT, BASE, testEnv, assertTestUrl } from "../../matflow-verify-local/scripts/env.mjs";
import { joinLock, fixtureStatePath, writeAtomic, readJson } from "./harness.mjs";
export { APP, OUT, BASE };

/** The run this process belongs to (and, for a hand-started process, the lock it holds until exit). */
export const RUN = joinLock(path.basename(process.argv[1] ?? "node"));

const require = createRequire(`${APP}/package.json`);
export const { chromium } = require("@playwright/test");
export const bcrypt = require("bcryptjs");
const pg = require("pg");
const otplib = require("otplib");
export const DB_URL = assertTestUrl(testEnv().DATABASE_URL, "DATABASE_URL");

// Fixture state holds synthetic passwords and authenticator secrets: kept under DATA/runs/<runId>, never printed or
// committed. Written whole (temporary file, then rename), so an interrupted save never leaves half a file.
const STATE = fixtureStatePath(RUN.runId);
export const state = readJson(STATE) ?? {};
export const saveState = () => writeAtomic(STATE, JSON.stringify(state, null, 2));
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const newSecret = () => otplib.generateSecret();

/** One authenticator code per 30 s step, never reused (the server rejects a replayed code). */
export async function freshCode(secret) {
  const last = state.lastStep ?? (state.lastStep = {});
  const key = sha256(secret).slice(0, 12);
  for (;;) {
    const step = Math.floor(Date.now() / 30000);
    if (step > (last[key] ?? 0) && Date.now() % 30000 < 24000) { last[key] = step; saveState(); return otplib.generateSync({ secret }); }
    await sleep(30000 - (Date.now() % 30000) + 600);
  }
}

/** Raw SQL on the TEST branch with RLS bypassed (fixtures and assertions only). */
export async function q(sql, params = []) {
  // Client-side limits too: statement_timeout is enforced by the server, so a connection Neon drops silently would
  // otherwise block a journey forever (a journey hung 5 h on 23 Oct). A timeout fails the step loudly.
  const c = new pg.Client({ connectionString: DB_URL, statement_timeout: 30000, connectionTimeoutMillis: 20000, query_timeout: 45000, keepAlive: true });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.bypass_rls','on',true)");
    // Every timestamp column in this schema is `timestamp` WITHOUT zone holding UTC wall-clock (Prisma's DateTime;
    // no timestamptz anywhere). node-postgres sends a JS Date in the machine's local zone, so during BST it stored and
    // matched an hour off (a 00:00Z day marker became 01:00; review of 23 Oct). Send a Date as its UTC wall-clock.
    const sqlParams = params.map((v) => (v instanceof Date ? v.toISOString().replace("T", " ").replace("Z", "") : v));
    const r = await c.query(sql, sqlParams);
    await c.query("commit");
    return r.rows;
  } catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { await c.end(); }
}

/** PASS / FAIL / NOTE ledger in OUT. Addresses and six-digit codes are scrubbed. */
export function ledger(name) {
  const file = `${OUT}/ledger-${name}.json`;
  const rows = [];
  const scrub = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "[address]").replace(/\b\d{6}\b/g, "[code]").slice(0, 800);
  const add = (result, c, id, saw) => {
    const row = { case: c, id, result, saw: scrub(typeof saw === "string" ? saw : JSON.stringify(saw)), at: new Date().toISOString() };
    rows.push(row); fs.writeFileSync(file, JSON.stringify(rows, null, 2));
    console.log(`${result} [${c}] ${id} — ${row.saw.slice(0, 300)}`);
    return result !== "FAIL";
  };
  return {
    rows, path: file,
    check: (c, id, ok, saw) => add(ok ? "PASS" : "FAIL", c, id, saw),
    note: (c, id, saw) => add("NOTE", c, id, saw),
    summary: () => ["PASS", "FAIL", "NOTE"].map((r) => `${rows.filter((x) => x.result === r).length} ${r}`).join(" / "),
  };
}

/** Full-page screenshot with addresses masked. */
export async function shot(page, name) {
  try {
    // Addresses are masked in the image, never rewritten in the page: rewriting text React had not hydrated yet made
    // React compare the server's address with "[address]" and throw #418 (smoke J3, 29 Oct 2026).
    const address = page.getByText(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/);
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, mask: [address], maskColor: "#6b7280" });
    return `${OUT}/${name}.png`;
  } catch (e) { console.log(`  (screenshot ${name} failed: ${String(e).slice(0, 120)})`); return null; }
}

/** A browser context through the HTTPS proxy. laneIp separates rate-limit buckets between runs. */
export async function context(browser, laneIp, opts = {}) {
  const ctx = await browser.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": laneIp }, viewport: { width: 1440, height: 900 }, ...opts });
  ctx.setDefaultTimeout(60000);
  ctx.setDefaultNavigationTimeout(120000);
  return ctx;
}

/** Club owner sign-in through the real /login form (club code, password, authenticator). */
export async function ownerSignIn(page, club) {
  await page.goto("/login");
  await page.getByLabel("Club code").fill(club.slug);
  await page.keyboard.press("Enter");
  await page.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Email address").first().fill(club.owner.email);
  await page.getByLabel("Password").fill(club.owner.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/login\/totp/, { timeout: 60000 });
  await page.getByLabel("Six-digit authentication code").fill(await freshCode(club.owner.secret));
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/(dashboard|onboarding)/, { timeout: 60000 });
}

/**
 * A staff user in the fixture club, by role: created (or reset) with a known password and, for the roles that must
 * have one, an enrolled authenticator. Synthetic address (example.test). Returns what staffSignIn needs.
 */
export async function seedStaff(club, role, { name = `Fixture ${role}` } = {}) {
  const { randomUUID, randomBytes } = require("node:crypto");
  const email = `${role}-${club.slug}@example.test`;
  // Random per run, as the fixture owner's is; it exists only in this process and as a hash on the test branch.
  const staffPass = randomBytes(18).toString("base64url");
  // Owner, manager and admin must have an authenticator (lib/mfa-policy.ts); a coach signs in without one.
  const secret = role === "coach" ? null : newSecret();
  const rows = await q(
    `insert into "User" (id, "tenantId", email, "passwordHash", name, role, "totpEnabled", "totpSecret", "updatedAt")
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict ("tenantId", email) do update set "passwordHash" = excluded."passwordHash", role = excluded.role, name = excluded.name,
       "totpEnabled" = excluded."totpEnabled", "totpSecret" = excluded."totpSecret", "totpLastUsedStep" = null,
       "failedLoginCount" = 0, "lockedUntil" = null, "mustChangePassword" = false, "updatedAt" = now()
     returning id`,
    [randomUUID(), club.tenantId, email, await bcrypt.hash(staffPass, 10), name, role, !!secret, secret],
  );
  return { id: rows[0].id, email, password: staffPass, secret, role, name };
}

/** Any staff account through the real /login form; the authenticator step only when the server asks for it. */
export async function staffSignIn(page, club, user) {
  await page.goto("/login");
  await page.getByLabel("Club code").fill(club.slug);
  await page.keyboard.press("Enter");
  await page.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Email address").first().fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((u) => u.pathname !== "/login", { timeout: 60000 });
  if (new URL(page.url()).pathname.startsWith("/login/totp")) {
    if (!user.secret) throw new Error(`${user.email} was asked for an authenticator code but has none`);
    await page.getByLabel("Six-digit authentication code").fill(await freshCode(user.secret));
    await page.keyboard.press("Enter");
  }
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
}

// ── Timetable poster grid (components/schedule/PosterGrid.tsx) ───────────────────────────────────────────────────────

/** Chromium with its scrollbars on show: a fit measured without them is about 15 px too generous on Windows. */
export const launchWithScrollbars = () => chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });

/** The staff week grid, one of its days ("mon" … "sun"), and the class chips inside a locator. */
export const weekGrid = (page) => page.getByTestId("week-grid");
export const weekDay = (page, day) => weekGrid(page).locator(`[data-day="${day}"]`);
export const weekChips = (loc) => loc.locator("[data-cell-key] button");

/**
 * The club accent colour. It rides in the session, so it shows only after a fresh sign-in: the caller signs in a
 * new context and asserts the accent the page computes (accentOf) before measuring anything under it.
 */
export async function setAccent(club, hex) {
  await q(`update "Tenant" set "primaryColor" = $2 where id = $1`, [club.tenantId, hex]);
}
/** The accent the page computes, as "r,g,b". */
export const accentOf = (page) => page.evaluate(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(--color-primary)";
  document.body.append(probe);
  const c = getComputedStyle(probe).color.match(/[\d.]+/g).slice(0, 3).map((n) => Math.round(Number(n))).join(",");
  probe.remove();
  return c;
});

/**
 * What the layout must always be, measured in the browser (never from the numbers the engine worked out):
 * every seeded session is on the grid or counted behind a "+N more"; the same start is the same height on the page
 * in every day; a later start is never higher, and strictly lower when it is more than ten minutes later; no two
 * chips intersect; a chip stays inside its day; a chip is at least 44 px tall; no time or name is cut in either axis
 * or leaves its chip; day headers do not spill. The place line may ellipsise, so its text must be in the accessible
 * name of the chip. Returns { problems: string[], … }: the journey asserts problems is empty.
 */
export function gridInvariants(page, { sessions }) {
  return page.evaluate((expected) => {
    const grid = document.querySelector('[data-testid="week-grid"]');
    if (!grid) return { problems: ["no week grid on the page"] };
    const R = (el) => el.getBoundingClientRect();
    const problems = [];
    const cut = (el) => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    const inside = (a, b, slack = 1) => a.left >= b.left - slack && a.right <= b.right + slack && a.top >= b.top - slack && a.bottom <= b.bottom + slack;
    const cells = [...grid.querySelectorAll("[data-cell-key]")];
    const folded = [...grid.querySelectorAll("[data-cell-more]")].reduce((n, m) => n + Number(/\+(\d+)/.exec(m.textContent ?? "")?.[1] ?? 0), 0);
    if (cells.length + folded !== expected) problems.push(`sessions on the grid: ${cells.length} chips + ${folded} folded, seeded ${expected}`);
    const chips = cells.map((cell) => {
      const button = cell.querySelector("button");
      const part = (p) => button?.querySelector(`[data-chip-part="${p}"]`) ?? null;
      const label = button?.getAttribute("aria-label") ?? "";
      const t = /(\d\d):(\d\d)/.exec(part("time")?.textContent ?? "");
      return { cell, button, label, day: cell.closest("[data-day]")?.getAttribute("data-day"), start: t ? Number(t[1]) * 60 + Number(t[2]) : null, time: part("time"), name: part("name"), place: part("place"), r: button ? R(button) : null };
    });
    for (const c of chips) {
      if (!c.button || !c.r) { problems.push("a cell has no chip"); continue; }
      if (c.start === null || !c.time || !c.name) { problems.push(`${c.label}: no time or name part`); continue; }
      if (c.r.height < 43.5) problems.push(`${c.label}: ${c.r.height.toFixed(1)} px tall`);
      for (const [what, el] of [["time", c.time], ["name", c.name]]) {
        if (cut(el)) problems.push(`${c.label}: ${what} is cut (${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight})`);
        if (!inside(R(el), c.r)) problems.push(`${c.label}: ${what} leaves its chip`);
      }
      if (c.place && !c.label.includes((c.place.textContent ?? "").trim())) problems.push(`${c.label}: place "${c.place.textContent}" is not in the accessible name`);
      const head = grid.querySelector(`[data-day-head="${c.day}"]`);
      if (!head) problems.push(`${c.label}: no header for ${c.day}`);
      else if (c.r.left < R(head).left - 1 || c.r.right > R(head).right + 1) problems.push(`${c.label}: outside its day (${c.r.left.toFixed(1)}–${c.r.right.toFixed(1)} against ${R(head).left.toFixed(1)}–${R(head).right.toFixed(1)})`);
      // Split by mat: a chip sits under its own mat's header, never under a neighbour's.
      const dayEl = c.cell.closest("[data-day]");
      const matHeads = dayEl ? [...dayEl.querySelectorAll("[data-mat-head]")] : [];
      if (matHeads.length > 0) {
        const mine = matHeads.find((h) => h.getAttribute("data-mat-head") === (c.cell.getAttribute("data-mat") ?? ""));
        if (!mine) problems.push(`${c.label}: no mat header for its column`);
        else if (c.r.left < R(mine).left - 1 || c.r.right > R(mine).right + 1) problems.push(`${c.label}: outside its mat column "${(mine.textContent ?? "").trim()}"`);
      }
    }
    // Mat headers show their name in full, or carry it in `title` when two lines are not enough.
    for (const head of grid.querySelectorAll("[data-mat-head]")) {
      const text = head.querySelector(".pg-mat-pill > span");
      if (text && (text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1) && head.getAttribute("title") !== (text.textContent ?? "")) {
        problems.push(`mat header "${text.textContent}" is cut and has no title`);
      }
    }
    const placed = chips.filter((c) => c.r && c.start !== null);
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i], b = placed[j];
        const [early, late] = a.start <= b.start ? [a, b] : [b, a];
        if (early.start === late.start && Math.abs(early.r.top - late.r.top) > 1) problems.push(`${early.label} and ${late.label}: same start, tops ${early.r.top.toFixed(1)} and ${late.r.top.toFixed(1)}`);
        if (late.start > early.start && late.r.top < early.r.top - 1) problems.push(`${late.label} starts later than ${early.label} but sits higher`);
        if (late.start - early.start > 10 && late.r.top <= early.r.top + 1) problems.push(`${late.label} starts over ten minutes after ${early.label} but is not lower`);
      }
    }
    // "+N more" buttons take a place on the grid like any chip: tall enough, inside their day, on top of nothing.
    const mores = [...grid.querySelectorAll("[data-cell-more]")].map((cell) => {
      const button = cell.querySelector("button");
      return { button, label: button?.getAttribute("aria-label") ?? "+N more", day: cell.closest("[data-day]")?.getAttribute("data-day"), r: button ? R(button) : null };
    });
    for (const m of mores) {
      if (!m.button || !m.r) { problems.push("a '+N more' cell has no button"); continue; }
      if (m.r.height < 43.5) problems.push(`${m.label}: ${m.r.height.toFixed(1)} px tall`);
      if (cut(m.button)) problems.push(`${m.label}: its text is cut`);
      const head = grid.querySelector(`[data-day-head="${m.day}"]`);
      if (!head || m.r.left < R(head).left - 1 || m.r.right > R(head).right + 1) problems.push(`${m.label}: outside its day`);
    }
    const boxes = [...placed, ...mores.filter((m) => m.r)];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (x > 1 && y > 1) problems.push(`${a.label} and ${b.label} intersect (${x.toFixed(1)} x ${y.toFixed(1)} px)`);
      }
    }
    for (const head of grid.querySelectorAll("[data-day-head]")) {
      const day = head.getAttribute("data-day-head");
      if (cut(head)) problems.push(`${day} header spills (${head.scrollWidth}x${head.scrollHeight} in ${head.clientWidth}x${head.clientHeight})`);
      for (const el of head.querySelectorAll("*")) if (R(el).width > 0 && !inside(R(el), R(head))) problems.push(`${day} header: "${(el.textContent ?? "").trim()}" leaves the header`);
    }
    const widths = placed.map((c) => c.r.width), heights = placed.map((c) => c.r.height);
    return {
      problems, chips: cells.length, folded,
      narrowestChip: widths.length ? Math.round(Math.min(...widths) * 10) / 10 : null,
      shortestChip: heights.length ? Math.round(Math.min(...heights) * 10) / 10 : null,
      dayDisplay: getComputedStyle(grid.querySelector("[data-day]")).display,
    };
  }, sessions);
}

/**
 * Nothing but the box of the week scrolls sideways: not <main> (the scrollport of the shell at 768 px and wider),
 * not the document; and no chip hangs outside the grid itself (a chip pushed past the grid's own edge would be in
 * the box's scrollable area by definition, so the grid's rectangle is what it is measured against).
 */
export function noSidewaysScroll(page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const box = document.querySelector('[data-testid="week-scroller"]');
    const grid = document.querySelector('[data-testid="week-grid"]');
    const out = {
      mainScrolls: !!main && main.scrollWidth > main.clientWidth + 1,
      documentScrolls: document.documentElement.scrollWidth > window.innerWidth + 1,
      boxScrolls: !!box && box.scrollWidth > box.clientWidth + 1,
      chipsOutsideGrid: 0,
    };
    if (grid) {
      const g = grid.getBoundingClientRect();
      for (const chip of grid.querySelectorAll("[data-cell-key] button, [data-cell-more] button")) {
        const r = chip.getBoundingClientRect();
        if (r.left < g.left - 1 || r.right > g.right + 1) out.chipsOutsideGrid += 1;
      }
    }
    return { ...out, ok: !!grid && !out.mainScrolls && !out.documentScrolls && out.chipsOutsideGrid === 0 };
  });
}

/** Pixels to spare: the inner width of the box less the narrowest the grid can be. Negative = the box scrolls. A NOTE. */
export const spare = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-testid="week-scroller"]');
  const grid = document.querySelector('[data-testid="week-grid"]');
  return box && grid ? Math.round((box.clientWidth - parseFloat(getComputedStyle(grid).minWidth)) * 10) / 10 : null;
});

/**
 * Contrast ratio of the text of a locator against what is actually behind it: translucent backgrounds are composited
 * up the ancestors until one is opaque (white if none is), and the opacity of the element and of its ancestors is
 * applied to the ink. Colours are resolved by a canvas, so color-mix() and color(srgb …) values measure correctly.
 */
export function contrast(locator) {
  return locator.evaluate((el) => {
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    const rgba = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? [0, 0, 0, 0] : [r, g, b, a / 255];
    };
    const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3]));
    const layers = [];
    let opacity = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      opacity *= Number(cs.opacity);
      layers.push(rgba(cs.backgroundColor));
      if (layers[layers.length - 1][3] === 1) break;
    }
    let bg = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i][3] > 0) bg = over(layers[i], bg);
    const ink = rgba(getComputedStyle(el).color);
    const fg = over([ink[0], ink[1], ink[2], ink[3] * opacity], bg);
    const lum = (c) => c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  });
}

/**
 * The focus outline an element shows and its contrast against the surface it is drawn on (the first opaque
 * background up the ancestors, composited as contrast() does).
 */
export function focusRing(locator) {
  return locator.evaluate((el) => {
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
    const rgba = (css) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#000";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return a === 0 ? [0, 0, 0, 0] : [r, g, b, a / 255];
    };
    const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3]));
    const layers = [];
    for (let n = el.parentElement; n; n = n.parentElement) {
      layers.push(rgba(getComputedStyle(n).backgroundColor));
      if (layers[layers.length - 1][3] === 1) break;
    }
    let bg = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i][3] > 0) bg = over(layers[i], bg);
    const cs = getComputedStyle(el);
    const ring = over(rgba(cs.outlineColor), bg);
    const lum = (c) => c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0);
    const [hi, lo] = [lum(ring), lum(bg)].sort((a, b) => b - a);
    return {
      focused: document.activeElement === el, focusVisible: el.matches(":focus-visible"),
      style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), color: cs.outlineColor,
      contrast: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
    };
  });
}
