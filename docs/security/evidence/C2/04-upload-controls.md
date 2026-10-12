# C2-04 Upload controls (lane C2, 9 Oct 2026) — SF-40 / SEC-049 / SEC-051 / SEC-073

## Inventory of multipart / blob-writing routes
| Route | Who | Accepts | Stored as | Before C2 | After C2 |
|---|---|---|---|---|---|
| POST /api/upload | owner (branding/announcement/waiver graphics); staff or member-self (`purpose=profile-pic`/`member-photo`) | png/jpeg/webp, magic bytes, re-encoded to WebP by sharp (`limitInputPixels` 50 MP) | `tenants/<tenantId>/<24 hex>.webp`, private blob, random suffix | no Content-Length bound (whole body parsed before auth), no rate limit, unchecked query/fields | 413 on declared size before anything; principal before body; per-user + per-tenant limit before body; strict query + multipart; duplicate fields refused |
| POST /api/initiatives/[id]/attachments | owner/manager | png/jpeg/webp/pdf by magic bytes | `tenants/<t>/initiatives/<id>/<24 hex>.<ext>`; display name stored | Content-Length bound already; no rate limit; filename `slice(0,200)` raw | + limit before body; strict multipart; filename normalised; DELETE query strict |
| POST /api/onboarding/csv-handoff | owner | CSV by MIME or `.csv` | private blob; **emails the MatFlow team** | Content-Length bound already; no limit (a mail-budget drain) | + limit spent only by acceptable files, before storage/mail; strict multipart; filename normalised |
| POST /api/admin/import/upload | owner | CSV | private blob via lib/import-storage | Content-Length bound already; no limit | + limit before body; strict multipart (the six fields ImportPanel sends); filename normalised |
| /api/admin/import/uploads/** (chunked) | owner | CSV chunks | lib/import-upload | per-tenant limits (30/600/60 per hour) | unchanged; open-call body now strict (03) |
| waiver signature (`lib/waiver-signature-upload.ts`) | via waiver sign routes | data-URL PNG in JSON | private blob | rate-limited per signer (5/15 min) | unchanged |
| GET /api/blob-image (serving) | signed-in, own tenant | — | — | any `image/*` inline incl. `image/svg+xml` | raster allow-list inline (png/jpeg/webp/gif/avif); everything else `application/octet-stream` attachment; `Content-Security-Policy: default-src 'none'; …; sandbox` |

## What backs the rate limit (stated plainly)
`lib/rate-limit.ts` counts hits in the `RateLimitHit` table: while the database answers, **one limit is shared by every Vercel instance**. On a database error it falls back to an **in-memory Map per instance**, so during that fault the ceiling is **N instances × limit**. The DB path is count-then-insert (not atomic): a burst of k concurrent requests arriving at count = max − 1 can all pass, so overshoot is bounded by concurrency. Neither is a distributed exact limit and none is claimed. Both behaviours are pinned by tests (shared-across-fresh-module cell; "HONEST LIMIT" cell: 2 instances × 30 allowed with the DB down).

| Kind | Per user | Per tenant | Worst case during a DB fault, N = 20 instances |
|---|---|---|---|
| image (/api/upload) | 30 / 10 min | 300 / h | 600 decodes / 10 min per user; each decode bounded at 50 MP (≈1 s CPU worst case, SEC-051) |
| attachment | 30 / 10 min | 200 / h | 600 stores / 10 min per user (≤10 MB each, no decode) |
| csvHandoff | 10 / h | 20 / 24 h | 200 mails / h per user — mail drain bounded; normal path 10 |
| importUpload | 30 / h | 60 / h | 600 parses / h per user (≤10 MB) |

## Input limits
- Content-Length judged before the body is read: `lib/upload-guard.ts refuseOversizeBody` (cap + 64 KB multipart overhead → 413) on /api/upload; the three other routes already had an equivalent check. A missing Content-Length (chunked) is not refused there — Vercel caps request bodies at ~4.5 MB; the per-file size check still applies.
- Pixel bound: sharp `limitInputPixels: 50_000_000` unchanged (pinned by lane E3's `sec-e3-upload-limit-input-pixels`, which stays green after the restructure).
- MIME sniffing vs declared type: magic bytes per declared type (unchanged); cells prove JPEG-as-PNG, PNG-as-JPEG, SVG-as-PNG, PDF-as-WebP are refused before sharp runs.
- SVG: refused at every upload route (type allow-list + magic bytes; already true before C2 — the red cell for the attachment route is the unknown-field half); never served inline (new).
- Filenames: `normaliseUploadFilename` — NFC, basename only, C0/C1/DEL, bidi controls (U+202A–202E, U+2066–2069, U+200E/F, U+061C), zero-width and BOM removed, whitespace collapsed, leading/trailing dots and spaces trimmed, ≤ 200 code points. Never a storage key: every blob path is built from server ids.

## Tests (bounded: fake blob client, sharp mocked, real lib/rate-limit over a fake RateLimitHit table)
`tests/unit/sec-c2-upload-controls.test.ts` 31 cells; `tests/unit/sec-c2-blob-image-inline.test.ts` 15 cells. Red against the HEAD route files: 20 failing (log `04-upload-red-green.log`); green 46/46. Existing suites green after the change: upload-blob, sec-e3-upload-limit-input-pixels, sec-d-image-bounds, initiative-attachment-validation-order, onboarding-csv-handoff, import-upload-routes, sec-d-csv-formula-injection, teamup-billed-provider-inert, blob-image-proxy, blob-image-member-scope, private-blob-reads, sec-c-blob-store-pin, e2e-triage-product-fixes, import-entry-routes, import-teamup-refresh.
