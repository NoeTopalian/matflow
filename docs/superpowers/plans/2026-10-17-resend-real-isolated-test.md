# Resend Isolated Test — Finish and Real Send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish `feat/email-test-isolation` to a reviewed, verified commit. Then prove one authorised real Resend send and its signed webhook end to end. Everything runs in isolation: a separate Resend test account, a local production build and the Neon test branch.

**Architecture:** The code is already on the branch:
- the `EMAIL_DELIVERY` off/test/on switch;
- the `EMAIL_TEST_RECIPIENTS` allowlist, enforced in `sendEmail`;
- the hardened Svix-verified webhook at `app/api/webhooks/resend/route.ts`.

This plan does three things:
1. Closes one remaining correctness gap. A webhook can arrive before `sendEmail` has recorded the Resend id.
2. Re-runs every gate on the final commit.
3. Adds a public-ingress gate and a REAL journey (both gitignored), and runs them once Noe's manual steps are done.

Real evidence is recorded separately from simulated evidence.

**Tech Stack:** Next.js 16, Prisma 7 (pg adapter), Neon test branch `ep-hidden-salad`, `resend` SDK, `svix`, Vitest, Node 24 (`MF_NODE24`), project skills `matflow-verify-local` (`$L`) and `matflow-verify-browser` (`$B`), Cloudflare quick tunnel (`cloudflared`).

**Spec:** Noe's two messages of 17 Oct 2026 (the isolated webhook implementation, and the configuration checklist), recorded in `docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md`. That doc is the checklist of record; this plan argues from it.

## Global Constraints

- **Production unchanged.**
  - No push, merge, deploy or Vercel env change.
  - No production database read or write by the agent.
  - No DNS change.
  - No paid Resend upgrade.
- **Customer sending stays off.** Sean is never a recipient. Recipients are only addresses Noe lists in his private file: his own address, plus optionally `delivered@resend.dev` and `bounced@resend.dev`.
- **Secrets are never printed or pasted into chat.**
  - Noe writes them to `%LOCALAPPDATA%\matflow-verify\email-test-isolation\email-test.env` and says only "file ready".
  - The agent reads them only into process environments.
  - Addresses are masked in every ledger and report (first character plus domain).
- **The allowlist is enforced server-side in `sendEmail`** (`lib/email.ts`), before any lookup or provider call, and fails closed.
- **Webhook verification is on the raw body.** Missing, invalid or stale signatures are rejected. Duplicates and out-of-order events are safe. Only known sends are updated. Logs carry no secret, body or address.
- **Evidence labels:** every result is labelled SIMULATED or REAL. Setup is **not complete** until a REAL authorised send and its REAL signed webhook have both succeeded.
- **Runtime:** Node 24 for every command. Builds run from PowerShell. Never `npm run build` locally; use `node $L/server.mjs build`. Never bare `next dev`.
- **Git:** never `git add -A`. Commit only named files. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- British English in user-facing copy.

## Review Focus

1. **A webhook arrives before `resendId` is recorded** (`lib/email.ts` writes it only after `emails.send` returns).
   - Today the route answers 200 `ignored_unknown_email`, Resend never retries, and the row stays `sent` forever.
   - Expected: a recent unknown id gets a non-2xx so Resend retries; an old one is acknowledged.
   - Task 1 pins this.
2. **The tunnel exposes the whole local app to the internet** (sign-in pages, kiosk, API) for as long as it runs.
   - Expected: only `POST /api/webhooks/resend` is reachable from outside; everything else answers 404 at the gate.
   - Task 3 pins this.
3. **Resend's testing sender refuses recipients other than the test account's own address** when no domain is verified. The row would go to `failed` with Resend's 403 message.
   - Expected: the REAL run checks this up front and reports it as BLOCKED with the reason, not as a code failure.
   - Task 3 (preflight) and Task 5 pin this.
4. **A malformed private file.** Examples: a lower-case key, `export KEY=`, a pasted `whsec_` with trailing spaces or quotes, or an address with a trailing comma.
   - Expected: the server refuses to start with a message naming no secret value; trailing spaces and quotes are trimmed.
   - Already enforced by `extraEnv()` in `$L/env.mjs`. Task 3's preflight re-checks the parsed result without printing values.
5. **A cloudflared restart issues a new URL.** The registered webhook endpoint then points nowhere, and events fail at Resend.
   - Expected: the REAL run reads the gate's request counter. It reports "0 webhook requests reached the gate" as BLOCKED (endpoint URL stale), not as a route failure.
   - Task 5 pins this.

