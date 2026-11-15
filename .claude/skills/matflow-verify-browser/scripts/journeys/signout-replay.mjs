// Sign-out must end THIS session on the server, and a response that was already on its way cannot bring it back
// (Round 8, 15 Nov 2026). Deterministic: no timing trials.
//   node run-journeys.mjs signout-replay
//
// Each scenario signs a staff member (owner, manager or admin, in turn) in afresh (a sign-out that works on the server ends the session, so sessions
// are never shared between scenarios), then:
//   1. HOLDS an authenticated response in the browser: the server has answered (and re-issued the session cookie, as
//      the next-auth proxy wrapper does on every request), but the browser has not received it yet. Paths: the
//      timetable's own /api/locations read, and the sidebar's automatic route prefetches.
//   2. Signs out through the real menu (desktop account menu; phone More → Sign out) and waits for /login.
//   3. RELEASES the held response, so its Set-Cookie reaches the browser after the sign-out.
//   4. Asserts, separately:
//        server — replaying the cookie the browser held before sign-out, and the cookie the held response carried,
//                 against a protected API (/api/locations) and a protected page (/dashboard) is refused;
//        client — whatever session cookie the browser holds after the held response arrives is refused (a late
//                 response may put one back until the next request), and opening the dashboard (in the signing-out
//                 tab and, with two tabs, the other one) is sent to /login. In one tab the sign-out navigation can
//                 cancel the held response before delivery; that case is recorded as not exercised, never as a pass.
//        identity — the held response's re-issued token carries the SAME session id as the signed-out session: a late
//                 response cannot mint a fresh identity that escapes the sign-out.
//   One-tab and two-tab variants; desktop and phone. Plus:
//   F  the sign-out request never reaches the server: the person is told, the session stays usable, a retry works;
//   X  the server records the sign-out but its answer is lost: the old cookie is refused, the person is told it did
//      not complete (the browser cannot know), and a retry signs out cleanly (repeating a sign-out is safe);
//   D  another device's independent session stays valid after this one signs out ("sign out everywhere" is separate,
//      covered by the round5-sign-out-everywhere journey);
//   L  the release transition: a cookie minted before session ids keeps working (nobody is signed out by the deploy),
//      every copy of it is given the same derived id, and signing one copy out ends that person's other pre-release
//      copies — including an original copy presented later — while a session signed in after the release stays valid.
// The checks state the REQUIRED behaviour. On code without per-session revocation (before 16 Nov 2026) the server
// checks fail: that is the defect this journey reproduced (runs rmwhyvwpt428bc4, rmwhzuiqx419598).
// Session cookies are credentials: the ledger records cookie names, sizes and yes/no facts about their claims, never
// a value. Decoding uses the test environment's secret (.env.test), as the server does.
import { createRequire } from "node:module";
import { encode, decode } from "next-auth/jwt";
import { state, ledger, shot, context, ownerSignIn, seedStaff, staffSignIn, chromium, BASE } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const require = createRequire(import.meta.url);
const { devices, request } = require("@playwright/test");
const club = state.club;
if (!club?.slug?.startsWith("mfv-")) throw new Error("Create a synthetic fixture first");
const L = ledger("signout-replay");
let LANE = "10.88.8.50";
/** A fresh client address per sign-in: the sign-in rate limit is per address, and this journey signs in nine times. */
let laneN = 50;
const nextLane = () => (LANE = `10.88.8.${++laneN}`);
const COOKIE = /^(?:__Secure-)?(?:authjs|next-auth)\.session-token(?:\.\d+)?$/;

const browser = await chromium.launch();

