// Round 8 measurement preload, v2 (local test-branch server only; never shipped). Loaded with
//   NODE_OPTIONS=--require=<this file>   R8_APP=<worktree>   R8_PROBE_PORT=<port>
// Inside the `next start` process only:
//  * aggregate counters (as v1): round trips and their time, new physical connections and connect time, pool acquires,
//    waits for a full pool, peak concurrent queries;
//  * per incoming HTTP request (AsyncLocalStorage opened when the server emits 'request'): method, path, the router
//    headers that mark a prefetch, status, start/end, and the round trips / transactions / acquires / new connections
//    made inside that request's async context. Work with no request context is counted as "unattributed";
//  * connection lifecycle with timestamps: create (connect ms), acquire (new or reused, idle ms since last release),
//    release (with error? ending?), remove (reason: idle-expiry | max-lifetime | max-uses | release-with-error |
//    explicit-dispose | error-while-idle | pool-end, plus idle ms and age).
// Serves: GET /snap, /reqs, /conns on 127.0.0.1:R8_PROBE_PORT; `?reset=1` returns and clears. SQL is reduced to a
// shape (literals and $n stripped, 120 chars); parameter values are never read.
"use strict";
const argv = process.argv.join(" ");
if (!/next[\\/]dist[\\/]bin[\\/]next/.test(argv) || !/\bstart\b/.test(argv)) return;
const path = require("node:path");
const http = require("node:http");
const { AsyncLocalStorage } = require("node:async_hooks");
const { createRequire } = require("node:module");
const app = process.env.R8_APP;
const port = Number(process.env.R8_PROBE_PORT || 0);
if (!app || !port) return;
const req = createRequire(path.join(app, "package.json"));
const pg = req("pg");
const now = () => performance.now();
const wall = () => Date.now();
const als = new AsyncLocalStorage();
const T0 = wall();

let s, reqs, conns, reqSeq = 0;
const zero = () => (s = { queries: 0, queryMs: 0, tx: 0, newConnections: 0, connectMs: 0, maxConnectMs: 0, acquires: 0, acquireMs: 0, maxAcquireMs: 0, queuedAcquires: 0, queueMs: 0, maxConcurrent: 0, inFlight: 0, unattributedQueries: 0, shapes: {} });
zero(); reqs = []; conns = [];
const shape = (t) => String(t).replace(/'(?:[^']|'')*'/g, "?").replace(/\$\d+/g, "?").replace(/\b\d+\b/g, "?").replace(/\s+/g, " ").trim().slice(0, 120);

// ── Per-request context ──
const origEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, rq, rs) {
  if (ev !== "request" || !rq || !rs || this === probeServer) return origEmit.apply(this, arguments);
  const u = new URL(rq.url, "http://x");
  if (u.pathname.startsWith("/_next/static") || u.pathname === "/favicon.ico") return origEmit.apply(this, arguments);
  const h = rq.headers;
  const r = {
    id: ++reqSeq, method: rq.method, path: u.pathname, rsc: u.searchParams.has("_rsc") || h.rsc === "1",
    prefetch: h["next-router-prefetch"] ?? null, segment: h["next-router-segment-prefetch"] ?? null,
    stateTree: h["next-router-state-tree"] ? h["next-router-state-tree"].length : 0, lane: h["x-lane-ip"] ?? null,
    start: wall() - T0, end: null, status: null, q: 0, qms: 0, tx: 0, acquires: 0, acquireMs: 0, newConns: 0, connectMs: 0, shapes: {},
  };
  reqs.push(r);
  const done = () => { if (r.end === null) { r.end = wall() - T0; r.status = rs.statusCode; } };
  rs.once("finish", done); rs.once("close", done);
  return als.run(r, () => origEmit.apply(this, arguments));
};

function record(text, ms) {
  s.queries++; s.queryMs += ms;
  const k = shape(text);
  const isBegin = /^BEGIN/i.test(k);
  if (isBegin) s.tx++;
  const e = (s.shapes[k] ??= { n: 0, ms: 0 }); e.n++; e.ms += ms;
  const r = als.getStore();
  if (!r) { s.unattributedQueries++; return; }
  r.q++; r.qms += ms; if (isBegin) r.tx++;
  const f = (r.shapes[k] ??= { n: 0, ms: 0 }); f.n++; f.ms += ms;
}

// ── Queries ──
const C = pg.Client.prototype;
const origQuery = C.query;
C.query = function (config, values, cb) {
  const text = typeof config === "string" ? config : config?.text ?? "(submittable)";
  const ctx = als.getStore();
  const t0 = now();
  s.inFlight++; if (s.inFlight > s.maxConcurrent) s.maxConcurrent = s.inFlight;
  let done = false;
  const finish = () => { if (done) return; done = true; s.inFlight--; als.run(ctx, () => record(text, now() - t0)); };
  if (typeof values === "function") { const f = values; return origQuery.call(this, config, (...a) => { finish(); f(...a); }); }
  if (typeof cb === "function") { const f = cb; return origQuery.call(this, config, values, (...a) => { finish(); f(...a); }); }
  if (config && typeof config.callback === "function") { const f = config.callback; config.callback = (...a) => { finish(); f(...a); }; }
  const r = origQuery.call(this, config, values);
  if (r && typeof r.then === "function") r.then(finish, finish);
  return r;
};