---

### Task 1: Retry a recent unknown email id instead of dropping it

**Files:**
- Modify: `app/api/webhooks/resend/route.ts` (constant + helper near `STATUS_RANK`; the `if (!existing)` line inside the retry loop; contract comment at the top)
- Test: `tests/unit/resend-webhook.test.ts`
- Modify: `docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md` (the "Facts" list)

**Interfaces:**
- Consumes: `ResendEvent.created_at` (top-level event time, ISO string), `outcome(o, extra, status, body)` inside `POST`.
- Produces: a new outcome string, `retry_unknown_recent` (HTTP 409). The REAL journey in Task 3 greps server logs for it.

- [ ] **Step 1: Write the failing tests.** In `tests/unit/resend-webhook.test.ts`, replace the existing test `"an event for an email this database never sent changes nothing"` with these three:

```ts
  it("an old event for an email this database never sent is acknowledged and changes nothing", async () => {
    const old = { ...ev("email.delivered", "re_from_another_environment"), created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    const r = await post(signed(old));
    expect(r).toEqual({ status: 200, body: expect.objectContaining({ outcome: "ignored_unknown_email" }) });
    expect(store.writes).toBe(0);
  });

  it("an event with no created_at for an unknown email is acknowledged (cannot be judged recent)", async () => {
    const noTime: Record<string, unknown> = ev("email.delivered", "re_unknown");
    delete noTime.created_at;
    const r = await post(signed(noTime));
    expect(r).toEqual({ status: 200, body: expect.objectContaining({ outcome: "ignored_unknown_email" }) });
  });

  it("a recent event that beats sendEmail's resendId write answers 409 so Resend retries; the retry applies", async () => {
    store.rows.get("log-1")!.resendId = "pending";            // sendEmail has not recorded the id yet
    const body = ev("email.delivered", "re_fast");
    const first = await post(signed(body, { id: "msg_fast" }));
    expect(first).toEqual({ status: 409, body: expect.objectContaining({ outcome: "retry_unknown_recent" }) });
    expect(store.writes).toBe(0);
    store.rows.get("log-1")!.resendId = "re_fast";            // the write lands
    const retry = await post(signed(body, { id: "msg_fast" }));
    expect(retry.body.outcome).toBe("applied");
    expect(row().status).toBe("delivered");
  });
```

- [ ] **Step 2: Run them and confirm they fail.**

Run (PowerShell, worktree root): `& (Join-Path $env:MF_NODE24 node.exe) node_modules/vitest/vitest.mjs run tests/unit/resend-webhook.test.ts`

Expected: FAIL. The recent-event test receives 200 `ignored_unknown_email` where it expects 409. The other two pass, since they already describe today's behaviour for old events.

- [ ] **Step 3: Implement.** In `app/api/webhooks/resend/route.ts`, add these after the `EMAIL_ADDRESS` constant:

```ts
// sendEmail records the Resend id only after Resend's API call returns, so a
// fast event (email.sent especially) can arrive first. A recent unknown id is
// answered 409 and Resend retries (5 s, then 5 min); after this window an
// unknown id is not ours — another tool on the same Resend account — and is
// acknowledged so it stops retrying.
const RECENT_UNKNOWN_MS = 15 * 60 * 1000;

function isRecent(createdAt: string | undefined): boolean {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) && Math.abs(Date.now() - t) <= RECENT_UNKNOWN_MS;
}
```

Then replace `if (!existing) return outcome("ignored_unknown_email", tag);` with:

```ts
      if (!existing) {
        return isRecent(event.created_at)
          ? outcome("retry_unknown_recent", tag, 409, { error: "Email not recorded yet; retry" })
          : outcome("ignored_unknown_email", tag);
      }
```

In the contract comment, replace the line `rules above); unknown emails and other event types answer 200 and change` and the line after it with:

```
 *   rules above). An unknown email id less than 15 minutes old answers 409
 *   (sendEmail may not have recorded it yet) so Resend retries; an older one,
 *   and other event types, answer 200 and change nothing.
```

- [ ] **Step 4: Run the focused tests and confirm they pass.**

