# Operator access — operation-level access matrix (14 Oct 2026)

Source of truth: `lib/support-session.ts` (`SUPPORT_EDIT_MUTATION_ALLOWLIST`, `SUPPORT_EDIT_FIELD_POLICY`, `SUPPORT_REFUSED_READS`), `proxy.ts` (edge gate), the in-route backstops (`refuseSupportSession` / `refuseSupportSessionUnlessEdit` / `refuseSupportEditFields`), `lib/impersonation.ts` (v3 scoped token) and `lib/audit-log.ts` (`resolveActingAs`). Candidate: PR #31 `a1dfee9` + PR #33 `6ad7e30`. Nothing in this table is inferred from a route being allowlisted; each row was traced to the handler.

## Scopes

| Scope | Who | How it starts | What binds it server-side | What ends it |
|---|---|---|---|---|
| **View club** | Named operator (MFA, `OPERATOR_ALLOWED_IDS`) | Hub → View, reason ≥ 10 chars, fresh authenticator code → step-up `support.impersonate` bound to `{club}/{owner}` | HMAC v3 cookie `{adminUserId, opSv, targetUserId, targetTenantId, tsv, scope:"view", n, exp}`, nonce hash on the Operator row, 30 min | Expiry; End session; operator logout/sessionVersion bump; operator de-listed or authenticator reset; target user sessionVersion bump; club status change; a NEW session by the same operator (supersedes) — all re-verified **on every request** |
| **Edit club** | Same | Hub → Edit, reason, fresh code → step-up **`support.edit`** bound to `{club}/{owner}/edit` (a view grant can never start an edit) | Same cookie with `scope:"edit"` | Same |
| **Privileged operator workflow** (login-email correction, ownership, resets) | Named operator, outside any support session | Hub cards, each with its own preflight + action-bound step-up | Per-workflow grant (`lib/operator-step-up.ts`) | Single use |

In-flight semantics: authorisation is checked at the start of each request and the token re-verified by `resolveActiveImpersonation`; revocation takes effect at the next request (residual = a request already executing). No queued or background job is reachable from a support session (the allowlisted handlers enqueue nothing).

## Mutations under an EDIT session (everything not listed is refused at the edge and again in-route)

| Operation | Accepted fields (raw keys) | Objects / ownership | DB effects | External effects | Audit |
|---|---|---|---|---|---|
| `POST /api/classes` | full class create schema | club-scoped | Class + rolling instances | none | `class.created` as operator |
| `PATCH /api/classes/[id]` | class edit schema | class in club (404 otherwise) | class row; FUTURE unmatched instances deleted; roster rows when roster toggled | none | class.updated |
| `POST /api/classes/[id]/instances` | — | class in club | instances generated | none | audited |
| `PATCH /api/classes/[id]/instances/[id]` | `cancelled`, times | instance in club | one instance | none (member-visible schedule) | audited |
| `POST /api/classes/[id]/roster` | member id | class + member in club | roster row | none | audited |
| `POST /api/members` | **name, email, phone, dateOfBirth, requestId** | club | member row (status default); **no membership tier**, **no guardian link**, **no invite token, no email** (`inviteUrl: null` + note) | none | `member.create` as operator |
| `PATCH /api/members/[id]` | **name, phone, emergencyContact{Name,Phone,Relation}, notes, dateOfBirth, updatedAt** | member in club (404 otherwise) | contact fields only | none (status/paymentStatus/membership/email refused ⇒ no Stripe path reachable) | `member.update` as operator |
| `POST /api/members/[id]/rank` | **rankSystemId, stripes, notes** (no photo) | member + rank in club | rank row | none | `rank.*` as operator |
| `POST /api/members/[id]/rank/demote` | **toRankId** (no notify, no reason) | same | rank row; ClassSubscription rows for gated classes | none (notify refused ⇒ no email) | audited |
| `POST /api/checkin` | check-in schema | member + instance in club | attendance row | none | audited |
| `POST /api/ranks`, `PATCH /api/ranks/[id]` | rank-system schema | club | rank system rows (DELETE is a separate handler, refused) | none | audited |
| `PATCH /api/settings` | **name, colours, fontFamily, logoSize, logoUrl, social/website/groupChat URLs, checkinWindow{Before,After}Min, timezone** | club | tenant row (those columns) | none (payment rail, BACS, self-billing, billing/privacy contacts, contactEmail, waiver, onboarding refused) | `tenant.settings.update` as operator |

Every refused field attempt under an edit session → 403 before any lookup/write/provider call/token/email, whole request refused (mixed bodies never partially apply), and one operator-plane row `support.edit.refused` (route pattern + field names only).

## Reads refused in both scopes (`SUPPORT_REFUSED_READS`)
DSAR export, payments CSV, attendance export, import exceptions CSV, Stripe connect/callback, Drive connect/callback, TOTP setup GETs (both planes).

## Never reachable from any support session (edge + in-route, both scopes)
Account credentials/password/login-email; TOTP/MFA setup, reset, recovery codes; staff management; ownership transfer; Stripe/billing/charges/refunds/holds; imports/rollbacks; exports; DSAR/erasure; invite and waiver links; guardian link/unlink/promote-to-adult; unlock; kiosk/display tokens; **every DELETE**; Server Actions (page POSTs never match the allowlist); the operator plane itself.

## Blob files (any session, PR #33)
A client-supplied blob URL is accepted only under `/tenants/<thisClub>/` on the four photo routes (rank photo, member photo, profile picture, parent-portal child photo; any scheme/host case). Announcement images are NOT restricted at accept time (external images are allowed by design) — they are restricted at delete time. The club logo (T9b, 17 Oct 2026) IS restricted at accept time, for owner and edit sessions alike: `PATCH /api/settings` accepts `logoUrl` only as a raster `data:` URL (PNG, JPEG or WebP, up to 3 MB) or a blob URL under `/tenants/<thisClub>/`; external `https://` images, root-relative paths (including `/api/blob-image?url=…`), SVG and other schemes are refused with a field error. A value equal to the one already stored is not a new write and is not refused. New logo uploads (`/api/upload?purpose=logo`) are never written to Blob: they are stored inline so the logo renders with no session on the login page, kiosk, leaderboard and public club page. There is no anonymous `/api/blob-image` branch. Every delete path (rank replace, photo delete, profile delete, child delete, announcement delete, member cascade, DSAR erase, tenant purge, retention cron) passes only this club's namespace to `del()`; anything else is left in place and logged.

## Known limits (stated, not hidden)
- Application-layer tenant filters are the primary boundary; RLS is a backstop and the runtime role can rewrite audit rows (see security campaign ledger).
- Edge-level route refusals are platform-logged (one structured line: scope, method, path, reason, request id — no identity) but not database-audited (no database at the edge); field-level refusals inside routes are audited on the operator plane.
- Socials/timezone/check-in windows are server-permitted but not exposed in the support UI (follow-up).
