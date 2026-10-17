// SIMULATED email journey (no Resend, no network to any provider) against a local production build on the
// Neon TEST branch. Labels every result SIMULATED.
//   node email-webhook-sim.mjs setup      fixture club (fixture.mjs) + member 2 gets a password + the private
//                                         sim env file: EMAIL_DELIVERY=test, EMAIL_TEST_RECIPIENTS=<member 2>,
//                                         a locally generated RESEND_WEBHOOK_SECRET, a dummy key and RESEND_BASE_URL
//                                         pointing at the local counting interceptor (nothing leaves the machine)
//   (start: MF_EXTRA_ENV=<printed file> node .claude/skills/matflow-verify-local/scripts/server.mjs start)
//   node email-webhook-sim.mjs run        sends + signed webhooks, EmailLog read back after each step
//   node email-webhook-sim.mjs teardown   fixture teardown (removes its EmailLog rows too) + sim env file
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { APP, OUT, BASE, state, saveState, q, ledger, bcrypt } from "./lib.mjs";
import { node24 } from "../../matflow-verify-local/scripts/env.mjs";

const require = createRequire(`${APP}/package.json`);
const { Webhook } = require("svix");
const SIM_ENV = path.join(OUT, "email-sim.env");
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

async function setup() {
  if (!state.club) {
    const r = spawnSync(node24(), [path.join(HERE, "fixture.mjs"), "create"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_APP: APP } });
    if (r.status !== 0) throw new Error(`fixture create failed: ${r.stdout.slice(-300)}`);
    Object.assign(state, JSON.parse(fs.readFileSync(path.join(OUT, "fixture-state.json"), "utf8")));
  }
  const c = state.club;
  const m2 = `${c.slug}-m2@example.test`;
  await q(`update "Member" set "passwordHash" = $1 where "tenantId" = $2 and email = $3`, [await bcrypt.hash(randomBytes(12).toString("hex"), 10), c.tenantId, m2]);
  const secret = `whsec_${randomBytes(24).toString("base64")}`;
  // Sends go to the local counting interceptor (never leaves the machine); the key is a dummy.
  fs.writeFileSync(SIM_ENV, `EMAIL_DELIVERY=test\nEMAIL_TEST_RECIPIENTS=${m2}\nRESEND_WEBHOOK_SECRET=${secret}\nRESEND_API_KEY=re_sim_dummy_interceptor_only\nRESEND_BASE_URL=http://127.0.0.1:4599\n`);
  state.sim = { secretFile: SIM_ENV, m2 };
  saveState();
  console.log(`setup done (SIMULATED). Start the server with MF_EXTRA_ENV=${SIM_ENV}`);
}