async function device(kind) {
  if (kind === "desktop") return context(browser, LANE);
  const ctx = await browser.newContext({ ...devices["iPhone 13"], baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": LANE }, serviceWorkers: "block" });
  ctx.setDefaultTimeout(60_000);
  ctx.setDefaultNavigationTimeout(120_000);
  return ctx;
}
const sessionCookies = async (ctx) => (await ctx.cookies()).filter((c) => COOKIE.test(c.name));
const cookieHeader = (cs) => cs.map((c) => `${c.name}=${c.value}`).join("; ");
/** Session cookies a response's Set-Cookie writes (values only; a clearing cookie has an empty value). */
function setSession(headersArray) {
  return headersArray.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value.split(";")[0]).map((kv) => {
    const i = kv.indexOf("=");
    return { name: kv.slice(0, i), value: kv.slice(i + 1) };
  }).filter((c) => COOKIE.test(c.name) && c.value);
}

/** For the ledger: cookie names and sizes only, never values (they are live session credentials until revoked). */
const safe = (held) => held.map(({ setsSession, ...h }) => ({ ...h, setsSession: (setsSession ?? []).map((c) => `${c.name} (${c.value.length} chars)`) }));

// ── Reading the session id inside a cookie (never logged) ──
const env = testEnv();
const SECRET = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
if (!SECRET) throw new Error("no AUTH secret in .env.test");
/** A session cookie may be split into numbered chunks; the token is their values in order, under the base name. */
function joinToken(cs) {
  const n = (c) => Number(/\.(\d+)$/.exec(c.name)?.[1] ?? 0);
  return { name: cs[0].name.replace(/\.\d+$/, ""), value: [...cs].sort((a, b) => n(a) - n(b)).map((c) => c.value).join("") };
}
async function claimsOf(cs) {
  if (!cs?.length) return null;
  const { name, value } = joinToken(cs);
  try { return await decode({ token: value, secret: SECRET, salt: name }); } catch { return null; }
}
const sidOf = async (cs) => (await claimsOf(cs))?.sid ?? null;

// Authenticator checks are limited to 5 per user per 10 minutes (app/api/auth/totp/verify/route.ts), and this journey
// signs in fourteen times, so sign-ins rotate over four accounts that each must enrol an authenticator: owner, manager
// and admin take the ten rotating sign-ins; the coach takes the four fixed ones (D and L).
const accounts = [
  null,
  await seedStaff(club, "manager", { name: "Replay manager" }),
  await seedStaff(club, "admin", { name: "Replay admin" }),
  await seedStaff(club, "coach", { name: "Replay coach" }),
];
const COACH = 3;
/** How many scenarios actually exercised the late-response checks (a NOTE is not a pass; review finding 2, 16 Nov). */
const exercised = { reissueReplayed: 0, browserCookieAfterLateResponse: 0 };
let signIns = 0;
async function signIn(page, tag, fixed) {
  const who = fixed !== undefined ? accounts[fixed] : accounts[signIns++ % accounts.length];
  try { if (who) await staffSignIn(page, club, who); else await ownerSignIn(page, club); } catch (e) { await shot(page, `signout-replay-signin-${tag.replace(/\//g, "-")}`); throw e; }
}

/** Server-side: does this cookie still open a protected API and a protected page? */
async function replay(cs) {
  if (!cs.length) return { skipped: true };
  const api = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-lane-ip": LANE, cookie: cookieHeader(cs) } });
  try {
    const a = await api.get("/api/locations", { maxRedirects: 0 });
    const p = await api.get("/dashboard", { maxRedirects: 0 });
    const loc = p.headers()["location"] ?? "";
    return { apiStatus: a.status(), pageStatus: p.status(), pageLocation: loc.replace(/^https?:\/\/[^/]+/, ""), refused: a.status() === 401 && p.status() >= 300 && p.status() < 400 && /\/login/.test(loc) };
  } finally { await api.dispose(); }
}

async function signOut(page, kind) {
  if (kind === "desktop") {
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "More options" }).tap();
    await page.getByRole("button", { name: "Sign out", exact: true }).filter({ visible: true }).first().tap();
  }
}
const landsOnLogin = async (page, path) => {
  await page.goto(path).catch(() => {});
  const ok = await page.waitForURL(/\/login/, { timeout: 30_000 }).then(() => true, () => false);
  return { ok, url: page.url().replace(/^https:\/\/[^/]+/, "") };
};

