# E-03 Native code, Node runtimes and install scripts (SEC-050, SEC-057, SEC-058, SEC-060, SEC-064)

Lane E, 9 Oct 2026. Candidate 2a6487e, lockfile ddf84f4. Sources are the lockfile, the installed `node_modules`, the
certified build's `.nft.json` traces (BUILD_ID xP9P9cHvx9xkgqHPXnOa9), `vercel project inspect`, the nodejs.org release
schedule and security posts, NVD CVE API 2.0 and OSV.

## 1. Node.js: three different majors
| Where | Version | Status on 9 Oct 2026 | Evidence |
|---|---|---|---|
| Vercel build and runtime (production) | **24.x** (project setting; the exact patch is chosen by Vercel at build time) | LTS ("Krypton"), maintenance from 2026-10-20, EOL 2028-04-30. The latest 24.x is 24.21.0; the last 24.x security release is 24.18.1 (July 2026) | `vercel project ls` / `vercel project inspect` → `Node.js Version 24.x`; `nodejs/Release/schedule.json`; `nodejs.org/dist/index.json` |
| GitHub Actions CI and nightly e2e | **22** (`actions/setup-node`, `node-version: 22`) | LTS ("Jod"), maintenance, EOL 2027-04-30. The latest security release is 22.23.2 | `.github/workflows/ci.yml`, `e2e.yml` |
| Local developer machine (runs every readiness script, rehearsal build, operator script, `vercel`/`gh`/`prisma` CLI) | **25.9.0** | **EOL since 2026-06-01** (odd line). It received **neither** the June 2026 security release (fixed in 22.23.0 / 24.17.0 / 26.3.1, e.g. CVE-2026-48618 high, TLS wildcard depth authentication bypass) **nor** the July 2026 release (22.23.2 / 24.18.1 / 26.5.1, e.g. CVE-2026-56846 and CVE-2026-56848 high, HTTP/2). | `node -v`; nodejs.org/en/blog/vulnerability/june-2026-security-releases and july-2026-security-releases |
`package.json` has no `engines` field, and there is no `.nvmrc` or `.node-version`. Nothing ties the three together, so
"tests passed" (Node 22 in CI, Node 25 locally) is not evidence about the runtime that ships (Node 24).
NVD's CPE data for `node.js:25.9.0` and `24.18.1` returns only two 2021/2022 Next.js CVEs (CPE noise). The 2026 Node
CVEs are not CPE-mapped yet, so the vendor posts are the primary source here, not NVD.
**Findings:** E-F1 (local EOL Node 25, developer endpoint, SEC-064/SEC-094). E-F2 (no engines pin; CI, runtime and local
differ, SEC-088). Whether Vercel picked a 24.x at or above 24.18.1 for the 4 Oct production build is **UNKNOWN**: the
build log is read-only lead territory.

## 2. Native and platform binaries in the lockfile (136 os/cpu-restricted entries, 11 families)
| Family | Version | Scope | Where it executes | Untrusted input reachability |
|---|---|---|---|---|
| `sharp` + `@img/sharp-<platform>` (15) | 0.35.5 | prod | **Runtime**: `/api/upload` (`app/api/upload/route.ts`) and Next's `next-server` image optimiser trace | **Reachable** (section 3) |
| `@img/sharp-libvips-<platform>` (10) | 1.3.4 → libvips **8.18.7** | prod | runtime (linux-x64 on Vercel) | as above |
| `@next/swc-<platform>` (8) | 16.3.8 | prod/optional | build only (compiler) | source code only (trusted) |
| `@prisma/engines` schema-engine binary | 7.10.0 (engines hash 0edf323e…) | prod | **build**: `prisma migrate deploy` in `npm run build` on Vercel, holding production DATABASE_URL | migrations from the repo only. Downloaded by a **postinstall** from Prisma's CDN, outside lockfile integrity |
| `@sentry/cli` + `@sentry/cli-<platform>` (8) | 2.58.6 | prod (via `@sentry/nextjs`) | install time only. `next.config.ts` does not wrap with `withSentryConfig` and no `SENTRY_AUTH_TOKEN` exists, so the binary is never invoked | none. Postinstall `node ./scripts/install.js` |
| `@napi-rs/lzma` | 1.5.1 | prod/optional (Prisma dev tooling) | not traced into runtime | none |
| `@rollup/rollup-*` (25) | 4.62.4 | prod/optional (build tooling) | build/test | none |
| `@tailwindcss/oxide-*`, `lightningcss-*` | 4.2.1, 1.31.1/1.33.0 | dev | build (CSS) | none |
| `@rolldown/binding-*`, `@unrs/resolver-binding-*` | 1.2.4, 1.11.1 | dev | test/lint | none |
| `fsevents` | 2.3.2/2.3.3 | optional/dev | macOS only | none |
Install scripts in the lockfile: `@prisma/engines`, `prisma`, `@sentry/cli`, `fsevents`, `unrs-resolver` (dev). All
1,173 entries resolve from `https://registry.npmjs.org/` with `sha512-` integrity. No git, file, link or tarball URLs.
The local tree also holds `node_modules/.better-sqlite3-0HnbaUXl/build/Release/better_sqlite3.node`, a leftover npm
staging directory for a package that is **not in the lockfile**. It is local only (Vercel installs clean), but it is
an untracked native binary on the developer machine. **E-F3**: recommend `npm ci` to rebuild `node_modules`.

