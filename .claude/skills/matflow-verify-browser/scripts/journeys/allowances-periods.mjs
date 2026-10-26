// Journey: plan allowances and their reset periods (release QA, 23 Oct 2026).
// The owner creates a plan in the plan editor and walks its allowance through weekly -> monthly -> every 4 weeks from a
// start date -> Unlimited, each save keeping price, cycle and description and writing an audit row; the editor never
// offers "each member's own billing period" and both membership routes refuse it with the exact message, writing
// nothing. Then consumption at the doors: "1 each week" at the desk register (real UI: admit, ask, undo gives the
// class back), "1 each calendar month" across the month boundary, "2 every 4 weeks from a start date" either side of a
// period boundary, attendance reversal at a boundary then a re-check-in, a duplicate tap, two simultaneous check-ins
// at the last place, a failed save / lost response / retry on the register, the real card-scanner request (latency
// recorded) and phone width. Every expected number is computed here from the seed, on the club's calendar.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/allowances-periods.mjs
//
// ── Notes: exact strings and routes this journey asserts (source: worktree batch-d, head cfd725e3) ──────────────
//  Plan editor components/dashboard/MembershipsManager.tsx
//   fields #tier-name #tier-description #tier-price #tier-cycle #tier-class-limit #tier-class-limit-basis
//          #tier-class-limit-weeks #tier-class-limit-anchor :619-766; summary data-testid tier-allowance-summary/-period :772-773
//   basis options = OFFERED_ALLOWANCE_BASES lib/class-allowance.ts:678 (billing filtered while BILLING_BASIS_AVAILABLE=false :677)
//   labels :109-114 "Each week (Monday to Sunday)" / "Each calendar month" / "Every N weeks from a start date"
//   edit sends the allowance only when changed :289-297; buttons "Add tier" :527, "Create tier"/"Save changes" :612,
//   toasts "Tier created" :340 / "Tier updated" :326; list cell data-testid tier-class-limit :460 (classLimitText: "1 each week", "Unlimited")
//   summary sentences lib/class-allowance.ts:620-640:
//     `Attend up to ${n} ${class|classes} during ${each week | each calendar month | each 4-week period}. The next reset is ${dateText(end, true)}.`
//     `The current period runs ${dateText(start)} to ${lastDayText(end, true)}.`;  Unlimited: "Unlimited classes. Members on this plan can attend any class their membership includes."
//  Routes
//   POST /api/memberships app/api/memberships/route.ts:56-132 (billing refused :81-83, audit membership.tier.create :116)
//   PATCH /api/memberships/[id] app/api/memberships/[id]/route.ts:37-115 (billing refused :64-66, audit membership.tier.update :100
//          with updateMetadata fields/before/after, lib/audit-snapshot.ts:57-71; Dates as ISO strings)
//   billing message lib/class-allowance.ts:679-680:
//     "Counting classes per member's billing period is not available yet — choose each week, each month or every N weeks"
//   desk POST /api/checkin (admin) app/api/checkin/route.ts:163-204; allowance gate "ask" for staff, refusal 403 with askable + allowance
//     lib/checkin-refusal.ts:169-188; error = allowanceRefusalSentence lib/class-allowance.ts:580-586:
//     `${count phrase}; it resets on ${dateText(resetsOn)}. Ask staff if you need to train before then.`
//     count phrase :556-562 with thisPeriodText :536-547 ("this week" / "this month" / "this 4-week period"; past period:
//     "the week of …", "September 2026", "the 4-week period from …")
//   register ask lib/class-allowance.ts:599-612: `${name} has used 1 of 1 class this week (resets on ${dateText(resetsOn)}). Admit anyway?`
//     dialog title "Class allowance used" RegisterPanel.tsx:347; undo "Remove check-in" :386; network failure
//     "Couldn't reach MatFlow — check your signal and try again." :369; 409 already_checked_in is not an error lib/checkin-outcome.ts:32-34
//   undo DELETE /api/checkin route.ts:285-330 (audit attendance.override); duplicate 409 {error:"Already checked in", reason:"already_checked_in"}
//     lib/checkin-refusal.ts:130-131; the duplicate is judged before the allowance (lib/checkin.ts:622)
//   counting: lib/class-allowance-count.ts:148-167 (rows by the class's own date; not imports, cancelled sessions or pack redemptions);
//     periods lib/class-allowance.ts:239-263 (week Monday-Monday, calendar month, anchor + k*N*7 days; half-open)
//   card scanner POST /api/checkin/card app/api/checkin/card/route.ts:63-75,245-349 (needs_confirmation + question; audit attendance.card_scan :330)
//  The monthly and 4-weekly sessions sit on past dates the register does not list (it shows today, /api/coach/today), so those
//  desk check-ins go through POST /api/checkin — the request the register itself sends (RegisterPanel.tsx:322-331).
import { randomUUID, createHmac } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn, sleep, BASE } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("allowances-periods");
const tenantId = club.tenantId;
const errors = [];
const ORIGIN = new URL(BASE).origin;
const TAG = randomUUID().replace(/[^a-z]/g, "").slice(0, 4).toUpperCase().padEnd(4, "Q");