const logRows = (tenantId) => q(`select id, "templateId", recipient, status, "errorMessage", "resendId" from "EmailLog" where "tenantId" = $1 order by "createdAt"`, [tenantId]);

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const c = state.club, sim = state.sim;
  if (!c || !sim) throw new Error("run setup first");
  const L = ledger("email-webhook-sim");
  const secret = fs.readFileSync(sim.secretFile, "utf8").match(/^RESEND_WEBHOOK_SECRET=(.+)$/m)[1];
  const forgot = (email) => fetch(`${BASE}/api/auth/forgot-password`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-lane-ip": "10.93.0.1" }, body: JSON.stringify({ email, tenantSlug: c.slug }) });

  // The local counting stand-in for Resend (RESEND_BASE_URL in the sim env): every send that reaches the
  // provider transport is counted here and nothing leaves the machine.
  // Same contract as scripts/readiness/release-verify.mjs mail-interceptor, but ids are unique per run
  // (EmailLog.resendId is unique; that interceptor restarts at intercepted-1 every run).
  const http = await import("node:http");
  const runTag = randomBytes(4).toString("hex");
  let intercepted = 0;
  const interceptor = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/__count") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ count: intercepted })); return; }
    req.resume();
    req.on("end", () => {
      if (req.method === "POST") intercepted++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `intercepted-${runTag}-${intercepted}` }));
    });
  }).listen(4599, "127.0.0.1");
  await new Promise((r) => interceptor.once("listening", r));
  const count = async () => (await (await fetch("http://127.0.0.1:4599/__count")).json()).count;

  // S1: a recipient outside EMAIL_TEST_RECIPIENTS (the owner) — blocked before any provider call.
  const before = (await logRows(c.tenantId)).length;
  const n0 = await count();
  const r1 = await forgot(c.owner.email);
  await new Promise((r) => setTimeout(r, 1500));
  const s1 = (await logRows(c.tenantId)).slice(before).find((x) => x.recipient.toLowerCase() === c.owner.email.toLowerCase());
  const n1 = await count();
  L.check("allowlist", "S1 SIMULATED: owner (not on the test list) → EmailLog suppressed_not_allowlisted and NO request reached the provider transport", r1.status === 200 && s1?.status === "suppressed" && /^suppressed_not_allowlisted/.test(s1.errorMessage ?? "") && n1 === n0, { http: r1.status, providerRequests: n1 - n0, row: s1 ? { status: s1.status, reason: (s1.errorMessage ?? "").split(":")[0] } : null });

  // S2: the allowlisted member — passes the allowlist; exactly one request reaches the (intercepted) transport.
  const r2 = await forgot(sim.m2);
  await new Promise((r) => setTimeout(r, 1500));
  const s2 = (await logRows(c.tenantId)).find((x) => x.recipient.toLowerCase() === sim.m2.toLowerCase());
  const n2 = await count();
  L.check("allowlist", "S2 SIMULATED: allowlisted member → exactly one intercepted provider request, EmailLog sent with the provider id", r2.status === 200 && n2 - n1 === 1 && s2?.status === "sent" && /^intercepted-/.test(s2.resendId ?? ""), { http: r2.status, providerRequests: n2 - n1, row: s2 ? { status: s2.status, resendId: s2.resendId } : null });
  interceptor.close();
  if (!s2?.resendId) { console.log(`\n${L.summary()} — ledger ${L.path}`); process.exit(1); }

  // Webhooks against the row sendEmail actually wrote.
  const resendId = s2.resendId;
  const row = { id: s2.id };
  const status = async () => (await q(`select status, "errorMessage" from "EmailLog" where id = $1`, [row.id]))[0];
  const hook = async (type, { id, at, key, data } = {}) => {
    const body = JSON.stringify({ type, created_at: new Date().toISOString(), data: { email_id: resendId, to: [sim.m2], ...(data ?? {}) } });
    const msgId = id ?? `msg_${randomBytes(6).toString("hex")}`;
    const when = at ?? new Date();
    const sig = new Webhook(key ?? secret).sign(msgId, when, body);
    const res = await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": msgId, "svix-timestamp": String(Math.floor(when.getTime() / 1000)), "svix-signature": sig }, body });
    return { http: res.status, outcome: (await res.json()).outcome };
  };
  const steps = [
    ["W1 delivered (valid signature) → applied, row delivered", () => hook("email.delivered", { id: "msg_sim_dup" }), (h, s) => h.outcome === "applied" && s.status === "delivered"],
    ["W2 same delivery again (same svix-id) → duplicate, no change", () => hook("email.delivered", { id: "msg_sim_dup" }), (h, s) => h.outcome === "duplicate" && s.status === "delivered"],
    ["W3 delivery_delayed after delivered → ignored, stays delivered", () => hook("email.delivery_delayed"), (h, s) => h.outcome === "ignored_would_downgrade" && s.status === "delivered"],
    ["W4 wrong signing secret → 401, no change", () => hook("email.bounced", { key: `whsec_${randomBytes(24).toString("base64")}` }), (h, s) => h.http === 401 && s.status === "delivered"],
    ["W5 stale timestamp (10 min) → 401, no change", () => hook("email.bounced", { at: new Date(Date.now() - 600000) }), (h, s) => h.http === 401 && s.status === "delivered"],
    ["W6 event naming another recipient → ignored, no change", () => hook("email.bounced", { data: { to: ["someone-else@example.test"] } }), (h, s) => h.outcome === "ignored_recipient_mismatch" && s.status === "delivered"],
    ["W7 bounced → applied, reason has no address", () => hook("email.bounced", { data: { bounce: { type: "Permanent", subType: "General", message: `550 ${sim.m2} unknown` } } }), (h, s) => h.outcome === "applied" && s.status === "bounced" && !s.errorMessage.includes("@")],
    ["W8 delivered after bounced → ignored, stays bounced", () => hook("email.delivered"), (h, s) => h.outcome === "ignored_would_downgrade" && s.status === "bounced"],
  ];
  for (const [label, act, ok] of steps) {
    const h = await act();
    const s = await status();
    L.check("webhook", `${label} [SIMULATED]`, ok(h, s), { ...h, status: s.status });
  }
  const unknown = await (async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_not_in_this_database", to: [sim.m2] } });
    const id = `msg_${randomBytes(6).toString("hex")}`; const at = new Date();
    const res = await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(secret).sign(id, at, body) }, body });
    return { http: res.status, outcome: (await res.json()).outcome };
  })();
  L.check("webhook", "W9 email this database never sent (no created_at) → ignored, 200 [SIMULATED]", unknown.http === 200 && unknown.outcome === "ignored_unknown_email", unknown);
  const recentUnknown = await (async () => {
    const body = JSON.stringify({ type: "email.sent", created_at: new Date().toISOString(), data: { email_id: `re_not_recorded_yet_${runTag}`, to: [sim.m2] } });
    const id = `msg_${randomBytes(6).toString("hex")}`; const at = new Date();
    const res = await fetch(`${BASE}/api/webhooks/resend`, { method: "POST", headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(secret).sign(id, at, body) }, body });
    return { http: res.status, outcome: (await res.json()).outcome };
  })();
  L.check("webhook", "W10 a recent event for an id not recorded yet → 409 so Resend retries [SIMULATED]", recentUnknown.http === 409 && recentUnknown.outcome === "retry_unknown_recent", recentUnknown);

  const serverLog = fs.readFileSync(path.join(OUT, "server-3991.log"), "utf8");
  const hookLines = serverLog.split(/\r?\n/).filter((l) => l.includes("[resend-webhook]"));
  L.check("logs", "G1 webhook log lines carry no address, secret or body [SIMULATED]", hookLines.length >= 9 && !hookLines.some((l) => /@|whsec_|550/.test(l)), { lines: hookLines.length, sample: hookLines[0]?.slice(0, 160) });
  console.log(`\n${L.summary()} — ledger ${L.path}`);
  process.exit(L.rows.some((r) => r.result === "FAIL") ? 1 : 0);
}

async function teardown() {
  const r = spawnSync(node24(), [path.join(HERE, "fixture.mjs"), "teardown"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_APP: APP } });
  console.log(r.stdout.split(/\r?\n/).filter((l) => l.includes("tornDown") || l.includes("nothingToTearDown")).join("\n"));
  if (state.sim?.secretFile) fs.rmSync(state.sim.secretFile, { force: true });
  // fixture.mjs rewrote the state file in its own process; drop our stale copies of what it removed.
  delete state.club; delete state.sim; saveState();
  console.log("sim env file removed");
}

const [cmd] = process.argv.slice(2);
if (cmd === "setup") await setup();
else if (cmd === "run") await run();
else if (cmd === "teardown") await teardown();
else { console.log("usage: setup | run | teardown"); process.exit(2); }
