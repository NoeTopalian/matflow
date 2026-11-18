# Round 8 — measured performance (15–16 Nov 2026)

Programme brief § Round 8. Everything here was measured on the Neon **test branch** from Bali with a synthetic club,
on a local production build (`next start`, pool max 5 as in production). Production runs in `lhr1` next to Neon
eu-west-2; a database round trip from Bali is ~226 ms. **Counts carry over to production; seconds do not.** No
production speed improvement has been demonstrated by this round.

## Method

- Build `e2b11f46` (= production on 15 Nov) for the baseline; batch 1 measured on `dd3a1212`.
- Fixture: 902 members (632 active), 4 plans, 15 classes, 49 weekly sessions, 595 sessions over 12 weeks, 8,232
  attendance records.
- Instruments (committed on this branch): `scripts/measure/r8-dbprobe.cjs`, a preload inside the server process that
  counts the app's own `pg` round trips, their time, pool acquires and waits, new connections and their lifecycle, per
  incoming request. Browser timings: Playwright + CDP, Chromium 1440×900 (phone 390×844).
- Journeys `r8-perf` (surfaces) and `r8-nav` (navigation, prefetch modes); analysis scripts beside the probe.
- Samples are small (cold 1 + warm 3 per surface for the table): ranges, never percentiles.

## Surfaces (baseline `e2b11f46`, run `rmwhd0adu0a6b47`)

| Surface | n cold/warm | Usable | Document server time | Requests | Transferred | DB queries | Query time (sum) | Pool acquire time (sum) | Full-pool wait (count) |
|---|---|---|---|---|---|---|---|---|---|
| Timetable | 1/3 | 7.8–9.8 s | 7.3–8.6 s | 54 | 137–567 kB | 274–278 | 70.6–73.5 s | 18.5–23.3 s | 1.3–3.0 s (1–2) |
| Register (desk) | 1/3 | 12.2–14.9 s | 5.9–7.4 s | 58 | 442–833 kB | 293 | 64.6–67.3 s | 10.4–13.2 s | 0.8–1.4 s (1–4) |
| Register: mark a member | 0/2 | — | — | 2 | 7 kB | 79 | 21.5–21.6 s | 1.2–1.3 s | 0 |
| Card check-in (API) | 0/3 | — | — | 1 | <1 kB | 41 | 10.6 s | 1.4–1.8 s | 0 |
| Members list | 1/3 | 21.0–23.5 s | 5.0–7.0 s | 58 | 213–637 kB | 272 | 64.5–76.4 s | 7.1–9.2 s | 0 |
| Members search | 0/2 | 0.2–0.6 s | — | 0 | 0 | 0 | 0 | 0 | 0 |
| Member profile | 1/3 | 10.0–11.5 s | 7.0–8.2 s | 58 | 152–606 kB | 284 | 70.2–74.0 s | 15.8–19.4 s | 1.1–1.8 s (1–2) |
| Reports | 1/3 | 6.6–21.8 s | 5.0–6.3 s | 54 | 146–682 kB | 227–283 | 50.4–68.2 s | 8.2–10.9 s | 0–0.4 s (0–1) |
| Analysis | 1/3 | 11.1–13.6 s | 4.3–5.7 s | 52 | 132–538 kB | 216 | 47.6–50.8 s | 2.9–5.4 s | 0 |
| Settings | 1/3 | 6.9–7.7 s | 5.8–6.7 s | 55 | 141–614 kB | 226 | 50.0–51.8 s | 8.4–12.3 s | 0–0.7 s (0–1) |

- Query and acquire times are sums across concurrent requests, so they exceed wall time.
- **Lock wait:** no waits observed. The locking statements on the check-in path averaged 216 ms against 231 ms for a
  bare `SELECT 1` in the same window, i.e. one round trip each. Contention under load was not measured (single user).
- Cold = fresh browser context; warm = reload in the same context.

## Findings and dispositions

