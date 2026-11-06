// S5: bot flood. The S3 browse mix at 200 users throughout; for the first half they are alone (the baseline), for
// the second half 200 junk requests a second arrive from 20 bot addresses: the sign-in form with made-up
// credentials, unknown kiosk tokens, signed-out API calls, the public pages, and random paths. Acceptance (spec):
// real-user p95 during the flood within 2x the baseline p95, and real-user errors below 1%. Junk answers are not
// errors of ours (429s, 401s, 404s are the point); only a 5xx to junk is counted (junk_server_errors).
// Smoke: 5 users, 20 junk a second, SMOKE_SECONDS split in two.
import http from "k6/http";
import exec from "k6/execution";
import { Rate } from "k6/metrics";
import { BASE, FULL, SUMMARY_STATS, laneIp, writeSummary } from "./k6-common.js";
import { browse } from "./k6-browse.js";

const HALF_S = FULL ? 180 : Math.max(2, Math.floor(Number(__ENV.SMOKE_SECONDS || 10) / 2));
const junk5xx = new Rate("junk_server_errors");

export const options = {
  insecureSkipTLSVerify: true,
  summaryTrendStats: SUMMARY_STATS,
  scenarios: {
    real: { executor: "constant-vus", vus: FULL ? 200 : 5, duration: `${HALF_S * 2}s`, exec: "real" },
    junk: { executor: "constant-arrival-rate", rate: FULL ? 200 : 20, timeUnit: "1s", duration: `${HALF_S}s`, startTime: `${HALF_S}s`, preAllocatedVUs: FULL ? 100 : 10, maxVUs: FULL ? 600 : 15, exec: "junk" },
  },
  thresholds: {
    // Recorded for the ratio computed below (the thresholds themselves only make k6 report the sub-metrics).
    "http_req_duration{user:real,phase:baseline}": ["p(95)>=0"],
    "http_req_duration{user:real,phase:flood}": ["p(95)>=0"],
    "unexpected_errors{user:real}": ["rate<0.01"],
    "unexpected_errors{user:real,phase:flood}": ["rate<0.01"],
  },
};

export function real() {
  const phase = Date.now() - exec.scenario.startTime < HALF_S * 1000 ? "baseline" : "flood";
  browse({ user: "real", phase }, FULL ? 10 : 0, FULL ? 30 : 0);
}

const rnd = (n) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, "x");
export function junk() {
  const ip = laneIp(60000 + (exec.scenario.iterationInTest % 20));
  const params = { headers: { "x-real-ip": ip, "x-lane-ip": ip, "user-agent": "matflow-loadtest/bot" }, tags: { kind: "junk", user: "bot" }, redirects: 0, timeout: "30s" };
  const choice = Math.floor(Math.random() * 7);
  let r;
  if (choice === 0) r = http.post(`${BASE}/api/auth/callback/credentials`, { csrfToken: rnd(32), email: `bot-${rnd(6)}@example.test`, password: rnd(12), tenantSlug: `nope-${rnd(5)}` }, params);
  else if (choice === 1) r = http.get(`${BASE}/api/kiosk/${rnd(43)}/classes`, params);
  else if (choice === 2) r = http.get(`${BASE}/api/member/home`, params);
  else if (choice === 3) r = http.get(`${BASE}/login`, params);
  else if (choice === 4) r = http.get(`${BASE}/api/auth/csrf`, params);
  else if (choice === 5) r = http.get(`${BASE}/${rnd(10)}`, params);
  else r = http.get(`${BASE}/wp-login.php?${rnd(6)}`, params);
  junk5xx.add(r.status >= 500 || r.status === 0);
}

export function handleSummary(data) {
  const p95 = (k) => (data.metrics[k] ? data.metrics[k].values["p(95)"] : null);
  const base = p95("http_req_duration{user:real,phase:baseline}");
  const flood = p95("http_req_duration{user:real,phase:flood}");
  const ratio = base && flood ? flood / base : null;
  const verdict = ratio === null ? "NO DATA" : ratio <= 2 ? "PASS" : "FAIL";
  return writeSummary("s5-bot-flood", data, { realUserP95Ms: { baseline: base, flood }, floodToBaselineRatio: ratio, twoTimesBaseline: verdict, halfSeconds: HALF_S });
}
