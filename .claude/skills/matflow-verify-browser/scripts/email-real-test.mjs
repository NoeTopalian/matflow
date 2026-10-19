// The first isolated REAL email test: exactly ONE password-reset email, through a SEPARATE Resend testing team, to ONE
// address Noe owns, from a local production build on the Neon TEST branch, with a synthetic club. Noe triggers the one
// send himself from the isolated app's own "Forgot password" screen; this script never sends.
// Every provider request goes through resend-relay.mjs (RESEND_BASE_URL=http://127.0.0.1:4598), which counts it,
// forwards only POST /emails to the one listed address, and forwards at most one.
// Credentials stay in the private file named by MF_EXTRA_ENV (outside git); no key, secret or full address is printed.
//
//   node email-real-test.mjs preflight [--before-webhook]   checks the private file and the key (no email is sent)
//   node email-real-test.mjs setup        synthetic club; member 2 becomes the listed address (relay must be running)
//   node email-real-test.mjs blocked      an unlisted address (the club owner): zero provider requests, nothing minted
//   node email-real-test.mjs verify       after Noe's reset: one provider send, signed webhook, code used, no others
//   node email-real-test.mjs teardown     removes the club and checks no row anywhere still holds the address
// Ledger rows are labelled REAL when the relay's upstream is Resend, SIMULATED when it is a local stand-in (dry run).
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { APP, OUT, BASE, state, saveState, q, ledger, bcrypt } from "./lib.mjs";
import { node24, extraEnv, REPO } from "../../matflow-verify-local/scripts/env.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const APP_PORT = Number(process.env.MF_PORT ?? 3991);
const GATE_PORT = Number(process.env.WEBHOOK_GATE_PORT ?? 3995);
const RELAY = `http://127.0.0.1:${Number(process.env.RESEND_RELAY_PORT ?? 4598)}`;
const ADDRESS = /^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/;
const WEBHOOK_SECRET = /^whsec_[A-Za-z0-9+/]{32,}={0,2}$/; // the route's own rule
const mask = (a) => { const [u, d] = String(a).split("@"); return d ? `${u.slice(0, 1)}…@${d}` : "…"; };
const fp = (v) => createHash("sha256").update(String(v)).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The private settings, validated by the same parser the server uses (refuses keys, files inside git, bad lines). */
function settings() {
  if (!process.env.MF_EXTRA_ENV) throw new Error("BLOCKED: set MF_EXTRA_ENV to the private email-test.env");
  return extraEnv();
}

/** The relay's counters; its `mode` (REAL / SIMULATED) labels every ledger row. */
async function relay() {
  try { return await (await fetch(`${RELAY}/__relay`)).json(); } catch { throw new Error(`BLOCKED: the Resend relay is not running on ${RELAY} (start resend-relay.mjs first)`); }
}

