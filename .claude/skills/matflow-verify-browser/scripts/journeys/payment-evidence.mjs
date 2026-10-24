// Journey: the payment evidence behind a self check-in refusal (D10, release QA, 23 Oct 2026).
// Three members on a plan are behind for three different reasons — A never paid (pending, first due date passed),
// B's card was declined after their due date, C paid before and is now past a due date. Each signs in to the member
// app and uses its real "Sign In to Class" sheet: the server refuses (402) with the sentence that names the evidence,
// the sheet shows that sentence, and nothing is recorded. The same three are then ADMITTED by the doors that do not
// gate on payment — the desk register (real UI), the kiosk (public API, real kiosk tokens) and the card scanner (real
// request) — with the stored rows read back. A paid member with a future due date is admitted at self check-in.
// Needs `fixture.mjs create` and `server.mjs start`. Run between 01:00 and 22:59 club time: the self check-in session
// starts this hour (check-in window), and the member home asks for today's sessions by the UTC date.
//   node journeys/payment-evidence.mjs
//
// ── Notes: exact strings and routes (source: worktree combined, HEAD c79b3ee6) ─────────────────────────────────────
//  Evidence lib/overdue.ts:292-309 paymentEvidence (null unless isOverdue :237-251; failed latest settled payment wins;
//   pending on a plan = no_payment_recorded; else payment_outstanding; Stripe/TeamUp dates never quoted)
//  Sentences lib/overdue.ts:320-333 paymentEvidenceSentence; dates via dayMonth :315-317 = toLocaleDateString("en-GB",
//   { day: "numeric", month: "short" }) — due dates read in UTC, a failed charge's instant in the club's zone:
//     `No payment has been recorded for this membership and its first payment date (${D Mon}) has passed.`   :324
//     `A payment failed on ${D Mon}.`                                                                         :327
//     `The payment due on ${D Mon} is outstanding.`                                                          :330
//  Next step lib/checkin-refusal.ts:85-90 paymentRefusalSentence: no_payment_recorded + " Ask the desk to record your
//   payment."; the other two + " Speak to the desk to settle it."; used for no_coverage :119-131 (status 402,
//   reason "no_coverage"); TeamUp sentence wins for TeamUp-billed members.
//  Engine lib/checkin.ts: covered/hasDeskMembership :932-940 (not overdue by isOverdue); refusal path reads the latest
//   settled Payment only when refusing, refusalPaymentEvidence :730-751, returned on no_coverage :1009-1016.
//  Route app/api/checkin/route.ts:170 requireCoverage only for self; :262-281 the club's zone passed for the failed-charge date.
//  Member app app/member/home/page.tsx: "Sign In to Class" :1793 opens the sheet "Sign in to a class" :1121; class buttons;
//   "Confirm Sign In" :1238 sends POST /api/checkin {classInstanceId, checkInMethod:"self"} :1065-1076; refusal shown
//   as <p role="alert"> :1227 (server's error, lib/checkin-outcome.ts classifyCheckinResponse); today's classes from
//   /api/member/home?date=<UTC date> filtered by the browser's day of week (:1252-1255) — contexts run in Europe/London.
//  Doors that do not gate on payment: kiosk requireCoverage false app/api/kiosk/[token]/checkin/route.ts:95;
//   card scanner requireCoverage false app/api/checkin/card/route.ts:253; desk register (admin) requireCoverage false
//   app/api/checkin/route.ts:170 (the register asks only about hold / waiver / kids class, RegisterPanel.tsx).
import { randomUUID, createHmac } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, bcrypt, sleep } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("payment-evidence");
const tenantId = club.tenantId;
const errors = [];
const TAG = randomUUID().replace(/[^a-z]/g, "").slice(0, 4).toUpperCase().padEnd(4, "Q");

