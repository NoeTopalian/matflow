// Shared k6 helpers for the MatFlow load-test scenarios (k6 JavaScript, not Node). Run through run.mjs, which sets:
//   BASE      the local load-test server (https://localhost:<port>, the TLS proxy in front of next start)
//   DATA      the k6 data file seed.mjs wrote (synthetic sessions; outside git)
//   PROFILE   "full" (the target's shape) or "smoke" (same requests, SMOKE_SECONDS long, a handful of users)
//   SUMMARY   where handleSummary writes this scenario's JSON result
// Refuses a BASE that is not this machine: the scenarios only ever drive the server run.mjs started.
import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Rate, Counter } from "k6/metrics";

export const BASE = (__ENV.BASE || "").replace(/\/+$/, "");
const baseHost = BASE.replace(/^https?:\/\//, "").split(/[:/]/)[0];
if (!BASE || (baseHost !== "localhost" && baseHost !== "127.0.0.1")) throw new Error("refusing: BASE must be the local load-test server started by scripts/loadtest/run.mjs");
if (!__ENV.DATA) throw new Error("refusing: DATA (the k6 data file written by scripts/loadtest/seed.mjs) is not set");

export const PROFILE = __ENV.PROFILE === "full" ? "full" : "smoke";
export const FULL = PROFILE === "full";
export const SMOKE_SECONDS = Number(__ENV.SMOKE_SECONDS || 10);
/** Duration string: the full profile's value, or the smoke length. */
export const dur = (full) => (FULL ? full : `${SMOKE_SECONDS}s`);

const load = () => JSON.parse(open(__ENV.DATA));
export const META = new SharedArray("meta", () => { const d = load(); return [{ stamp: d.stamp, cookieName: d.cookieName, memberPassword: d.memberPassword }]; })[0];
export const CLUBS = new SharedArray("clubs", () => load().clubs);
export const MEMBERS = new SharedArray("members", () => load().members);
export const STAFF = new SharedArray("staff", () => load().staff);

/** Members of one club, as indexes into MEMBERS (members are stored club by club). */
export function clubMemberRange(c) {
  let start = 0;
  for (let i = 0; i < c; i++) start += CLUBS[i].memberCount;
  return { start, count: CLUBS[c].memberCount };
}

export const unexpected = new Rate("unexpected_errors");
export const rateLimited = new Counter("rate_limited_429");

/**
 * A lane address per simulated device, in the RFC 2544 benchmarking range 198.18.0.0/15 (seed.mjs teardown removes
 * rate-limit rows keyed by it). Sent as x-real-ip (what lib/rate-limit.ts getClientIp trusts off Vercel when no
 * proxy rewrites it) and x-lane-ip (what the local TLS proxy turns into the last x-forwarded-for hop).
 */
export function laneIp(n) {
  const v = (n % 131070) + 1;
  return `198.${18 + ((v >> 16) & 1)}.${(v >> 8) & 255}.${v & 255}`;
}

export const SUMMARY_STATS = ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max", "count"];

/** The target's latency thresholds (spec: check-in p95 < 0.5 s, page p95 < 1 s, API p95 < 400 ms, errors < 0.5%). */
export const TARGET_THRESHOLDS = {
  "http_req_duration{kind:checkin}": ["p(95)<500"],
  "http_req_duration{kind:page}": ["p(95)<1000"],
  "http_req_duration{kind:api}": ["p(95)<400"],
  unexpected_errors: ["rate<0.005"],
};

/**
 * One request. `expect` lists the statuses that are a correct answer; a 429 is counted separately (an intended
 * refusal by a rate limit) and never as an unexpected error. Redirects are not followed: a signed-in page that
 * redirects (to /login, say) is a failure, not a 200.
 */
export function req(method, path, { kind, name, ip, body = null, headers = {}, expect = [200], jar, tags = {} }) {
  const params = {
    headers: { "x-real-ip": ip, "x-lane-ip": ip, "user-agent": "matflow-loadtest/k6", ...headers },
    tags: { kind, name, ...tags },
    redirects: 0,
    timeout: "60s",
  };
  if (jar) params.jar = jar;
  const r = http.request(method, `${BASE}${path}`, body, params);
  if (r.status === 429) rateLimited.add(1, { kind, name });
  const ok = expect.indexOf(r.status) !== -1;
  unexpected.add(!ok && r.status !== 429, { kind, name, ...tags });
  check(r, { [`${name}: ${expect.join("/")}`]: () => ok || r.status === 429 });
  return r;
}

export const json = (r) => { try { return r.json(); } catch { return null; } };

let sessionToken = null;
/** Put a minted session in this VU's cookie jar (once per token). */
export function withSession(token) {
  if (sessionToken === token) return;
  const jar = http.cookieJar();
  jar.clear(BASE);
  jar.set(BASE, META.cookieName, token, { secure: true, http_only: true, path: "/" });
  sessionToken = token;
}

/** Think time: min..max seconds in the full profile, a short pause in smoke runs. */
export function think(min, max) {
  sleep(FULL ? min + Math.random() * (max - min) : 0.2 + Math.random() * 0.8);
}

export const pick = (list) => list[Math.floor(Math.random() * list.length)];
export const todayIso = () => new Date().toISOString().slice(0, 10);

/** Collected for the report: the metrics, the thresholds' verdicts, and anything the scenario adds. */
export function writeSummary(name, data, extra = {}) {
  const metrics = {};
  const failed = [];
  for (const [k, m] of Object.entries(data.metrics)) {
    metrics[k] = { type: m.type, values: m.values };
    if (m.thresholds) {
      metrics[k].thresholds = m.thresholds;
      for (const [t, v] of Object.entries(m.thresholds)) if (!v.ok) failed.push(`${k} ${t}`);
    }
  }
  const result = { scenario: name, profile: PROFILE, stamp: META.stamp, at: new Date().toISOString(), thresholdsFailed: failed, ...extra, metrics };
  const lines = [`\n== ${name} (${PROFILE}) ==`];
  for (const [k, m] of Object.entries(metrics)) if (m.thresholds) for (const [t, v] of Object.entries(m.thresholds)) {
    const val = m.type === "trend" ? `p95 ${Math.round(m.values["p(95)"])} ms` : m.type === "rate" ? `${(m.values.rate * 100).toFixed(2)}%` : JSON.stringify(m.values);
    lines.push(`${v.ok ? "PASS" : "FAIL"} ${k} ${t} (${val})`);
  }
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${JSON.stringify(v)}`);
  const out = { stdout: lines.join("\n") + "\n" };
  if (__ENV.SUMMARY) out[__ENV.SUMMARY] = JSON.stringify(result, null, 2);
  return out;
}

export const counterValue = (data, name) => (data.metrics[name] ? data.metrics[name].values.count : 0);