Run: `& (Join-Path $env:MF_NODE24 node.exe) node_modules/vitest/vitest.mjs run tests/unit/resend-webhook.test.ts tests/unit/email-test-allowlist.test.ts tests/unit/sec-d-mail-holds.test.ts tests/unit/env-guards-email-delivery.test.ts`

Expected: all pass.

- [ ] **Step 5: Docs.** In `docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md`, under "Facts that shape the set-up", append: `- A webhook for an email id this database has not recorded yet answers 409 for 15 minutes after the event (Resend retries at 5 s and 5 min), then 200: the id is written after Resend's API returns, so a fast event can arrive first.`

- [ ] **Step 6: Commit.**

```bash
git add app/api/webhooks/resend/route.ts tests/unit/resend-webhook.test.ts docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md
git commit -m "fix(webhook): retry a recent unknown Resend email id instead of dropping it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Gates on the final commit, simulated journey, scoped re-review

**Files:**
- Modify: `docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md` (row 5 status cell: commit and simulated result)
- Gitignored, unchanged: `$B/journeys/email-webhook-sim.mjs`

**Interfaces:**
- Consumes: the HEAD commit after Task 1.
- Produces: evidence lines (commit SHA, counts) for the completion report in Task 6.

- [ ] **Step 1: Lint and type check.**

Run (PowerShell; put Node 24 first on `Path`):
```powershell
$env:Path = "$env:MF_NODE24;$env:Path"; node -v
npm run lint
node node_modules/typescript/bin/tsc --noEmit -p .
node --check .claude/skills/matflow-verify-local/scripts/env.mjs
```
Expected: `v24.*`; lint 0 errors; tsc exit 0; `--check` silent.

- [ ] **Step 2: Full suite.** Run `npm test`. Expected: 0 failed. Record passed and skipped counts; skipped database files are not passes. The previous run on `8e737311` had 4 failures, all in `sec-d-mail-holds`, which were fixed in `153505ae`.

- [ ] **Step 3: Production build.**

Run: `node .claude/skills/matflow-verify-local/scripts/server.mjs build`

Expected: `BUILD EXIT 0 commit <HEAD sha> tree clean`.

- [ ] **Step 4: Simulated journey.** It is SIMULATED: a local interceptor on port 4599 stands in for Resend, and nothing leaves the machine.

```powershell
$B = ".claude/skills/matflow-verify-browser/scripts"; $L = ".claude/skills/matflow-verify-local/scripts"
node $B/journeys/email-webhook-sim.mjs setup
$env:MF_EXTRA_ENV = "$env:LOCALAPPDATA\matflow-verify\email-test-isolation\email-sim.env"; node $L/server.mjs start
node $B/journeys/email-webhook-sim.mjs run
node $L/server.mjs stop; Remove-Item Env:MF_EXTRA_ENV
node $B/journeys/email-webhook-sim.mjs teardown
```

Expected: `12 PASS / 0 FAIL`; teardown prints `tornDown` with 0 rows left. W9 still answers 200 because it sends no `created_at`.

- [ ] **Step 5: Scoped re-review.** Dispatch the same reviewer type that returned CHANGES REQUESTED (`oh-my-claudecode:code-reviewer`). Point it at a brief file in the scratchpad. The brief contains:
  - the original findings H1, H2, M1–M3 and the low items;
  - `git diff 8e737311..HEAD`;
  - the instruction to verify each finding is closed and to report new defects only within that diff.

  The reviewer writes its report to the scratchpad. Expected: APPROVED, or APPROVED WITH RESIDUALS. If not, fix, commit, and repeat Steps 1–5 on the new HEAD.

- [ ] **Step 6: Update and commit the checklist row.** In row 5's status cell, record the HEAD commit and `SIMULATED 12/12` with the date.

```bash
git add docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md
git commit -m "docs(email): simulated evidence on the reviewed commit" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Webhook-only ingress gate and the REAL journey (gitignored)

**Files (gitignored under `$B/journeys/`, never committed):**
- Create: `.claude/skills/matflow-verify-browser/scripts/journeys/webhook-gate.mjs`
- Create: `.claude/skills/matflow-verify-browser/scripts/journeys/email-webhook-real.mjs`

**Interfaces:**
- Consumes:
  - `../lib.mjs` exports `APP, OUT, BASE, state, saveState, q, ledger, bcrypt`;
  - `../../../matflow-verify-local/scripts/env.mjs` export `node24`;
  - `fixture.mjs create|teardown`, which writes `OUT/fixture-state.json` with `club.{slug, tenantId, owner.email}`;
  - the server log at `OUT/server-3991.log`;
  - the private file named by `MF_EXTRA_ENV`.
