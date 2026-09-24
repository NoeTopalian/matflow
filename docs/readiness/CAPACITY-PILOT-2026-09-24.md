# Capacity — pilot stage measurement, 2026-09-24 (execution prompt §8)

**Verdict: no errors and no collapse under the pilot workload; absolute latency budgets cannot be judged from this environment.** Every number below was measured from a laptop in Italy against a production build talking to the Neon **test** branch over the public internet, where a single database round-trip costs about 500 ms. Production runs on Vercel next to Neon. This run therefore proves error behaviour, queueing and throttling under load; it does not prove the p95 budgets, which need a run from a Vercel-region generator (register R1-6 stays IN PROGRESS).

## Setup
| | |
|---|---|
| Build | `next build` at SHA `9993565`, `next start` on :3948, `.env.test` (test branch), `AUTH_TRUST_HOST`, mail key deliberately invalid (sends fail into EmailLog) |
| Dataset | club `loadpilotmug0ox4x`: 500 people (350 adults, 150 kids on parents), 5 tiers, 6 classes, 630 instances over 24 months, 32,941 attendance rows, 3,718 payments — `scratchpad/load/seed-load.mjs` |
| Generator | `scratchpad/load/run-load.mjs`: arrival-rate scheduler (offered load fixed, not reduced by slow responses); 25 owner sessions, one action per session per 20 s; mix 30 % schedule (timetable page + classes API), 25 % member lookup (search + detail page), 20 % home (**staff home, not the member portal** — seeded members have no password), 15 % booking substitute (**staff check-in write**, a real insert), 10 % reports (8 weeks); bursts of kiosk lookups at 3 × 5 = 15 requests/s for 60 s at minutes 2 and 7 (the third burst fell outside the 10-minute window) |
| Duration | 10 minutes steady state + 2 bursts |

## Results (2,683 requests, **0 unexpected 5xx / network errors**)
| Kind | n | p50 ms | p95 ms | p99 ms | max ms | statuses |
|---|---:|---:|---:|---:|---:|---|
| member:list (search) | 186 | 843 | 1,697 | 2,248 | 3,201 | 200 ×186 |
| member:detail (page) | 186 | 747 | 1,304 | 1,822 | 1,870 | 200 ×186 |
| schedule:page | 190 | 679 | 1,453 | 2,264 | 2,576 | 200 ×190 |
| schedule:api | 190 | 815 | 1,574 | 2,593 | 3,057 | 200 ×190 |
| home (staff) | 139 | 691 | 1,372 | 2,428 | 2,753 | 200 ×139 |
| report:api (8 weeks) | 74 | 2,982 | 5,025 | 7,008 | 7,008 | 200 ×74 |
| checkin:staff-write | 136 | 1,547 | 3,451 | 4,502 | 4,683 | 201 ×35, 409 ×101 (duplicate check-ins — expected, one instance today) |
| kiosk:lookup (bursts) | 1,582 | 75 | 1,064 | 2,258 | 2,669 | 200 ×136, **429 ×1,446** |

Bursts: offered 15 req/s, achieved 13.2 and 13.17 req/s (generator timer granularity), 792 and 790 requests each.

## Reading it honestly
- **Throttling, not failure.** 91 % of kiosk lookups answered 429: the kiosk lookup limit is 60 per minute per token and IP (`[rate-limit] bucket=kiosk:lookup … max=60 windowMs=60000` in the server log). One tablet firing 15 lookups a second is not a real door; 60/min per tablet is. Reported separately from errors as the prompt requires. The kiosk **check-in write** was not exercised because the lookup response field the generator expected did not match — a harness gap, to fix before the next run.
- **Reports are the heavy path.** p95 5 s and p99 7 s with 74 calls in 10 minutes. Network explains ~0.5 s of it; the rest is the ~12-query interactive transaction in `lib/reports.ts` under 25 concurrent sessions. Already on the backlog (cache reports; top-200 cap). This is the first thing to fix before any 25-club stage.
- **Everything else queued mildly and recovered.** p50s of 0.7–0.85 s against a ~0.5 s network floor mean roughly 0.2–0.35 s of server work at rest; p95s of 1.3–1.7 s show queueing under the mix, no runaway tail (max ≤ 3.2 s), no 5xx, no pool exhaustion in the server log.
- **Staff check-in writes** p95 3.5 s: a real insert inside the tenant transaction plus the capacity/pack/waiver reads; the 409s are correct duplicate refusals. Worth a look at what the write path reads before it inserts.

## Not measured (say so)
Member portal (no member passwords in the seed); kiosk check-in write (harness field mismatch); Bacs/Checkout flows (provider); 30-minute peak and 2-hour soak (10-minute run only); DB connection/pool metrics and query plans (no access to Neon metrics from here); cost per club.

## Next run
From a Vercel-region generator (or a Neon branch in the same region as a preview deployment) with: the kiosk write fixed, a member session in the mix, 30-minute peak + one 60-minute soak, Neon metrics captured, and the reports cache in place. Only then can the p95 ≤ 750 ms / check-in p95 ≤ 500 ms budgets be passed or failed.
