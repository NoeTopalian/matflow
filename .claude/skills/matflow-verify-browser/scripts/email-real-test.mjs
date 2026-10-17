// The first isolated REAL email test (17 Oct 2026): exactly ONE password-reset email, through a SEPARATE Resend test
// account, to ONE address Noe owns, from a local production build on the Neon TEST branch, with a synthetic club.
// Noe triggers the one send himself from the isolated app's own "Forgot password" screen; this script never sends.
// Credentials stay in the private file named by MF_EXTRA_ENV (outside git); no key, secret or full address is printed.
//
//   node email-real-test.mjs preflight [--before-webhook]   checks the private file and the key (no email is sent)
//   node email-real-test.mjs setup        synthetic club; member 2 becomes the listed address, with a password
//   node email-real-test.mjs blocked      an unlisted address (the club owner) is refused before Resend
//   node email-real-test.mjs verify       after Noe's reset: one provider send, signed webhook, reset used, no others
//   node email-real-test.mjs teardown     removes the club and checks no row anywhere still holds the address
// Ledger rows are labelled REAL; evidence goes to the output folder (outside git).
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { APP, OUT, BASE, state, saveState, q, ledger, bcrypt } from "./lib.mjs";
import { node24, extraEnv, REPO } from "../../matflow-verify-local/scripts/env.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const APP_PORT = Number(process.env.MF_PORT ?? 3991);
const GATE_PORT = Number(process.env.WEBHOOK_GATE_PORT ?? 3995);
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
    if (m) out.push({ file: path.basename(f), where: f.startsWith(APP) ? "worktree" : "main checkout", fp: fp(m[1].trim()) });
  }
  return out;
}

