# Accept Invite (Staff-Created Member First Login)

> **Status:** ✅ Working · shipped LB-003 (commit `18f4061`) · members created without a password get an emailed invite link to set one and sign in.

## Purpose

Close audit item H8 ("Staff-created members can never log in"). When an owner/manager/admin creates a member via the dashboard with no `passwordHash`, the system mints a `MagicLinkToken` with `purpose='first_time_signup'`, emails an invite, and provides a copyable URL fallback. The member opens the link, picks a password, and is signed in straight away.

## Surfaces

| Surface | Path |
|---|---|
| Member create form | [Members list](../app/dashboard/members/page.tsx) → "Add Member" drawer |
| Invite email | [`invite_member` template](../lib/email.ts) — branded "Welcome to {gymName}!" with a "Set up your account" button |
| Accept page | [/login/accept-invite](../app/login/accept-invite/page.tsx) — public (whitelisted in proxy.ts), Suspense-wrapped because of `useSearchParams` |

## Data model

Re-uses the existing `MagicLinkToken`:

```prisma
purpose String @default("login")  // 'login' | 'first_time_signup' | 'waiver_open'
```

For invites: `purpose = 'first_time_signup'`, `expiresAt = now + 7 days`. Longer TTL than a login link because owners may not get the new member to check email immediately.

## API routes

### `POST /api/members` (existing route, extended in LB-003)
On non-kid member creation, after the `Member.create`:

- Mints a 24-byte hex token in `MagicLinkToken` with `purpose='first_time_signup'`, 7-day expiry
- Sends Resend `invite_member` email with the absolute URL (`NEXTAUTH_URL` or request origin + `/login/accept-invite?token=...`)
- Returns the new member row plus `inviteUrl` so the owner UI can show a copyable fallback if email delivery fails

Failure to mint or email **does NOT** break member creation — wrapped in try/catch, errors logged, owner still sees the member row.

### `POST /api/members/accept-invite`
Public (whitelisted at [proxy.ts](../proxy.ts) line 14). Body: `{ token, password }`.

- Per-IP rate-limit (10 / 15 min) — bucket `accept-invite:{ip}`
- Zod validates password: 10+ chars, upper + lower + digit (same policy as reset)
- Looks up token; rejects `404` if missing, `410` if used, `410` if expired, `404` if `purpose !== 'first_time_signup'`
- Wraps in `prisma.$transaction`:
  - `Member.update` — sets `passwordHash` (bcrypt 12 rounds), bumps `sessionVersion`
  - `MagicLinkToken.update` — `used: true`, stamps `usedAt + ipAddress`
- Returns `{ ok: true, tenantSlug, email }` so the client can call `signIn("credentials", ...)` immediately

## Flow

1. **Owner adds a member** in dashboard → `POST /api/members` → response contains `inviteUrl`
2. **Resend email** fires (best-effort) — recipient sees branded invite email
3. **Owner toast** shows "Invite emailed to alex@example.com" + a "Copy invite link" button as fallback
4. **Member clicks** the email link → lands on `/login/accept-invite?token=...`
5. **Page** ([app/login/accept-invite/page.tsx](../app/login/accept-invite/page.tsx)) shows new-password form. Validates client-side (10 chars, upper, lower, digit, must match confirm)
6. **POST /api/members/accept-invite** → token consumed + password set + sessionVersion bumped
7. **NextAuth `signIn("credentials", ...)`** runs immediately on the new password → redirect to `/member/home`
8. **Edge case**: if the credentials sign-in fails (shouldn't, the password was just set), fall back to `/login?email=...`

## Security

| Control | Where |
|---|---|
| Token entropy | 24 bytes hex (192 bits) |
| 7-day TTL | Generous for invite flow; mitigates inbox-takeover by long-lived link |
| Atomic consume | `$transaction` ensures token + password update atomic |
| Rate limit | `accept-invite:{ip}` 10/15min — token brute-force is hopelessly slow |
| Password policy | Same as forgot-password (10+/upper/lower/digit) |
| sessionVersion bump | Defends against any pre-existing token theft |
| Public route | Explicitly whitelisted in proxy.ts — token-gated by design |
| No enumeration | All errors return generic messages |

## Known limitations

- **No "resend invite" UI yet.** If the member loses the email, the owner has to delete the member and re-create them, OR call `/api/magic-link/request` manually. A Re-send button on the member detail page would be a one-liner improvement.
- **Email-only delivery** — no SMS option. If `RESEND_API_KEY` is unset, only the `inviteUrl` fallback works (owner must hand-deliver the link).
- **No "claim email" for kids** — kid sub-accounts are passwordless by design and never get an invite.
- **The invite URL is a bearer token** — anyone with it can set the password. Owners should treat it as sensitive. The 7-day TTL is the only safety net.

## Test coverage

- [tests/unit/accept-invite.test.ts](../tests/unit/accept-invite.test.ts) — 6 cases: unknown token (404), wrong purpose (404), expired (410), used (410), success path (sets password + consumes), weak password rejection (400)

## Files

- [app/api/members/route.ts](../app/api/members/route.ts) — POST mints token + sends email
- [app/api/members/accept-invite/route.ts](../app/api/members/accept-invite/route.ts) — public consume endpoint
- [app/login/accept-invite/page.tsx](../app/login/accept-invite/page.tsx) — Suspense-wrapped form
- [lib/email.ts](../lib/email.ts) — `invite_member` template
- [proxy.ts](../proxy.ts) — `/api/members/accept-invite` in `PUBLIC_PREFIXES`