| # | Finding (measured) | Disposition |
|---|---|---|
| F1 | Sidebar prefetch: every dashboard load issues 30 background requests (each sidebar link twice) and 150 queries on desktop, 14 / 70 on the phone; one session-check transaction (5 queries) each. | **Kept, deliberately.** Experiment (`auto` / `off` / hover-intent / one link, interleaved, n=3 per scenario): prefetch only changes time to the loading shell (≈1.3 s from Bali); time to usable content is the same in every mode. Removing it would cost every first navigation one server round trip before any feedback. Not changed. |
| F2 | Each tenant transaction has a fixed 4-round-trip cost (BEGIN, set_config, abort check, COMMIT). | Deliberate (RLS context and abort check). Not a candidate without its own security review. |
| F3 | Connections churn: every closure is pg-pool's default 10 s idle expiry; a new connection costs ~1.3 s from Bali. | Explained, not changed. Relevant to R8-0 (below). Changing pool timeouts needs production evidence and a connection-budget assessment. |
| F4 | Members list: the document arrives in 5–7 s but the first row only at ~21 s; the page runs 18 member counts in one transaction plus two more, sequentially. | Measured opportunity (≈8 round trips by merging two counts), **deferred**: at production latency the saving is milliseconds and unproven. |
| F5 | `/api/auth/session` requested twice on every page (next-auth's SessionProvider hearing its own broadcast) and again on every tab focus. | **Fixed in batch 1** (below). |
| F6 | Writes: register mark 79 round trips in 9 transactions; card check-in 41 in 6. The class instance is read twice on the mark path; eligibility re-reads the plan inside the locked write. | Deferred: about 5–7 round trips per mark, but the second read is inside the Member lock by design; changing it needs a concurrency review. |
| — | Register loads the whole club's desk-search list in pages of 500 (291 kB for 902 members). | Not a duplicate (cursor pagination); a design choice for desk search. |
| — | Members search is client-side over the first 1,500 members. | Known limit, already disclosed on the page above 1,500 members ("the list and search show only the first 1,500 by name"). No club is near it. |

## Batch 1 — session context only where it is read (`perf/round8-batch1`)

- The root `SessionProvider` is removed; the two components that read the session on the client (the Import panel's
  owner gate and the forced two-factor setup page) get their own provider, seeded with the server render's session.
- Result (same journey, like for like): desktop timetable load 5 → 3 requests and 124 → 114 queries; phone settings
  load 5 → 3 requests and 76 → 66 queries; no session request on tab focus for pages with no session reader.
  Usable times overlap between runs: **no speed claim**.
- Separately reviewable functional fix: the member's two-factor setup page sent its one setup request to the staff
  route on a hard load and showed "Could not initialise two-factor setup" (`c6ee48b2`; also a standalone PR from
  main).
- Evidence: journeys `session-provider-scope` 22/0, `import-review` 14/0, `round5-sign-out-everywhere` 6/0 on a build of
  `6d8d39ad`; unit suite 9,585 passed; DB suites (5 files, 90 tests) under both roles; independent review approve with
  nits, nits applied.

## Security finding raised by this round

Sign-out could be undone by a response already in flight (the token stayed valid after sign-out). Fixed separately:
single-session revocation, PR #88 (`docs/readiness/SIGNOUT-SINGLE-SESSION-2026-11-16.md`).

## R8-0 — production connection timeout: UNRESOLVED

One production health check on 14 Nov 2026 failed with "Connection terminated due to connection timeout": a new
database connection did not complete within the 10 s connect timeout. That message is not pool exhaustion. Not caused
by category code; any route needing a new connection at that moment would fail the same way. Hypotheses (Neon compute
start after suspend; network blip) need the Neon console for that time — Noe's read. On the test branch, a connection
after 7 idle minutes took 2.2–2.6 s from Bali, nowhere near 10 s. No change made; raising the timeout is excluded by the
brief.

## Not measured

Production timings; function invocations per page view (Vercel Observability); behaviour under concurrent load.