// ── Club clock and calendar (Europe/London), computed here ──
const DAY = 86_400_000;
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
const hourNow = Number(parts.hour);
if (hourNow < 1 || hourNow > 22) throw new Error("run between 01:00 and 22:59 club time (self check-in window; the member home asks for the UTC date)");
const mk = (iso) => new Date(`${iso}T00:00:00.000Z`);
const isoAdd = (iso, n) => new Date(mk(iso).getTime() + n * DAY).toISOString().slice(0, 10);
const hh = (h) => `${String(Math.min(23, Math.max(0, h))).padStart(2, "0")}:00`;
const T_S = hh(hourNow), T_E = hh(hourNow + 1), T_DESK = "06:15", T_SCAN = "06:45";
const dowSun0 = mk(todayIso).getUTCDay();
/** "3 Oct" for a due date (a UTC wall-clock date). The en-GB short month ("Sept" for September in current ICU) comes
 *  from Intl, as on the server; the date itself is the seed's. */
const dueText = (iso) => mk(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** "3 Oct" for an instant, on the club's calendar. */
const instantText = (d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

// ── Seed: one plan, four members, one class with today's slot ──
const PLAN = `Pay Plan ${TAG}`, CLASS = `Pay Mat ${TAG}`;
const tier = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "updatedAt") values ($1, $2, $3, 5000, 'GBP', 'monthly', now())`, [tier, tenantId, PLAN]);
async function addMember(key, name, paymentStatus, nextDueIso) {
  const id = randomUUID();
  const password = `Mfv-${randomUUID().slice(0, 12)}-aa1`;
  const email = `${club.slug}-${key}-${TAG}@example.test`.toLowerCase();
  await q(`insert into "Member" (id, "tenantId", email, name, "membershipTierId", "membershipType", "paymentStatus", "nextDueAt", "waiverAccepted", "onboardingCompleted", "passwordHash", "updatedAt")
           values ($1, $2, $3, $4, $5, $6, $7, $8, true, true, $9, now())`,
    [id, tenantId, email, name, tier, PLAN, paymentStatus, mk(nextDueIso), await bcrypt.hash(password, 10)]);
  return { id, name, email, password };
}
const addPayment = (memberId, status, createdAt, failureReason = null) =>
  q(`insert into "Payment" (id, "tenantId", "memberId", "amountPence", currency, status, "failureReason", "paidAt", "createdAt") values ($1, $2, $3, 5000, 'GBP', $4, $5, $6, $7)`,
    [randomUUID(), tenantId, memberId, status, failureReason, status === "succeeded" ? createdAt : null, createdAt]);

const dueA = isoAdd(todayIso, -10), dueB = isoAdd(todayIso, -12), dueC = isoAdd(todayIso, -5), dueD = isoAdd(todayIso, 20);
const A = await addMember("a", `Ava Neverpaid ${TAG}`, "pending", dueA);
const B = await addMember("b", `Ben Declined ${TAG}`, "paid", dueB);
const C = await addMember("c", `Cleo Lapsed ${TAG}`, "paid", dueC);
const D = await addMember("d", `Dan Paidup ${TAG}`, "paid", dueD);
// B: paid once a month before, then the card was declined two days after the due date (12:00 UTC: one club date either way).
const failedAtB = new Date(`${isoAdd(dueB, 2)}T12:00:00.000Z`);
await addPayment(B.id, "succeeded", new Date(`${isoAdd(dueB, -30)}T12:00:00.000Z`));
await addPayment(B.id, "failed", failedAtB, "card_declined");
// C: paid for the previous period; nothing since the due date passed.
await addPayment(C.id, "succeeded", new Date(`${isoAdd(dueC, -30)}T12:00:00.000Z`));
// D: paid; next due date in the future.
await addPayment(D.id, "succeeded", new Date(`${isoAdd(todayIso, -10)}T12:00:00.000Z`));

const cls = randomUUID();
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 50)`, [cls, tenantId, CLASS]);
await q(`insert into "ClassSchedule" (id, "classId", "dayOfWeek", "startTime", "endTime") values ($1, $2, $3, $4, $5)`, [randomUUID(), cls, dowSun0, T_S, T_E]);
const S = randomUUID(), SD = randomUUID(), SC = randomUUID();
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $4, $5, $6, $7), ($2, $4, $5, $8, $8), ($3, $4, $5, $9, $9)`,
  [S, SD, SC, cls, mk(todayIso), T_S, T_E, T_DESK, T_SCAN]);

const EXPECT = {
  [A.id]: `No payment has been recorded for this membership and its first payment date (${dueText(dueA)}) has passed. Ask the desk to record your payment.`,
  [B.id]: `A payment failed on ${instantText(failedAtB)}. Speak to the desk to settle it.`,
  [C.id]: `The payment due on ${dueText(dueC)} is outstanding. Speak to the desk to settle it.`,
};
const KIND = { [A.id]: "never paid", [B.id]: "card declined", [C.id]: "lapsed" };

// ── Read-backs ──
const rows = async (inst, mid) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, inst, mid]))[0].n);
const record = async (inst, mid) => (await q(`select id, "checkInMethod" from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, inst, mid]))[0] ?? null;
const auditByMember = async (action, mid) => q(`select metadata from "AuditLog" where "tenantId" = $1 and action = $2 and metadata->>'memberId' = $3`, [tenantId, action, mid]);
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(500); }
}
async function pollAudit(fn, want) {
  if (want === 0) { await sleep(1500); return fn(); }
  for (let i = 0; i < 30; i++) { const r = await fn(); if (r.length >= want) return r; await sleep(500); }
  return fn();
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Kiosk and card secrets derived as lib/token-hash.ts, lib/kiosk-token.ts and lib/card-token.ts do; never printed.
const env = testEnv();
const SECRET = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
if (!SECRET) throw new Error("no AUTH secret in .env.test");
const kioskRaw = `mfvk${randomUUID().replace(/-/g, "")}`;
await q(`update "Tenant" set "kioskTokenHash" = $1 where id = $2`, [createHmac("sha256", SECRET).update(kioskRaw).digest("hex"), tenantId]);
function signCardToken(memberId, cardVersion) {
  const key = createHmac("sha256", SECRET).update("matflow.card.v1").digest();
  const keyId = createHmac("sha256", key).update("matflow.card.keyid").digest().toString("base64url").slice(0, 6);
  const body = Buffer.from(JSON.stringify({ tenantId, memberId, cardVersion, purpose: "card", keyId, exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

async function memberSignIn(page, m) {
  await page.goto("/login");
  await page.getByLabel("Club code").fill(club.slug);
  await page.keyboard.press("Enter");
  await page.getByLabel("Email address").first().waitFor({ timeout: 60000 });
  await page.getByLabel("Email address").first().fill(m.email);
  await page.getByLabel("Password").fill(m.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/member/, { timeout: 60000 });
}
/** The member app's own sign-in sheet; returns the request it sent and what the sheet then showed. */
async function selfSignIn(page) {
  await page.goto("/member/home");
  await page.getByRole("button", { name: "Sign In to Class" }).click();
  await page.getByText("Sign in to a class").waitFor();
  await page.getByRole("button", { name: new RegExp(esc(CLASS)) }).last().click();
  const sent = page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/checkin", { timeout: 30000 }).catch(() => null);
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/checkin", { timeout: 30000 }).catch(() => null);
  await page.getByRole("button", { name: "Confirm Sign In" }).click();
  const [rq, rs] = await Promise.all([sent, answered]);
  const body = rs ? await rs.json().catch(() => null) : null;
  return { payload: rq ? rq.postDataJSON() : null, status: rs ? rs.status() : null, body };
}

const browser = await chromium.launch();
try {
  // ── 1. Self check-in in the member app: A, B, C refused with their evidence; nothing recorded ──
  const lane = { [A.id]: "10.97.0.11", [B.id]: "10.97.0.12", [C.id]: "10.97.0.13", [D.id]: "10.97.0.14" };
  for (const m of [A, B, C]) {
    const mctx = await context(browser, lane[m.id], { timezoneId: "Europe/London" });
    const p = await mctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await memberSignIn(p, m);
    const r = await selfSignIn(p);
    const alert = p.getByRole("alert").filter({ hasText: EXPECT[m.id] });
    const shown = await alert.waitFor({ timeout: 15000 }).then(() => true, () => false);
    if (!shown) await shot(p, `payment-evidence-self-${KIND[m.id].replace(/ /g, "-")}-unexpected`);
    L.check("journey", `J1 self check-in (${KIND[m.id]}): the member app sends {classInstanceId, checkInMethod:"self"} for today's session`,
      r.payload?.classInstanceId === S && r.payload?.checkInMethod === "self" && !("memberId" in (r.payload ?? {})), r.payload);
    L.check("journey", `J2 self check-in (${KIND[m.id]}): 402 no_coverage with the evidence sentence`,
      r.status === 402 && r.body?.reason === "no_coverage" && r.body?.error === EXPECT[m.id], { status: r.status, body: r.body, want: EXPECT[m.id] });
    L.check("journey", `J3 self check-in (${KIND[m.id]}): the sheet shows the same sentence and nothing is recorded or audited`,
      shown && (await rows(S, m.id)) === 0 && (await pollAudit(() => auditByMember("attendance.self_checkin", m.id), 0)).length === 0, { shown, rows: await rows(S, m.id) });
    await shot(p, `payment-evidence-self-${KIND[m.id].replace(/ /g, "-")}`);
    await mctx.close();
  }

  // ── 2. A paid member with a future due date is admitted at self check-in ──
  {
    const mctx = await context(browser, lane[D.id], { timezoneId: "Europe/London" });
    const p = await mctx.newPage();
    p.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
    await memberSignIn(p, D);
    const r = await selfSignIn(p);
    const rec = await until(() => record(S, D.id));
    const auditRows = await pollAudit(() => auditByMember("attendance.self_checkin", D.id), 1);
    const audit = auditRows[0]?.metadata ?? null;
    const auditEntity = (await q(`select "entityType", "entityId" from "AuditLog" where "tenantId" = $1 and action = 'attendance.self_checkin' and metadata->>'memberId' = $2`, [tenantId, D.id]));
    const rowCount = await rows(S, D.id);
    // Next.js renders its route announcer (#__next-route-announcer__) with role="alert" on every page, so the old
    // "no alert at all" condition could never hold (23 Oct run: 201, success true, row and audit present, still FAIL).
    // Only the page's own alerts count; their texts go into the evidence.
    await p.waitForTimeout(1500);
    const pageAlerts = await p.locator('[role="alert"]:not(#__next-route-announcer__)').allInnerTexts();
    const shownAlerts = pageAlerts.map((t) => t.trim()).filter(Boolean);
    L.check("journey", "J4 a paid member whose due date is in the future is admitted at self check-in: 201 {success:true}, one self row, attendance.self_checkin audit, no error shown",
      r.status === 201 && r.body?.success === true && r.body?.record?.id === rec?.id && rowCount === 1 && rec?.checkInMethod === "self" &&
        auditRows.length === 1 && audit?.classInstanceId === S && auditEntity[0]?.entityType === "AttendanceRecord" && auditEntity[0]?.entityId === rec?.id && shownAlerts.length === 0,
      { status: r.status, success: r.body?.success ?? null, bodyRecord: r.body?.record?.id ?? null, error: r.body?.error ?? null, rowCount, record: rec, audits: auditRows.length, auditEntity: auditEntity[0] ?? null, audit, shownAlerts });
    await mctx.close();
  }

  // ── 3. Doors that do not gate on payment admit the same three ──
  const ctx = await context(browser, "10.97.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J5 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);

  // Desk register (real UI).
  await page.goto("/dashboard/checkin");
  await page.getByRole("button", { name: new RegExp(`${esc(T_DESK)} · ${esc(CLASS)}`) }).click();
  const search = page.getByLabel("Search members");
  await search.waitFor();
  for (const m of [A, B, C]) {
    await search.fill("");
    await search.fill(m.name);
    await page.getByRole("button", { name: new RegExp(`^${esc(m.name)}`) }).first().waitFor({ timeout: 30000 });
    await search.press("Enter");
    const rec = await until(() => record(SD, m.id));
    const audit = (await pollAudit(() => q(`select metadata from "AuditLog" where "tenantId" = $1 and action = 'attendance.mark' and "entityId" = $2`, [tenantId, `${SD}:${m.id}`]), 1))[0]?.metadata ?? null;
    L.check("journey", `J6 desk register (${KIND[m.id]}): admitted with no question and no refusal; one admin row and its attendance.mark audit row`,
      rec?.checkInMethod === "admin" && (await page.getByRole("dialog").count()) === 0 && (await page.getByRole("alert").filter({ hasText: EXPECT[m.id] }).count()) === 0 && audit?.recordId === rec?.id,
      { record: rec, audit });
  }
  await shot(page, "payment-evidence-desk");

  // Kiosk (public door, real member tokens from the kiosk list), into the session the member app refused.
  const kctx = await context(browser, "10.97.0.9");
  for (const m of [A, B, C]) {
    const list = (await (await kctx.request.get(`/api/kiosk/${kioskRaw}/members?q=${encodeURIComponent(m.name)}&classInstanceId=${S}`)).json()).members ?? [];
    const hit = list.find((x) => x.name === m.name);
    const res = await kctx.request.post(`/api/kiosk/${kioskRaw}/checkin`, { data: { kioskMemberToken: hit?.kioskMemberToken ?? "missing-token", classInstanceId: S } });
    const body = await res.json().catch(() => null);
    const rec = await until(() => record(S, m.id), 10000);
    const audit = rec ? (await pollAudit(() => q(`select metadata from "AuditLog" where "tenantId" = $1 and action = 'attendance.kiosk_checkin' and "entityId" = $2`, [tenantId, rec.id]), 1))[0]?.metadata ?? null : null;
    L.check("journey", `J7 kiosk (${KIND[m.id]}): listed, admitted (201) into the same session the member app refused; one kiosk row and its audit row`,
      !!hit && res.status() === 201 && body?.success === true && rec?.checkInMethod === "kiosk" && audit?.memberId === m.id,
      { listed: !!hit, status: res.status(), body, record: rec });
  }

  // Card scanner (the real request the scanner sends, real server).
  for (const m of [A, B, C]) {
    const cardVersion = (await q(`select "cardVersion" from "Member" where id = $1`, [m.id]))[0].cardVersion;
    const r = await page.evaluate(async ({ id, tok }) => {
      const t0 = performance.now();
      const res = await fetch("/api/checkin/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, tokens: [tok] }) });
      return { status: res.status, ms: Math.round(performance.now() - t0), body: await res.json().catch(() => null) };
    }, { id: SC, tok: signCardToken(m.id, cardVersion) });
    const rec = await record(SC, m.id);
    const audit = (await pollAudit(() => q(`select metadata from "AuditLog" where "tenantId" = $1 and action = 'attendance.card_scan' and "entityId" = $2 and metadata->'memberIds' ? $3`, [tenantId, SC, m.id]), 1))[0]?.metadata ?? null;
    L.check("journey", `J8 card scanner (${KIND[m.id]}): success, recorded 1, one qr row; card_scan audit names the member`,
      r.status === 200 && r.body?.results?.[0]?.status === "success" && r.body?.recorded === 1 && rec?.checkInMethod === "qr" && Array.isArray(audit?.memberIds) && audit.memberIds.includes(m.id),
      { status: r.status, result: r.body?.results?.[0], record: rec });
    L.note("journey", `N1 card request latency (${KIND[m.id]})`, { ms: r.ms, withinScannerTimeout: r.ms < 10000 });
  }
  const totals = await q(`select "memberId", count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = any($2) group by "memberId"`, [tenantId, [S, SD, SC]]);
  const byMember = Object.fromEntries(totals.map((t) => [t.memberId, t.n]));
  L.check("journey", "J9 stored rows: each of A, B, C has exactly 3 (desk, kiosk, scanner) and none from the member app; the paid member has 1",
    [A, B, C].every((m) => byMember[m.id] === 3) && byMember[D.id] === 1, { A: byMember[A.id], B: byMember[B.id], C: byMember[C.id], D: byMember[D.id] });

  // ── 4. Phone width (the member home with the refusal) ──
  const phone = await context(browser, "10.97.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "Europe/London" });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await memberSignIn(p2, A);
  await p2.goto("/member/home");
  await p2.waitForLoadState("load");
  const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M1 /member/home at 390 px has no horizontal page scroll", m.scroll <= m.width + 1, m);
  await shot(p2, "payment-evidence-mobile-home");
  L.check("journey", "J10 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
