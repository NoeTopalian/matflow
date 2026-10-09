# Advisory register: MatFlow

Owner: security campaign lane E (supply chain and infrastructure). **Advisory-check date: 9 Oct 2026, ~10:40–11:10 UTC.**
Candidate `2a6487e` (source and lockfile identical to the tested build `c837e38`; see evidence E-01). Production
today runs `e8afb6a` (4 Oct), which has a different lockfile, so its versions are listed separately.
Evidence folder: `docs/security/evidence/E/`.

Sources: `npm audit` (GitHub Advisory Database via the npm registry), OSV querybatch over every unique lockfile
package@version (1,138), GitHub advisory pages linked by npm, NVD CVE API 2.0 (CPE virtual match), nodejs.org release
schedule and security-release posts, and the bundled-library manifest `@img/sharp-*/versions.json`. CISA KEV was
**not** consulted in this pass (no KEV correlation performed; the proposed daily job is the place for it). An empty
result from any one source is not proof of absence: NVD's CPE backlog leaves recent CVEs unmapped.

Status vocabulary: applicability APPLICABLE / NOT APPLICABLE WITH EVIDENCE / UNKNOWN; verification NOT RUN / FAIL /
FIXED AWAITING RETEST / PASS / BLOCKED. NOT APPLICABLE is not PASS.

## Snapshot
| Tree | npm audit | OSV | Command |
|---|---|---|---|
| Candidate, production deps (`--omit=dev`) | 2 (mysql2 high, prisma moderate; same chain) | mysql2 (2 ids) | `npm audit --omit=dev --json` → `npm-audit-omit-dev-2026-10-09.json` |
| Candidate, all deps | 11 packages (1 moderate, 10 high): mysql2/prisma + the braces → micromatch → fast-glob chain under eslint-config-next, shadcn, ts-morph | braces (dev), mysql2 | `npm-audit-all-2026-10-09.json`, `osv-lockfile-2026-10-09.json` |
| Production e8afb6a (from `git show e8afb6a:package-lock.json`) | not re-run; versions affected by ADV-04..07 | n/a | — |