- Produces:
  - the gate on `127.0.0.1:3995`, which forwards only `POST /api/webhooks/resend` to `127.0.0.1:3991` and serves `GET /__gate` → `{forwarded, refused}`;
  - ledger `email-webhook-real` with REAL-labelled rows.

- [ ] **Step 1: Write the gate.**

```js
// Webhook-only ingress for the REAL email test. The quick tunnel points HERE, never at the app:
// only POST /api/webhooks/resend is forwarded to the local server; everything else is 404.
//   node webhook-gate.mjs            listens on 127.0.0.1:3995, forwards to 127.0.0.1:3991
import http from "node:http";

const PORT = 3995, APP_PORT = Number(process.env.MF_PORT ?? 3991);
let forwarded = 0, refused = 0;
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/__gate" && req.socket.remoteAddress === "127.0.0.1") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ forwarded, refused }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/webhooks/resend") {
    refused++; req.resume(); res.writeHead(404); res.end(); return;
  }
  forwarded++;
  const headers = { ...req.headers, host: `127.0.0.1:${APP_PORT}` };
  const up = http.request({ host: "127.0.0.1", port: APP_PORT, method: "POST", path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json" });
    r.pipe(res);
  });
  up.on("error", () => { res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(PORT, "127.0.0.1", () => console.log(`[webhook-gate] 127.0.0.1:${PORT} → 127.0.0.1:${APP_PORT} (POST /api/webhooks/resend only)`));
```

- [ ] **Step 2: Check the gate locally** (no tunnel yet; the server from Task 2 is stopped, so forwarding returns 502).

```powershell
Start-Process -NoNewWindow node "$B/journeys/webhook-gate.mjs"
(Invoke-WebRequest -Uri http://127.0.0.1:3995/ -SkipHttpErrorCheck).StatusCode            # expect 404
(Invoke-WebRequest -Uri http://127.0.0.1:3995/api/auth/signin -SkipHttpErrorCheck).StatusCode   # expect 404
(Invoke-WebRequest -Method Post -Uri http://127.0.0.1:3995/api/webhooks/resend -SkipHttpErrorCheck).StatusCode   # expect 502 (no app running)
(Invoke-RestMethod http://127.0.0.1:3995/__gate)                                            # expect forwarded 1, refused 2
```

Windows PowerShell 5.1 lacks `-SkipHttpErrorCheck`. If so, wrap each call in `try { … } catch { $_.Exception.Response.StatusCode.value__ }`. Stop the gate afterwards with `Stop-Process`.

- [ ] **Step 3: Write the REAL journey.**

