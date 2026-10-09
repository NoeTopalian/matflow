# D-02 Files, image decoding and CSV (SEC-049, SEC-050, SEC-051, SEC-052)

Lane D, 9 Oct 2026. sharp 0.35.5 / libvips 8.18.7 (`node -e "require('sharp').versions"`). Native inventory: lane E E-03.

## SEC-049 Upload types and serving (code review + unit). PASS with proposals
Writers to Blob (all `access: "private"`):
| Writer | Accepted | Check | Stored as |
|---|---|---|---|
| `app/api/upload` (photos, branding) | png, jpeg, webp, 4 MB | declared type in the allowlist AND magic bytes match it. libvips decodes by content, and every image is RE-ENCODED to WebP | `image/webp` (polyglots and EXIF are dropped by the re-encode) |
| `app/api/initiatives/[id]/attachments` | png, jpeg, webp, pdf, 10 MB | allowlist + magic bytes | declared type (never svg/html, because only allowlisted types pass) |
| `lib/waiver-signature-upload.ts` | server-generated PNG | — | `image/png` |
| `app/api/onboarding/csv-handoff`, `app/api/admin/import/upload`, `lib/import-storage.ts` | CSV, owner-only, 10 MB | type/extension + sniff | `text/csv` |
Serving is `app/api/blob-image` only. Path must be under `tenants/<session tenant>/`. Members are limited to blobs that a row
of theirs (or a confirmed child's) references, and are refused `imports/`. The response is `image/*` inline, everything else
`application/octet-stream` + `attachment`, always `nosniff`.
Unit evidence: `tests/unit/sec-d-image-bounds.test.ts` "type confusion" (svg/gif/tiff/html bodies fail every magic
check). Proposals (not lane D files): (P1) `blob-image` should allow-list `image/png|jpeg|webp` for inline rather than
`image/*`, so that a future writer of `image/svg+xml` cannot become same-origin script. No current writer stores SVG, so this is
defence in depth. (P2) `/api/upload` has no rate limit (see SEC-051).

## SEC-050 / SEC-051 Decoder bounds: measured with tiny, bounded fixtures (no real bomb)
`tests/unit/sec-d-image-bounds.test.ts` runs the route's exact pipeline
(`sharp(buf).rotate().resize(1600,1600,{fit:"inside",withoutEnlargement:true}).webp({quality:82})`). Fixtures are 1-bit
greyscale PNGs built in memory. The largest DECODED is 8192² (67 MP). Anything over a limit is header-checked only.
| Case | Input bytes | Pixels | Result | Time | RSS growth |
|---|---:|---:|---|---:|---:|
| header 20000² (400 MP) | 68 | 400 M | refused "Input image exceeds pixel limit" | 7 ms | 1 MB |
| header 16000² (256 MP) | ~70 | 256 M | **passes the header check** (under the default 268,402,689) | — | — |
| decode 2048² | 590 | 4.2 M | ok | 170 ms | 22 MB |
| decode 4096² | 2,116 | 16.8 M | ok | 215 ms | 30 MB |
| decode 8192² | 8,229 | 67.1 M | ok | 396 ms | 60 MB |
| estimate at the default limit (linear, NOT measured) | ~33 KB | 268 M | — | ~1.6 s | — |
| proposed `limitInputPixels: 50_000_000`, 8192² header | — | 67 M | refused before decode | 1 ms | 0 |
Decompression ratio is about 8,000 pixels per input byte (deflate of 1-bit rows). The 4 MB body cap does not bound work. The
default pixel limit does. Verdict: **APPLICABLE, bounded, Low.** Any signed-in member (own photo) can make one request decode up to
268 MP. Measured libvips streaming keeps memory modest, and CPU is estimated at ~1.6 s/request on this machine. There is no rate limit on
`/api/upload`. Not measured: RGB/RGBA 8-bit fixtures (more bytes per pixel), or Vercel's CPU.
**Proposed fix (app/api/upload/route.ts, not a lane D file):** `sharp(uploadBuffer, { limitInputPixels: 50_000_000 })`
(clients already downscale to ≤1600 px edge, and 50 MP still admits a 48 MP frame), plus
`checkRateLimit(\`upload:${tenantId}:${userId}\`, 60, 3_600_000)` after `authoriseUpload`. The test's PROPOSED-bound cell
already shows the option refuses a 67 MP header in 1 ms.

## SEC-052 CSV formula injection: FIXED (red, then green)
Policy: every CSV goes through `lib/csv.ts` (`csvCell` = apostrophe prefix on a formula-trigger text cell, then RFC-4180
quoting). Trigger set per the OWASP CSV Injection community page (fetched 9 Oct 2026): `= + - @`, tab, CR, **LF**, and the
**full-width ＝ ＋ － ＠**. Before the fix, LF and the full-width forms were not prefixed (red: 6 failed).
Fix: `lib/csv.ts` regex `/^[=+\-@\t\r\n＝＋－＠]/`. Lane C had not changed this file (checked `git diff` first).
Producers (inventory test, fails on a new producer that bypasses `lib/csv.ts`): `app/api/admin/import/attendance/export`,
`app/api/payments/export.csv` (lane C added only a Cache-Control header), `app/api/admin/import/[id]/exceptions`
(`exceptionsCsv`), `lib/stripe/cutover-manifest.ts`, `app/admin/tenants/TenantsList.tsx`, `components/dashboard/ReportsView.tsx`.
DSAR export is JSON. No XLSX writer exists. Test: `tests/unit/sec-d-csv-formula-injection.test.ts` (16 cells, including a
2,000-value property test). Existing CSV/export/report suites: 16 files, 160 tests, green.
Residual, manual: OWASP notes the apostrophe is "not reliable in Microsoft Excel after saving and re-opening". This was not tested in
a real spreadsheet (no spreadsheet app in this environment). It needs a manual check in Excel/Sheets/LibreOffice.