## Register
| ID | Package / product (exact version) | Advisory (verified id) | Affected → fixed (source) | Necessary configuration / reachable path | Applicability | Verification | Remediation / owner |
|---|---|---|---|---|---|---|---|
| ADV-01 | mysql2 **3.15.3** (pinned exactly by prisma 7.10.0; build chain) | GHSA-3f6p-5ww8-9rcr: auth-plugin downgrade to `mysql_clear_password` leaks the plaintext password | < 3.22.0 → **3.22.0** (OSV/GHSA) | The client must connect to a hostile MySQL server. The only loader is the Prisma Studio MySQL executor (`prisma/build/cli.js`, dynamic `import("mysql2/promise")`). Not in any runtime trace. `prisma --version/validate/generate` load 0 mysql2 files (load trace with positive control) | NOT APPLICABLE WITH EVIDENCE (runtime and traced build commands). **Present in the build chain** | PASS for "not loaded" (E-02). `migrate deploy` not traced (needs a DB) | npm `overrides: { "mysql2": "^3.24.5" }`, simulated: audit → 0. Lead decides (changes lockfile, so gates re-run). Exception in `supply-chain-check.mjs` expires **2026-11-09** |
| ADV-02 | mysql2 3.15.3 | GHSA-rgwj-5xj2-c3m3: unbounded zlib inflate in the compressed protocol (decompression-bomb DoS) | ≤ 3.23.0 → **3.23.1** (OSV) | As ADV-01 | NOT APPLICABLE WITH EVIDENCE | PASS (as ADV-01) | As ADV-01 |
| ADV-03 | prisma 7.10.0 (CLI) | inherits ADV-01/02 (npm "via mysql2") | npm suggests prisma 6.19.3, a major downgrade | — | as ADV-01 | — | Downgrade **rejected** (breaks Prisma 7 config, adapter and query compiler). Prisma 8 (rc) drops mysql2 |
| ADV-04 | next: candidate **16.3.8**; production e8afb6a **16.3.3** | GHSA-vcvr-r3jv-pc5j (critical, RCE in `next/og` ImageResponse, ≥16.2.0 <16.3.6); GHSA-cjq9-62q9-8jv4 (high, SSRF in Image Optimization, <16.3.8); GHSA-3w37-wq28-93x7, -4jqv-mc3x-m676, -mcj8-r9mp-w47p, -f87g-xv8r-7p7x (moderate); -39w2-rjm5-chcv (low) | all fixed at **16.3.8** (npm advisory ranges) | `next/og`/`ImageResponse`, `use cache`/`draftMode`, metadata image routes (`opengraph-image`, `icon.tsx`): **none in app/, lib/, components/ at 2a6487e or e8afb6a**. Image optimiser: no `images` config (no remote patterns). On Vercel the optimiser is the platform service | Candidate: fixed (0 npm/OSV hits for next@16.3.8). Production 16.3.3: critical RCE NOT APPLICABLE WITH EVIDENCE (feature unused). Image-optimisation SSRF **UNKNOWN** on Vercel. The cache-poisoning items are stated "self-hosted" by the advisory, but that was not verified per item | Candidate PASS (version). Production FAIL (version) until the push | Ship the candidate (release decision). The 63 old deployments also run ≤16.3.3 (E-04) |
| ADV-05 | sharp: candidate **0.35.5** (libvips 8.18.7, sharp-libvips 1.3.4); production **0.35.4** (sharp-libvips 1.3.3) | GHSA-wq5f-xc86-pv6w: librsvg CVE-2026-96889 bundled in sharp | < 0.35.5 → **0.35.5** (npm) | librsvg runs only for SVG input. `/api/upload` admits only PNG/JPEG/WebP by declared type **and** magic bytes, and libvips selects the loader by content, so SVG is unreachable | NOT APPLICABLE WITH EVIDENCE (both builds) | PASS (code review, E-03 §3). No fuzz run | Candidate already fixed |
| ADV-06 | undici: candidate **6.29.0**; production 6.28.0 (via `@vercel/blob`) | GHSA-rfgv-xxqx-mfg5 (high, WebSocket subprotocol DoS), GHSA-3wwx-pv8p-q78v (moderate, permessage-deflate DoS), GHSA-r53p-7pc4-xj5r (low, retry-interceptor response splitting) | fixed **6.28.1** (npm) | WebSocket is not used. `@vercel/blob` issues HTTPS requests to Vercel Blob only | Candidate fixed. Production: low (WebSocket paths unused; retry interceptor not configured by app code, not verified inside `@vercel/blob`) | Candidate PASS (version) | Ship the candidate |
| ADV-07 | proxy-addr 2.0.8, ip-address 10.7.3, source-map-js 1.2.2, brace-expansion 5.0.12, @modelcontextprotocol/sdk 1.32.1 (candidate) | GHSA-jqcg-44mw-7w3h (critical), GHSA-rpw4/2vr4/j6r3/h3mg (moderate), GHSA-68fv-2mgg-jv7q (high), GHSA-q2hr/qhr7/6j4f (brace-expansion), GHSA-6qxp-vccf-f47h (high) | all at or above fixed versions in the candidate lockfile; proxy-addr, ip-address and the MCP sdk are now **dev-only** (shadcn moved to devDependencies) | Build tooling (shadcn CLI, source maps); not in runtime traces | Candidate: fixed or not shipped | PASS (lockfile versions; npm/OSV 0 hits) | — |
| ADV-08 | braces **3.0.3** (dev: shadcn CLI, eslint-config-next via fast-glob/micromatch) | **GHSA-vfj7-8cjw-p6xm / CVE-2026-93687**: stack-exhaustion DoS through deeply nested patterns | last_affected 3.0.3; **no fixed version** (OSV, modified 2 Oct 2026) | Patterns come from repository config (lint globs, shadcn components), never from users. Not in runtime traces | NOT APPLICABLE WITH EVIDENCE (dev tooling, trusted input) | PASS (scope evidence) | Wait for an upstream fix. Re-checked by the daily job |
| ADV-09 | libvips **8.18.7** (sharp-libvips 1.3.4) | **CVE-2026-2913** (CVSS 3.1 2.5): heap overflow in `vips_source_read_to_memory` | ≤ 8.19.0 (NVD); fix commit a56feec | Upstream says it affects only custom seekable sources > 4 GiB. The app passes a ≤ 4 MB Buffer | NOT APPLICABLE WITH EVIDENCE | PASS (code review) | Take a sharp release bundling libvips > 8.19.0 when available |
| ADV-10 | Bundled native libs (libpng 1.6.58, libwebp 1.6.0, mozjpeg 0826579, libexif 0.6.26, lcms 2.19.1, zlib-ng 2.3.3, glib 2.90.0, highway 1.4.0; unreachable: tiff 4.7.2, heif 1.23.5, aom 3.15.1, rsvg 2.63.2, cairo, pango, xml2 2.15.4, expat 2.8.5, freetype, harfbuzz, fontconfig, archive) | NVD CPE match: 0 for all, except aom → CVE-2021-30473/30474/30475 via a date-style CPE (`< 2021-04-07`), a **false positive** | — | Reachable from `/api/upload` (any signed-in member, ≤ 4 MB): png, jpeg, webp, exif, lcms, zlib-ng, glib, highway | APPLICABLE surface; **no known applicable advisory** | NOT RUN beyond lookups (no fuzzing). NVD backlog limits confidence | Daily advisory job. Lane D/F to bound pixel count (`limitInputPixels`) (SEC-051/073) |
| ADV-11 | Node.js **25.9.0** (developer machine: all local scripts, rehearsal builds, `vercel`/`gh`/`prisma` CLIs) | June 2026 release (e.g. CVE-2026-48618 high, TLS wildcard depth authentication bypass; CVE-2026-48615/48619/48928 medium) and July 2026 release (CVE-2026-56846, CVE-2026-56848 high, HTTP/2; CVE-2026-56850 medium; CVE-2026-58039/58040 and more) | Fixed only in 22.23.x / 24.17.0+ / 24.18.1 / 26.3.1 / 26.5.1. **v25 EOL 2026-06-01, no fix** (nodejs.org) | Local CLIs and scripts make outbound TLS and HTTP/2 connections (Vercel, GitHub, Neon) | APPLICABLE (developer endpoint, SEC-064/094) | FAIL (EOL) | Install Node 24 LTS locally, matching Vercel. Add `engines` / `.nvmrc` |
| ADV-12 | Node.js on Vercel (**24.x**, exact patch chosen at build) and CI (**22**, latest at run) | The same June/July 2026 releases | 24.17.0 / 24.18.1 fix them | All server-side TLS and HTTP | **UNKNOWN** for the production build (patch level not read). CI: patched (setup-node resolves the latest 22.x) | BLOCKED for lane E (build log is lead-only) | Lead reads the Node version in the production build log, or pins `engines.node: ">=24.18.1 <25"` |

