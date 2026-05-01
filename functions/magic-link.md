# Magic-Link Sign-In

> **Status:** ✅ Working · single-use email link · 30-min TTL · 3 distinct purposes (login, first-time signup, waiver open).

## Purpose

Passwordless sign-in via a one-time link emailed to the user. Same `MagicLinkToken` table is overloaded (via `purpose`) for: passwordless login, accepting a staff-created invite, and opening the waiver page on a member's own device.

## Surfaces

| Surface | Path |
|---|---|
| Magic-link request screen | [/login](../app/login/page.tsx) — "Email me a sign-in link" button toggles `magicMode` |
| Email | [`magic_link` template](../lib/email.ts) — Resend, sent from `RESEND_FROM` env var |

## Data model

```prisma
model MagicLinkToken {
  id        String    @id @default(cuid())
  tenantId  String
  email     String
  token     String    @unique
  purpose   String    @default("login")  // login | first_time_signup | waiver_open
  expiresAt DateTime
  used      Boolean   @default(false)
  usedAt    DateTime?
  ipAddress String?
  userAgent String?
  createdAt DateTime  @default(now())

  @@index([email, tenantId])
  @@index([expiresAt])
}
```

## API routes

### `POST /api/magic-link/request`
Public route (whitelisted in [proxy.ts](../proxy.ts)). Body: `{ email, tenantSlug }`.

- Rate-limit per-IP + per-email
- Looks up tenant by slug; quietly returns `200 ok` even if tenant or email doesn't exist (no enumeration)
- Mints a 32-byte hex token, expiry `now + 30 min`
- Optionally invalidates prior unused tokens (anti-stockpile)
- Sends email via `sendEmail({ templateId: "magic_link", vars: { gymName, link, expiresIn: "30 minutes" } })`
- Always returns `{ ok: true }` regardless of outcome — the only signal of failure is the email not arriving

### `GET /api/magic-link/verify?token=...`
Public. Atomically consumes the token:

- Looks up `token` in `MagicLinkToken`
- Rejects if not found, used, or expired (`410 Gone`)
- Marks `used: true`, stamps `usedAt + ipAddress + userAgent`
- Resolves the matching `User` or `Member` row by `(tenantId, email)`
- Issues a NextAuth session (custom impl since the standard credentials provider isn't used here)
- Redirects member → `/member/home`, staff → `/dashboard`

## Flow

1. User clicks "Email me a sign-in link" on the login screen → magic-mode form appears (email pre-filled from credentials step thanks to recent fix in [login-page useEffect](../app/login/page.tsx))
2. User submits → `POST /api/magic-link/request`
3. Server creates token, fires email (or silently no-ops if Resend unconfigured), returns 200
4. UI shows "Check your inbox — link expires in 30 minutes" success state
5. User clicks link in email → `GET /api/magic-link/verify?token=...`
6. Server consumes token + creates session → redirect to home

## Security

| Control | Where |
|---|---|
| Atomic single-use | `update({where: {token}, data: {used: true}})` in verify — second click returns 410 |
| TTL | `expiresAt` checked before consume — also enforced at index scan time |
| No enumeration | request always returns 200; verify uses generic 410 message |
| Rate limit | per-IP + per-email request bucket |
| Audit | `usedAt + ipAddress + userAgent` captured on consumption |
| Token entropy | 32 bytes hex (256 bits) — cryptographically random via `crypto.randomBytes` |

## Known limitations

- **Email failure is invisible.** If Resend is unconfigured (`RESEND_API_KEY` unset) or bounces, the user sees "Check your inbox" forever. Only signal: the email never arrives. Worth surfacing a dev-mode console hint when key is unset.
- **Same token shape for 3 purposes** (login, first_time_signup, waiver_open) — the `purpose` column is the only discriminator. A bug that ignored `purpose` could let a waiver-open token be used to sign in. Consumers MUST always verify `purpose` matches.
- **Inbox-takeover risk** — like all magic links, anyone with access to the user's email can sign in. Mitigated by the 30-min TTL but not eliminated.

## Files

- [app/api/magic-link/request/route.ts](../app/api/magic-link/request/route.ts)
- [app/api/magic-link/verify/route.ts](../app/api/magic-link/verify/route.ts)
- [app/login/page.tsx](../app/login/page.tsx) — magic mode UI
- [lib/email.ts](../lib/email.ts) — `magic_link` template
- [prisma/schema.prisma](../prisma/schema.prisma) — `MagicLinkToken` model
