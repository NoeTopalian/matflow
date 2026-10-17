// Webhook-only ingress for the isolated REAL email test (17 Oct 2026). The public tunnel points HERE, never at the
// app: only `POST /api/webhooks/resend` (exact path, no query) is forwarded to the local server; everything else
// answers 404 and never reaches the app. The body is bounded WHILE it is read (and by Content-Length up front), and
// only the Svix signature headers and the content type are passed on — the app verifies the signature itself.
//   node webhook-gate.mjs
//   env: WEBHOOK_GATE_PORT (default 3995), MF_PORT (the app, default 3991), WEBHOOK_GATE_MAX_BYTES (default 262144)
//   GET http://127.0.0.1:<gate>/__gate — loopback only, never through the tunnel -> {"forwarded":n,"refused":n,"tooLarge":n}
// Prints one line per request: method, a sanitised path and the result. Never a header value or a body.
import http from "node:http";

const GATE_PORT = Number(process.env.WEBHOOK_GATE_PORT ?? 3995);
const APP_PORT = Number(process.env.MF_PORT ?? 3991);
const MAX_BYTES = Number(process.env.WEBHOOK_GATE_MAX_BYTES ?? 256 * 1024); // Resend event payloads are a few KB
const ROUTE = "/api/webhooks/resend";
const PASS_HEADERS = ["content-type", "svix-id", "svix-timestamp", "svix-signature"];
const counts = { forwarded: 0, refused: 0, tooLarge: 0 };
const safe = (s) => String(s ?? "").replace(/[^A-Za-z0-9/_.:?=&-]/g, "").slice(0, 80);
const note = (req, result) => console.log(`[webhook-gate] ${safe(req.method)} ${safe(req.url)} -> ${result}`);

function refuse(req, res, status, result) {
  res.writeHead(status, { connection: "close" });
  res.end();
  req.destroy();
  note(req, result);
}

const server = http.createServer((req, res) => {
  req.setTimeout(10_000, () => { if (!res.headersSent) { counts.refused++; refuse(req, res, 408, "408 timeout"); } });
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  // cloudflared connects from loopback too; it adds cf-connecting-ip, so tunnel traffic can never read the counter.
  if (req.method === "GET" && req.url === "/__gate" && loopback && !req.headers["cf-connecting-ip"]) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  if (req.method !== "POST" || req.url !== ROUTE) { counts.refused++; return refuse(req, res, 404, "404 not the webhook route"); }
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > MAX_BYTES) { counts.tooLarge++; return refuse(req, res, 413, "413 declared too large"); }

  const chunks = [];
  let size = 0;
  let stopped = false;
  req.on("data", (c) => {
    if (stopped) return;
    size += c.length;
    if (size > MAX_BYTES) { stopped = true; counts.tooLarge++; refuse(req, res, 413, "413 body over the limit"); return; }
    chunks.push(c);
  });
  req.on("end", () => {
    if (stopped) return;
    const body = Buffer.concat(chunks);
    const headers = { "content-length": String(body.length), host: `127.0.0.1:${APP_PORT}` };
    for (const h of PASS_HEADERS) if (typeof req.headers[h] === "string") headers[h] = req.headers[h];
    counts.forwarded++;
    const up = http.request({ host: "127.0.0.1", port: APP_PORT, method: "POST", path: ROUTE, headers, timeout: 15_000 }, (r) => {
      res.writeHead(r.statusCode ?? 502, { "content-type": r.headers["content-type"] ?? "application/json" });
      r.pipe(res);
      note(req, `forwarded -> app ${r.statusCode}`);
    });
    up.on("timeout", () => up.destroy(new Error("upstream timeout")));
    up.on("error", () => { if (!res.headersSent) { res.writeHead(502); res.end(); } note(req, "502 app unreachable"); });
    up.end(body);
  });
  req.on("error", () => {});
});

server.listen(GATE_PORT, "127.0.0.1", () =>
  console.log(`[webhook-gate] listening on 127.0.0.1:${GATE_PORT} -> app 127.0.0.1:${APP_PORT}; only POST ${ROUTE}; max body ${MAX_BYTES} bytes`));
