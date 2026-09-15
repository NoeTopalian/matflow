# Deep Dive Trace: ui-rules-and-hosting

**Date:** 2026-08-15 · **Method:** /deep-dive, 5 read-only lanes + surface map + git archaeology · **Full lane reports:** session scratchpad (`ui-explore.md`, `ui-lane1.md`, `ui-lane2.md`, `ui-lane3.md`, `infra-lane4.md`, `sec-mem-lane5.md`); load-bearing facts reproduced here.

## Observed Result

Noe asked for (a) a thorough UI assessment feeding an "ultimate UI rules file", and (b) an assessment of whether the hosting is appropriate for multiple clubs — efficiency, memory, security included.

## Ranked Hypotheses

| Rank | Hypothesis | Confidence | Evidence Strength | Why it leads |
|---|---|---|---|---|
| 1 | **UI drift is caused by absent/unenforced shared scaffolding, not developer indiscipline.** The design system exists on paper (48KB `docs/design.md`, real token layer) but was never wired into the code path: the only shadcn primitive has 0 importers vs 459 raw `<button>`s; no Card/Dialog/Table/Input/Form primitive exists at all; CLAUDE.md never mentions the design doc. | High | Strong | Control case is decisive: wherever exactly one mechanism existed with no competitor (lucide icons — 70 files; Toast — 16 importers), consistency is near-perfect. Ambiguity + absence, not culture. |
| 2 | **A deliberate but unfinished dark→light migration accounts for the worst visible breakage.** Git: Apr 26 "revert to dark theme" created `darkTheme`; Jun 10 the light palette landed buried in an unrelated bundle commit (487f70c); Jun 25 was already patching fallout ("light-theme header… invisible", 3553f73). `docs/design.md` untouched since 14 May — its colour system is now inverted vs shipped CSS. | High | Strong | Live bugs, not drift: white-on-white skeletons/scrollbars/glass (`globals.css:293,297,319,169`), white toast text on light surfaces (`Toast.tsx:74`), member `loading.tsx` white bars on `#111111`, hard-dark staff mobile header on light body. |
| 3 | **UX reality: three of four weekly member screens are sale-ready; the specific failures are honesty and access, not ugliness.** Home/Schedule/Kiosk are genuinely well built (bottom nav, 44px targets, dvh, swipe, keystroke-aware kiosk idle reset, uniformly British copy). The gaps: Profile fabricates a member's life; PWA is fiction; HTTP errors render as empty states; zoom disabled. | High | Strong | Two of three "known" bugs handed to the lane were already fixed in-tree (manifest start_url, progress-page DEMO flash) — the folklore is stale; the remaining defects are enumerable. |
| 4 | **Hosting: platform appropriate, code cost-model not, beyond ~5 clubs.** Vercel lhr1 + Neon eu-west-2 colocation and strong composite tenant indexes are right; but every read is an interactive transaction (~4 round-trips; 296 sites), kiosk check-in ≈25–30 round-trips across 7–9 transactions, zero server-side caching, sequential 300s-capped cron/bulk-invite, invocation-per-avatar blob proxy, client-side member-home waterfall (5–6 invocations per open). P2028 contention already observed at ~1 club and papered over by raising timeouts. | High | Strong | UK clubs share `Europe/London` — 18:00–20:00 is a synchronised thundering herd; concurrency, not volume, is the binding constraint. |
| 5 | **Security/memory: adequate for a 25-club launch, conditionally.** Disciplined app-layer tenant filters (20+ route sample, no IDOR), strong token/session hygiene, bounded queries, singleton Prisma, self-pruning module state. Conditions: prod role has BYPASSRLS (RLS decorative), `unsafe-inline` CSP, admin v1 shared-secret cookie, blob-image proxy lacks tenant check. | Medium-High | Strong (security) / High (memory) | No launch blocker found; one structural fix (restricted DB role) dominates. |

## Rebuttal Round

**Lane 4 vs Lane 5 on RLS.** Lane 4 credited RLS as "a real per-tenant backstop" (policies + transaction-local `set_config`, `lib/prisma-tenant.ts:43-47`). Lane 5 refuted it: prod `DATABASE_URL` uses `neondb_owner` (BYPASSRLS), and `scripts/create-restricted-role.ts` exists precisely to fix this but targets only the test branch. **Lane 5 wins** — the machinery is real, the enforcement is not.