```js
// REAL email journey: one authorised send through the Resend TEST account and its signed webhook, against a
// local production build on the Neon TEST branch. Every ledger row is labelled REAL. Addresses are masked.
//   node email-webhook-real.mjs preflight   checks the private file (MF_EXTRA_ENV) without printing values
//   node email-webhook-real.mjs setup       fixture club; member 2 gets a password (its address is set per send)
//   (start the server with MF_EXTRA_ENV, the gate, and the tunnel — see the plan, Task 5)
//   node email-webhook-real.mjs run         S1 blocked, then one send per listed recipient, webhooks awaited
//   node email-webhook-real.mjs teardown    fixture teardown (removes its EmailLog rows, so no address stays)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { APP, OUT, BASE, state, saveState, q, ledger, bcrypt } from "../lib.mjs";
import { node24 } from "../../../matflow-verify-local/scripts/env.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const mask = (a) => { const [u, d] = String(a).split("@"); return d ? `${u.slice(0, 1)}…@${d}` : "…"; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function privateFile() {
  const f = process.env.MF_EXTRA_ENV;
  if (!f || !fs.existsSync(f)) throw new Error("BLOCKED: MF_EXTRA_ENV must name Noe's private email-test.env");
  const out = {};
  for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
  return out;
}

function recipients(env) {
  const list = (env.EMAIL_TEST_RECIPIENTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s));
  return {
    delivered: list.find((a) => a === "delivered@resend.dev") ?? null,
    bounced: list.find((a) => a === "bounced@resend.dev") ?? null,
    own: list.find((a) => !a.endsWith("@resend.dev")) ?? null,
  };
}

function preflight() {
  const env = privateFile();
  const r = recipients(env);
  const checks = [
    ["EMAIL_DELIVERY is test", (env.EMAIL_DELIVERY ?? "").toLowerCase() === "test"],
    ["RESEND_API_KEY present and starts re_", /^re_\S+$/.test(env.RESEND_API_KEY ?? "")],
    ["RESEND_WEBHOOK_SECRET present and starts whsec_", /^whsec_\S+$/.test(env.RESEND_WEBHOOK_SECRET ?? "")],
    ["RESEND_FROM present", Boolean(env.RESEND_FROM)],
    ["no RESEND_BASE_URL (REAL run talks to Resend)", !env.RESEND_BASE_URL],
    ["at least one recipient listed", Boolean(r.own || r.delivered)],
    ["no sean / totalbjj address listed", !/sean|totalbjj/i.test(env.EMAIL_TEST_RECIPIENTS ?? "")],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`recipients: own ${r.own ? mask(r.own) : "-"}, delivered@ ${r.delivered ? "yes" : "no"}, bounced@ ${r.bounced ? "yes" : "no"} (values not printed)`);
  if (checks.some(([, ok]) => !ok)) process.exit(1);
}

async function setup() {
  if (!state.club) {
    const res = spawnSync(node24(), [path.join(HERE, "..", "fixture.mjs"), "create"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_APP: APP } });
    if (res.status !== 0) throw new Error(`fixture create failed: ${res.stdout.slice(-300)}`);
    Object.assign(state, JSON.parse(fs.readFileSync(path.join(OUT, "fixture-state.json"), "utf8")));
  }
  const c = state.club;
  const m2 = `${c.slug}-m2@example.test`;
  await q(`update "Member" set "passwordHash" = $1 where "tenantId" = $2 and email = $3`, [await bcrypt.hash(randomBytes(12).toString("hex"), 10), c.tenantId, m2]);
  state.real = { m2 };
  saveState();
  console.log("setup done (REAL run next). Start the server with MF_EXTRA_ENV, then the gate and the tunnel.");
}

const rowsFor = (tenantId, recipient) => q(`select id, status, "errorMessage", "resendId" from "EmailLog" where "tenantId" = $1 and lower(recipient) = lower($2) order by "createdAt"`, [tenantId, recipient]);
const gate = async () => (await (await fetch("http://127.0.0.1:3995/__gate")).json());

async function run() {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const c = state.club, real = state.real;
  if (!c || !real) throw new Error("run setup first");
  const r = recipients(privateFile());
  const L = ledger("email-webhook-real");
  let current = real.m2;
  const pointMember2At = async (addr) => { await q(`update "Member" set email = $1 where "tenantId" = $2 and lower(email) = lower($3)`, [addr, c.tenantId, current]); current = addr; };
  // A fresh lane IP per request so the forgot-password rate limit never decides a result.
  let lane = 10;
  const forgot = (email) => fetch(`${BASE}/api/auth/forgot-password`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "x-lane-ip": `10.93.1.${lane++}` }, body: JSON.stringify({ email, tenantSlug: c.slug }) });

  // S1: the owner is not on the list — blocked before Resend; no provider id is ever recorded.
  const r1 = await forgot(c.owner.email);
  await sleep(1500);
  const s1 = (await rowsFor(c.tenantId, c.owner.email)).at(-1);
  L.check("allowlist", "S1 REAL server: unlisted owner → EmailLog suppressed_not_allowlisted, no resendId", r1.status === 200 && s1?.status === "suppressed" && /^suppressed_not_allowlisted/.test(s1.errorMessage ?? "") && !s1.resendId, { http: r1.status, status: s1?.status });

  // One real send per listed recipient; each must reach `sent` with a Resend id, then a REAL signed webhook.
  const targets = [["delivered@resend.dev", r.delivered, "delivered"], ["Noe's own address", r.own, "delivered"], ["bounced@resend.dev", r.bounced, "bounced"]].filter(([, a]) => a);
  for (const [label, addr, want] of targets) {
    await pointMember2At(addr);
    const g0 = await gate();
    const res = await forgot(addr);
    await sleep(2000);
    const sent = (await rowsFor(c.tenantId, addr)).at(-1);
    const accepted = sent?.status === "sent" && /^[0-9a-f-]{36}$/i.test(sent.resendId ?? "");
    L.check("send", `R-send ${label} (${mask(addr)}) → Resend accepted, EmailLog sent with a Resend id [REAL]`, res.status === 200 && accepted, { http: res.status, status: sent?.status, reason: (sent?.errorMessage ?? "").split(":")[0].slice(0, 120) });
    if (!accepted) continue;
    let s = sent;
    for (let i = 0; i < 60 && s.status !== want; i++) { await sleep(5000); s = (await rowsFor(c.tenantId, addr)).at(-1); }
    const g1 = await gate();
    const log = fs.readFileSync(path.join(OUT, "server-3991.log"), "utf8").split(/\r?\n/).filter((l) => l.includes("[resend-webhook]") && l.includes(`email=${sent.resendId}`));
    L.check("webhook", `R-hook ${label}: signed webhook through the tunnel moved the row to ${want} [REAL]`, s.status === want && log.some((l) => /outcome=applied/.test(l)), {
      status: s.status, gateForwarded: g1.forwarded - g0.forwarded, svixIds: log.map((l) => l.match(/svix=(\S+)/)?.[1]).filter(Boolean),
      outcomes: log.map((l) => l.match(/type=(\S+) .*outcome=(\S+)/)?.slice(1).join(":")),
      note: g1.forwarded === g0.forwarded ? "BLOCKED: 0 webhook requests reached the gate — check the tunnel URL registered in Resend" : undefined,
    });
  }
  if (r.bounced) {
    // After a real bounce, a second send to the same address short-circuits without calling Resend.
    await pointMember2At(r.bounced);
    await forgot(r.bounced);
    await sleep(2000);
    const again = (await rowsFor(c.tenantId, r.bounced)).at(-1);
    L.check("send", "R-short-circuit: second send to the bounced address → failed, no new Resend id [REAL server]", again?.status === "failed" && !again.resendId, { status: again?.status });
  }
  await pointMember2At(real.m2);
  console.log(`\n${L.summary()} — ledger ${L.path}`);
  process.exit(L.rows.some((x) => x.result === "FAIL") ? 1 : 0);
}

async function teardown() {
  const res = spawnSync(node24(), [path.join(HERE, "..", "fixture.mjs"), "teardown"], { cwd: APP, encoding: "utf8", env: { ...process.env, MF_APP: APP } });
  console.log(res.stdout.split(/\r?\n/).filter((l) => l.includes("tornDown") || l.includes("nothingToTearDown")).join("\n"));
  delete state.club; delete state.real; saveState();
}

const [cmd] = process.argv.slice(2);
if (cmd === "preflight") preflight();
else if (cmd === "setup") await setup();
else if (cmd === "run") await run();
else if (cmd === "teardown") await teardown();
else { console.log("usage: preflight | setup | run | teardown"); process.exit(2); }
```