// ── Club calendar (Europe/London), computed independently of the app ──
const DAY = 86_400_000;
const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
const hourNow = Number(parts.hour);
const mk = (iso) => new Date(`${iso}T00:00:00.000Z`);
const isoAdd = (iso, n) => new Date(mk(iso).getTime() + n * DAY).toISOString().slice(0, 10);
const dateText = (iso, withYear = false) => {
  const t = mk(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  return withYear ? `${t} ${iso.slice(0, 4)}` : t;
};
const monthYear = (iso) => mk(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const dow = (mk(todayIso).getUTCDay() + 6) % 7; // Monday = 0
const monday = isoAdd(todayIso, -dow);
const nextMonday = isoAdd(monday, 7);
const monthStart = `${todayIso.slice(0, 8)}01`;
const nextMonthStart = (() => { const d = mk(monthStart); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); })();
const prevMonthLast = isoAdd(monthStart, -1);
const prevMonthStart = `${prevMonthLast.slice(0, 8)}01`;
const hh = (h) => `${String(Math.min(23, Math.max(0, h))).padStart(2, "0")}:00`;

// ── Names ──
const PLAN = `Allow P ${TAG}`;
const PLAN_DESC = "Synthetic plan for the allowance journey";
const BILLING_MSG = "Counting classes per member's billing period is not available yet — choose each week, each month or every N weeks";

// ── DB read-backs ──
const tierRow = async (name) => (await q(`select id, "pricePence", "billingCycle", description, "classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor"::text as "classLimitAnchor", "maxClassesPerWeek" from "MembershipTier" where "tenantId" = $1 and name = $2`, [tenantId, name]))[0] ?? null;
const rows = async (inst, mid) => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, inst, mid]))[0].n);
const record = async (inst, mid) => (await q(`select id, "checkInMethod" from "AttendanceRecord" where "tenantId" = $1 and "classInstanceId" = $2 and "memberId" = $3`, [tenantId, inst, mid]))[0] ?? null;
const audits = async (action, entityId) => q(`select metadata from "AuditLog" where "tenantId" = $1 and action = $2 and "entityId" = $3 order by "createdAt" asc`, [tenantId, action, entityId]);
/** Audit writes are best-effort and asynchronous: poll for `want` rows; for 0, settle then read. */
async function auditsSettled(action, entityId, want) {
  if (want === 0) { await sleep(1500); return audits(action, entityId); }
  for (let i = 0; i < 30; i++) { const r = await audits(action, entityId); if (r.length >= want) return r; await sleep(500); }
  return audits(action, entityId);
}
async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(500); }
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function api(page, method, path, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const t0 = performance.now();
    const r = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, body: json, ms: Math.round(performance.now() - t0) };
  }, { method, path, body });
}
async function req(page, method, path, data) {
  const r = await page.request.fetch(path, { method, headers: { Origin: ORIGIN, ...(data ? { "Content-Type": "application/json" } : {}) }, ...(data ? { data } : {}) });
  let body = null; try { body = await r.json(); } catch { /* not JSON */ }
  return { status: r.status(), body };
}

