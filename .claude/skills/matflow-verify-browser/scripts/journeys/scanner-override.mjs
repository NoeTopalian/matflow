// Journey: the card scanner and a used-up class allowance. Until 27 Oct 2026 the scanner asked and offered "Admit
// anyway" (review gap 6 / M-2, 21 Oct 2026); the owner then ruled that no door admits past the allowance. The file
// keeps its name so earlier ledgers still line up.
// The REAL CardScanner component runs with a mocked camera boundary: `navigator.mediaDevices.getUserMedia` returns a
// canvas stream and `window.BarcodeDetector` is a class whose detect() yields one real card token once. The member's
// weekly class is already used, so the real server REFUSES the card with the staff sentence and records nothing, an
// old scanner's acknowledgement admits no one, the row shows the sentence with no "Admit anyway" and no membership
// hint, and — once the member holds a class pack — the same card is admitted on one pack credit, which an unmark
// gives back.
// Needs `fixture.mjs create` and `server.mjs start`.
//   node journeys/scanner-override.mjs
import { randomUUID, createHmac } from "node:crypto";
import { chromium, state, q, ledger, shot, context, ownerSignIn } from "../lib.mjs";
import { testEnv } from "../../../matflow-verify-local/scripts/env.mjs";

const club = state.club;
if (!club) throw new Error("no fixture — run: node fixture.mjs create");
const L = ledger("scanner-override");
const tenantId = club.tenantId;
const errors = [];

// A card token exactly as lib/card-token.ts signs it, with the server's own AUTH secret (never printed).
function signCardToken(args) {
  const env = testEnv();
  const secret = env.NEXTAUTH_SECRET || env.AUTH_SECRET;
  if (!secret) throw new Error("no AUTH secret in .env.test");
  const key = createHmac("sha256", secret).update("matflow.card.v1").digest();
  const keyId = createHmac("sha256", key).update("matflow.card.keyid").digest().toString("base64url").slice(0, 6);
  const payload = { ...args, purpose: "card", keyId, exp: Math.floor(Date.now() / 1000) + 3600 };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest().toString("base64url");
  return `${body}.${sig}`;
}

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
const todayIso = `${parts.year}-${parts.month}-${parts.day}`;
const todayMarker = new Date(`${todayIso}T00:00:00.000Z`);
const hourNow = Number(parts.hour);
const hh = (h) => `${String(Math.min(23, Math.max(0, h))).padStart(2, "0")}:00`;
const T1 = hh(hourNow - 2), T2 = hh(hourNow + 1);
const dow = (todayMarker.getUTCDay() + 6) % 7; // Monday = 0
const nextMonday = new Date(todayMarker.getTime() + (7 - dow) * 86_400_000);
const long = (d) => d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

const member = (await q(`select id, name, "cardVersion" from "Member" where "tenantId" = $1 and name = 'Member 1'`, [tenantId]))[0];
if (!member) throw new Error("fixture has no Member 1");
const tier = randomUUID(); const cls = randomUUID(); const inst1 = randomUUID(); const inst2 = randomUUID();
await q(`insert into "MembershipTier" (id, "tenantId", name, "pricePence", currency, "billingCycle", "classLimit", "classLimitBasis", "updatedAt") values ($1, $2, 'Limited S', 0, 'GBP', 'monthly', 1, 'week', now())`, [tier, tenantId]);
await q(`update "Member" set "membershipTierId" = $1, "waiverAccepted" = true where id = $2 and "tenantId" = $3`, [tier, member.id, tenantId]);
await q(`insert into "Class" (id, "tenantId", name, duration, "maxCapacity") values ($1, $2, 'Scan Mat', 60, 50)`, [cls, tenantId]);
await q(`insert into "ClassInstance" (id, "classId", date, "startTime", "endTime") values ($1, $3, $4, $5, $5), ($2, $3, $4, $6, $6)`, [inst1, inst2, cls, todayMarker, T1, T2]);
await q(`insert into "AttendanceRecord" (id, "tenantId", "memberId", "classInstanceId", "checkInMethod") values ($1, $2, $3, $4, 'admin')`, [randomUUID(), tenantId, member.id, inst1]);
const records = async () => Number((await q(`select count(*)::int as n from "AttendanceRecord" where "tenantId" = $1 and "memberId" = $2 and "classInstanceId" = $3`, [tenantId, member.id, inst2]))[0].n);
const token = signCardToken({ tenantId, memberId: member.id, cardVersion: member.cardVersion });

