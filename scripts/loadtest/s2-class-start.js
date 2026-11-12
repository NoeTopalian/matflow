// S2: class start in the big club (club 1), two doors at once, 150 check-ins each in 120 s:
//   (a) kiosk: ONE kiosk token on ONE device address — name search, then check-in — as a tablet at the door;
//   (b) app: 150 members checking themselves in from their phones to ONE session whose capacity (seed
//       --s2-app-capacity, default 120) is below the 150 who try, and every tenth member double-taps (two
//       simultaneous requests), so "never over capacity" and "no duplicates" are exercised, not assumed.
// run.mjs then checks the database: attendance per S2 session <= capacity, no member twice in a session, and the
// successes k6 saw equal the rows written. Smoke: the same rate for SMOKE_SECONDS.
import http from "k6/http";
import exec from "k6/execution";
import { Counter } from "k6/metrics";
import { MEMBERS, CLUBS, FULL, dur, req, json, laneIp, withSession, unexpected, rateLimited, TARGET_THRESHOLDS, SUMMARY_STATS, writeSummary, counterValue, clubMemberRange } from "./k6-common.js";

const outcome = {
  ok: new Counter("checkin_ok"), duplicate: new Counter("checkin_duplicate"), full: new Counter("checkin_class_full"),
  refused: new Counter("checkin_refused_other"), limited: new Counter("checkin_rate_limited"), lookupMiss: new Counter("kiosk_lookup_miss"),
};

export const options = {
  insecureSkipTLSVerify: true,
  summaryTrendStats: SUMMARY_STATS,
  scenarios: {
    kiosk: { executor: "constant-arrival-rate", rate: 75, timeUnit: "1m", duration: dur("2m"), preAllocatedVUs: 5, maxVUs: FULL ? 30 : 5, exec: "kiosk" },
    app: { executor: "constant-arrival-rate", rate: 75, timeUnit: "1m", duration: dur("2m"), preAllocatedVUs: 5, maxVUs: FULL ? 60 : 5, exec: "app" },
  },
  thresholds: { ...TARGET_THRESHOLDS, checkin_refused_other: ["count<1"] },
};

const BIG = 0;
function record(r, door) {
  const body = json(r) || {};
  if (r.status === 201) outcome.ok.add(1, { door });
  else if (r.status === 429) outcome.limited.add(1, { door });
  else if (r.status === 409 && body.reason === "already_checked_in") outcome.duplicate.add(1, { door });
  else if (r.status === 409 && body.reason === "class_full") outcome.full.add(1, { door });
  else outcome.refused.add(1, { door });
}

export function kiosk() {
  const club = CLUBS[BIG];
  const { start, count } = clubMemberRange(BIG);
  const i = exec.scenario.iterationInTest;
  const m = MEMBERS[start + (i % count)];
  const ip = laneIp(1); // one tablet
  const inst = club.s2.kiosk.instanceId;
  if (i % 10 === 0) req("GET", `/api/kiosk/${club.kioskToken}/classes`, { kind: "api", name: "kiosk classes", ip });
  const found = json(req("GET", `/api/kiosk/${club.kioskToken}/members?q=${encodeURIComponent(m.name)}&classInstanceId=${inst}`, { kind: "api", name: "kiosk member search", ip }));
  const hit = found && found.members ? found.members.find((x) => x.name === m.name) : null;
  if (!hit) { if (!found || !found.error) outcome.lookupMiss.add(1); return; }
  const r = req("POST", `/api/kiosk/${club.kioskToken}/checkin`, {
    kind: "checkin", name: "kiosk check-in", ip, expect: [201, 409],
    body: JSON.stringify({ kioskMemberToken: hit.kioskMemberToken, classInstanceId: inst }), headers: { "content-type": "application/json" },
  });
  record(r, "kiosk");
}

export function app() {
  const club = CLUBS[BIG];
  const { start, count } = clubMemberRange(BIG);
  const i = exec.scenario.iterationInTest;
  const m = MEMBERS[start + ((150 + i) % count)];
  const ip = laneIp(2000 + i);
  withSession(m.token);
  const body = JSON.stringify({ classInstanceId: club.s2.app.instanceId, checkInMethod: "self" });
  const headers = { "content-type": "application/json", origin: (__ENV.BASE || "").replace(/\/+$/, "") };
  const params = { headers: { "x-real-ip": ip, "x-lane-ip": ip, "user-agent": "matflow-loadtest/k6", ...headers }, tags: { kind: "checkin", name: "app check-in" }, redirects: 0, timeout: "60s" };
  if (i % 10 === 5) {
    // Double tap: two identical requests at once. Exactly one may succeed.
    const url = `${(__ENV.BASE || "").replace(/\/+$/, "")}/api/checkin`;
    for (const r of http.batch([["POST", url, body, params], ["POST", url, body, params]])) {
      if (r.status === 429) rateLimited.add(1, { kind: "checkin", name: "app check-in" });
      unexpected.add([201, 409, 429].indexOf(r.status) === -1, { kind: "checkin", name: "app check-in" });
      record(r, "app");
    }
    return;
  }
  record(req("POST", "/api/checkin", { kind: "checkin", name: "app check-in", ip, body, headers, expect: [201, 409] }), "app");
}

export function handleSummary(data) {
  const n = (k) => counterValue(data, k);
  return writeSummary("s2-class-start", data, {
    checkins: { ok: n("checkin_ok"), duplicate: n("checkin_duplicate"), classFull: n("checkin_class_full"), refusedOther: n("checkin_refused_other"), rateLimited: n("checkin_rate_limited"), kioskLookupMiss: n("kiosk_lookup_miss") },
    sessions: { kiosk: CLUBS[BIG].s2.kiosk, app: CLUBS[BIG].s2.app },
  });
}
