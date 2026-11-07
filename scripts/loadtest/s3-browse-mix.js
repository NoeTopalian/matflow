// S3: browse mix. 90% members, 10% staff, each virtual user its own device and session, one screen (page + its
// API calls) then 10-30 s of thought. Full: ramp to 1,000 users and hold, then to 5,000 and hold. The two plateaus
// are tagged (stage: 1k / 5k) so the report gives each its own p95. Smoke: 5 users for SMOKE_SECONDS.
import exec from "k6/execution";
import { FULL, TARGET_THRESHOLDS, SUMMARY_STATS, writeSummary } from "./k6-common.js";
import { browse } from "./k6-browse.js";

const STAGES = FULL
  ? [{ duration: "1m", target: 1000 }, { duration: "3m", target: 1000 }, { duration: "2m", target: 5000 }, { duration: "3m", target: 5000 }, { duration: "30s", target: 0 }]
  : [{ duration: `${Math.max(1, Math.floor(Number(__ENV.SMOKE_SECONDS || 10) / 2))}s`, target: 5 }, { duration: `${Math.ceil(Number(__ENV.SMOKE_SECONDS || 10) / 2)}s`, target: 5 }];
// The first plateau ends after 4 minutes; anything later is the 5k part (ramp included).
const FIRST_PLATEAU_END_MS = 4 * 60 * 1000;

export const options = {
  insecureSkipTLSVerify: true,
  summaryTrendStats: SUMMARY_STATS,
  scenarios: { browse: { executor: "ramping-vus", startVUs: 0, stages: STAGES, gracefulRampDown: "30s", exec: "run" } },
  thresholds: {
    ...TARGET_THRESHOLDS,
    "http_req_duration{kind:page,stage:1k}": ["p(95)<1000"],
    "http_req_duration{kind:api,stage:1k}": ["p(95)<400"],
    "http_req_duration{kind:page,stage:5k}": ["p(95)<1000"],
    "http_req_duration{kind:api,stage:5k}": ["p(95)<400"],
  },
};

export function run() {
  const stage = !FULL || Date.now() - exec.scenario.startTime < FIRST_PLATEAU_END_MS ? "1k" : "5k";
  browse({ stage });
}

export function handleSummary(data) {
  return writeSummary("s3-browse-mix", data);
}