## Deployed versus candidate
The serving production deployment (`e8afb6a`) and the 63 retained old deployments (E-04) carry the pre-fix versions
of ADV-04..07. Only ADV-04's image-optimisation SSRF (UNKNOWN on Vercel) and ADV-06 (low) remain plausibly
applicable there. The rest are NOT APPLICABLE WITH EVIDENCE by feature non-use. Shipping the candidate and deleting
the old deployments closes the version exposure.

## How this register is kept current
- `node scripts/readiness/supply-chain-check.mjs --audit --osv`: lockfile policy plus both advisory sources; exceptions
  expire (the current ones lapse on 2026-11-09).
- `.github/workflows/security-supply-chain.yml` (PROPOSAL, **not running**: it exists only on the unpushed branch)
  runs it on every PR and daily.
- Re-open any row when the lockfile, Node version, libvips bundle or upload path changes.

## Iteration 2 addendum (lane E2, 9 Oct 2026, 17:30–17:50 UTC)
- **ADV-12 update.** The serving build log (`vercel inspect --logs`, fetched 17:30 UTC; build of 2026-10-04T02:32) does
  not print the Node patch version. Read-only observations: project Node `24.x`, functions `nodejs24.x`, build image
  Vercel CLI 62.1.0 (`evidence/E2/build-log-extract-e8afb6a.txt`). Status stays **UNKNOWN** for the patch level; HEAD
  now pins `engines.node ">=24.18.1 <25"`, so the next build is constrained to a patched 24 line. E2 test evidence ran on
  Node v24.21.0.
- **Install scripts (SEC-060 note).** In the serving build npm reported five dependency install scripts "not yet covered
  by allowScripts" (@prisma/engines, @sentry/cli, msw, prisma, unrs-resolver) and did not run them; only the root
  `postinstall` ran. This narrows, for that build, the "Vercel runs install scripts with production env" concern in E-03.
  Earlier builds were not checked; the behaviour depends on the npm version in the build image and is not pinned.
- No new package advisory was evaluated in this pass (no lockfile change by lane E2).
