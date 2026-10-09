# SF-36 — Google sign-in: established state and the explicit-linking proposal (lane A2, 9 Oct 2026)

## Established
- Enabled? In code, only when `ENABLE_GOOGLE_OAUTH === "true"` AND `GOOGLE_CLIENT_ID` AND `GOOGLE_CLIENT_SECRET` are set (auth.ts `GOOGLE_OAUTH_ENABLED`); the button needs `NEXT_PUBLIC_ENABLE_GOOGLE_OAUTH === "true"` (app/login/page.tsx); the pre-sign-in club cookie route refuses unless `ENABLE_GOOGLE_OAUTH === "true"` (app/api/account/pending-tenant). Production: none of the four names appears in the Vercel variable listing (source: lane E `vercel env ls`, names only, docs/security/evidence/E/vercel-env-names-2026-10-09.txt, observed 9 Oct 2026). So the provider is not registered in production as of that observation. Not re-observed by lane A2 (no production access).
- Behaviour before this lane (code at 6e75e03): `signIn` callback required `email_verified`, a signed pending-club cookie, an admitting club, and an existing User or Member whose stored email equals the Google email; refused a temporary-password staff row and a provisional login email; then signed in as that account. That is linking by email alone. A member with no password (refused by the magic-link door) was signed in (red test sec-a2-google-link: `true`).
- Verification guarantees: Google's `email_verified` proves control of the mailbox at Google at that moment — not that the person is the account holder here, and not durable (Workspace addresses are reassigned; consumer accounts can be recovered by whoever controls recovery). The stable identifier is the OIDC `sub` (`account.providerAccountId`), which the code never stored or compared.

## Interim (implemented, tested)
Every Google sign-in that would have matched an account is refused with `/login?error=google_link_required` before the account is hydrated, the login event recorded or the club cookie consumed. Earlier refusals are unchanged. The link lookup (`linkedExternalIdentity`) is the single seam; it returns no link until the store exists. Login page copy for the code is lane-owner work (app/login/page.tsx is outside lane A2): recommended "Google sign-in isn't set up for this account. Sign in with your email and password, then link Google from your account settings." (Lane A3: the copy landed in 0619b7d — "This Google account isn't linked to a MatFlow login yet…" — and is pinned by tests/unit/sec-a3-login-copy.test.tsx; it is true whether or not an account exists, which matters now the no-account case answers with the same code.)

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

### Tenant binding (REQUIRED — review R3 §5; added by lane A3, 9 Oct 2026)
The table above lets a row say `tenantId = club A` while `userId`/`memberId` names an account in club B: the single-column foreign keys check only that the account exists somewhere. The sign-in lookup filters on the club from the pending-club cookie, so such a row would sign a club-B account in through club A's door (or an RLS-scoped writer in club A could plant one for a club-B id). The link must be bound to the account's OWN club by the database, not by application code. Composite foreign keys do it with no trigger; replace the two single-column references in the CREATE TABLE above with these (the composite FK needs a unique key on the referenced pair — `id` is already unique, so the extra index is cheap and changes nothing for existing rows):
```sql
CREATE UNIQUE INDEX "User_id_tenantId_key"   ON "User"("id", "tenantId");
CREATE UNIQUE INDEX "Member_id_tenantId_key" ON "Member"("id", "tenantId");

ALTER TABLE "ExternalIdentity"
  DROP CONSTRAINT IF EXISTS "ExternalIdentity_userId_fkey",
  DROP CONSTRAINT IF EXISTS "ExternalIdentity_memberId_fkey",
  ADD CONSTRAINT "ExternalIdentity_user_same_tenant_fkey"
    FOREIGN KEY ("userId", "tenantId") REFERENCES "User"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "ExternalIdentity_member_same_tenant_fkey"
    FOREIGN KEY ("memberId", "tenantId") REFERENCES "Member"("id", "tenantId")
    ON DELETE CASCADE ON UPDATE NO ACTION;
-- MATCH SIMPLE (the default) skips a composite FK whose userId/memberId is NULL, which is exactly the
-- "one of the two" CHECK above. ON UPDATE NO ACTION: moving an account to another club fails while it
-- has a link, so a club move must revoke links first (a link proven in club A never follows the
-- account into club B).

CREATE POLICY tenant_isolation ON "ExternalIdentity" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );
```
Prisma form: `@@unique([id, tenantId])` on User and Member; on ExternalIdentity `user User? @relation(fields: [userId, tenantId], references: [id, tenantId], onDelete: Cascade, onUpdate: NoAction)` and the same for `member`. (A trigger is the fallback only if Prisma cannot express the overlapping `tenantId` column in both relations; the FK is preferred because it cannot be disabled by `session_replication_role` games short of the table owner, and needs no function.) Test owed: inserting a row whose `tenantId` differs from the account's club fails with 23503 under BOTH roles.