## 3. sharp/libvips reachability (SEC-050, SEC-064)
- Who can reach it: `POST /api/upload`. Purposes `profile-pic`/`member-photo` are open to **any signed-in member for
  their own record** and to staff of the member's club. Every other purpose is owner-only. Same-origin check first.
- Input bounds before libvips: `file.size` ≤ 4 MB; declared type ∈ {png, jpeg, jpg, webp}; magic bytes must match the
  declared type. libvips picks its loader by content, so with a PNG/JPEG/RIFF-WEBP header **only the
  pngload/jpegload/webpload loaders** are reachable (libspng/libpng 1.6.58, mozjpeg 0826579, libwebp 1.6.0). Also
  reachable: libexif 0.6.26 (`.rotate()` reads EXIF orientation), lcms 2.19.1 (embedded ICC), zlib-ng 2.3.3, glib
  2.90.0, highway 1.4.0 and the libwebp encoder. **Not reachable** from this route: tiff, heif/aom, rsvg/cairo/pango,
  gif (cgif), archive, xml2/expat (SVG), fontconfig/freetype/harfbuzz.
- Call: `sharp(buffer).rotate().resize(512|1600…).webp().toBuffer()` with default options. sharp's default
  `limitInputPixels` (268,402,689 px) applies and `failOn` defaults to `warning`. A 4 MB PNG can declare up to the
  pixel limit, so **memory and CPU per request are bounded only by the default pixel limit and the function memory**.
  Handed to lane F/D as SEC-051/SEC-073 (decompression bomb). Not tested here.
- `/_next/image`: there is no `images` config, so no remote patterns. In Next 16, local sources with query strings
  are refused unless `images.localPatterns.search` is configured (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md`
  "Local Images with Query Strings"), so `/api/blob-image?…` cannot be fed to the optimiser. On Vercel the optimiser is
  the platform service, not this function. That is from Vercel's documentation and not re-verified here (UNKNOWN at
  test level).
- Advisories for the bundled versions (NVD CPE match, 9 Oct, `nvd-native-and-node-2026-10-09.json`): libvips 8.18.7 →
  **CVE-2026-2913** (CVSS 2.5; heap overflow in `vips_source_read_to_memory`; affected ≤ 8.19.0; upstream says it only
  affects custom seekable sources > 4 GiB). Our path passes a ≤ 4 MB Buffer, so **NOT APPLICABLE WITH EVIDENCE**. aom
  3.15.1 matched three 2021 CVEs through a date-style CPE range (`< 2021-04-07`). That is a false positive, and aom is
  unreachable anyway. libpng 1.6.58, libwebp 1.6.0, libexif 0.6.26, lcms 2.19.1, libxml2 2.15.4, expat 2.8.5, libtiff
  4.7.2, libheif 1.23.5, librsvg 2.63.2, glib 2.90.0, freetype, harfbuzz, cairo, fontconfig, pango, pixman, zlib-ng,
  libarchive: **0 CPE matches**. NVD's analysis backlog means 0 matches is **not proof of absence**. OSV has no hit for
  `sharp@0.35.5`.
- Verdict: native image parsing is **APPLICABLE** (reachable by any member). No known applicable unfixed advisory at
  the bundled versions as of 9 Oct 2026. The residual risk is an unknown or unpublished libvips/libpng/libjpeg/libwebp
  bug, and it is bounded by the 4 MB input and the 3-loader restriction. The daily advisory job proposed in
  `.github/workflows/security-supply-chain.yml` re-checks this.

## 4. Commands (all exit 0 unless stated)
`node -e …package-lock analysis` · `find node_modules -name "*.node" -o -name "*.exe"` ·
`node <scratchpad>/security/E/nft-scan.mjs .next` · `cat node_modules/@img/sharp-win32-x64/versions.json` ·
`vercel project ls` / `vercel project inspect matflow` (read-only) · `curl raw.githubusercontent.com/nodejs/Release/main/schedule.json` ·
`node <scratchpad>/security/E/nvd.mjs` · `node scripts/readiness/supply-chain-check.mjs --audit` (exit 0; violations []).
