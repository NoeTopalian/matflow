// Counting relay between the isolated app and Resend for the REAL email test (19 Oct 2026). The app's Resend client
// is pointed here (RESEND_BASE_URL=http://127.0.0.1:4598 in the private file), so EVERY provider request the app
// makes is seen and counted. It is defence in depth on top of sendEmail's allowlist:
//   - only `POST /emails` is forwarded; any other path is refused and never reaches Resend;
//   - the payload must address exactly ONE recipient, equal to the single EMAIL_TEST_RECIPIENTS entry, with no
//     cc / bcc; otherwise it is refused (403) and never reaches Resend;
//   - at most RESEND_RELAY_MAX_SENDS (default 1) requests are forwarded; later ones are refused (429).
// Upstream is https://api.resend.com (REAL). A dry run sets RESEND_RELAY_UPSTREAM to a loopback stand-in (SIMULATED).
// Never logs the key, the body or a full address.
//   node resend-relay.mjs       (MF_EXTRA_ENV must name the private file)
//   GET http://127.0.0.1:4598/__relay (loopback only) → {mode, received, forwarded, refused, lastStatus}
import http from "node:http";
import { extraEnv } from "../../matflow-verify-local/scripts/env.mjs";

const PORT = Number(process.env.RESEND_RELAY_PORT ?? 4598);
const UPSTREAM = process.env.RESEND_RELAY_UPSTREAM ?? "https://api.resend.com";
const MODE = UPSTREAM === "https://api.resend.com" ? "REAL" : "SIMULATED";
if (MODE === "SIMULATED" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(UPSTREAM)) throw new Error("refusing: RESEND_RELAY_UPSTREAM must be https://api.resend.com or a loopback stand-in");
const MAX_SENDS = Number(process.env.RESEND_RELAY_MAX_SENDS ?? 1);
const MAX_BODY = 1024 * 1024;
const PASS = ["authorization", "content-type", "idempotency-key", "user-agent"];

const list = (extraEnv().EMAIL_TEST_RECIPIENTS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
if (list.length !== 1 || !/^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/.test(list[0])) throw new Error("refusing: EMAIL_TEST_RECIPIENTS must hold exactly one plain address");
const ALLOWED = list[0];
const mask = (a) => { const [u, d] = String(a).split("@"); return d ? `${u.slice(0, 1)}…@${d}` : "…"; };
const counts = { mode: MODE, received: 0, forwarded: 0, refused: 0, lastStatus: null };

function answer(res, status, name, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ statusCode: status, name, message }));
}

http.createServer((req, res) => {
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  if (!loopback) { req.destroy(); return; }
  if (req.method === "GET" && req.url === "/__relay") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  counts.received++;
  const chunks = [];
  let size = 0;
  req.on("data", (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
  req.on("end", async () => {
    const refuse = (status, name, why) => { counts.refused++; console.log(`[resend-relay] ${req.method} ${String(req.url).slice(0, 40)} refused: ${why}`); answer(res, status, name, `relay refused: ${why}`); };
    if (req.method !== "POST" || req.url !== "/emails") return refuse(404, "relay_refused", "only POST /emails is relayed");
    if (size > MAX_BODY) return refuse(413, "relay_refused", "body too large");
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return refuse(400, "relay_refused", "not JSON"); }
    const to = Array.isArray(payload.to) ? payload.to : [payload.to];
    if (to.length !== 1 || typeof to[0] !== "string" || to[0].trim().toLowerCase() !== ALLOWED) return refuse(403, "relay_refused", `recipient is not the one listed address (${to.length} recipient(s))`);
    for (const k of ["cc", "bcc"]) if (payload[k] !== undefined) return refuse(403, "relay_refused", `${k} is not allowed`);
    if (counts.forwarded >= MAX_SENDS) return refuse(429, "relay_refused", `the ${MAX_SENDS}-send budget for this run is spent`);
    const headers = {};
    for (const h of PASS) if (typeof req.headers[h] === "string") headers[h] = req.headers[h];
    counts.forwarded++;
    try {
      const up = await fetch(`${UPSTREAM}/emails`, { method: "POST", headers, body: JSON.stringify(payload) });
      const text = await up.text();
      counts.lastStatus = up.status;
      console.log(`[resend-relay] POST /emails to ${mask(to[0])} -> ${MODE} upstream ${up.status}`);
      res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
      res.end(text);
    } catch (e) {
      counts.lastStatus = "network_error";
      console.log(`[resend-relay] upstream unreachable (${e instanceof Error ? e.name : "error"})`);
      answer(res, 502, "relay_upstream_error", "upstream unreachable");
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[resend-relay] 127.0.0.1:${PORT} -> ${MODE} ${UPSTREAM}; only POST /emails to ${mask(ALLOWED)}; at most ${MAX_SENDS} send(s)`));