- [ ] **Step 4: Syntax check, and confirm nothing is tracked.**

```powershell
node --check $B/journeys/webhook-gate.mjs; node --check $B/journeys/email-webhook-real.mjs
git status --short   # expect: nothing (journeys/ is gitignored)
```

- [ ] **Step 5: Check the testing-sender rule against current docs** (Review Focus 3).
  - Fetch Resend's current docs on sending without a verified domain, and on the `resend.dev` test addresses.
  - Record in the checklist's Facts list whether Resend's testing sender may only send to the account's own address, with the date read.
  - Expected: that restriction holds. Then M3's "your own address" must be the address the Resend test account was created with.

  Commit the doc line:

```bash
git add docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md
git commit -m "docs(email): Resend testing-sender rule, read from current docs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: GATE — Noe's manual steps (not agent work; the plan stops here until "file ready")

These are steps M1–M6 in `docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md`, with two changes from Tasks 3 and 5:
- **M3:** your own address must be the one the Resend test account was created with, if the testing sender rule holds. Also add `delivered@resend.dev` and, for the bounce check, `bounced@resend.dev`. Never Sean.
- **M4:** the tunnel points at the gate, not the app: `cloudflared tunnel --url http://127.0.0.1:3995`. Approve the `cloudflared` install (`winget install Cloudflare.cloudflared`), or name another tunnel.

The agent waits for exactly "file ready". It never asks for a key, secret or address in chat.

---

### Task 5: REAL run (M7), evidence, cleanup

**Files:**
- Create: `docs/readiness/RESEND-REAL-TEST-EVIDENCE-2026-10-<dd>.md` (date of the run)
- Modify: `docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md` (rows 1, 2, 4, 5, 8: status → Verified REAL with date, or Blocked with reason)

