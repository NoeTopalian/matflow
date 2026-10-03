# Sean Coates / Total BJJ — handover verification, 3 October 2026

Secret-free evidence record for the first real handover: owner access, reconciled TeamUp membership data, the promised CSV exports. Everything here is either observed (with where and how) or marked as not yet proven. Credentials, recovery codes and member personal data never appear in this file.

Verdict vocabulary: **READY FOR SEAN** (mechanism proven, no open P0/P1 for this handover) · **BLOCKED** (named missing input or check) · **ACTIVATED** (Sean himself completed password + MFA login — reserved, not ours to claim).

## 1. Current state, established before any further write

| Fact | Evidence |
| --- | --- |
| Production URL | `https://matflow.studio` — `/api/health` 200 `{"status":"ok","db":"ok"}` at 2026-10-03T06:58Z |
| Deployed SHA | `d5cd255aff054ad1e11ee8b596644739297e6520` — GitHub deployment 6823876483, environment Production, state `success`, created 2026-10-03T05:43:36Z (Vercel → GitHub deployments API). No route exposes the SHA; this is the deployment metadata |
| `origin/main` | `d5cd255` — equal to the deployed SHA |
| Local HEAD at start | `0f8dff5` = `d5cd255` + `scripts/wipe-totalbjj-demo-data.mjs` (the one-shot that was run; not deployed, not needed in production) |
| Worktree | clean apart from `.omc/` session state |
| Pending migrations | none beyond the deployed candidate at start; this work adds any it needs and they are listed in §3 |
| Club | tenant `totalbjj`, id `cmucpxc4c0000uctgouza06aj`, name "Total BJJ" (`/api/tenant/totalbjj` 200). This is Sean's real club since the 3 Oct wipe. Iron Path BJJ (`ironpathbjj`) remains the demo and is untouched |
| Anonymous gating | `/dashboard` → 307 `/login`; `/api/members` → 401 (observed 3 Oct) |
| `TESTING_MODE` / `DEMO_MODE` in production | `DEMO_MODE=true` would throw at boot on `VERCEL_ENV=production` (`auth.ts:53`) and production boots; `TESTING_MODE=true` is ignored there (`auth.ts:58`). So no bypass is live. Vercel's env list itself was not readable from this session (CLI not logged in) |
| Owner account after the wipe | one `User` on the tenant, role owner, provisional login identifier `sean.coates@totalbjj.co.uk`, TOTP cleared. Mailbox ownership of that address is **not established** and it is not treated as verified. The wipe did **not** bump `sessionVersion`, did **not** clear `totpRecoveryCodes`, did **not** set `mustChangePassword` (script read, `scripts/wipe-totalbjj-demo-data.mjs:156-167`) — see §2 |
| Import state | the most recent upload history on production ended with failed Generic previews (operator-side evidence, 3 Oct morning). **No TeamUp import has been committed.** No tiers exist. Production DB reads are refused to this session, so the live counts are to be re-read by the operator with `scripts/readiness/tenant-state.mjs` (read-only, aggregates) before the import |
| Retained from the demo era | the tenant row keeps `displayTokenHash` / `kioskTokenHash` if they were ever minted (the old leaderboard link resolved to this tenant on 3 Oct). Operator action: Settings → Display → **Disable** (or Regenerate) and Settings → Kiosk likewise, before Sean's data goes in. Both are audited owner actions (`app/api/settings/display/route.ts`) |

### Source file controls (independent parser, not the importer's)

File `report-download-hdJocCUxn3aEXNGBdg22Dc.csv`, SHA-256 `90693f95228db57f39b9fd596e694fa62b57107fd63b6aa546a9275bf0aaed22`, 266,080 bytes, BOM + CRLF, 26 columns, 1,082 data rows, no embedded newlines, all dates `YYYY-MM-DD`. Script: `.omc/scratch/teamup-controls-independent.mjs` (RFC-4180 state machine written for this check; aggregates only).

| Measure | Expected | Observed |
| --- | ---: | ---: |
| Membership data rows | 1,082 | **1,082** |
| Provisional name/email groups | 708 | **708** |
| Active rows / groups with active | 302 / 298 | **302 / 298** |
| Groups with two active rows | 4 | **4** |
| Shared non-blank emails / groups sharing | 78 / 172 | **78 / 172** |
| Missing-email rows / groups | 15 / 5 | **15 / 5** — of which **8 rows are "(deleted customer)" rows**; the remaining 7 are the figure the old controls script reported. Both are right under their own definition; the brief's 15 is the raw count |
| Exact duplicate excess rows | 3 | **3** |
| Distinct plan labels | 20 | **20** (0 whitespace oddities, 0 case-insensitive collisions) |
| Statuses | active 302 · hold 22 · cancelled 505 · completed 163 · upgraded 60 · downgraded 30 | **identical** |
| Rows starting after 2 Oct 2026 | 2 | **2** |
| Rows with blank date of birth | — | 136 |

File modification time 2026-10-02T11:27:24Z (12:27 BST). **This is the file's save time, not an export timestamp; TeamUp writes no export time into the file.** It remains provisional until Sean states the real time (§3).

## 2. Owner account — activation order and revocation

_To be completed from specialist A's evidence._

## 3. Import entry point, source time, mapping, reconciliation

_To be completed from specialist B's evidence._

## 4. Family authority and external billing

_To be completed from specialist C's evidence._

## 5. Exports, reconciliation route, recovery

_To be completed from specialist D's evidence._

## 6. Checks run

_Recorded separately as passed / failed / retried / skipped / not run, with SHA and environment._

## 7. Verdict

_Pending._