**Synthesis insight (worst of both worlds):** the app pays the full RLS tax — BEGIN + `set_config` + COMMIT wrapping all 296 tenant reads, the root cause of Lane 4's A1 round-trip amplification — while getting zero RLS protection because the role bypasses policies. Either flip prod to the restricted role (making the cost buy something) or the wrapper is pure overhead. The plan does the former AND batches transactions to cut the tax.

## Convergence / Separation Notes

- Lanes 1, 2 and the surface map converged on one mechanism and are merged as Hypothesis 1: *each surface was built in a different era against a different (or absent) foundation; no shared layer was ever extracted; the de-facto styling API became inline style + hardcoded hex* (2,433 inline style props, 881 hex literals, 4 competing token systems, 5 navs, ~30 modals in 6 conventions, `hex()` copy-pasted 20-23×).
- Hypothesis 2 (unfinished migration) is a separable, dateable event layered on top of H1 — fixing it is a bug sweep, not a design programme.
- Lane 3 bounds the blast radius: this is not a redesign; it is scaffolding + a defect list.

## Per-Lane Critical Unknowns (and how they were resolved)

- **Lane 1/2 (shared):** Was the dark→light flip deliberate? Is `button.tsx` in-flight or abandoned? → **RESOLVED by git probe:** flip deliberate (Jun 10) but never completed; doc contract broken (design.md stale since 14 May while globals.css changed); `button.tsx` untouched since the 7 Mar initial commit = abandoned scaffolding.
- **Lane 3:** Has any PWA install ever succeeded? → Effectively resolved from source: `public/icons/` does not exist (both manifest icons 404), Serwist is not in package.json, no SW registration anywhere. `CLAUDE.md:4` "PWA via Serwist" is false. Runtime confirm (curl the icon URLs on prod) listed as probe.
- **Lane 4:** What is the actual prod `DATABASE_URL` (pooler? `pgbouncer=true&connection_limit=1`?) and is Fluid Compute on? → **OPEN — the single highest-value 5-minute user probe.** Repo signals contradict: `.env` uses the non-pooler host with no params; `.env.local`/`.env.test` use `-pooler`.
- **Lane 5 (security):** Are there stored-XSS sinks `unsafe-inline` would fail to contain? → OPEN; note `app/member/layout.tsx:203` injects styles via `dangerouslySetInnerHTML` already. Grep sweep is in the plan.
- **Lane 5 (memory):** Does the 20-query report transaction hold under 25-club concurrency? → folded into Lane 4's load probe.

## Most Likely Explanation

MatFlow's UI problem is a **governance failure, not a design failure**: a good written design system and token layer were never wired into the always-loaded context (CLAUDE.md), never turned into importable primitives, and were then contradicted by a half-finished, bundle-committed dark→light migration — so every feature independently re-derived styling, and the shared pieces that do exist rotted (0-importer Button/Skeleton, doc inverted vs CSS). The hosting problem is the mirror image: right platform, wrong per-request cost model — transaction-per-read amplification + zero caching + synchronised UK evening peaks — with the added irony that the RLS tax being paid on every read buys nothing because the prod role bypasses RLS.

## Recommended Discriminating Probes (user, ~15 min total)

1. **Vercel dashboard → prod `DATABASE_URL`**: must be the `-pooler` host with `pgbouncer=true&connection_limit=1`; also check whether Fluid Compute is enabled (inverts the correct `connection_limit`). If the pooler is absent, that is the multi-club answer and a one-line fix.
2. **`SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user;`** against prod (read-only) — confirms RLS is decorative.
3. **`curl -I https://<prod>/icons/icon-192.png`** — expected 404; converts "PWA unpolished" into "PWA never worked".
4. Logged in as a member, open `/member/profile` — expected: "Alex Johnson"/"Total BJJ" flash then fabricated milestones ("Awarded by Coach Mike", "UKBJJA Nottingham Open — Bronze"). Confirms the P0.