const browser = await chromium.launch();
try {
  const ctx = await context(browser, "10.94.0.1");
  // The camera boundary: a canvas stream for getUserMedia, and a BarcodeDetector that reads the token once.
  await ctx.addInitScript((tok) => {
    window.__mfScanToken = tok;
    window.__mfDetectCalls = 0;
    class FakeBarcodeDetector {
      static async getSupportedFormats() { return ["qr_code"]; }
      constructor() {}
      async detect() {
        window.__mfDetectCalls += 1;
        if (window.__mfDetectCalls === 3) return [{ rawValue: window.__mfScanToken, format: "qr_code" }];
        return [];
      }
    }
    window.BarcodeDetector = FakeBarcodeDetector;
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 480;
    const g = canvas.getContext("2d");
    setInterval(() => { g.fillStyle = `hsl(${Date.now() % 360} 60% 50%)`; g.fillRect(0, 0, 640, 480); }, 50);
    if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    navigator.mediaDevices.getUserMedia = async () => canvas.captureStream(15);
  }, token);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
  let cardPosts = 0;
  const cardResponses = [];
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/checkin/card") cardPosts++; });
  page.on("requestfailed", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/checkin/card") cardResponses.push({ failed: r.failure()?.errorText ?? "failed", afterMs: Date.now() - cardStartedAt });
  });
  let cardStartedAt = Date.now();
  page.on("request", (r) => { if (r.method() === "POST" && new URL(r.url()).pathname === "/api/checkin/card") cardStartedAt = Date.now(); });
  page.on("response", async (r) => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/checkin/card") {
      cardResponses.push({ status: r.status(), body: await r.text().then((t) => t.slice(0, 300)).catch(() => null) });
    }
  });

  await ownerSignIn(page, club);
  await page.goto("/dashboard/checkin");
  await page.getByRole("button", { name: new RegExp(`${T2} · Scan Mat`) }).click();
  await page.getByRole("tab", { name: "Scan cards" }).click();
  // Warm the route first: on this laptop the first request to a route of a freshly started production server can
  // exceed the scanner's own 10 s timeout (which then reads "Didn't reach MatFlow" — the real behaviour under test
  // is what happens to a card the server answers, not a cold-start timeout). A junk token is answered "invalid".
  const warm = await page.evaluate(async (id) => {
    const t0 = Date.now();
    const r = await fetch("/api/checkin/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, tokens: ["warm-up"] }) });
    return { status: r.status, ms: Date.now() - t0 };
  }, inst2);
  L.note("journey", "N0 first request to /api/checkin/card after server start (warm-up, junk token)", warm);

  // The REAL server with the REAL token, from the page, without the component's 10 s abort: proves the server
  // refuses this card and records nothing. (Timed, because on this laptop the full check-in path to Neon can exceed
  // the scanner's 10 s client timeout, which then reads "Didn't reach MatFlow" — see N2.)
  const scanReal = (acknowledged) => page.evaluate(async ({ id, tok, ack }) => {
    const t0 = Date.now();
    const r = await fetch("/api/checkin/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, tokens: [tok], ...(ack ? { acknowledged: ack } : {}) }) });
    const body = await r.json().catch(() => null);
    return { status: r.status, ms: Date.now() - t0, result: body?.results?.[0] ?? null, recorded: body?.recorded ?? null };
  }, { id: inst2, tok: token, ack: acknowledged ?? null });
  const real = await scanReal();
  const staffSentence = `Member 1 has used their 1 class this week (resets on ${long(nextMonday)}) and has no class-pack credit, so they can't be checked in.`;
  L.check("journey", "J1 the real server, given the real card, REFUSES the used allowance (refused, allowance_reached, the staff sentence) and records nothing",
    real.status === 200 && real.result?.status === "refused" && real.result?.reason === "allowance_reached" && real.result?.message === staffSentence && !("question" in (real.result ?? {})) && real.recorded === 0 && (await records()) === 0,
    { status: real.status, ms: real.ms, result: real.result });
  L.note("journey", "N2 real card request time against the scanner's 10 s client timeout", { ms: real.ms, withinScannerTimeout: real.ms < 10000 });
  const old = await scanReal(["allowance_reached"]);
  L.check("journey", "J1b an old scanner's resend with acknowledged: [allowance_reached] is not a 400 and admits no one",
    old.status === 200 && old.result?.status === "refused" && old.result?.reason === "allowance_reached" && old.recorded === 0 && (await records()) === 0,
    { status: old.status, result: old.result });

  // The component, driven by the mocked camera. The network boundary is served by the answer the server gave above,
  // so the row behaviour is judged on its own and not on tonight's Neon latency; the request body the component sends
  // is asserted exactly.
  const bodies = [];
  await page.route("**/api/checkin/card", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    const body = req.postDataJSON();
    bodies.push(body);
    const result = { index: 0, status: "refused", memberId: member.id, memberName: "Member 1", reason: "allowance_reached", message: staffSentence };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [result], recorded: 0, failed: 1 }) });
  });
  await page.getByRole("button", { name: "Start camera" }).click();

  const rowName = page.getByText("Member 1", { exact: true });
  const shown = await page.getByText(staffSentence, { exact: true }).waitFor({ timeout: 30000 }).then(() => true, () => false);
  if (!shown) await shot(page, "scanner-no-refusal");
  await page.waitForTimeout(800);
  const status = await page.getByRole("status").filter({ hasText: "class allowance used" }).first().textContent({ timeout: 5000 }).catch(() => null);
  L.check("journey", "J2 the real scanner reads the card through the mocked camera, sends that one token with no acknowledgement, and shows ONE refused row: the staff sentence, labelled Allowance used, no Admit anyway, no membership hint",
    shown && (await rowName.count()) === 1 && (await page.getByText("Allowance used").count()) >= 1 && bodies.length === 1 && bodies[0].tokens?.length === 1 && bodies[0].tokens[0] === token && !bodies[0].acknowledged
      && (await page.getByRole("button", { name: "Admit anyway" }).count()) === 0 && (await page.getByText(/Change their membership or the squad list/).count()) === 0,
    { shown, rows: await rowName.count(), posts: bodies.length, askButtons: await page.getByRole("button", { name: "Admit anyway" }).count() });
  L.check("journey", "J2b the screen reader hears \"Member 1, class allowance used. Can't be checked in.\"",
    status === "Member 1, class allowance used. Can't be checked in.", { status });
  await shot(page, "scanner-refused");
  await page.unroute("**/api/checkin/card");

  // A class pack pays instead of a refusal at the scanner too (owner, 27 Oct 2026: "they get what they paid for").
  const packTpl = randomUUID(); const memberPack = randomUUID();
  await q(`insert into "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", "updatedAt") values ($1, $2, 'Scan pack', 5, 90, 5000, now())`, [packTpl, tenantId]);
  await q(`insert into "MemberClassPack" (id, "tenantId", "memberId", "packId", "creditsRemaining", "expiresAt", status) values ($1, $2, $3, $4, 2, now() + interval '60 days', 'active')`, [memberPack, tenantId, member.id, packTpl]);
  const credits = async () => Number((await q(`select "creditsRemaining" as n from "MemberClassPack" where id = $1`, [memberPack]))[0].n);
  try {
    const paid = await scanReal();
    const redeemed = (await q(`select r."attendanceRecordId" as rec from "ClassPackRedemption" r join "AttendanceRecord" a on a.id = r."attendanceRecordId" where r."memberPackId" = $1 and a."classInstanceId" = $2`, [memberPack, inst2]))[0];
    L.check("journey", "J3 with a class pack the same card is admitted on ONE pack credit (2 → 1), the redemption names the new row, and the card_scan row carries no override",
      paid.status === 200 && paid.result?.status === "success" && paid.recorded === 1 && (await records()) === 1 && (await credits()) === 1 && !!redeemed,
      { status: paid.status, result: paid.result, credits: await credits(), redeemed: !!redeemed });
    const scanAudit = (await q(`select metadata from "AuditLog" where "tenantId" = $1 and action = 'attendance.card_scan' and "entityId" = $2 order by "createdAt" desc limit 1`, [tenantId, inst2]))[0]?.metadata;
    L.check("journey", "J3b the card_scan audit row has no overrides key", !!scanAudit && !("overrides" in scanAudit), { scanAudit });
    const removed = await page.evaluate(async ({ id, mid }) => (await fetch(`/api/checkin?classInstanceId=${id}&memberId=${mid}`, { method: "DELETE" })).status, { id: inst2, mid: member.id });
    L.check("journey", "J3c removing that check-in gives the pack credit back (1 → 2) and deletes the row",
      removed === 200 && (await records()) === 0 && (await credits()) === 2, { removed, credits: await credits(), rows: await records() });
  } finally {
    await q(`delete from "ClassPackRedemption" where "memberPackId" = $1`, [memberPack]);
    await q(`delete from "MemberClassPack" where id = $1`, [memberPack]);
    await q(`delete from "ClassPack" where id = $1`, [packTpl]);
  }
  L.check("journey", "J4 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