/** Hold every matching response on `page` until release(); returns the holder. */
function holdOn(page, match) {
  const held = [];
  let release;
  const released = new Promise((r) => (release = r));
  page.route("**/*", async (route) => {
    const req = route.request();
    if (!match(req)) return route.fallback();
    let resp;
    try { resp = await route.fetch(); } catch (e) { held.push({ url: req.url(), error: String(e).slice(0, 120) }); return; }
    const rec = { url: new URL(req.url()).pathname, status: resp.status(), setsSession: setSession(await resp.headersArray()), delivered: false };
    held.push(rec);
    await released;
    try { await route.fulfill({ response: resp }); rec.delivered = true; } catch (e) { rec.deliverError = String(e).slice(0, 120); }
  });
  return { held, release: () => release() };
}
const isLocations = (req) => new URL(req.url()).pathname === "/api/locations" && req.method() === "GET";
const isPrefetch = (req) => !!req.headers()["next-router-prefetch"];

async function scenario({ kind, path, tabs }) {
  const tag = `${kind}/${path}/${tabs}`;
  nextLane();
  const ctx = await device(kind);
  const signer = await ctx.newPage();
  await signIn(signer, tag);
  const before = await sessionCookies(ctx);
  const holderPage = tabs === "two" ? await ctx.newPage() : signer;
  const hold = holdOn(holderPage, path === "locations" ? isLocations : isPrefetch);
  if (tabs === "two") {
    await signer.goto("/dashboard/members");
    await signer.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
  }
  await holderPage.goto("/dashboard/timetable");
  await holderPage.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
  // The timetable reads /api/locations itself and the sidebar prefetches on load; wait until the server has answered one.
  let waited = 0;
  while (!hold.held.some((h) => h.status) && waited < 30_000) { await holderPage.waitForTimeout(250); waited += 250; }
  let triggered = "page";
  if (!hold.held.some((h) => h.status) && path === "locations") {
    triggered = "script";
    await holderPage.evaluate(() => { void fetch("/api/locations").catch(() => {}); });
    while (!hold.held.some((h) => h.status) && waited < 60_000) { await holderPage.waitForTimeout(250); waited += 250; }
  }
  const heldOne = hold.held.find((h) => h.status);
  L.check("setup", `${tag} H an authenticated response is held after the server answered it`, !!heldOne && heldOne.status < 400, { triggered, held: safe(hold.held.slice(0, 3)) });

  await signOut(signer, kind);
  const signedOutUi = await signer.waitForURL(/\/login/, { timeout: 60_000 }).then(() => true, () => false);
  L.check("client", `${tag} U1 the signing-out tab lands on /login`, signedOutUi, { url: signer.url() });
  const afterSignOut = await sessionCookies(ctx);

  hold.release();
  await holderPage.waitForTimeout(3000);
  const delivered = hold.held.filter((h) => h.delivered).length;
  const reissued = hold.held.flatMap((h) => h.setsSession);
  const afterRelease = await sessionCookies(ctx);
  L.note("client", `${tag} cookies`, { before: before.length, afterSignOut: afterSignOut.length, delivered, heldResponsesSettingSession: reissued.length, afterRelease: afterRelease.length });

  const r0 = await replay(before);
  L.check("server", `${tag} R1 replaying the cookie held before sign-out is refused (API 401, dashboard → /login)`, r0.refused === true, r0);
  // Every chunk of the first re-issued session cookie (a large token is split into .0, .1, …).
  const firstReissue = hold.held.find((h) => h.setsSession?.length)?.setsSession ?? [];
  const r1 = await replay(firstReissue);
  if (r1.skipped) L.note("server", `${tag} R2 the held response re-issued no session cookie: nothing to replay`, {});
  else {
    exercised.reissueReplayed++;
    L.check("server", `${tag} R2 replaying the cookie the held response re-issued is refused`, r1.refused === true, { chunks: firstReissue.length, ...r1 });
    const sidBefore = await sidOf(before);
    const sidReissued = await sidOf(firstReissue);
    L.check("server", `${tag} S1 the held response carries the signed-out session's own id, not a fresh one`,
      !!sidBefore && sidReissued === sidBefore, { beforeHasId: !!sidBefore, reissuedHasId: !!sidReissued, same: sidReissued === sidBefore });
  }

  // Client: only meaningful if the held response actually reached the browser. In one tab the sign-out navigation
  // usually cancels it first — then the browser-side restore was not exercised, and that is said, not passed.
  if (delivered === 0 || afterRelease.length === 0) {
    // Cancelled before delivery, or delivered to a document already gone (one tab): the browser kept no cookie, so the
    // late-response restore did not happen in this run — not exercised, never a pass.
    L.note("client", `${tag} U2 not exercised: the late response restored no cookie in this run`, { delivered, held: hold.held.map((h) => h.deliverError ?? h.error ?? (h.delivered ? "delivered" : "pending")).slice(0, 3) });
  } else {
    // A late response may put a cookie back until the next request; what matters is that the server refuses it.
    exercised.browserCookieAfterLateResponse++;
    const rb = await replay(afterRelease);
    L.check("client", `${tag} U2 whatever session cookie the browser holds after the held response arrives is refused by the server`,
      rb.refused === true, { names: afterRelease.map((c) => c.name), delivered, replay: rb });
  }
  const u3 = await landsOnLogin(signer, "/dashboard/timetable");
  if (!u3.ok) await shot(signer, `signout-replay-${kind}-${path}-${tabs}`);
  L.check("client", `${tag} U3 the dashboard then sends this tab to /login`, u3.ok, u3);
  if (tabs === "two") {
    const u4 = await landsOnLogin(holderPage, "/dashboard/members");
    L.check("client", `${tag} U4 the other tab's next navigation is sent to /login`, u4.ok, u4);
  }
  await ctx.close();
}