## Proposed flow
1. Link (from an authenticated, non-support session): POST /api/account/external-identity/google/start with the current password (or a TOTP code if enrolled), same-origin, rate-limited. On success set a short-lived (10 min), HMAC-signed, httpOnly, SameSite=Lax link-intent cookie naming {subject kind, id, tenantId, sessionVersion, nonce}; redirect to Google with `prompt=select_account`.
2. Callback: `signIn` sees the link intent; verifies its signature, expiry, nonce (single use), that the current session is the same subject at the same sessionVersion, and `email_verified`; inserts ExternalIdentity with `account.providerAccountId`; audits `auth.external_identity.linked`; emails the account's address; does NOT sign in as anyone new.
3. Sign-in (Lookup — REQUIRED order, lane A3): look up ExternalIdentity by (club from the signed pending-club cookie, 'google', sub) where not revoked, FIRST and ONLY by those three values → no row: refuse `/login?error=google_link_required` before any account is read → row: load that User/Member BY ID (`id = link.userId|memberId AND tenantId = club`) → existing refusals (admission, temporary password, provisional email) → TOTP challenge as today. The Google email is never used to find an account; it may be stored for audit only.
   **The current code is email-first and must change when the store lands.** auth.ts:869-878 (`const [dbUser, memberRow] = await withTenantContext(...)` with `where: { tenantId_email: { tenantId: tenant.id, email } }`) finds the account by the Google address, and the link seam is consulted only afterwards, at auth.ts:929 (`linkedExternalIdentity("google", account?.providerAccountId, tenant.id)`), and only to CONFIRM that address match (auth.ts:930-931 compares the link to the email-found row). Filled in as-is, that would still require the email to match — "same sub, different email admitted" would be refused, and an account whose login email changed would lose its link. When the migration lands, delete the email lookup from the Google path, move the link lookup to the top of the callback (after `email_verified` and the club checks), and read the account by the link's id. (Line numbers as of lane A3's working tree on ebd761d.)
4. Unlink — REQUIRED, not recommended (review R3 §5). Every link of the account is revoked (`revokedAt = now()`) IN THE SAME TRANSACTION as the event below, and the audit row names the reason:
   - password reset by any route (app/api/auth/reset-password/route.ts; an owner- or operator-issued temporary password) — a reset is the "someone else had my account" recovery, and a link created by that someone else must not survive it;
   - revoke-access by an operator (app/api/admin/customers/[id]/revoke-access/route.ts);
   - "Wasn't me?" (app/api/auth/disown-login/[token]/route.ts), which already bumps the session version;
   - account deletion and erasure (ON DELETE CASCADE above; the DSAR erasure path must delete, not merely anonymise, the row);
   - the person's own unlink (session + password/TOTP, same-origin, rate-limited).
   A test per trigger, under both DB roles: after the event the old sub is refused with google_link_required.
Tests owed with the migration: link requires proof (no password → refused), link bound to session version, intent single-use, sign-in by sub only (same email different sub refused; different email same sub admitted), revoked link refused, tenant binding (cross-club row refused 23503), unlink on each trigger above, both DB roles.

## Residuals closed in code by lane A3 (9 Oct 2026; red first, tests/unit/sec-a3-google-door.test.ts)
- **Existence signal (Low).** The door answered NoAccountForGym for an address with no account in the club and google_link_required for an account without a link, so the mailbox owner learned whether the address is registered there. Proposal: ONE code, google_link_required, for both on the Google door; implemented (auth.ts:885, one line). The login page no longer renders an account-specific sentence for a crafted ?error=NoAccountForGym (app/login/page.tsx). Remaining distinct answers on the Google door, for the record: invalid_link for a bootstrap (temporary-password) staff row or a provisional login email (auth.ts:890, :910). Both are reachable only by the mailbox owner and only for accounts in an unusual state; they disappear when the link-first lookup above lands (no link → refused before any account is read).
- **Login-event IP.** The Google path took the client IP from the FIRST x-forwarded-for entry (client-written). It now uses `requestClientIp` (lib/auth-lockout.ts), the same trust order as the credentials path: x-vercel-forwarded-for, x-real-ip, then the LAST x-forwarded-for hop (auth.ts:993). The login event decides which devices are "known" (new-device mail and the address-cap exemption), so this was a spoofable device identity on that path.
- The seam `linkedExternalIdentity` moved to lib/external-identity.ts (behaviour unchanged: no store, no link) so the store lands in one place and tests can reach the rest of the Google path.
