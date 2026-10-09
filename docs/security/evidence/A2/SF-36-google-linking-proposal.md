# SF-36 — Google sign-in: established state and the explicit-linking proposal (lane A2, 9 Oct 2026)

## Established
- Enabled? In code, only when `ENABLE_GOOGLE_OAUTH === "true"` AND `GOOGLE_CLIENT_ID` AND `GOOGLE_CLIENT_SECRET` are set (auth.ts `GOOGLE_OAUTH_ENABLED`); the button needs `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH === "true"` (app/login/page.tsx); the pre-sign-in club cookie route refuses unless `ENABLE_GOOGLE_OAUTH === "true"` (app/api/account/pending-tenant). Production: none of the four names appears in the Vercel variable listing (source: lane E `vercel env ls`, names only, docs/security/evidence/E/vercel-env-names-2026-10-09.txt, observed 9 Oct 2026). So the provider is not registered in production as of that observation. Not re-observed by lane A2 (no production access).
- Behaviour before this lane (code at 6e75e03): `signIn` callback required `email_verified`, a signed pending-club cookie, an admitting club, and an existing User or Member whose stored email equals the Google email; refused a temporary-password staff row and a provisional login email; then signed in as that account. That is linking by email alone. A member with no password (refused by the magic-link door) was signed in (red test sec-a2-google-link: `true`).
- Verification guarantees: Google's `email_verified` proves control of the mailbox at Google at that moment — not that the person is the account holder here, and not durable (Workspace addresses are reassigned; consumer accounts can be recovered by whoever controls recovery). The stable identifier is the OIDC `sub` (`account.providerAccountId`), which the code never stored or compared.

## Interim (implemented, tested)
Every Google sign-in that would have matched an account is refused with `/login?error=google_link_required` before the account is hydrated, the login event recorded or the club cookie consumed. Earlier refusals are unchanged. The link lookup (`linkedExternalIdentity`) is the single seam; it returns no link until the store exists. Login page copy for the code is lane-owner work (app/login/page.tsx is outside lane A2): recommended "Google sign-in isn't set up for this account. Sign in with your email and password, then link Google from your account settings."

## Proposed migration (lead-owned; not applied)
```sql
CREATE TABLE "ExternalIdentity" (
  "id"              TEXT PRIMARY KEY,
  "tenantId"        TEXT NOT NULL REFERENCES "Tenant"("id") ON DELETE CASCADE,
  "provider"        TEXT NOT NULL CHECK ("provider" IN ('google')),
  "providerSubject" TEXT NOT NULL,              -- OIDC sub, never the email
  "userId"          TEXT REFERENCES "User"("id") ON DELETE CASCADE,
  "memberId"        TEXT REFERENCES "Member"("id") ON DELETE CASCADE,
  "emailAtLink"     TEXT NOT NULL,              -- audit only; never used to match
  "linkedVia"       TEXT NOT NULL CHECK ("linkedVia" IN ('password', 'totp')),
  "linkedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"       TIMESTAMP(3),
  CHECK (("userId" IS NULL) <> ("memberId" IS NULL))
);
CREATE UNIQUE INDEX "ExternalIdentity_tenant_provider_subject" ON "ExternalIdentity"("tenantId","provider","providerSubject") WHERE "revokedAt" IS NULL;
CREATE UNIQUE INDEX "ExternalIdentity_user_provider" ON "ExternalIdentity"("userId","provider") WHERE "revokedAt" IS NULL AND "userId" IS NOT NULL;
CREATE UNIQUE INDEX "ExternalIdentity_member_provider" ON "ExternalIdentity"("memberId","provider") WHERE "revokedAt" IS NULL AND "memberId" IS NOT NULL;
ALTER TABLE "ExternalIdentity" ENABLE ROW LEVEL SECURITY;  -- tenant policy as for every tenant table
```

## Proposed flow
1. Link (from an authenticated, non-support session): POST /api/account/external-identity/google/start with the current password (or a TOTP code if enrolled), same-origin, rate-limited. On success set a short-lived (10 min), HMAC-signed, httpOnly, SameSite=Lax link-intent cookie naming {subject kind, id, tenantId, sessionVersion, nonce}; redirect to Google with `prompt=select_account`.
2. Callback: `signIn` sees the link intent; verifies its signature, expiry, nonce (single use), that the current session is the same subject at the same sessionVersion, and `email_verified`; inserts ExternalIdentity with `account.providerAccountId`; audits `auth.external_identity.linked`; emails the account's address; does NOT sign in as anyone new.
3. Sign-in: look up ExternalIdentity by (club from the signed pending-club cookie, 'google', sub) where not revoked → load that User/Member by id → existing refusals (admission, temporary password, provisional email) → TOTP challenge as today. Email never consulted.
4. Unlink: session + password/TOTP; also revoked by revoke-access (operator), account deletion (cascade) and, recommended, by a password reset.
Tests owed with the migration: link requires proof (no password → refused), link bound to session version, intent single-use, sign-in by sub only (same email different sub refused; different email same sub admitted), revoked link refused, both DB roles.
