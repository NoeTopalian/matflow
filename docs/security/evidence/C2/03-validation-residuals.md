# C2-03 Remaining request validation (lane C2, 9 Oct 2026)

Inventories re-run on `af803d5` + lane C2 changes, Node v24.21.0:
- Body: `node docs/security/evidence/C/scripts/body-inventory.cjs <repoRoot> --md <out>` (lane C's AST scan, unchanged). Exit 0.
- Query: `node docs/security/evidence/C2/scripts/query-inventory.mjs <repoRoot> --md <out>` (new, regex scan of `searchParams.get`; a map, not a proof). Exit 0.

| Measure | Before (af803d5) | After (lane C2) |
|---|---|---|
| Routes reading a body | 121 (113 JSON, 4 form, 4 text) | 121 |
| Body routes with no schema parse | 15 | 5 (all reviewed below) |
| Strict (`z.strictObject`) body routes | 9 | 19 (+6 JSON, +4 multipart) |
| Routes reading query params | 33 | 33 |
| Query routes without zod | 27 | 25 |

## Fixed in this lane — top ten by blast radius (zod strictObject, red first)
Ranking: authentication factor > billing/state change > file ingestion > owner admin intake. Tests: `tests/unit/sec-c2-request-validation.test.ts` (58 cells, red 28 at HEAD) and `tests/unit/sec-c2-upload-controls.test.ts` (31 cells, red 14 at HEAD incl. upload-control cells).

| # | Route | Was | Now | Defect found |
|---|---|---|---|---|
| 1 | POST /api/auth/totp/verify (staff MFA challenge) | destructured `body as {code}` | `{ code: /^\d{6}$/ }` strict | **Yes (SF-C2-V1)**: null body threw (500); `{"code":["123456"]}` coerced past the regex into `consumeUserTotp` |
| 2 | POST /api/member/totp/verify | same | same | **Yes (SF-C2-V1)**: same two shapes reached `verifySync` |
| 3 | POST /api/auth/totp/setup (staff MFA enrolment) | manual typeof checks | `{ code, issueRecoveryCodes?: boolean }` strict | unknown keys accepted silently (no effect found) |
| 4 | POST /api/member/totp/setup | manual typeof checks | `{ code, issueRecoveryCodes?: boolean }` strict (the shared enrolment UI sends both) | unknown keys accepted silently |
| 5 | POST /api/members/[id]/hold (pauses Stripe collection) | non-object or unparsable body coerced to `{}` | `{ until?: string \| null }` strict; unparsable → 400 | **Yes (SF-C2-V2)**: `garbage{`, `null`, `[]`, `"x"` placed an OPEN-ENDED hold (paymentStatus paused, holdUntil null; Stripe pause for a subscribed member). `{}` stays an open-ended hold by the documented contract (member-hold.test.ts) |
| 6 | POST /api/upload (images; owner or member-self) | `formData.get` only, query unchecked | query `{ purpose?: [a-z-]{1,32} }` strict, single-valued; multipart `{ file, targetMemberId?, prefix? }` strict, duplicate fields refused | duplicate `targetMemberId` was resolved by `formData.get` (first wins) — now refused |
| 7 | POST/DELETE /api/initiatives/[id]/attachments | `formData.get`; DELETE `attachmentId` unchecked | multipart `{ file }` strict; DELETE query `{ attachmentId: [A-Za-z0-9_-]{1,64} }` strict, single-valued | — |
| 8 | POST /api/onboarding/csv-handoff (emails the MatFlow team) | `formData.get` | `{ file, notes? }` strict | — |
| 9 | POST /api/admin/import/upload | `formData.get` | the six fields ImportPanel sends, strict | — |
| 10 | POST /api/admin/import/uploads (chunked import open) | `body.x` with typeof checks | `{ purpose, fileName, bytes: finite number, sha256 }` strict | an array body passed the `typeof === "object"` guard (no effect: createUpload refused the empty values) |

## Residuals — body (5)
| Route | Why no schema | Disposition |
|---|---|---|
| /api/auth/[...nextauth] | NextAuth's own handler | NOT APPLICABLE (framework; credentials parsed by `credentialsSchema` in auth.ts) |
| /api/stripe/webhook | raw text verified by Stripe signature, then `constructEvent` | NOT APPLICABLE (signature is the validation) |
| /api/payments/outstanding | inventory false positive (GET; JSON is the response) | NOT APPLICABLE |
| /api/admin/import/attendance (POST/DELETE) | object-shape guard only (SF-33 sixth route) | OPEN → lane D2 owns the attendance import this iteration |
| /api/member/children/[id] (PATCH) | object-shape guard only | OPEN → file is being edited by lane D2 (uncommitted deletion-provenance work); not touched here |

## Residuals — strip-mode schemas
~100 JSON routes parse with `z.object` (unknown keys STRIPPED, not refused). Lane C's canary sweep (`sec-c-body-canary-sweep`, re-run below) shows no forged key reaches a database, mail, Stripe or Blob call on any of them, so this is hardening, not an open defect. Recommended order for strictObject conversion: routes the inventory marks "sensitive keys accepted" (/api/staff, /api/staff/[id], /api/members/accept-invite, /api/auth/reset-password, /api/auth/set-password, /api/account/password is already strict) and "dataSpread" (/api/members/[id], /api/staff/[id], /api/products*, /api/memberships/[id], /api/class-packs/[id], /api/ranks/[id], /api/announcements/[id], /api/coach/instances/[id]/attendance).

## Residuals — query strings (25 routes without zod)
Every value from `searchParams.get` is a string or null, so type confusion is impossible; the risk is malformed values reaching Prisma (500) or unbounded paging. Read of each:

| Route | Params | Current handling | Risk | Disposition |
|---|---|---|---|---|
| /api/audit-log | entityType, entityId, userId, action, from, to | sliced to 40/50 chars; dates via parseDate (Invalid → undefined) | Low | OPEN (convert to zod) |
| /api/admin/activity | tenantId, action, since, cursor | since: isNaN guard; cursor unchecked | Low (operator only) | OPEN |
| /api/checkin/members | instanceId, take, cursor, includeCancelled | take clamped 1–500; cursor passed to Prisma | Low | OPEN |
| /api/classes/[id]/instances | cursor, take | take clamped 1–200 | Low | OPEN |
| /api/member/classes | cursor, take | take clamped 1–200 | Low | OPEN |
| /api/reports | weeks | clamped 4–24 (documented) | Low | OPEN |
| /api/member/home, /api/member/schedule | date | YYYY-MM-DD parsed | Low | OPEN |
| /api/admin/import/attendance (+/export) | jobId, list, state, offset, limit, info, part | partial checks | Low | lane D2 |
| /api/settings/import-reconciliation | jobId | tenant-scoped lookup | Low | OPEN |
| /api/members/[id] | strategy, probe, confirm, toParentMemberId | enum-like compares | Low | lane D2 file this iteration |
| /api/members/[id]/photos | photoId | tenant-scoped lookup | Low | OPEN |
| /api/blob-image | url | isVercelBlobUrl (store-pinned, SF-28) + tenant prefix + row ownership | — | PASS (validated by code, not zod) |
| /api/magic-link/verify | token | single-use token lookup | — | PASS (token is the credential) |
| /api/drive/callback, /api/stripe/connect/callback | code, state, error | OAuth state checked | — | PASS (state binding) |
| /api/drive/folders | parentId | passed to Google API for the tenant's own token | Low | OPEN |
| /api/kiosk/[token]/members | q | search string, kiosk token gate | Low | OPEN (length cap recommended) |
| /api/admin/applications, /api/classes/[id], /api/cron/retention, /api/member/me, /api/member/me/children, /api/members | status, dryRun/force, dryRun, fields, include, guardianReview/filter/search | compared to fixed values | — | NOT APPLICABLE (fixed-value compares) |
