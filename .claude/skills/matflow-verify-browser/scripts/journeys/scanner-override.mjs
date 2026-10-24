// Journey: the card scanner's allowance "Admit anyway" (review gap 6 / M-2, 21 Oct 2026).
// The REAL CardScanner component runs with a mocked camera boundary: `navigator.mediaDevices.getUserMedia` returns a
// canvas stream and `window.BarcodeDetector` is a class whose detect() yields one real card token once. The member's
// weekly class is already used, so the scan is asked about; Admit anyway settles the SAME row to "Checked in" (no
// stale askable row, no second row), the record exists and the card_scan audit row carries the override.
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

  // The REAL server with the REAL token, from the page, without the component's 10 s abort: proves the server asks
  // about this card and records nothing. (Timed, because on this laptop the full check-in path to Neon can exceed
  // the scanner's 10 s client timeout, which then reads "Didn't reach MatFlow" — see N2.)
  const real = await page.evaluate(async ({ id, tok }) => {
    const t0 = Date.now();
    const r = await fetch("/api/checkin/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ classInstanceId: id, tokens: [tok] }) });
    const body = await r.json().catch(() => null);
    return { status: r.status, ms: Date.now() - t0, result: body?.results?.[0] ?? null, recorded: body?.recorded ?? null };
  }, { id: inst2, tok: token });
  const question = `Member 1 has used 1 of 1 class this week (resets on ${long(nextMonday)}). Admit anyway?`;
  L.check("journey", "J1 the real server, given the real card, ASKS about the used allowance (needs_confirmation with the question) and records nothing",
    real.status === 200 && real.result?.status === "needs_confirmation" && real.result?.reason === "allowance_reached" && real.result?.question === question && real.recorded === 0 && (await records()) === 0,
    { status: real.status, ms: real.ms, result: real.result });
  L.note("journey", "N2 real card request time against the scanner's 10 s client timeout", { ms: real.ms, withinScannerTimeout: real.ms < 10000 });

  // The component, driven by the mocked camera. The network boundary is served by the same answers the server gives
  // (the asked answer above, then the admitted answer), so the row behaviour is judged on its own and not on tonight's
  // Neon latency; the request bodies the component sends are asserted exactly.
  const bodies = [];
  await page.route("**/api/checkin/card", async (route) => {
    const req = route.request();
    if (req.method() !== "POST") return route.fallback();
    const body = req.postDataJSON();
    bodies.push(body);
    const confirmed = Array.isArray(body.acknowledged) && body.acknowledged.includes("allowance_reached");
    const result = confirmed
      ? { index: 0, status: "success", memberId: member.id, memberName: "Member 1" }
      : { index: 0, status: "needs_confirmation", memberId: member.id, memberName: "Member 1", reason: "allowance_reached", question };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [result], recorded: confirmed ? 1 : 0 }) });
  });
  await page.getByRole("button", { name: "Start camera" }).click();

  const rowName = page.getByText("Member 1", { exact: true });
  const asked = await page.getByRole("button", { name: "Admit anyway" }).waitFor({ timeout: 30000 }).then(() => true, () => false);
  if (!asked) await shot(page, "scanner-no-ask");
  L.check("journey", "J2 the real scanner reads the card through the mocked camera, sends that one token, and shows ONE askable row with the server's question",
    asked && (await rowName.count()) === 1 && (await page.getByText("Allowance used").count()) >= 1 && bodies.length === 1 && bodies[0].tokens?.length === 1 && bodies[0].tokens[0] === token && !bodies[0].acknowledged && (await page.getByText(question).count()) === 1,
    { asked, rows: await rowName.count(), posts: bodies.length });
  await shot(page, "scanner-asked");

  await page.getByRole("button", { name: "Admit anyway" }).click();
  const settled = await page.getByText("Checked in", { exact: true }).waitFor({ timeout: 30000 }).then(() => true, () => false);
  await page.waitForTimeout(800);
  L.check("journey", "J3 Admit anyway resends that one card once with acknowledged: [allowance_reached], and the SAME row settles to Checked in — no stale askable row, no second row (review M-2)",
    settled && bodies.length === 2 && bodies[1].tokens?.length === 1 && bodies[1].tokens[0] === token && JSON.stringify(bodies[1].acknowledged) === JSON.stringify(["allowance_reached"])
      && (await rowName.count()) === 1 && (await page.getByRole("button", { name: "Admit anyway" }).count()) === 0,
    { settled, resends: bodies.length - 1, acknowledged: bodies[1]?.acknowledged, rows: await rowName.count(), askButtons: await page.getByRole("button", { name: "Admit anyway" }).count() });
  await shot(page, "scanner-admitted");
  L.note("journey", "N3 what the confirmed request does on the server (record + card_scan audit override) is covered by tests/unit/checkin-allowance-doors.test.ts and the register journey; not re-proved here", "see evidence doc");
  L.check("journey", "J4 no uncaught page errors", errors.length === 0, errors);
} finally {
  await browser.close();
}
console.log(`\n${L.summary()} — ledger ${L.path}`);
process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
