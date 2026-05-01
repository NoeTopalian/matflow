# Encryption & Secrets

> **Status:** ✅ Working · AES-256-GCM with `AUTH_SECRET`-derived key · used for Drive tokens, TOTP secrets, and any field flagged sensitive · all platform secrets in Vercel env, never committed.

## Purpose

Two related concerns:

1. **At-rest encryption** — fields like Google OAuth tokens and TOTP secrets must not be readable if the database is dumped. We encrypt them via AES-256-GCM in [lib/encryption.ts](../lib/encryption.ts).
2. **Secrets management** — the platform's signing keys, Stripe secret, Anthropic API key, etc. live in Vercel environment variables. They never enter the repo.

This document is the single source of truth for "what's encrypted, what's a secret, and where it lives".

## At-rest encryption library

[lib/encryption.ts](../lib/encryption.ts):

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

function getKey(): Buffer {
  return createHash("sha256").update(AUTH_SECRET_VALUE).digest();
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}
```

### Cipher choices

- **AES-256-GCM** — authenticated encryption (catches tampering); industry standard
- **96-bit IV** (12 bytes) — recommended by NIST for GCM
- **128-bit auth tag** (16 bytes) — full strength
- **Key derivation**: SHA-256 of `AUTH_SECRET_VALUE` — turns any-length secret into a 256-bit key deterministically

### Storage format

`base64(iv || tag || ciphertext)`. Single string per field, easy to round-trip via Prisma (`String` columns). The IV is fresh per encryption — never reuse keystreams.

### Why not envelope encryption / KMS

- We're a small platform — adding AWS KMS (or equivalent) means infra complexity for marginal additional protection.
- The KEK (`AUTH_SECRET`) is stored in Vercel env, which is itself encrypted at rest by Vercel.
- Compromise model: an attacker who reads `AUTH_SECRET` can also read the database, so the additional layer doesn't help that scenario.
- Migration path: if we ever add KMS, the encrypted blobs can be re-wrapped without scheme change.

## What's encrypted

| Field | Why |
|---|---|
| `GoogleDriveConnection.accessToken` | Google OAuth grant — would let attacker read the gym's Drive folder |
| `GoogleDriveConnection.refreshToken` | Long-lived refresh — even worse than access token if stolen |
| `User.totpSecret` | TOTP shared secret — anyone with this can generate valid codes |

Things NOT encrypted at rest (deliberate):

- `password` — hashed with bcrypt (12 rounds), not encrypted (encryption assumes you'd want to recover the value; for passwords we want one-way)
- `stripeCustomerId` — public-ish identifier, not a secret
- `stripeAccountId` — same
- `email` — used as a lookup key; encrypting would require deterministic encryption (defeats the point)

## Platform secrets (Vercel env)

| Secret | What |
|---|---|
| `AUTH_SECRET` | NextAuth JWT signing key + KEK for at-rest encryption |
| `DATABASE_URL` | Postgres connection string (Neon) — read/write |
| `DATABASE_URL_DIRECT` | Direct Postgres URL (bypasses pooler — used by `prisma migrate`) |
| `STRIPE_SECRET_KEY` | Stripe API key (live in prod, test in preview) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` — Stripe webhook HMAC verification |
| `STRIPE_CONNECT_CLIENT_ID` | Stripe Connect OAuth app id |
| `RESEND_API_KEY` | Email sending |
| `RESEND_WEBHOOK_SECRET` | Resend webhook Svix verification |
| `ANTHROPIC_API_KEY` | Claude AI for monthly reports |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REDIRECT_URI` | Drive OAuth |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (file uploads) |
| `CRON_SECRET` | Bearer token verified by `/api/cron/*` handlers |
| `MATFLOW_APPLICATIONS_TO` | Comma-separated emails for new application notifications |
| `NEXTAUTH_URL` | Canonical app URL (used for OAuth redirects + magic links) |

Test environments use separate keys (Stripe test, Resend test API key) so a bug in preview doesn't fire real emails or charge real cards.

## `AUTH_SECRET_VALUE` accessor

[lib/auth-secret.ts](../lib/auth-secret.ts):

```ts
const value = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
if (!value) {
  throw new Error("AUTH_SECRET (or NEXTAUTH_SECRET) is required");
}
export const AUTH_SECRET_VALUE = value;
```

The `??` handles the historical name (`NEXTAUTH_SECRET`) — both work, but new deployments should use `AUTH_SECRET`. The throw at module-load time ensures we fail fast on misconfigured envs (vs. cryptic crypto errors later).

## HMAC for short-lived tokens

For things that don't need encryption but DO need tamper-resistance, we HMAC instead:

- Magic link tokens: `HMAC-SHA256(email + expires_at, AUTH_SECRET)`
- Drive OAuth state: `HMAC-SHA256(tenantId + ts, AUTH_SECRET)`
- Cron tokens: simple Bearer compare via `timingSafeEqual`

HMAC is faster than AES, and we don't need to recover the payload — just verify it.

## Secret rotation

### `AUTH_SECRET` rotation

Rotating breaks all existing JWTs (users have to re-login) AND makes encrypted DB fields unreadable. Procedure:

1. Stop the bleeding (if compromised) — rotate via Vercel env
2. Run a one-shot migration that decrypts-with-old + encrypts-with-new for affected rows (Drive tokens, TOTP secrets)
3. Force sign-out for all sessions (bump every `User.sessionVersion`)
4. Notify users of forced re-login

This is painful by design — `AUTH_SECRET` should rotate only on suspected compromise, not annually.

### `STRIPE_WEBHOOK_SECRET` rotation

1. Add a new endpoint signing secret in Stripe dashboard
2. Update Vercel env to support both old and new for a transition period (handler tries both)
3. Once Stripe stops sending events with the old secret, remove it

### Other API keys

Standard rotation: add new in vendor dashboard → update Vercel env → confirm deployment uses new → revoke old in vendor dashboard.

## Secrets in code review

The git pre-commit hook + GitHub secret scanning catch obvious patterns (`sk_live_...`, `whsec_...`, `AKIA...`). Nothing has been committed to repo to date.

`.env` files are in `.gitignore`. `.env.example` ships with placeholder values for local dev.

## Security

| Control | Where |
|---|---|
| AES-256-GCM at rest | `lib/encryption.ts` |
| KEK derived from `AUTH_SECRET` | `getKey()` — SHA-256 derivation |
| Fresh IV per encryption | `randomBytes(IV_LEN)` |
| Authenticated encryption | GCM auth tag — tamper detection |
| Secrets in Vercel env only | Never committed to repo |
| Pre-commit secret-scan | Catches obvious leaks |
| Test envs use separate keys | Bugs don't hit production vendors |
| Module-load fail-fast | `AUTH_SECRET` missing → throw at startup, not runtime |

## Known limitations

- **No per-record key derivation** — same KEK for every row. Compromise of `AUTH_SECRET` decrypts everything.
- **No HSM / KMS integration** — for a higher security tier we'd want envelope encryption with cloud KMS holding the KEK.
- **No automated key rotation** — manual procedure documented but not exercised in production.
- **`AUTH_SECRET` does double duty** as JWT signing key AND KEK — separating would be cleaner but adds operational complexity.
- **bcrypt for passwords is CPU-bound** — fine at our scale, but Argon2 would be preferred for new builds.
- **No field-level encryption on PII** (member names, emails) — full-DB-encryption-at-rest via Neon covers this layer; we don't apply application-level encryption to lookup-able fields.
- **Decrypt is synchronous** — large blobs would block the event loop. Acceptable because we only decrypt small tokens.
- **No rotation history** — once a secret rotates, the old value is gone. If a record was encrypted with an old key and never re-encrypted, it's permanently lost.

## Test coverage

- Round-trip tests (encrypt → decrypt → assert equal)
- Tamper detection test (modify ciphertext → expect throw)
- IV uniqueness test (1000 encryptions → no IV collisions)

## Files

- [lib/encryption.ts](../lib/encryption.ts) — AES-256-GCM helpers
- [lib/auth-secret.ts](../lib/auth-secret.ts) — `AUTH_SECRET_VALUE` accessor
- [lib/google-drive.ts](../lib/google-drive.ts) — uses `encrypt/decrypt` for tokens
- See [google-drive.md](google-drive.md), [totp-2fa.md](totp-2fa.md), [session-and-cookies.md](session-and-cookies.md), [magic-link.md](magic-link.md), [stripe-webhook.md](stripe-webhook.md)