// ── Seed: plans with an allowance, members on them, classes and sessions, earlier attendance ──
async function addTier(name, limit, basis, weeks = null, anchor = null) {
  const id = randomUUID();
  await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "classLimit", "classLimitBasis", "classLimitWeeks", "classLimitAnchor", "maxClassesPerWeek", "updatedAt")
           values ($1, $2, $3, 0, 'GBP', 'monthly', $4, $5, $6, $7::date, $8, now())`, [id, tenantId, name, limit, basis, weeks, anchor, basis === "week" ? limit : null]);
  return id;
}
async function addMember(key, name, tierId, tierName) {
  const id = randomUUID();
  await q(`insert into "Member" (id, "tenantId", email, name, "membershipTierId", "membershipType", "waiverAccepted", "updatedAt") values ($1, $2, $3, $4, $5, $6, true, now())`,
    [id, tenantId, `${club.slug}-${key}-${TAG}@example.test`.toLowerCase(), name, tierId, tierName]);
  return { id, name };
}
async function addClass(name) {
  const id = randomUUID();
  await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, $3, 60, 50)`, [id, tenantId, name]);
  return id;
}
async function addSession(classId, iso, time) {
  const id = randomUUID();
  await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $2, $3, $4, $4)`, [id, classId, mk(iso), time]);
  return id;
}
const seedAttend = (mid, inst) => q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [randomUUID(), tenantId, mid, inst]);

const W1 = `Week One ${TAG}`, W2 = `Week Two ${TAG}`, M1 = `Month One ${TAG}`, F2 = `Four Two ${TAG}`;
const A4 = isoAdd(monday, -13); // a Tuesday: the 4-week periods start on Tuesdays, not on calendar weeks
const tW1 = await addTier(W1, 1, "week"), tW2 = await addTier(W2, 2, "week"), tM1 = await addTier(M1, 1, "month"), tF2 = await addTier(F2, 2, "weeks", 4, A4);
const wendy = await addMember("wendy", `Wendy Weekly ${TAG}`, tW1, W1);
const mona = await addMember("mona", `Mona Monthly ${TAG}`, tM1, M1);
const fay = await addMember("fay", `Fay Fourweekly ${TAG}`, tF2, F2);
const dee = await addMember("dee", `Dee Double ${TAG}`, tW2, W2);
const lou = await addMember("lou", `Lou Last ${TAG}`, tW1, W1);
const rory = await addMember("rory", `Rory Retry ${TAG}`, null, null);
const lena = await addMember("lena", `Lena Lost ${TAG}`, null, null);
const sam = await addMember("sam", `Sam Scan ${TAG}`, tW1, W1);

const WEEK_CLASS = `Week Mat ${TAG}`, RETRY_CLASS = `Retry Mat ${TAG}`;
const cWeek = await addClass(WEEK_CLASS), cMonth = await addClass(`Month Mat ${TAG}`), cFour = await addClass(`Four Mat ${TAG}`);
const cDup = await addClass(`Dup Mat ${TAG}`), cRace = await addClass(`Race Mat ${TAG}`), cRetry = await addClass(RETRY_CLASS), cScan = await addClass(`Scan Mat ${TAG}`);
const Ta = hh(hourNow - 1), Tb = hh(hourNow + 1) === Ta ? "23:30" : hh(hourNow + 1);
const iTa = await addSession(cWeek, todayIso, Ta), iTb = await addSession(cWeek, todayIso, Tb);
// Month: the last day of the previous club month (two sessions), the 1st of this one, and later today.
const iP = await addSession(cMonth, prevMonthLast, "18:00"), iP2 = await addSession(cMonth, prevMonthLast, "10:00");
const iQ = await addSession(cMonth, monthStart, "09:00"), iR = await addSession(cMonth, todayIso, "20:30");
// Every 4 weeks from A4: previous period [A4-28, A4), current [A4, A4+28).
const iX1 = await addSession(cFour, isoAdd(A4, -1), "18:00"), iX2 = await addSession(cFour, isoAdd(A4, -1), "10:00"), iX3 = await addSession(cFour, isoAdd(A4, -2), "10:00");
const iY1 = await addSession(cFour, A4, "10:00"), iY2 = await addSession(cFour, isoAdd(A4, 1), "10:00"), iY3 = await addSession(cFour, todayIso, "21:00");
const iDa = await addSession(cDup, todayIso, "06:10"), iDb = await addSession(cDup, todayIso, "06:20"), iDc = await addSession(cDup, todayIso, "06:30");
const iLa = await addSession(cRace, todayIso, "07:10"), iLb = await addSession(cRace, todayIso, "07:20"), iLc = await addSession(cRace, todayIso, "07:30"), iLd = await addSession(cRace, todayIso, "07:40");
const iRt = await addSession(cRetry, todayIso, hh(hourNow));
const iSa = await addSession(cScan, todayIso, "05:00"), iSb = await addSession(cScan, todayIso, "05:30");
await seedAttend(mona.id, iP);
await seedAttend(fay.id, iX1);
await seedAttend(fay.id, iX2);
await seedAttend(sam.id, iSa);

// ── Expected allowance answers (period arithmetic done here) ──
const sentence = (count, resetsOn) => `${count}; it resets on ${dateText(resetsOn)}. Ask staff if you need to train before then.`;
function refusedAs(r, want, text) {
  const a = r.body?.allowance ?? {};
  return r.status === 403 && r.body?.reason === "allowance_reached" && r.body?.askable === true && r.body?.error === text
    && a.used === want.used && a.limit === want.limit && a.basis === want.basis && (want.weeks === undefined || a.weeks === want.weeks)
    && a.period?.start === want.period.start && a.period?.end === want.period.end && a.resetsOn === want.resetsOn && a.current === want.current;
}

// Card token exactly as lib/card-token.ts signs it (the server's own secret, never printed) — as scanner-override.mjs.
function signCardToken(args) {
  const env = testEnv();
  const secret = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
  if (!secret) throw new Error("no AUTH secret in .env.test");
  const key = createHmac("sha256", secret).update("matflow.card.v1").digest();
  const keyId = createHmac("sha256", key).update("matflow.card.keyid").digest().toString("base64url").slice(0, 6);
  const body = Buffer.from(JSON.stringify({ ...args, purpose: "card", keyId, exp: Math.floor(Date.now() / 1000) + 3600 }), "utf8").toString("base64url");
  return `${body}.${createHmac("sha256", key).update(body).digest().toString("base64url")}`;
}

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.96.0.1");
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  await ownerSignIn(page, club);
  L.check("journey", "J1 owner sign-in lands on the dashboard", /\/dashboard/.test(page.url()), new URL(page.url()).pathname);
  const desk = (inst, mid, ack) => api(page, "POST", "/api/checkin", { classInstanceId: inst, memberId: mid, checkInMethod: "admin", ...(ack ? { acknowledged: ack } : {}) });
  const undo = (inst, mid) => api(page, "DELETE", `/api/checkin?classInstanceId=${inst}&memberId=${mid}`);
  /** A desk admission: 201, exactly one admin row, its attendance.mark audit row (created, no override). */
  async function admitted(r, inst, mid) {
    const rec = await record(inst, mid);
    const a = (await auditsSettled("attendance.mark", `${inst}:${mid}`, 1)).at(-1)?.metadata ?? null;
    return { ok: r.status === 201 && (await rows(inst, mid)) === 1 && rec?.checkInMethod === "admin" && a?.recordId === rec?.id && a?.created === true && !a?.overrides, saw: { status: r.status, error: r.body?.error, record: rec, audit: a } };
  }

  // ── 1. Plan editor: create weekly, then month, every 4 weeks, Unlimited ──
  await page.goto("/dashboard/memberships");
  await page.getByRole("button", { name: "Add tier" }).first().click();
  await page.locator("#tier-name").waitFor();
  const optionsOf = () => page.locator("#tier-class-limit-basis option").evaluateAll((os) => os.map((o) => ({ value: o.value, text: o.textContent?.trim() })));
  const createOptions = await optionsOf();
  L.check("journey", "J2 the editor offers exactly week / month / every N weeks — never each member's own billing period",
    JSON.stringify(createOptions) === JSON.stringify([
      { value: "week", text: "Each week (Monday to Sunday)" },
      { value: "month", text: "Each calendar month" },
      { value: "weeks", text: "Every N weeks from a start date" },
    ]), createOptions);
  await page.locator("#tier-name").fill(PLAN);
  await page.locator("#tier-description").fill(PLAN_DESC);
  await page.locator("#tier-price").fill("25");
  await page.locator("#tier-cycle").selectOption("monthly");
  await page.locator("#tier-class-limit").fill("1");
  await page.locator("#tier-class-limit").press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.id);
  L.check("keyboard", "K1 Tab from Classes allowed reaches the reset-basis select", focused === "tier-class-limit-basis", focused);
  await page.locator("#tier-class-limit-basis").selectOption("week");
  const summary = page.getByTestId("tier-allowance-summary"), period = page.getByTestId("tier-allowance-period");
  L.check("journey", "J3 '1 each week': the summary and the current period read the real dates",
    (await summary.textContent()) === `Attend up to 1 class during each week. The next reset is ${dateText(nextMonday, true)}.`
      && (await period.textContent()) === `The current period runs ${dateText(monday)} to ${dateText(isoAdd(nextMonday, -1), true)}.`,
    { summary: await summary.textContent(), period: await period.textContent() });
  let tierPosts = 0, tierPatches = 0;
  page.on("request", (r) => {
    const p = new URL(r.url()).pathname;
    if (r.method() === "POST" && p === "/api/memberships") tierPosts++;
    if (r.method() === "PATCH" && p.startsWith("/api/memberships/")) tierPatches++;
  });
  await page.getByRole("button", { name: "Create tier" }).click();
  const made = await until(() => tierRow(PLAN));
  const t0 = await tierRow(PLAN);
  L.check("journey", "J4 Create tier: one request; stored price 2500, monthly, description, 1 each week (weekly mirror 1, no weeks/anchor)",
    !!made && tierPosts === 1 && t0.pricePence === 2500 && t0.billingCycle === "monthly" && t0.description === PLAN_DESC
      && t0.classLimit === 1 && t0.classLimitBasis === "week" && t0.classLimitWeeks === null && t0.classLimitAnchor === null && t0.maxClassesPerWeek === 1, { posts: tierPosts, row: t0 });
  const createAudit = (await auditsSettled("membership.tier.create", t0.id, 1))[0]?.metadata ?? null;
  L.check("audit", "A1 membership.tier.create audit row: name, price, cycle and the allowance",
    createAudit?.name === PLAN && createAudit?.pricePence === 2500 && createAudit?.billingCycle === "monthly" && createAudit?.classLimit === 1 && createAudit?.classLimitBasis === "week" && createAudit?.classLimitWeeks === null && createAudit?.classLimitAnchor === null, createAudit);

  const tierId = t0.id;
  let updates = 0;
  async function editAndSave(apply, label) {
    await page.reload();
    await page.locator(`button[aria-label="Edit ${PLAN}"]:visible`).first().click();
    await page.locator("#tier-class-limit").waitFor();
    const opts = await optionsOf();
    const result = await apply();
    const before = tierPatches;
    const resp = page.waitForResponse((r) => r.request().method() === "PATCH" && new URL(r.url()).pathname === `/api/memberships/${tierId}`);
    await page.getByRole("button", { name: "Save changes" }).click();
    const status = (await resp).status();
    updates += 1;
    const audit = (await auditsSettled("membership.tier.update", tierId, updates)).at(-1)?.metadata ?? null;
    return { ...result, opts, status, requests: tierPatches - before, row: await tierRow(PLAN), audit, label };
  }
  const kept = (row, audit) => row.pricePence === 2500 && row.billingCycle === "monthly" && row.description === PLAN_DESC
    && audit && !("pricePence" in (audit.after ?? {})) && !("billingCycle" in (audit.after ?? {})) && !("description" in (audit.after ?? {}));

  const toMonth = await editAndSave(async () => {
    await page.locator("#tier-class-limit-basis").selectOption("month");
    return { summary: await summary.textContent(), period: await period.textContent() };
  }, "month");
  L.check("journey", "J5 edit to '1 each calendar month': the summary names the month's dates before saving",
    toMonth.summary === `Attend up to 1 class during each calendar month. The next reset is ${dateText(nextMonthStart, true)}.`
      && toMonth.period === `The current period runs ${dateText(monthStart)} to ${dateText(isoAdd(nextMonthStart, -1), true)}.`, toMonth);
  L.check("journey", "J6 the edit sheet offers no billing-period basis either", !toMonth.opts.some((o) => o.value === "billing" || /billing/i.test(o.text ?? "")), toMonth.opts);
  L.check("journey", "J7 saved as month (weekly mirror cleared); price, cycle and description kept; one request",
    toMonth.status === 200 && toMonth.requests === 1 && toMonth.row.classLimit === 1 && toMonth.row.classLimitBasis === "month" && toMonth.row.maxClassesPerWeek === null && kept(toMonth.row, toMonth.audit), toMonth.row);
  L.check("audit", "A2 membership.tier.update audit: basis week -> month, weekly mirror 1 -> null, nothing else changed",
    toMonth.audit?.before?.classLimitBasis === "week" && toMonth.audit?.after?.classLimitBasis === "month" && toMonth.audit?.before?.maxClassesPerWeek === 1 && toMonth.audit?.after?.maxClassesPerWeek === null
      && Object.keys(toMonth.audit?.after ?? {}).sort().join(",") === "classLimitBasis,maxClassesPerWeek", toMonth.audit);

  const Aw = isoAdd(monday, -14);
  const toWeeks = await editAndSave(async () => {
    await page.locator("#tier-class-limit-basis").selectOption("weeks");
    await page.locator("#tier-class-limit-weeks").selectOption("4");
    await page.locator("#tier-class-limit-anchor").fill(Aw);
    return { summary: await summary.textContent(), period: await period.textContent() };
  }, "weeks");
  L.check("journey", "J8 edit to '1 every 4 weeks from a start date': the summary and period follow the start date",
    toWeeks.summary === `Attend up to 1 class during each 4-week period. The next reset is ${dateText(isoAdd(Aw, 28), true)}.`
      && toWeeks.period === `The current period runs ${dateText(Aw)} to ${dateText(isoAdd(Aw, 27), true)}.`, toWeeks);
  L.check("journey", "J9 saved as every 4 weeks from the start date; price, cycle and description kept",
    toWeeks.status === 200 && toWeeks.requests === 1 && toWeeks.row.classLimitBasis === "weeks" && toWeeks.row.classLimitWeeks === 4 && toWeeks.row.classLimitAnchor === Aw && toWeeks.row.classLimit === 1 && kept(toWeeks.row, toWeeks.audit), toWeeks.row);
  L.check("audit", "A3 audit: basis month -> weeks, weeks null -> 4, start date null -> the date",
    toWeeks.audit?.before?.classLimitBasis === "month" && toWeeks.audit?.after?.classLimitBasis === "weeks" && toWeeks.audit?.after?.classLimitWeeks === 4 && toWeeks.audit?.after?.classLimitAnchor === `${Aw}T00:00:00.000Z` && toWeeks.audit?.before?.classLimitAnchor === null, toWeeks.audit);

  const toUnlimited = await editAndSave(async () => {
    await page.locator("#tier-class-limit").fill("");
    return { summary: await summary.textContent() };
  }, "unlimited");
  L.check("journey", "J10 clearing Classes allowed reads Unlimited before saving",
    toUnlimited.summary === "Unlimited classes. Members on this plan can attend any class their membership includes.", toUnlimited.summary);
  L.check("journey", "J11 saved as Unlimited: every allowance column null; price, cycle and description kept",
    toUnlimited.status === 200 && toUnlimited.requests === 1 && toUnlimited.row.classLimit === null && toUnlimited.row.classLimitBasis === null && toUnlimited.row.classLimitWeeks === null && toUnlimited.row.classLimitAnchor === null && toUnlimited.row.maxClassesPerWeek === null && kept(toUnlimited.row, toUnlimited.audit), toUnlimited.row);
  L.check("audit", "A4 audit: limit 1 -> null, basis weeks -> null, weeks 4 -> null, start date -> null",
    toUnlimited.audit?.before?.classLimit === 1 && toUnlimited.audit?.after?.classLimit === null && toUnlimited.audit?.before?.classLimitBasis === "weeks" && toUnlimited.audit?.after?.classLimitBasis === null && toUnlimited.audit?.after?.classLimitWeeks === null && toUnlimited.audit?.after?.classLimitAnchor === null, toUnlimited.audit);
  await page.reload();
  const cell = page.getByRole("row").filter({ hasText: PLAN }).getByTestId("tier-class-limit");
  L.check("journey", "J12 after reload the plan reads Unlimited in the list", (await cell.first().textContent())?.trim() === "Unlimited", await cell.first().textContent());
  await shot(page, "allowances-editor-list");

  // ── 2. The billing-period basis is refused by both routes and writes nothing ──
  const beforeRow = await tierRow(PLAN);
  const beforeUpdates = (await audits("membership.tier.update", tierId)).length;
  const pb = await api(page, "PATCH", `/api/memberships/${tierId}`, { classLimit: 2, classLimitBasis: "billing" });
  L.check("journey", "J13 PATCH with classLimitBasis 'billing' is 400 with the exact message, the row unchanged and no audit row",
    pb.status === 400 && pb.body?.error === BILLING_MSG && pb.body?.details?.fieldErrors?.classLimitBasis?.[0] === BILLING_MSG
      && JSON.stringify(await tierRow(PLAN)) === JSON.stringify(beforeRow) && (await auditsSettled("membership.tier.update", tierId, 0)).length === beforeUpdates, { status: pb.status, body: pb.body });
  const probe = `Billing Probe ${TAG}`;
  const pp = await api(page, "POST", "/api/memberships", { name: probe, pricePence: 1000, currency: "GBP", billingCycle: "monthly", isKids: false, classLimit: 2, classLimitBasis: "billing" });
  await sleep(1500);
  const probeAudit = await q(`select id from "AuditLog" where "tenantId" = $1 and action = 'membership.tier.create' and metadata->>'name' = $2`, [tenantId, probe]);
  L.check("journey", "J14 POST with classLimitBasis 'billing' is 400 with the exact message; no plan and no audit row",
    pp.status === 400 && pp.body?.error === BILLING_MSG && pp.body?.details?.fieldErrors?.classLimitBasis?.[0] === BILLING_MSG && (await tierRow(probe)) === null && probeAudit.length === 0, { status: pp.status, body: pp.body });

  // ── 3. "1 each week" at the desk register (real UI) ──
  await page.goto("/dashboard/checkin");
  const search = page.getByLabel("Search members");
  const openSession = async (time, cls) => {
    await page.getByRole("button", { name: new RegExp(`${esc(time)} · ${esc(cls)}`) }).click();
    await search.waitFor();
  };
  const searchEnter = async (name) => {
    await search.fill("");
    await search.fill(name);
    await page.getByRole("button", { name: new RegExp(`^${esc(name)}`) }).first().waitFor({ timeout: 30000 });
    await search.press("Enter");
  };
  const dialog = page.getByRole("dialog");
  await openSession(Ta, WEEK_CLASS);
  await searchEnter(wendy.name);
  const w1 = await until(async () => (await rows(iTa, wendy.id)) === 1);
  const w1a = (await auditsSettled("attendance.mark", `${iTa}:${wendy.id}`, 1))[0]?.metadata ?? null;
  L.check("journey", "J15 the first class of the week is admitted at the desk with no question: one row, audit without override",
    !!w1 && (await dialog.count()) === 0 && w1a?.created === true && !w1a?.overrides, { audit: w1a });
  await openSession(Tb, WEEK_CLASS);
  await searchEnter(wendy.name);
  const askQ = `${wendy.name} has used 1 of 1 class this week (resets on ${dateText(nextMonday)}). Admit anyway?`;
  const asked = await dialog.getByText("Class allowance used").waitFor({ timeout: 20000 }).then(() => true, () => false);
  L.check("journey", "J16 the second class the same week ASKS, with the count and the reset date",
    asked && (await dialog.getByText(askQ).count()) === 1, { asked, askQ, dialog: asked ? null : await page.getByRole("alert").allTextContents().catch(() => null) });
  await shot(page, "allowances-week-ask");
  if (asked) await dialog.getByRole("button", { name: "Cancel" }).click();
  L.check("journey", "J17 Cancel records nothing and writes no audit row",
    (await rows(iTb, wendy.id)) === 0 && (await auditsSettled("attendance.mark", `${iTb}:${wendy.id}`, 0)).length === 0, "0 rows");
  await openSession(Ta, WEEK_CLASS);
  await page.getByRole("button", { name: `Mark ${wendy.name} absent` }).click();
  await dialog.getByRole("button", { name: "Remove check-in" }).click();
  const undone = await until(async () => (await rows(iTa, wendy.id)) === 0);
  L.check("journey", "J18 undo on the register removes the row and writes attendance.override",
    !!undone && (await auditsSettled("attendance.override", `${iTa}:${wendy.id}`, 1)).length === 1, { rows: await rows(iTa, wendy.id) });
  await openSession(Tb, WEEK_CLASS);
  await searchEnter(wendy.name);
  const w2 = await until(async () => (await rows(iTb, wendy.id)) === 1);
  const w2a = (await auditsSettled("attendance.mark", `${iTb}:${wendy.id}`, 1))[0]?.metadata ?? null;
  L.check("journey", "J19 after the undo the next attempt is admitted without a question (consumption reversed): one row, no override",
    !!w2 && w2a?.created === true && !w2a?.overrides, { audit: w2a });

  // ── 4. "1 each calendar month" across the month boundary (desk request) ──
  const monthNow = { used: 1, limit: 1, basis: "month", period: { start: monthStart, end: nextMonthStart }, resetsOn: nextMonthStart, current: true };
  const monthPrev = { used: 1, limit: 1, basis: "month", period: { start: prevMonthStart, end: monthStart }, resetsOn: monthStart, current: false };
  const monthNowText = sentence("1 of 1 class used this month", nextMonthStart);
  const monthPrevText = sentence(`1 of 1 class used ${monthYear(prevMonthStart)}`, monthStart);
  let r = await desk(iQ, mona.id);
  let a = await admitted(r, iQ, mona.id);
  L.check("boundary", `B1 month: a class on the last day of last month (${prevMonthLast}) does not count against the 1st (${monthStart}): admitted`, a.ok, a.saw);
  r = await desk(iR, mona.id);
  L.check("boundary", "B2 month: a second class this month is asked (403 askable) with used 1 of 1, this month's dates and the sentence; nothing recorded",
    refusedAs(r, monthNow, monthNowText) && (await rows(iR, mona.id)) === 0, r.body);
  r = await desk(iP2, mona.id);
  L.check("boundary", "B3 month: another class on last month's last day is judged in LAST month (named, not 'this month'), used 1 of 1; nothing recorded",
    refusedAs(r, monthPrev, monthPrevText) && (await rows(iP2, mona.id)) === 0, r.body);
  r = await undo(iP, mona.id);
  L.check("boundary", "B4 month: reversing the attendance on the boundary day removes it and writes attendance.override",
    r.status === 200 && (await rows(iP, mona.id)) === 0 && (await auditsSettled("attendance.override", `${iP}:${mona.id}`, 1)).length === 1, r);
  r = await desk(iP2, mona.id);
  a = await admitted(r, iP2, mona.id);
  L.check("boundary", "B5 month: re-check-in on the boundary day after the reversal is admitted (the period went back to 0)", a.ok, a.saw);
  r = await desk(iP, mona.id);
  L.check("boundary", "B6 month: the reversed session asks again (last month's class is used by the re-check-in); nothing recorded",
    refusedAs(r, monthPrev, monthPrevText) && (await rows(iP, mona.id)) === 0, r.body);
  r = await undo(iQ, mona.id);
  const rr = await desk(iR, mona.id);
  a = await admitted(rr, iR, mona.id);
  L.check("boundary", "B7 month: undoing the 1st gives this month's class back; the later class is admitted", r.status === 200 && a.ok, a.saw);

  // ── 5. "2 every 4 weeks" from a Tuesday start date, either side of a period boundary (desk request) ──
  const fourNow = { used: 2, limit: 2, basis: "weeks", weeks: 4, period: { start: A4, end: isoAdd(A4, 28) }, resetsOn: isoAdd(A4, 28), current: true };
  const fourPrev = { used: 2, limit: 2, basis: "weeks", weeks: 4, period: { start: isoAdd(A4, -28), end: A4 }, resetsOn: A4, current: false };
  const fourNowText = sentence("2 of 2 classes used this 4-week period", isoAdd(A4, 28));
  const fourPrevText = sentence(`2 of 2 classes used the 4-week period from ${dateText(isoAdd(A4, -28))}`, A4);
  r = await desk(iY1, fay.id);
  a = await admitted(r, iY1, fay.id);
  L.check("boundary", `B8 4-weekly: two classes on ${isoAdd(A4, -1)} (the day before the period starts, ${A4}) do not count: the first class of the new period is admitted`, a.ok, a.saw);
  r = await desk(iY2, fay.id);
  a = await admitted(r, iY2, fay.id);
  L.check("boundary", "B9 4-weekly: the second class of the period is admitted (2 allowed)", a.ok, a.saw);
  r = await desk(iY3, fay.id);
  L.check("boundary", "B10 4-weekly: the third class in the period is asked: used 2 of 2, this 4-week period, resets on the start date + 28 days; nothing recorded",
    refusedAs(r, fourNow, fourNowText) && (await rows(iY3, fay.id)) === 0, r.body);
  r = await desk(iX3, fay.id);
  L.check("boundary", "B11 4-weekly: a class in the previous period is judged in that period (named by its start date), used 2 of 2; nothing recorded",
    refusedAs(r, fourPrev, fourPrevText) && (await rows(iX3, fay.id)) === 0, r.body);
  r = await undo(iX1, fay.id);
  const x3 = await desk(iX3, fay.id);
  a = await admitted(x3, iX3, fay.id);
  L.check("boundary", "B12 4-weekly: reversing a class on the last day of the previous period frees that period only; the earlier class is then admitted", r.status === 200 && a.ok, a.saw);
  r = await desk(iX1, fay.id);
  L.check("boundary", "B13 4-weekly: re-check-in into the reversed session now asks (the previous period is full again); nothing recorded",
    refusedAs(r, fourPrev, fourPrevText) && (await rows(iX1, fay.id)) === 0, r.body);
  r = await undo(iY2, fay.id);
  const y3 = await desk(iY3, fay.id);
  a = await admitted(y3, iY3, fay.id);
  L.check("boundary", "B14 4-weekly: undoing a class in the current period gives it back; the third class is admitted", r.status === 200 && a.ok, a.saw);

  // ── 6. Duplicate tap into the same session ──
  const [d1, d2] = await Promise.all([
    req(page, "POST", "/api/checkin", { classInstanceId: iDa, memberId: dee.id, checkInMethod: "admin" }),
    req(page, "POST", "/api/checkin", { classInstanceId: iDa, memberId: dee.id, checkInMethod: "admin" }),
  ]);
  const dupStatuses = [d1.status, d2.status].sort();
  const dupBody = [d1, d2].find((x) => x.status === 409)?.body;
  L.check("journey", "J20 a double tap (two requests at once) gives one admission and one 'Already checked in' (never allowance_reached): one row, one audit row",
    JSON.stringify(dupStatuses) === "[201,409]" && dupBody?.error === "Already checked in" && dupBody?.reason === "already_checked_in"
      && (await rows(iDa, dee.id)) === 1 && (await auditsSettled("attendance.mark", `${iDa}:${dee.id}`, 1)).length === 1, { dupStatuses, dupBody });
  const d3 = await desk(iDa, dee.id);
  L.check("journey", "J21 a third tap later is still the duplicate answer; still one row",
    d3.status === 409 && d3.body?.reason === "already_checked_in" && (await rows(iDa, dee.id)) === 1, d3);
  r = await desk(iDb, dee.id);
  a = await admitted(r, iDb, dee.id);
  L.check("journey", "J22 the duplicate consumed nothing: with 2 each week the next session is admitted", a.ok, a.saw);
  r = await desk(iDc, dee.id);
  L.check("journey", "J23 ...and the session after that asks: used 2 of 2 this week",
    refusedAs(r, { used: 2, limit: 2, basis: "week", period: { start: monday, end: nextMonday }, resetsOn: nextMonday, current: true }, sentence("2 of 2 classes used this week", nextMonday)) && (await rows(iDc, dee.id)) === 0, r.body);

  // ── 7. Two simultaneous check-ins at the last place (twice) ──
  for (const [round, x, y] of [[1, iLa, iLb], [2, iLc, iLd]]) {
    const [p1, p2] = await Promise.all([
      req(page, "POST", "/api/checkin", { classInstanceId: x, memberId: lou.id, checkInMethod: "admin" }),
      req(page, "POST", "/api/checkin", { classInstanceId: y, memberId: lou.id, checkInMethod: "admin" }),
    ]);
    const winner = p1.status === 201 ? x : p2.status === 201 ? y : null;
    const loser = [p1, p2].find((p) => p.status !== 201);
    const total = (await rows(x, lou.id)) + (await rows(y, lou.id));
    const marks = (await auditsSettled("attendance.mark", `${x}:${lou.id}`, winner === x ? 1 : 0)).length + (await auditsSettled("attendance.mark", `${y}:${lou.id}`, winner === y ? 1 : 0)).length;
    L.check("race", `R${round} two check-ins at the last place at once: exactly one admitted, the other asked (used 1 of 1); one row, one audit row`,
      [p1, p2].filter((p) => p.status === 201).length === 1 && loser?.status === 403 && loser?.body?.reason === "allowance_reached" && loser?.body?.allowance?.used === 1 && loser?.body?.allowance?.limit === 1 && total === 1 && marks === 1,
      { statuses: [p1.status, p2.status], loser: loser?.body?.allowance, total, marks });
    if (round === 1 && winner) await undo(winner, lou.id);
  }

  // ── 8. Register: failed save, lost response, retry ──
  await page.goto("/dashboard/checkin");
  let checkinPosts = 0;
  page.on("request", (rq) => { if (rq.method() === "POST" && new URL(rq.url()).pathname === "/api/checkin") checkinPosts++; });
  await openSession(hh(hourNow), RETRY_CLASS);
  await page.route("**/api/checkin", (rt) => (rt.request().method() === "POST" ? rt.abort("failed") : rt.fallback()));
  await searchEnter(rory.name);
  const netMsg = "Couldn't reach MatFlow — check your signal and try again.";
  const sawNet = await page.getByRole("alert").filter({ hasText: netMsg }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F1 network failure: the register says so, the search keeps the name, nothing stored",
    sawNet && (await search.inputValue()) === rory.name && (await rows(iRt, rory.id)) === 0, { sawNet });
  await shot(page, "allowances-register-failed");
  await page.unroute("**/api/checkin");
  let before = checkinPosts;
  await search.press("Enter");
  const stored = await until(async () => (await rows(iRt, rory.id)) === 1);
  await sleep(800);
  L.check("retry", "R3 retry sends exactly one request and stores one row; the error is cleared",
    !!stored && checkinPosts - before === 1 && (await page.getByRole("alert").filter({ hasText: netMsg }).count()) === 0, { requests: checkinPosts - before });
  await page.reload();
  await openSession(hh(hourNow), RETRY_CLASS);
  L.check("retry", "R4 after reload the register shows the stored row (from the server)",
    await page.getByRole("button", { name: `Mark ${rory.name} absent` }).waitFor({ timeout: 45000 }).then(() => true, () => false), "row shown");
  // Lost response: the request reaches the server, the answer never reaches the browser.
  const lost = [];
  await page.route("**/api/checkin", async (rt) => {
    if (rt.request().method() !== "POST") return rt.fallback();
    const resp = await rt.fetch();
    lost.push(resp.status());
    await rt.abort("failed");
  });
  await searchEnter(lena.name);
  const sawLost = await page.getByRole("alert").filter({ hasText: netMsg }).waitFor({ timeout: 15000 }).then(() => true, () => false);
  L.check("failed-save", "F2 lost response: the server stored the row (201) but the register shows the network failure",
    sawLost && JSON.stringify(lost) === "[201]" && (await rows(iRt, lena.id)) === 1, { sawLost, lost });
  await page.unroute("**/api/checkin");
  before = checkinPosts;
  const retryResp = page.waitForResponse((x) => x.request().method() === "POST" && new URL(x.url()).pathname === "/api/checkin");
  await search.press("Enter");
  const rs = await retryResp;
  await sleep(1500);
  L.check("retry", "R5 retry after the lost response sends one request, is answered 'already checked in', and leaves exactly one row and one audit row",
    checkinPosts - before === 1 && rs.status() === 409 && (await rows(iRt, lena.id)) === 1 && (await auditsSettled("attendance.mark", `${iRt}:${lena.id}`, 1)).length === 1
      && (await page.getByRole("alert").filter({ hasText: netMsg }).count()) === 0, { requests: checkinPosts - before, status: rs.status() });
  await page.reload();
  await openSession(hh(hourNow), RETRY_CLASS);
  L.check("retry", "R6 after reload the register shows the one stored row",
    await page.getByRole("button", { name: `Mark ${lena.name} absent` }).waitFor({ timeout: 45000 }).then(() => true, () => false), "row shown");

  // ── 9. The real card-scanner request, end to end ──
  const cardVersion = (await q(`select "cardVersion" from "Member" where id = $1`, [sam.id]))[0].cardVersion;
  const token = signCardToken({ tenantId, memberId: sam.id, cardVersion });
  const warm = await api(page, "POST", "/api/checkin/card", { classInstanceId: iSb, tokens: ["warm-up"] });
  L.note("journey", "N1 first request to /api/checkin/card (warm-up, junk token)", { status: warm.status, ms: warm.ms });
  const scan = await api(page, "POST", "/api/checkin/card", { classInstanceId: iSb, tokens: [token] });
  const scanQ = `${sam.name} has used 1 of 1 class this week (resets on ${dateText(nextMonday)}). Admit anyway?`;
  const res0 = scan.body?.results?.[0];
  L.check("journey", "J24 end-to-end: the real server, given the real card, asks (needs_confirmation, the question) and records nothing",
    scan.status === 200 && res0?.status === "needs_confirmation" && res0?.reason === "allowance_reached" && res0?.question === scanQ && scan.body?.recorded === 0 && (await rows(iSb, sam.id)) === 0,
    { status: scan.status, result: res0 });
  L.note("journey", "N2 real card request latency (the scanner's client timeout is 10 s)", { ms: scan.ms, withinScannerTimeout: scan.ms < 10000 });
  const conf = await api(page, "POST", "/api/checkin/card", { classInstanceId: iSb, tokens: [token], acknowledged: ["allowance_reached"] });
  const scanAudit = (await auditsSettled("attendance.card_scan", iSb, 1))[0]?.metadata ?? null;
  const ov = scanAudit?.overrides?.[0];
  L.check("journey", "J25 end-to-end: the confirmed resend admits that one card: one qr row; card_scan audit carries the override with the count",
    conf.status === 200 && conf.body?.results?.[0]?.status === "success" && conf.body?.recorded === 1 && (await record(iSb, sam.id))?.checkInMethod === "qr"
      && ov?.memberId === sam.id && JSON.stringify(ov?.reasons) === JSON.stringify(["allowance_reached"]) && ov?.overAllowance?.used === 1 && ov?.overAllowance?.limit === 1 && ov?.overAllowance?.basis === "week" && ov?.overAllowance?.resetsOn === nextMonday,
    { status: conf.status, result: conf.body?.results?.[0], audit: ov });
  L.note("journey", "N3 confirmed card request latency", { ms: conf.ms, withinScannerTimeout: conf.ms < 10000 });

  // ── 10. Phone width ──
  const phone = await context(browser, "10.96.0.2", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await ctx.storageState() });
  const p2 = await phone.newPage();
  p2.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  for (const path of ["/dashboard/memberships", "/dashboard/checkin"]) {
    await p2.goto(path);
    await p2.waitForLoadState("load");
    const m = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
    L.check("mobile", `M1 ${path} at 390 px has no horizontal page scroll`, m.scroll <= m.width + 1, m);
    await shot(p2, `allowances-mobile${path.replace(/\//g, "-")}`);
  }
  await p2.goto("/dashboard/memberships");
  await p2.locator(`button[aria-label="Edit ${PLAN}"]:visible`).first().click();
  await p2.locator("#tier-class-limit").waitFor();
  await p2.locator("#tier-class-limit").fill("2");
  await p2.locator("#tier-class-limit-basis").selectOption("weeks");
  const sheet = await p2.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  L.check("mobile", "M2 the plan editor with every-N-weeks fields open at 390 px has no horizontal page scroll", sheet.scroll <= sheet.width + 1, sheet);
  await shot(p2, "allowances-mobile-editor");
  L.check("journey", "J26 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
