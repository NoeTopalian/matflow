-- P1.6 Login Notifications — new-device detection.
--
-- LoginEvent records each (subject, device-fingerprint) pair seen on a successful
-- sign-in. Composite uniques on (userId, deviceHash) and (memberId, deviceHash)
-- make Postgres enforce "one row per (subject, device)" without app-layer dedup.
--
-- userId / memberId are mutually exclusive (mirrors MagicLinkToken pattern):
-- a row belongs to a User OR a Member, never both.
--
-- ipApprox stores an IPv4 /24 or IPv6 /48 prefix only (GDPR — full IP is PII;
-- the prefix is enough for "new neighbourhood" detection).
-- uaSummary is a lossy, stable-across-patch-versions UA string ("Chrome 121
-- on Windows") so routine browser updates don't trigger spurious alerts.
-- deviceHash is HMAC-SHA256(normalisedIp + uaSummary, AUTH_SECRET).
--
-- disownedAt is set by the "Wasn't me?" flow — forces re-notification next time
-- this fingerprint shows up. Also see notifyOnNewLogin column added below.

CREATE TABLE "LoginEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "memberId" TEXT,
    "deviceHash" TEXT NOT NULL,
    "ipApprox" TEXT,
    "uaSummary" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disownedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginEvent_pkey" PRIMARY KEY ("id")
);

-- One row per (subject, device): two partial unique indexes since one of
-- userId/memberId is always NULL (Prisma composite unique on nullable cols
-- works in Postgres but partial indexes are clearer about intent).
CREATE UNIQUE INDEX "LoginEvent_userId_deviceHash_key"
  ON "LoginEvent"("userId", "deviceHash") WHERE "userId" IS NOT NULL;
CREATE UNIQUE INDEX "LoginEvent_memberId_deviceHash_key"
  ON "LoginEvent"("memberId", "deviceHash") WHERE "memberId" IS NOT NULL;

CREATE INDEX "LoginEvent_tenantId_firstSeenAt_idx"
  ON "LoginEvent"("tenantId", "firstSeenAt");

-- Mutual exclusion: exactly one of userId / memberId is set.
ALTER TABLE "LoginEvent" ADD CONSTRAINT "LoginEvent_subject_xor_chk"
  CHECK ((("userId" IS NOT NULL)::int + ("memberId" IS NOT NULL)::int) = 1);

-- ─── Notification preference ────────────────────────────────────────────────
-- Default true: every account gets new-device alerts unless they opt out.
-- Owners cannot opt out (server-side guard in lib/login-event.ts).
ALTER TABLE "User"   ADD COLUMN "notifyOnNewLogin" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Member" ADD COLUMN "notifyOnNewLogin" BOOLEAN NOT NULL DEFAULT true;

-- ─── RLS — match the policy pattern from 20260503100000 ─────────────────────
-- LoginEvent is tenant-scoped and must enforce tenant isolation. The activate
-- migration (20260503200000) only enabled RLS on tables present at that time,
-- so this new table needs its own ENABLE+FORCE here.

CREATE POLICY tenant_isolation ON "LoginEvent" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );

ALTER TABLE "LoginEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LoginEvent" FORCE ROW LEVEL SECURITY;
