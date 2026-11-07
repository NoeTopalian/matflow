// S4: 50 owners on Reports at once for two minutes: the Reports page, then its data for one of the five period
// presets (lib/report-period), then 5-15 s of reading. Ten clubs mean ten owner accounts, so each owner is open on
// five devices; the periods vary so the 60-second per-club cache (lib/reports.ts) is not the only thing measured.
// Smoke: 5 owners for SMOKE_SECONDS.
import exec from "k6/execution";
import { STAFF, FULL, dur, req, withSession, think, pick, laneIp, TARGET_THRESHOLDS, SUMMARY_STATS, writeSummary } from "./k6-common.js";

const PERIODS = ["this-month", "last-month", "3m", "6m", "12m"];
const OWNERS = STAFF.filter((s) => s.role === "owner");

export const options = {
  insecureSkipTLSVerify: true,
  summaryTrendStats: SUMMARY_STATS,
  scenarios: { reports: { executor: "constant-vus", vus: FULL ? 50 : 5, duration: dur("2m"), exec: "run" } },
  thresholds: { ...TARGET_THRESHOLDS },
};

export function run() {
  const vu = exec.vu.idInTest;
  const owner = OWNERS[vu % OWNERS.length];
  const ip = laneIp(20000 + vu);
  withSession(owner.token);
  req("GET", "/dashboard/reports", { kind: "page", name: "reports page", ip });
  req("GET", `/api/reports?period=${pick(PERIODS)}`, { kind: "api", name: "reports api", ip });
  think(5, 15);
}

export function handleSummary(data) {
  return writeSummary("s4-reports", data, { owners: OWNERS.length, virtualUsers: FULL ? 50 : 5 });
}