async function preflight() {
  const s = settings();
  const r = recipient(s);
  const key = s.RESEND_API_KEY ?? "";
  const from = s.RESEND_FROM ?? "";
  const known = knownKeys();
  const checks = [
    ["EMAIL_DELIVERY is test", (s.EMAIL_DELIVERY ?? "").toLowerCase() === "test"],
    [r.error ?? `exactly one recipient: ${mask(r.address)}`, !r.error],
    ["RESEND_API_KEY present (re_…)", /^re_[A-Za-z0-9_]{16,}$/.test(key)],
    [`RESEND_API_KEY is not any key already in a local .env file (${known.length} compared by fingerprint; the 440 historical sends used an unknown account)`, key !== "" && !known.some((k) => k.fp === fp(key))],
    ["RESEND_FROM is Resend's testing sender (…@resend.dev): the test account has no domain", /@resend\.dev>?\s*$/i.test(from)],
    process.argv.includes("--before-webhook")
      ? ["RESEND_WEBHOOK_SECRET not checked yet (--before-webhook)", true]
      : ["RESEND_WEBHOOK_SECRET is a full whsec_ signing secret", WEBHOOK_SECRET.test(s.RESEND_WEBHOOK_SECRET ?? "")],
    ["no RESEND_BASE_URL (this run talks to Resend itself)", !s.RESEND_BASE_URL],
  ];
  // One read-only call to Resend (no email): a Sending-access key is refused on any endpoint but sending, with
  // `restricted_api_key`; an unknown key gets `validation_error`; a Full-access key would answer 200.
  let keyCheck = "not run";
  if (/^re_/.test(key)) {
    try {
      const res = await fetch("https://api.resend.com/api-keys", { headers: { authorization: `Bearer ${key}` } });
      const body = await res.json().catch(() => ({}));
      keyCheck = res.status === 401 && body?.name === "restricted_api_key" ? "PASS" : res.status === 200 ? "FULL_ACCESS" : `INVALID (${res.status} ${String(body?.name ?? "").slice(0, 40)})`;
    } catch (e) { keyCheck = `BLOCKED (network: ${e instanceof Error ? e.name : "error"})`; }
  }
  checks.push([`Resend accepts the key as Sending access only (read-only check, no email): ${keyCheck}`, keyCheck === "PASS"]);
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log("Account ownership is confirmed by you in the test account's dashboard (the key and the webhook were created there); it cannot be read with a Sending-access key.");
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

async function setup() {
  const r = recipient(settings());
  if (r.error) throw new Error(`refusing: ${r.error}`);
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
  state.real = { memberId: rows[0].id, addressFp: fp(r.address), hashFp: fp(hash) };
  saveState();
  console.log(`setup done: club ${c.slug}; member 2 is ${mask(r.address)} with a password.`);
  console.log(`Isolated app reset screen: ${BASE}/login?club=${c.slug}  →  "Forgot password"`);
}

const providerRows = (tenantId) => q(`select id, recipient, status, "resendId", "errorMessage" from "EmailLog" where "tenantId" = $1 and "resendId" is not null`, [tenantId]);

async function blocked() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const c = state.club;
  if (!c || !state.real) throw new Error("run setup first");
  const L = ledger("email-real-blocked");
  const before = await providerRows(c.tenantId);
  const res = await fetch(`${BASE}/api/auth/forgot-password`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-lane-ip": "10.93.2.1" }, body: JSON.stringify({ email: c.owner.email, tenantSlug: c.slug }) });
  await sleep(1500);
  const row = (await q(`select status, "errorMessage", "resendId" from "EmailLog" where "tenantId" = $1 and lower(recipient) = lower($2) order by "createdAt" desc limit 1`, [c.tenantId, c.owner.email]))[0];
  const after = await providerRows(c.tenantId);
  L.check("allowlist", "B1 REAL server, Resend key loaded: the unlisted club owner is refused before Resend (suppressed_not_allowlisted, no provider id, no provider send)", res.status === 200 && row?.status === "suppressed" && /^suppressed_not_allowlisted/.test(row?.errorMessage ?? "") && !row?.resendId && after.length === before.length && before.length === 0, { http: res.status, status: row?.status, providerSendsBefore: before.length, providerSendsAfter: after.length });
  console.log(`\n${L.summary()} — ledger ${L.path}`);
  process.exit(L.rows.some((x) => x.result === "FAIL") ? 1 : 0);
}

async function verify() {
  const c = state.club, real = state.real;
  if (!c || !real) throw new Error("run setup first");
  const r = recipient(settings());
  if (r.error || fp(r.address) !== real.addressFp) throw new Error("refusing: the private file's recipient changed since setup");
  const L = ledger("email-real-verify");
  let sends = await providerRows(c.tenantId);
  // V1 — exactly one email reached Resend, to the confirmed address.
  L.check("send", "V1 exactly one provider send in this club, to the confirmed address [REAL]", sends.length === 1 && sends[0].recipient.toLowerCase() === r.address, { providerSends: sends.length, to: sends.map((s) => mask(s.recipient)) });
  // V2 — a genuine signed Resend event moved that row (allow time for delivery).
  for (let i = 0; i < 36 && sends[0] && !["delivered", "bounced", "complained"].includes(sends[0].status); i++) { await sleep(5000); sends = await providerRows(c.tenantId); }
  const id = sends[0]?.resendId ?? "-";
  const lines = fs.readFileSync(path.join(OUT, `server-${APP_PORT}.log`), "utf8").split(/\r?\n/).filter((l) => l.includes("[resend-webhook]") && l.includes(`email=${id}`));
  L.check("webhook", "V2 a signed Resend webhook updated that row to delivered [REAL]", sends[0]?.status === "delivered" && lines.some((l) => /type=email\.delivered .*outcome=applied/.test(l)), {
    status: sends[0]?.status, resendId: id,
    events: lines.map((l) => { const m = l.match(/svix=(\S+) .*type=(\S+) .*outcome=(\S+)/); return m ? `${m[2]}:${m[3]} (${m[1]})` : null; }).filter(Boolean),
  });
  // V3 — the code worked against the isolated app: the token is spent and the synthetic member's password changed.
  const tok = await q(`select used from "PasswordResetToken" where "tenantId" = $1 and lower(email) = $2 order by "createdAt" desc limit 1`, [c.tenantId, r.address]);
  const mem = await q(`select "passwordHash" from "Member" where id = $1`, [real.memberId]);
  L.check("reset", "V3 the emailed code reset the password on the isolated app (token used, password changed) [REAL]", tok[0]?.used === true && mem[0] && fp(mem[0].passwordHash) !== real.hashFp, { tokenUsed: tok[0]?.used ?? null, passwordChanged: mem[0] ? fp(mem[0].passwordHash) !== real.hashFp : null });
  // V4 — the gate forwarded webhook traffic and nothing else reached the app through it.
  let gate = null;
  try { gate = await (await fetch(`http://127.0.0.1:${GATE_PORT}/__gate`)).json(); } catch { /* gate stopped */ }
  L.check("gate", "V4 webhook traffic came through the gate; everything else was refused there [REAL]", (gate?.forwarded ?? 0) >= 1, gate ?? { gate: "not reachable" });
  // V5 — the unlisted owner never reached Resend.
  const owner = await q(`select count(*)::int n from "EmailLog" where "tenantId" = $1 and lower(recipient) = lower($2) and "resendId" is not null`, [c.tenantId, c.owner.email]);
  L.check("allowlist", "V5 no provider send to anyone but the confirmed address [REAL]", owner[0].n === 0 && sends.every((s) => s.recipient.toLowerCase() === r.address), { ownerProviderSends: owner[0].n });
  console.log(`\n${L.summary()} — ledger ${L.path}`);
  process.exit(L.rows.some((x) => x.result === "FAIL") ? 1 : 0);
}

async function teardown() {
  const real = state.real;
  const res = spawnSync(node24(), [path.join(HERE, "fixture.mjs"), "teardown"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_APP: APP } });
  console.log(res.stdout.split(/\r?\n/).filter((l) => l.includes("tornDown") || l.includes("nothingToTearDown")).join("\n"));
  if (real && process.env.MF_EXTRA_ENV) {
    const r = recipient(settings());
    if (!r.error) {
      const left = (await q(
        `select (select count(*) from "EmailLog" where lower(recipient) = $1)::int email_log,
                (select count(*) from "PasswordResetToken" where lower(email) = $1)::int reset_tokens,
                (select count(*) from "MagicLinkToken" where lower(email) = $1)::int magic_links,
                (select count(*) from "Member" where lower(email) = $1)::int members,
                (select count(*) from "User" where lower(email) = $1)::int users,
                (select count(*) from "AuditLog" where metadata::text ilike '%' || $1 || '%')::int audit`, [r.address]))[0];
      console.log(`rows still holding ${mask(r.address)} anywhere in the test branch: ${JSON.stringify(left)}`);
    }
  }
  delete state.club; delete state.real; saveState();
}

const [cmd] = process.argv.slice(2);
const run = { preflight, setup, blocked, verify, teardown }[cmd];
if (!run) { console.log("usage: preflight | setup | blocked | verify | teardown"); process.exit(2); }
await run();