const ERROR_TEXT = /couldn.t sign you out/i;
const errorVisible = (page) => page.getByText(ERROR_TEXT).first().isVisible().catch(() => false);
const path = (page) => page.url().replace(/^https:\/\/[^/]+/, "");

/** F: the sign-out request never reaches the server. */
async function failedSignOut(kind) {
  const tag = `${kind}/signout-fails`;
  nextLane();
  const ctx = await device(kind);
  const page = await ctx.newPage();
  await signIn(page, tag);
  const before = await sessionCookies(ctx);
  await page.goto("/dashboard/timetable");
  await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
  let posted = 0;
  await page.route("**/api/auth/signout", (route) => { posted++; return route.abort("failed"); });
  await signOut(page, kind);
  await page.waitForTimeout(5000);
  const url = path(page);
  const onLogin = /\/login/.test(url);
  const errorShown = await errorVisible(page);
  const r = await replay(before);
  L.note("failure", `${tag} what happened`, { signoutRequests: posted, url, onLogin, cookieLeft: (await sessionCookies(ctx)).length, errorShown, serverStillAccepts: r.refused === false });
  if (!errorShown) await shot(page, `signout-replay-${kind}-fails`);
  L.check("client", `${tag} F1 the page does not show /login while the session is still valid`, !(onLogin && r.refused === false), { url, server: r });
  L.check("client", `${tag} F2 the person is told the sign-out did not complete`, errorShown, { url });
  L.check("server", `${tag} F3 nothing was recorded, so the session is still usable (API 200, dashboard 200)`, r.apiStatus === 200 && r.pageStatus === 200, r);
  await page.unroute("**/api/auth/signout");
  await signOut(page, kind);
  const retried = await page.waitForURL(/\/login/, { timeout: 60_000 }).then(() => true, () => false);
  const r2 = await replay(before);
  L.check("client", `${tag} F4 trying again signs out (lands on /login)`, retried, { url: path(page) });
  L.check("server", `${tag} F5 after the retry the old cookie is refused`, r2.refused === true, r2);
  await ctx.close();
}

