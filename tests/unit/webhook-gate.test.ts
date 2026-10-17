/**
 * The webhook-only ingress used for the isolated REAL email test
 * (.claude/skills/matflow-verify-browser/scripts/webhook-gate.mjs, 17 Oct 2026).
 * Runs the real script against a stand-in app on spare loopback ports and checks
 * that only `POST /api/webhooks/resend` ever reaches the app, that the body is
 * bounded while it is read, and that only the Svix headers are passed on.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const GATE = path.resolve(__dirname, "../../.claude/skills/matflow-verify-browser/scripts/webhook-gate.mjs");
const MAX = 1024;

type Seen = { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
const seen: Seen[] = [];
let app: http.Server;
let gate: ChildProcess;
let gatePort = 0;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); });
  });

function call(method: string, url: string, opts: { headers?: Record<string, string>; body?: string | Buffer; chunks?: Buffer[] } = {}) {
  return new Promise<{ status: number; body: string }>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: gatePort, method, path: url, headers: opts.headers }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on("error", () => resolve({ status: -1, body: "" })); // the gate may cut a refused upload mid-stream
    if (opts.chunks) { for (const c of opts.chunks) req.write(c); req.end(); }
    else req.end(opts.body);
  });
}

beforeAll(async () => {
  const appPort = await freePort();
  gatePort = await freePort();
  app = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const answer = () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, outcome: "applied" })); };
      if (body.includes("slow-app")) setTimeout(answer, 1500); else answer();
    });
  });
  await new Promise<void>((r) => app.listen(appPort, "127.0.0.1", () => r()));
  gate = spawn(process.execPath, [GATE], {
    env: { ...process.env, WEBHOOK_GATE_PORT: String(gatePort), MF_PORT: String(appPort), WEBHOOK_GATE_MAX_BYTES: String(MAX), WEBHOOK_GATE_IDLE_MS: "500" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("gate did not start")), 10_000);
    gate.stdout!.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
  });
}, 20_000);

afterAll(async () => {
  gate?.kill();
  await new Promise<void>((r) => app.close(() => r()));
});

describe("webhook gate — only the webhook route reaches the app", () => {
  it("everything except POST /api/webhooks/resend is 404 and never reaches the app", async () => {
    const before = seen.length;
    const probes: Array<[string, string]> = [
      ["GET", "/"], ["GET", "/login"], ["GET", "/api/health"], ["POST", "/api/auth/forgot-password"],
      ["POST", "/api/members"], ["GET", "/api/webhooks/resend"], ["PUT", "/api/webhooks/resend"],
      ["POST", "/api/webhooks/resend?x=1"], ["POST", "/api/webhooks/resend/"], ["POST", "/api/webhooks/../auth/forgot-password"],
      ["POST", "/API/WEBHOOKS/RESEND"], ["POST", "/api/stripe/webhook"],
    ];
    for (const [m, u] of probes) expect((await call(m, u, { body: "{}" })).status, `${m} ${u}`).toBe(404);
    expect(seen.length).toBe(before);
  });

  it("the counter is loopback-only and never answers tunnel traffic (cf-connecting-ip)", async () => {
    expect((await call("GET", "/__gate")).status).toBe(200);
    expect((await call("GET", "/__gate", { headers: { "cf-connecting-ip": "203.0.113.9" } })).status).toBe(404);
  });

  it("POST /api/webhooks/resend is forwarded with the body intact and only the Svix headers", async () => {
    const before = seen.length;
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "re_x" } });
    const r = await call("POST", "/api/webhooks/resend", {
      headers: {
        "content-type": "application/json", "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,abc",
        cookie: "session=secret", authorization: "Bearer x", "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9",
      },
      body,
    });
    expect(r.status).toBe(200);
    const got = seen.slice(before);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ method: "POST", url: "/api/webhooks/resend", body });
    expect(got[0].headers).toMatchObject({ "svix-id": "msg_1", "svix-timestamp": "1700000000", "svix-signature": "v1,abc", "content-type": "application/json" });
    for (const h of ["cookie", "authorization", "x-forwarded-for", "cf-connecting-ip"]) expect(got[0].headers[h], h).toBeUndefined();
  });

  it("an app that answers after the upload idle limit still gets its answer back (the connection is not reset)", async () => {
    const r = await call("POST", "/api/webhooks/resend", { headers: { "content-type": "application/json" }, body: JSON.stringify({ marker: "slow-app" }) });
    expect(r.status).toBe(200);
    expect(r.body).toContain("applied");
  });

  it("a body over the limit is refused while it is read (declared or streamed) and never forwarded", async () => {
    const before = seen.length;
    expect((await call("POST", "/api/webhooks/resend", { headers: { "content-length": String(MAX * 4) }, body: Buffer.alloc(MAX * 4, 120) })).status).toBe(413);
    // Chunked upload with no Content-Length: the gate must stop at the limit, not after the whole body.
    const streamed = await call("POST", "/api/webhooks/resend", { headers: { "transfer-encoding": "chunked" }, chunks: [Buffer.alloc(MAX, 120), Buffer.alloc(MAX, 120), Buffer.alloc(MAX, 120)] });
    expect([413, -1]).toContain(streamed.status);
    expect(seen.length).toBe(before);
    const counter = JSON.parse((await call("GET", "/__gate")).body) as { tooLarge: number };
    expect(counter.tooLarge).toBeGreaterThanOrEqual(2);
  });
});
