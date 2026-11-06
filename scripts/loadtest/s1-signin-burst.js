// S1: sign-in burst. 500 real password sign-ins in one minute (the target's "500 active in the same minute"),
// 90% members and 10% coaches, each from its own device address, through the real Auth.js credentials flow:
// GET /api/auth/csrf, POST /api/auth/callback/credentials, GET /api/auth/session. Smoke: 1 sign-in a second.
// Owners and managers are not in this burst: their sign-in has an authenticator step (seeded secrets are never
// handed to k6); S3-S5 use minted sessions for them.
import http from "k6/http";
import exec from "k6/execution";
import { Counter } from "k6/metrics";
import { MEMBERS, STAFF, CLUBS, META, FULL, dur, req, json, laneIp, TARGET_THRESHOLDS, SUMMARY_STATS, writeSummary, counterValue } from "./k6-common.js";

const signedIn = new Counter("signin_ok");
const signinFailed = new Counter("signin_failed");

export const options = {
  insecureSkipTLSVerify: true,
  summaryTrendStats: SUMMARY_STATS,
  scenarios: {
    signin: { executor: "constant-arrival-rate", rate: FULL ? 500 : 1, timeUnit: FULL ? "1m" : "1s", duration: dur("1m"), preAllocatedVUs: FULL ? 100 : 2, maxVUs: FULL ? 500 : 5, exec: "signin" },
  },
  thresholds: {
    ...TARGET_THRESHOLDS,
    // A sign-in is one bcrypt verification (cost 12) plus the session write: held to the page budget.
    "http_req_duration{kind:signin}": ["p(95)<1000"],
    signin_failed: ["count<1"],
  },
};

export function signin() {
  const i = exec.scenario.iterationInTest;
  const coaches = STAFF.filter((s) => s.role === "coach");
  const acct = i % 10 === 9 && coaches.length ? coaches[i % coaches.length] : MEMBERS[i % MEMBERS.length];
  const ip = laneIp(1000 + i);
  const jar = new http.CookieJar();
  const csrf = json(req("GET", "/api/auth/csrf", { kind: "api", name: "auth csrf", ip, jar }));
  if (!csrf || !csrf.csrfToken) { signinFailed.add(1); return; }
  const r = req("POST", "/api/auth/callback/credentials", {
    kind: "signin", name: "credentials sign-in", ip, jar, expect: [200, 302],
    body: { csrfToken: csrf.csrfToken, email: acct.email, password: META.memberPassword, tenantSlug: CLUBS[acct.c].slug, callbackUrl: "/", json: "true" },
    headers: { "content-type": "application/x-www-form-urlencoded", origin: (__ENV.BASE || "").replace(/\/+$/, "") },
  });
  const location = String(r.headers.Location || r.headers.location || "");
  const hasSession = Object.keys(jar.cookiesForURL(__ENV.BASE)).some((k) => k === META.cookieName);
  if (r.status === 429) return;
  if (!hasSession || location.includes("error")) { signinFailed.add(1); return; }
  const s = json(req("GET", "/api/auth/session", { kind: "api", name: "auth session", ip, jar }));
  if (s && s.user && s.user.email === acct.email) signedIn.add(1);
  else signinFailed.add(1);
}

export function handleSummary(data) {
  return writeSummary("s1-signin-burst", data, { signedIn: counterValue(data, "signin_ok"), signinFailed: counterValue(data, "signin_failed"), rateLimited: counterValue(data, "rate_limited_429") });
}
