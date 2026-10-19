/**
 * The counting relay between the isolated app and Resend
 * (.claude/skills/matflow-verify-browser/scripts/resend-relay.mjs, 19 Oct 2026).
 * Runs the real script with a stand-in upstream on spare loopback ports: only
 * POST /emails to the one listed address (no cc/bcc) is forwarded, at most once,
 * and every request is counted.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const RELAY = path.resolve(__dirname, "../../.claude/skills/matflow-verify-browser/scripts/resend-relay.mjs");
const LISTED = "noe.test@example.org";
const upstreamSeen: Array<{ url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
let upstream: http.Server;
let relay: ChildProcess;
let relayPort = 0;
let privateFile = "";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${relayPort}${url}`, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const counters = async () => (await call("GET", "/__relay")).body as { mode: string; received: number; forwarded: number; refused: number };

beforeAll(async () => {
  const upPort = await freePort();
  relayPort = await freePort();
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      upstreamSeen.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "11111111-0000-4000-8000-000000000001" }));
    });
  });
  await new Promise<void>((r) => upstream.listen(upPort, "127.0.0.1", () => r()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-relay-test-"));
  privateFile = path.join(dir, "email-test.env");
  fs.writeFileSync(privateFile, `EMAIL_DELIVERY=test\nEMAIL_TEST_RECIPIENTS=${LISTED}\n`);
  relay = spawn(process.execPath, [RELAY], {
    env: { ...process.env, MF_EXTRA_ENV: privateFile, RESEND_RELAY_PORT: String(relayPort), RESEND_RELAY_UPSTREAM: `http://127.0.0.1:${upPort}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("relay did not start")), 15_000);
    relay.stdout!.on("data", (d) => { if (String(d).includes("[resend-relay] 127.0.0.1")) { clearTimeout(t); resolve(); } });
  });
}, 30_000);

afterAll(async () => {
  relay?.kill();
  await new Promise<void>((r) => upstream.close(() => r()));
  fs.rmSync(path.dirname(privateFile), { recursive: true, force: true });
});

const email = (to: unknown, extra: Record<string, unknown> = {}) => ({ from: "MatFlow Test <onboarding@resend.dev>", to, subject: "s", text: "t", ...extra });

describe("Resend relay — counts everything, forwards only one email to the listed address", () => {
  it("reports SIMULATED for a loopback upstream, an instance id, and starts DISARMED", async () => {
    const c = await counters() as unknown as { mode: string; instance: string; armed: boolean };
    expect(c.mode).toBe("SIMULATED");
    expect(c.instance).toMatch(/^[0-9a-f]{12}$/);
    expect(c.armed).toBe(false);
  });

  it("while disarmed, even the listed address is counted and refused (control request) — nothing reaches the upstream", async () => {
    const before = await counters();
    const r = await call("POST", "/emails", email(LISTED));
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ name: "relay_disarmed" });
    const after = await counters();
    expect(after.received - before.received).toBe(1);
    expect(after.forwarded).toBe(0);
    expect(upstreamSeen).toHaveLength(0);
  });

  it("refuses other paths and methods, other recipients, several recipients, cc and bcc — none reach the upstream", async () => {
    const before = await counters();
    expect((await call("GET", "/emails")).status).toBe(404);
    expect((await call("POST", "/emails/batch", [email(LISTED)])).status).toBe(404);
    expect((await call("POST", "/api-keys", {})).status).toBe(404);
    expect((await call("POST", "/emails", email("member@example.org"))).status).toBe(403);
    expect((await call("POST", "/emails", email([LISTED, "member@example.org"]))).status).toBe(403);
    expect((await call("POST", "/emails", email(LISTED, { cc: "member@example.org" }))).status).toBe(403);
    expect((await call("POST", "/emails", email(LISTED, { bcc: ["member@example.org"] }))).status).toBe(403);
    expect((await call("POST", "/emails", email(LISTED, { headers: { " Bcc ": "member@example.org" } }))).status).toBe(403);
    expect((await call("POST", "/emails", email("NOE.TEST@example.org"))).status).toBe(503); // the listed address in another case passes the check (refused only because disarmed)
    expect((await call("POST", "/emails", email("noe.teſt@example.org"))).status).toBe(403); // a non-ASCII look-alike never matches
    expect((await call("POST", "/emails", null)).status).toBe(400);
    const after = await counters();
    expect(after.received - before.received).toBe(11);
    expect(after.refused - before.refused).toBe(11);
    expect(after.forwarded).toBe(0);
    expect(upstreamSeen).toHaveLength(0);
  });

  it("once armed, forwards exactly one email to the listed address (with its key and idempotency key) and refuses a second", async () => {
    const armed = await (await fetch(`http://127.0.0.1:${relayPort}/__arm`, { method: "POST" })).json() as { armed: boolean; receivedAtArm: number };
    expect(armed.armed).toBe(true);
    expect(typeof armed.receivedAtArm).toBe("number");
    const first = await call("POST", "/emails", email(" Noe.Test@example.org "), { authorization: "Bearer re_x", "idempotency-key": "matflow-emaillog/log-1", cookie: "x=y" });
    expect(first.status).toBe(200);
    expect(upstreamSeen).toHaveLength(1);
    expect(upstreamSeen[0].url).toBe("/emails");
    expect(upstreamSeen[0].headers).toMatchObject({ authorization: "Bearer re_x", "idempotency-key": "matflow-emaillog/log-1" });
    expect(upstreamSeen[0].headers.cookie).toBeUndefined();
    const second = await call("POST", "/emails", email(LISTED));
    expect(second.status).toBe(429);
    expect(upstreamSeen).toHaveLength(1);
    expect((await counters()).forwarded).toBe(1);
  });
});