/** X: the server records the sign-out, but its answer never reaches the browser. */
async function lostResponse(kind) {
  const tag = `${kind}/signout-answer-lost`;
  nextLane();
  const ctx = await device(kind);
  const page = await ctx.newPage();
  await signIn(page, tag);
  const before = await sessionCookies(ctx);
  await page.goto("/dashboard/timetable");
  await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
  let serverStatus = null;
  await page.route("**/api/auth/signout", async (route) => {
    try { serverStatus = (await route.fetch()).status(); } catch (e) { serverStatus = String(e).slice(0, 80); }
    return route.abort("failed");
  });
  await signOut(page, kind);
  await page.waitForTimeout(5000);
  const url = path(page);
  const errorShown = await errorVisible(page);
  const r = await replay(before);
  L.check("server", `${tag} X1 the server ended the session although its answer was lost: the old cookie is refused`, serverStatus === 200 && r.refused === true, { serverStatus, ...r });
  L.check("client", `${tag} X2 the person is told the sign-out did not complete (the browser never heard back)`, errorShown && !/\/login/.test(url), { url, errorShown });
  await page.unroute("**/api/auth/signout");
  await signOut(page, kind);
  const retried = await page.waitForURL(/\/login/, { timeout: 60_000 }).then(() => true, () => false);
  L.check("client", `${tag} X3 trying again signs out cleanly (repeating a sign-out is safe)`, retried, { url: path(page) });
  await ctx.close();
}

async function otherDeviceSurvives() {
  nextLane();
  const other = await device("desktop");
  const op = await other.newPage();
  await signIn(op, "other-device-a", COACH); // the same person on both devices
  const otherCookies = await sessionCookies(other);
  nextLane();
  const ctx = await device("desktop");
  const page = await ctx.newPage();
  await signIn(page, "other-device-b", COACH);
  await page.goto("/dashboard/timetable");
  await page.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
  const sidA = await sidOf(otherCookies);
  const sidB = await sidOf(await sessionCookies(ctx));
  L.check("server", "D0 two sign-ins of the same person are two sessions with different ids", !!sidA && !!sidB && sidA !== sidB, { bothHaveIds: !!sidA && !!sidB, different: sidA !== sidB });
  await signOut(page, "desktop");
  await page.waitForURL(/\/login/, { timeout: 60_000 });
  const r = await replay(otherCookies);
  L.check("server", "D1 another device's session still opens the API and the dashboard after this one signs out", r.apiStatus === 200 && r.pageStatus === 200, r);
  await op.goto("/dashboard/timetable");
  L.check("client", "D2 the other device's dashboard still loads", !/\/login/.test(op.url()), { url: path(op) });
  await other.close();
  await ctx.close();
}