/** The single recipient, or a reason it is not acceptable. */
function recipient(s) {
  const list = (s.EMAIL_TEST_RECIPIENTS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (list.length !== 1) return { error: `EMAIL_TEST_RECIPIENTS must hold exactly ONE address for this test (it holds ${list.length})` };
  const a = list[0].toLowerCase();
  if (!ADDRESS.test(a)) return { error: "EMAIL_TEST_RECIPIENTS is not a plain ASCII address" };
  if (a.endsWith("@resend.dev")) return { error: "the one recipient must be your own address, not a resend.dev test address" };
  if (/sean|totalbjj/i.test(a)) return { error: "that looks like Sean / Total BJJ — refused" };
  if (/@(example|test)\.(com|test|org)$/.test(a)) return { error: "a placeholder domain cannot receive mail" };
  return { address: a };
}

function knownKeys() {
  // Keys whose owner account is unknown (the 440 historical test-branch sends) — this test must not use them.
  const out = [];
  for (const f of [path.join(REPO, ".env"), path.join(REPO, ".env.test"), path.join(APP, ".env"), path.join(APP, ".env.test")]) {
    if (!fs.existsSync(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(/^RESEND_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) out.push(fp(m[1].trim()));
  }
  return out;
}

async function preflight() {
  const s = settings();
  const r = recipient(s);
  const key = s.RESEND_API_KEY ?? "";
  const known = knownKeys();
  const checks = [
    ["EMAIL_DELIVERY is test", (s.EMAIL_DELIVERY ?? "").toLowerCase() === "test"],
    [r.error ?? `exactly one recipient: ${mask(r.address)}`, !r.error],
    ["RESEND_API_KEY present (re_…)", /^re_[A-Za-z0-9_]{16,}$/.test(key)],
    [`RESEND_API_KEY differs from every RESEND_API_KEY in a local .env file (${known.length} compared by fingerprint; the 440 historical sends used an account that is unknown)`, key !== "" && !known.includes(fp(key))],
    ["RESEND_FROM is Resend's testing sender (…@resend.dev): the testing team has no domain", /@resend\.dev>?\s*$/i.test(s.RESEND_FROM ?? "")],
    process.argv.includes("--before-webhook")
      ? ["RESEND_WEBHOOK_SECRET not checked yet (--before-webhook)", true]
      : ["RESEND_WEBHOOK_SECRET is a full whsec_ signing secret", WEBHOOK_SECRET.test(s.RESEND_WEBHOOK_SECRET ?? "")],
    [`RESEND_BASE_URL is the counting relay (${RELAY}), so every provider request is seen`, s.RESEND_BASE_URL === RELAY],
  ];
  // One read-only call straight to Resend (no email): a Sending-access key is refused on every endpoint except sending,
  // with `restricted_api_key`; an unknown key gets `validation_error`; a Full-access key would answer 200.
  let keyCheck = "not run";
  if (/^re_/.test(key)) {
    try {
      const res = await fetch("https://api.resend.com/api-keys", { headers: { authorization: `Bearer ${key}` } });
      const body = await res.json().catch(() => ({}));
      keyCheck = res.status === 401 && body?.name === "restricted_api_key" ? "PASS" : res.status === 200 ? "FULL_ACCESS" : `INVALID (${res.status} ${String(body?.name ?? "").slice(0, 40)})`;
    } catch (e) { keyCheck = `BLOCKED (network: ${e instanceof Error ? e.name : "error"})`; }
  }
  checks.push([`Resend accepts the key and it is Sending access only (read-only check, no email): ${keyCheck}`, keyCheck === "PASS"]);
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log("Which TEAM owns the key cannot be read with a Sending-access key. It is proven after the one send: the signed event must arrive through the webhook registered only in the testing team (V2), and the email must appear on that team's Emails page.");
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

async function setup() {
  const r = recipient(settings());
  if (r.error) throw new Error(`refusing: ${r.error}`);
  const rel = await relay();
  if (!state.club) {
    const res = spawnSync(node24(), [path.join(HERE, "fixture.mjs"), "create"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_APP: APP } });
    if (res.status !== 0) throw new Error(`fixture create failed: ${res.stdout.slice(-300)}`);
    Object.assign(state, JSON.parse(fs.readFileSync(path.join(OUT, "fixture-state.json"), "utf8")));
  }
  const c = state.club;
  const m2 = `${c.slug}-m2@example.test`;
  const hash = await bcrypt.hash(randomBytes(12).toString("hex"), 10);
  const rows = await q(`update "Member" set email = $1, "passwordHash" = $2 where "tenantId" = $3 and email = $4 returning id`, [r.address, hash, c.tenantId, m2]);
  if (rows.length !== 1) throw new Error("member 2 not found");
  state.real = { memberId: rows[0].id, addressFp: fp(r.address), hashFp: fp(hash), mode: rel.mode, relayInstance: rel.instance };
  saveState();
  console.log(`setup done (${rel.mode}): club ${c.slug}; member 2 is ${mask(r.address)} with a password.`);
  console.log(`Isolated app reset screen: ${BASE}/login?club=${c.slug}  ->  "Forgot password"`);
}

const providerRows = (tenantId) => q(`select id, recipient, status, "resendId", "errorMessage" from "EmailLog" where "tenantId" = $1 and "resendId" is not null`, [tenantId]);
const resetTokens = (tenantId, email) => q(`select id, used from "PasswordResetToken" where "tenantId" = $1 and lower(email) = lower($2)`, [tenantId, email]);

/** The relay this run started with — never counters from another relay instance. */
async function sameRelay(real) {
  const rel = await relay();
  if (rel.instance !== real.relayInstance) throw new Error("refusing: the relay was restarted since setup — its counters no longer cover this run (run teardown and start again)");
  if (rel.mode !== real.mode) throw new Error(`refusing: setup ran ${real.mode} but the relay now says ${rel.mode}`);
  return rel;
}

const forgot = (c, email, lane) => fetch(`${BASE}/api/auth/forgot-password`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-lane-ip": lane }, body: JSON.stringify({ email, tenantSlug: c.slug }) });

async function blocked() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const c = state.club, real = state.real;
  if (!c || !real) throw new Error("run setup first");
  const r = recipient(settings());
  if (r.error || fp(r.address) !== real.addressFp) throw new Error("refusing: the private file's recipient changed since setup");
  const r0 = await sameRelay(real);
  if (r0.armed) throw new Error("refusing: the relay is already armed — start a fresh relay so the control request cannot reach Resend");
  const L = ledger("email-real-blocked");

  // B0 — positive control. The LISTED address, with the relay DISARMED: the request must reach the relay (proving the
  // server runs in test mode, with a key, through the relay) and be refused there, so nothing reaches Resend.
  const c0 = await forgot(c, r.address, "10.93.2.1");
  await sleep(1500);
  const r1 = await sameRelay(real);
  const control = (await q(`select id, status, "resendId" from "EmailLog" where "tenantId" = $1 and lower(recipient) = $2 order by "createdAt" desc limit 1`, [c.tenantId, r.address]))[0];
  L.check("control", `B0 [${r1.mode}] control: the listed address reaches the relay (+1 request), which refuses it while disarmed — nothing forwarded`, c0.status === 200 && r1.received === r0.received + 1 && r1.forwarded === 0 && control && !control.resendId, { http: c0.status, relayBefore: r0.received, relayAfter: r1.received, forwarded: r1.forwarded, controlRow: control?.status });
  real.controlLogId = control?.id ?? null;

  // B1/B2 — an UNLISTED address (the club owner), holding a live code from earlier: zero provider requests, the earlier
  // code survives, nothing new is minted, no email row is written.
  await q(`insert into "PasswordResetToken" (id, email, "tenantId", "tokenHash", "expiresAt", used) values ($1, lower($2), $3, $4, now() + interval '10 minutes', false)`, [`b1-${randomBytes(6).toString("hex")}`, c.owner.email, c.tenantId, `b1-${randomBytes(16).toString("hex")}`]);
  const tokensBefore = await resetTokens(c.tenantId, c.owner.email);
  const ownerRows = () => q(`select count(*)::int n from "EmailLog" where "tenantId" = $1 and lower(recipient) = lower($2)`, [c.tenantId, c.owner.email]);
  const rowsBefore = (await ownerRows())[0].n;
  const b1 = await forgot(c, c.owner.email, "10.93.2.2");
  await sleep(1500);
  const r2 = await sameRelay(real);
  const tokensAfter = await resetTokens(c.tenantId, c.owner.email);
  const rowsAfter = (await ownerRows())[0].n;
  L.check("allowlist", `B1 [${r2.mode}] an unlisted address, same server and relay as the control: ZERO provider requests (relay counter unchanged), same opaque 200`, b1.status === 200 && r2.received === r1.received, { http: b1.status, relayBefore: r1.received, relayAfter: r2.received });
  L.check("side-effects", `B2 [${r2.mode}] the blocked request retired no earlier code, minted none, and wrote no email row`, tokensAfter.length === tokensBefore.length && tokensAfter.every((t) => t.used === false) && rowsAfter === rowsBefore, { codesBefore: tokensBefore.length, codesAfter: tokensAfter.length, stillLive: tokensAfter.filter((t) => !t.used).length, emailRowsAdded: rowsAfter - rowsBefore });

  const passed = !L.rows.some((x) => x.result === "FAIL");
  if (passed) {
    const armed = await (await fetch(`${RELAY}/__arm`, { method: "POST" })).json();
    real.armedAtReceived = armed.receivedAtArm;
    console.log(`relay ARMED (instance ${armed.instance}): it will now forward exactly one email to ${mask(r.address)}.`);
  }
  saveState();
  console.log(`\n${L.summary()} — ledger ${L.path}`);
  process.exit(passed ? 0 : 1);
}

async function verify() {
  const c = state.club, real = state.real;
  if (!c || !real) throw new Error("run setup first");
  const r = recipient(settings());
  if (r.error || fp(r.address) !== real.addressFp) throw new Error("refusing: the private file's recipient changed since setup");
  const rel = await sameRelay(real);
  if (!rel.armed || real.armedAtReceived == null) throw new Error("refusing: the relay was never armed by `blocked` — run blocked first");
  const M = rel.mode;
  const L = ledger("email-real-verify");
  let sends = await providerRows(c.tenantId);
  // Every email row this club wrote since setup that was not suppressed by the app, except blocked's control row.
  const attempted = await q(`select id, recipient, status, "resendId" from "EmailLog" where "tenantId" = $1 and status <> 'suppressed' and id <> $2`, [c.tenantId, real.controlLogId ?? ""]);
  // V1 — after arming, exactly one request reached the relay, it was forwarded, and it is the one accepted email.
  const sinceArm = rel.received - real.armedAtReceived;
  L.check("send", `V1 [${M}] after arming: exactly one provider request (same relay instance), forwarded once, and one email attempt — to the confirmed address`, sinceArm === 1 && rel.forwarded === 1 && attempted.length === 1 && sends.length === 1 && sends[0].recipient.toLowerCase() === r.address && attempted[0].id === sends[0].id, { relayRequestsSinceArm: sinceArm, forwarded: rel.forwarded, emailAttempts: attempted.length, acceptedEmails: sends.length, to: sends.map((s) => mask(s.recipient)) });
  // V2 — a genuine signed event moved that row; it can only come from the webhook registered in the testing team.
  for (let i = 0; i < 36 && sends[0] && !["delivered", "bounced", "complained"].includes(sends[0].status); i++) { await sleep(5000); sends = await providerRows(c.tenantId); }
  const id = sends[0]?.resendId ?? "-";
  const lines = fs.readFileSync(path.join(OUT, `server-${APP_PORT}.log`), "utf8").split(/\r?\n/).filter((l) => l.includes("[resend-webhook]") && l.includes(`email=${id}`));
  L.check("webhook", `V2 [${M}] a signed webhook (testing team's secret, through the gate) moved that row to delivered`, sends[0]?.status === "delivered" && lines.some((l) => /type=email\.delivered .*outcome=applied/.test(l)), {
    status: sends[0]?.status, resendId: id,
    events: lines.map((l) => { const m = l.match(/svix=(\S+) .*type=(\S+) .*outcome=(\S+)/); return m ? `${m[2]}:${m[3]} (${m[1]})` : null; }).filter(Boolean),
  });
  // V3 — the code worked once against the isolated app: the token is spent and the synthetic member's password changed.
  const tok = await q(`select used from "PasswordResetToken" where "tenantId" = $1 and lower(email) = $2 order by "createdAt" desc limit 1`, [c.tenantId, r.address]);
  const mem = await q(`select "passwordHash" from "Member" where id = $1`, [real.memberId]);
  L.check("reset", `V3 [${M}] the emailed code reset the password on the isolated app (token used, password changed)`, tok[0]?.used === true && mem[0] && fp(mem[0].passwordHash) !== real.hashFp, { tokenUsed: tok[0]?.used ?? null, passwordChanged: mem[0] ? fp(mem[0].passwordHash) !== real.hashFp : null });
  // V4 — webhook traffic came through the gate.
  let gate = null;
  try { gate = await (await fetch(`http://127.0.0.1:${GATE_PORT}/__gate`)).json(); } catch { /* gate stopped */ }
  L.check("gate", `V4 [${M}] webhook traffic came through the gate (anything else was refused there)`, (gate?.forwarded ?? 0) >= 1, gate ?? { gate: "not reachable" });
  // V5 — the unlisted owner never reached the provider.
  const owner = await q(`select count(*)::int n from "EmailLog" where "tenantId" = $1 and lower(recipient) = lower($2) and "resendId" is not null`, [c.tenantId, c.owner.email]);
  L.check("allowlist", `V5 [${M}] no provider send to anyone but the confirmed address`, owner[0].n === 0 && sends.every((s) => s.recipient.toLowerCase() === r.address), { ownerProviderSends: owner[0].n });
  console.log(`\n${L.summary()} — ledger ${L.path}`);
  process.exit(L.rows.some((x) => x.result === "FAIL") ? 1 : 0);
}

async function teardown() {
  const c = state.club, real = state.real;
  let address = null;
  if (real) {
    // The address is needed to prove nothing still holds it; refuse rather than skip that proof.
    const r = recipient(settings());
    if (r.error || fp(r.address) !== real.addressFp) throw new Error("refusing: teardown needs MF_EXTRA_ENV with the same recipient as setup, to check every table for it");
    address = r.address;
  }
  if (c && address) {
    // First take the address off the synthetic member, so a failed fixture teardown cannot leave it behind,
    // and remove the rate-limit buckets that embed it ("forgot:<slug>:<address>", "reset-attempt:<slug>:<address>").
    await q(`update "Member" set email = $1 where "tenantId" = $2 and lower(email) = $3`, [`${c.slug}-m2@example.test`, c.tenantId, address]);
    await q(`delete from "RateLimitHit" where position($1 in lower(bucket)) > 0 or position(':' || $2 || ':' in bucket) > 0`, [address, c.slug]);
  }
  const res = spawnSync(node24(), [path.join(HERE, "fixture.mjs"), "teardown"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_APP: APP } });
  const out = res.stdout.split(/\r?\n/).filter((l) => l.includes("tornDown") || l.includes("nothingToTearDown")).join("\n");
  console.log(out);
  if (res.status !== 0 || !out) throw new Error(`fixture teardown failed — state kept so it can be re-run: ${(res.stderr || res.stdout).slice(-300)}`);
  if (address) {
    const left = (await q(
      `select (select count(*) from "EmailLog" where lower(recipient) = $1)::int email_log,
              (select count(*) from "PasswordResetToken" where lower(email) = $1)::int reset_tokens,
              (select count(*) from "MagicLinkToken" where lower(email) = $1)::int magic_links,
              (select count(*) from "Member" where lower(email) = $1)::int members,
              (select count(*) from "User" where lower(email) = $1)::int users,
              (select count(*) from "RateLimitHit" where position($1 in lower(bucket)) > 0)::int rate_limit_buckets,
              (select count(*) from "AuditLog" where position($1 in lower(metadata::text)) > 0)::int audit`, [address]))[0];
    const total = Object.values(left).reduce((a, b) => a + b, 0);
    console.log(`rows still holding ${mask(address)} anywhere in the test branch: ${JSON.stringify(left)} — ${total === 0 ? "none" : "NOT CLEAN"}`);
    if (total !== 0) process.exitCode = 1;
  }
  delete state.club; delete state.real; saveState();
}

const [cmd] = process.argv.slice(2);
const run = { preflight, setup, blocked, verify, teardown }[cmd];
if (!run) { console.log("usage: preflight | setup | blocked | verify | teardown"); process.exit(2); }
await run();