// ── Connections ──
let clientSeq = 0;
const meta = new WeakMap(); // client -> { id, createdAt, connectMs, lastReleasedAt, uses, relErr, relEnding }
const m = (c) => { let x = meta.get(c); if (!x) { x = { id: ++clientSeq, createdAt: wall() - T0, connectMs: null, lastReleasedAt: null, uses: 0 }; meta.set(c, x); } return x; };
const origConnect = C.connect;
C.connect = function (cb) {
  const t0 = now();
  const ctx = als.getStore();
  const self = this;
  const finish = (err) => {
    const ms = now() - t0; s.newConnections++; s.connectMs += ms; if (ms > s.maxConnectMs) s.maxConnectMs = ms;
    const x = m(self); x.connectMs = Math.round(ms);
    conns.push({ t: wall() - T0, ev: err ? "create-failed" : "create", id: x.id, connectMs: Math.round(ms), req: ctx?.id ?? null, err: err ? String(err.message ?? err).slice(0, 120) : undefined });
    if (ctx) { ctx.newConns++; ctx.connectMs += ms; }
  };
  if (typeof cb === "function") return origConnect.call(this, (...a) => { finish(a[0]); cb(...a); });
  const r = origConnect.call(this);
  if (r && typeof r.then === "function") r.then(() => finish(null), (e) => finish(e));
  return r;
};

const hooked = new WeakSet();
function hookPool(pool) {
  if (hooked.has(pool)) return;
  hooked.add(pool);
  let pendingReason = null;
  const origLog = pool.log;
  pool.log = function (msg, ...rest) {
    if (msg === "remove idle client") pendingReason = "idle-expiry";
    else if (msg === "remove expired client") pendingReason = "max-lifetime";
    else if (msg === "remove expended client") pendingReason = "max-uses";
    return origLog.call(this, msg, ...rest);
  };
  pool.on("acquire", (c) => {
    const x = m(c); x.uses++;
    const r = als.getStore();
    conns.push({ t: wall() - T0, ev: "acquire", id: x.id, reused: x.uses > 1, idleMs: x.lastReleasedAt === null ? null : wall() - T0 - x.lastReleasedAt, req: r?.id ?? null });
  });
  pool.on("release", (err, c) => {
    const x = m(c); x.lastReleasedAt = wall() - T0; x.relErr = !!err; x.relEnding = !!c._ending;
    conns.push({ t: x.lastReleasedAt, ev: "release", id: x.id, err: !!err, ending: !!c._ending });
  });
  const origRemove = pool._remove;
  pool._remove = function (c, cb) {
    const x = m(c);
    const reason = pendingReason ?? (this.ending ? "pool-end" : x.relErr ? "release-with-error" : x.relEnding || c._ending ? "explicit-dispose" : "error-while-idle");
    pendingReason = null;
    conns.push({ t: wall() - T0, ev: "remove", id: x.id, reason, idleMs: x.lastReleasedAt === null ? null : wall() - T0 - x.lastReleasedAt, ageMs: wall() - T0 - x.createdAt, uses: x.uses });
    return origRemove.call(this, c, cb);
  };
  pool.on("error", (e, c) => conns.push({ t: wall() - T0, ev: "pool-error", id: c ? m(c).id : null, err: String(e?.message ?? e).slice(0, 120) }));
}

const P = pg.Pool.prototype;
const origPoolConnect = P.connect;
P.connect = function (cb) {
  hookPool(this);
  const t0 = now();
  const ctx = als.getStore();
  const queued = this.totalCount >= this.options.max && this.idleCount === 0;
  const finish = () => {
    const ms = now() - t0; s.acquires++; s.acquireMs += ms; if (ms > s.maxAcquireMs) s.maxAcquireMs = ms;
    if (queued) { s.queuedAcquires++; s.queueMs += ms; }
    if (ctx) { ctx.acquires++; ctx.acquireMs += ms; }
  };
  if (typeof cb === "function") return origPoolConnect.call(this, (...a) => { finish(); cb(...a); });
  const r = origPoolConnect.call(this);
  if (r && typeof r.then === "function") r.then(finish, finish);
  return r;
};

const round = (r) => ({ ...r, qms: Math.round(r.qms), acquireMs: Math.round(r.acquireMs), connectMs: Math.round(r.connectMs), shapes: Object.entries(r.shapes).sort((a, b) => b[1].n - a[1].n).slice(0, 15).map(([k, v]) => [v.n, Math.round(v.ms), k]) });
let probeServer = null;
probeServer = http.createServer((rq, rs) => {
  const u = new URL(rq.url, "http://x");
  const reset = u.searchParams.get("reset") === "1";
  let out;
  if (u.pathname === "/snap") { out = { ...s, shapes: Object.entries(s.shapes).sort((a, b) => b[1].n - a[1].n).slice(0, 40) }; if (reset) zero(); }
  else if (u.pathname === "/reqs") { out = reqs.map(round); if (reset) reqs = []; }
  else if (u.pathname === "/conns") { out = conns; if (reset) conns = []; }
  else if (u.pathname === "/t") { out = { t: wall() - T0 }; }
  else { rs.writeHead(404); return rs.end(); }
  rs.writeHead(200, { "content-type": "application/json" }); rs.end(JSON.stringify(out));
}).listen(port, "127.0.0.1").unref();
