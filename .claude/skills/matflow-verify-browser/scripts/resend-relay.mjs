// Counting relay between the isolated app and Resend for the REAL email test (19 Oct 2026). The app's Resend client
// is pointed here (RESEND_BASE_URL=http://127.0.0.1:4598 in the private file), so EVERY provider request the app
// makes is seen and counted. It is defence in depth on top of sendEmail's allowlist:
//   - it starts DISARMED: every request is counted and refused (503), so a control request can prove the app is wired
//     through it without anything reaching Resend; `POST /__arm` (loopback) arms it;
//   - only `POST /emails` is forwarded; any other path is refused and never reaches Resend;
//   - the payload must address exactly ONE recipient, equal to the single EMAIL_TEST_RECIPIENTS entry (plain ASCII),
//     with no cc / bcc and no To/Cc/Bcc in custom headers; otherwise it is refused (403);
//   - at most RESEND_RELAY_MAX_SENDS (default 1) requests are forwarded per relay instance; later ones get 429.
// Upstream is https://api.resend.com (REAL). A dry run sets RESEND_RELAY_UPSTREAM to a loopback stand-in (SIMULATED).
// Each start has a random instance id, so counters from two different relay runs can never be mixed up.
// Never logs the key, the body or a full address.
//   node resend-relay.mjs       (MF_EXTRA_ENV must name the private file)
//   GET  http://127.0.0.1:4598/__relay  → {instance, mode, armed, received, receivedAtArm, forwarded, refused, lastStatus}
//   POST http://127.0.0.1:4598/__arm
import http from "node:http";
import { randomBytes } from "node:crypto";
import { extraEnv } from "../../matflow-verify-local/scripts/env.mjs";

const PORT = Number(process.env.RESEND_RELAY_PORT ?? 4598);
const UPSTREAM = process.env.RESEND_RELAY_UPSTREAM ?? "https://api.resend.com";
const MODE = UPSTREAM === "https://api.resend.com" ? "REAL" : "SIMULATED";
if (MODE === "SIMULATED" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(UPSTREAM)) throw new Error("refusing: RESEND_RELAY_UPSTREAM must be https://api.resend.com or a loopback stand-in");
const MAX_SENDS = Number(process.env.RESEND_RELAY_MAX_SENDS ?? 1);
if (!Number.isInteger(MAX_SENDS) || MAX_SENDS < 1 || MAX_SENDS > 5) throw new Error("refusing: RESEND_RELAY_MAX_SENDS must be a whole number from 1 to 5");
const MAX_BODY = 1024 * 1024;
const PASS = ["authorization", "content-type", "idempotency-key", "user-agent"];
const ASCII = /^[\x21-\x7e]+$/;

const list = (extraEnv().EMAIL_TEST_RECIPIENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (list.length !== 1 || !/^[\x21-\x7e]+@[\x21-\x7e]+\.[\x21-\x7e]+$/.test(list[0])) throw new Error("refusing: EMAIL_TEST_RECIPIENTS must hold exactly one plain ASCII address");
const ALLOWED = list[0].toLowerCase();
const mask = (a) => { const [u, d] = String(a).split("@"); return d ? `${u.slice(0, 1)}…@${d}` : "…"; };
const counts = { instance: randomBytes(6).toString("hex"), mode: MODE, armed: false, received: 0, receivedAtArm: null, forwarded: 0, refused: 0, lastStatus: null };

function answer(res, status, name, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ statusCode: status, name, message }));
}

http.createServer((req, res) => {
  req.on("error", () => {});
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
  if (!loopback) { req.destroy(); return; }
  if (req.method === "GET" && req.url === "/__relay") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  if (req.method === "POST" && req.url === "/__arm") {
    req.resume();
    if (!counts.armed) { counts.armed = true; counts.receivedAtArm = counts.received; console.log("[resend-relay] armed"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  counts.received++;
  const chunks = [];
  let size = 0;
  req.on("data", (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
  req.on("end", async () => {
    const refuse = (status, name, why) => { counts.refused++; console.log(`[resend-relay] ${String(req.method).slice(0, 8)} ${String(req.url).slice(0, 40)} refused: ${why}`); answer(res, status, name, `relay refused: ${why}`); };
    try {
      if (req.method !== "POST" || req.url !== "/emails") return refuse(404, "relay_refused", "only POST /emails is relayed");
      if (size > MAX_BODY) return refuse(413, "relay_refused", "body too large");
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return refuse(400, "relay_refused", "not JSON"); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) return refuse(400, "relay_refused", "not a single email");
      const to = Array.isArray(payload.to) ? payload.to : [payload.to];
      const ok = to.length === 1 && typeof to[0] === "string" && ASCII.test(to[0].trim()) && to[0].trim().toLowerCase() === ALLOWED;
      if (!ok) return refuse(403, "relay_refused", `recipient is not the one listed address (${to.length} recipient(s))`);
      for (const k of ["cc", "bcc"]) if (payload[k] !== undefined) return refuse(403, "relay_refused", `${k} is not allowed`);
      if (payload.headers && typeof payload.headers === "object" && Object.keys(payload.headers).some((h) => /^(to|cc|bcc)$/i.test(h.trim()))) return refuse(403, "relay_refused", "recipient headers are not allowed");
      // Disarmed: the request proves the app is wired through the relay; nothing goes upstream.
      if (!counts.armed) return refuse(503, "relay_disarmed", "the relay is not armed (control request)");
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
    } catch {
      if (!res.headersSent) answer(res, 500, "relay_error", "relay error");
    }
  });
}).listen(PORT, "127.0.0.1", () => console.log(`[resend-relay] 127.0.0.1:${PORT} -> ${MODE} ${UPSTREAM}; instance ${counts.instance}; DISARMED; only POST /emails to ${mask(ALLOWED)}; at most ${MAX_SENDS} send(s)`));