- [ ] **Step 1: Preflight.**

Run: `$env:MF_EXTRA_ENV = "$env:LOCALAPPDATA\matflow-verify\email-test-isolation\email-test.env"; node $B/journeys/email-webhook-real.mjs preflight`

Expected: all PASS. On any FAIL, tell Noe which line (by label, no value) and stop.

- [ ] **Step 2: Setup and start.** The build is from Task 2, on the reviewed HEAD.

```powershell
node $B/journeys/email-webhook-real.mjs setup
node $L/server.mjs start          # MF_EXTRA_ENV still set; prints the build commit
Start-Process -NoNewWindow node "$B/journeys/webhook-gate.mjs"
```

Noe starts `cloudflared tunnel --url http://127.0.0.1:3995`, then checks that the Resend endpoint is `https://<printed>.trycloudflare.com/api/webhooks/resend`. If the URL changed since M5, he updates the endpoint in Resend; the signing secret stays the same.

- [ ] **Step 3: Run.**

Run: `node $B/journeys/email-webhook-real.mjs run`

Expected:
- S1 PASS.
- For each listed recipient: R-send PASS and R-hook PASS, with svix ids and `type:outcome` pairs recorded.
- R-short-circuit PASS if `bounced@` is listed.
- Noe confirms the reset email arrived in his own inbox (yes/no only).
- A `retry_unknown_recent` line followed by `applied` is a PASS: it shows Task 1's retry working on real traffic.

- [ ] **Step 4: Read back.**

Run: `node scripts/readiness/email-log-report.mjs --env C:\Users\NoeTo\Desktop\matflow\.env.test --days 1 --tenant <fixture slug>`

This is read-only, on the test branch only. Record the counts by status. Recipients are masked.

- [ ] **Step 5: Cleanup.** Every item is required.

```powershell
node $L/server.mjs stop; Get-Process node | Where-Object { $_.CommandLine -like "*webhook-gate.mjs*" } | Stop-Process
node $B/journeys/email-webhook-real.mjs teardown      # expect tornDown, 0 rows left (no address stays in the test DB)
Remove-Item Env:MF_EXTRA_ENV
```

Noe does three things:
- stops `cloudflared`;
- disables or deletes the test webhook endpoint in Resend;
- deletes the private file, or keeps it if more runs are planned. That is his call; it is outside git either way.

- [ ] **Step 6: Evidence document.**
  - Write `docs/readiness/RESEND-REAL-TEST-EVIDENCE-2026-10-<dd>.md` with:
    - the commit;
    - the build stamp;
    - the run time in UK time;
    - REAL rows: masked recipients, Resend ids, svix ids, statuses and outcomes;
    - the SIMULATED rows from Task 2, under a separate heading;
    - Noe's inbox confirmation;
    - the cleanup state;
    - "production unchanged": a `vercel env ls` names/scopes comparison, run by Noe or read-only, against the 20 entries recorded on 17 Oct. No deploys.
  - Update the checklist rows.
  - Commit both files.

```bash
git add docs/readiness/RESEND-REAL-TEST-EVIDENCE-2026-10-<dd>.md docs/readiness/RESEND-TEST-CONFIG-2026-10-17.md
git commit -m "docs(email): REAL isolated send + signed webhook evidence" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Completion report, memory, Needs Noe

**Files:**
- Modify: `C:\Users\NoeTo\.claude\projects\c--Users-NoeTo-Desktop-matflow\memory\project_email_test_isolation_2026_10_17.md` and its `MEMORY.md` line

- [ ] **Step 1:** Run the `matflow-completion-report` skill. Its report covers:
  - what changed (commits since `e954482`);
  - what was tested (SIMULATED and REAL, separately, with commits);
  - what is unverified;
  - the exact release state: branch unpushed, no PR, production unchanged with `emailDelivery=off`.
- [ ] **Step 2:** Update the memory file: commits, verdict, REAL evidence path, residuals.
- [ ] **Step 3:** Give Noe the Needs Noe list:
  - push or PR approval for `feat/email-test-isolation`;
  - PR #43 browser observations, still pending;
  - which Resend account received the 440 historical test-branch sends;
  - production Resend plan, limits and domain status;
  - commercial go-ahead before any paid plan or activation.

  Then name the next queued plan: the Stripe test-mode demo, after reconciling `payments/stripe-defects-2026-10`.