/** L: cookies minted before session ids existed. */
async function releaseTransition() {
  nextLane();
  const minter = await device("desktop");
  const mp = await minter.newPage();
  await signIn(mp, "transition-mint", COACH);
  const fresh = await sessionCookies(minter);
  const claims = await claimsOf(fresh);
  if (!claims?.sid) throw new Error("expected a session id in a fresh sign-in");
  // The same person's claims with no session id: what a cookie issued before this release decodes to.
  const { sid: _sid, iat: _iat, exp: _exp, jti: _jti, ...preRelease } = claims;
  const name = joinToken(fresh).name;
  const oldValue = await encode({ token: preRelease, secret: SECRET, salt: name, maxAge: 30 * 24 * 60 * 60 });
  const oldCookie = [{ name, value: oldValue }];
  await minter.close();

  const preReleaseDevice = async () => {
    nextLane();
    const ctx = await device("desktop");
    await ctx.addCookies([{ name, value: oldValue, url: BASE, httpOnly: true, secure: true, sameSite: "Lax" }]);
    return ctx;
  };
  const A = await preReleaseDevice();
  const B = await preReleaseDevice();
  const r0 = await replay(oldCookie);
  L.check("legacy", "L1 a pre-release cookie still works after the release (the deploy signs nobody out)", r0.apiStatus === 200 && r0.pageStatus === 200, r0);
  const pa = await A.newPage();
  await pa.goto("/dashboard/timetable");
  await pa.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
  const pb = await B.newPage();
  await pb.goto("/dashboard/timetable");
  await pb.locator("main").getByRole("heading", { level: 1 }).first().waitFor({ timeout: 90_000 });
  const sa = await sidOf(await sessionCookies(A));
  const sb = await sidOf(await sessionCookies(B));
  L.check("legacy", "L2 every pre-release copy is given the same DERIVED id, never a random one", !!sa && String(sa).startsWith("legacy-") && sa === sb,
    { aDerived: !!sa && String(sa).startsWith("legacy-"), same: sa === sb });

  nextLane();
  const C = await device("desktop");
  const pc = await C.newPage();
  await signIn(pc, "transition-after-release", COACH);
  const cCookies = await sessionCookies(C);
  const sc = await sidOf(cCookies);
  L.check("legacy", "L3 a sign-in after the release has its own random id", !!sc && !String(sc).startsWith("legacy-") && sc !== sa, { hasId: !!sc, derived: String(sc).startsWith("legacy-") });

  const aBefore = await sessionCookies(A);
  await signOut(pa, "desktop");
  const aOut = await pa.waitForURL(/\/login/, { timeout: 60_000 }).then(() => true, () => false);
  L.check("legacy", "L4 the pre-release device signs out (lands on /login)", aOut, { url: path(pa) });
  const rA = await replay(aBefore);
  L.check("legacy", "L5 that device's own pre-sign-out cookie is refused", rA.refused === true, rA);
  const rB = await replay(await sessionCookies(B));
  L.check("legacy", "L6 the same person's other pre-release copy is refused too (by design: they share the derived id)", rB.refused === true, rB);
  const rOld = await replay(oldCookie);
  L.check("legacy", "L7 an ORIGINAL pre-release copy presented later (a late response, a copied cookie) is refused: it cannot get a fresh id", rOld.refused === true, rOld);
  const rC = await replay(cCookies);
  L.check("legacy", "L8 the session signed in after the release (same person, another device) stays valid", rC.apiStatus === 200 && rC.pageStatus === 200, rC);
  const u = await landsOnLogin(pb, "/dashboard/members");
  L.check("legacy", "L9 the other pre-release device's next navigation is sent to /login", u.ok, u);
  await A.close();
  await B.close();
  await C.close();
}

try {
  for (const s of [
    { kind: "desktop", path: "locations", tabs: "one" },
    { kind: "desktop", path: "locations", tabs: "two" },
    { kind: "desktop", path: "prefetch", tabs: "one" },
    { kind: "desktop", path: "prefetch", tabs: "two" },
    { kind: "phone", path: "locations", tabs: "one" },
    { kind: "phone", path: "prefetch", tabs: "two" },
  ]) await scenario(s);
  // The late-response case must actually have run, not only been noted as not exercised.
  L.check("server", "E1 R2 and S1 (a held response's re-issued cookie) were exercised in at least one scenario", exercised.reissueReplayed >= 1, exercised);
  L.check("client", "E2 U2 (the cookie a late response put back in the browser) was exercised in at least one scenario", exercised.browserCookieAfterLateResponse >= 1, exercised);
  await failedSignOut("desktop");
  await failedSignOut("phone");
  await lostResponse("desktop");
  await lostResponse("phone");
  await otherDeviceSurvives();
  await releaseTransition();
} finally {
  await browser.close();
}
