-- PR 7: Operator + PlatformConfig + Tenant.featureFlags.
--
-- Foundational schema for the v1.5 multi-operator admin hub. UI ships
-- separately. The `featureFlags` Json column on Tenant lets operators
-- enable per-tenant beta features without a deploy.

ALTER TABLE "Tenant" ADD COLUMN "featureFlags" JSONB;

CREATE TABLE "Operator" (
    "id"               TEXT NOT NULL,
    "email"            TEXT NOT NULL,
    "name"             TEXT NOT NULL,
    "passwordHash"     TEXT NOT NULL,
    "role"             TEXT NOT NULL DEFAULT 'super_admin',
    "totpEnabled"      BOOLEAN NOT NULL DEFAULT false,
    "totpSecret"       TEXT,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil"      TIMESTAMP(3),
    "sessionVersion"   INTEGER NOT NULL DEFAULT 0,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt"      TIMESTAMP(3),

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Operator_email_key" ON "Operator"("email");

CREATE TABLE "PlatformConfig" (
    "key"         TEXT NOT NULL,
    "value"       JSONB NOT NULL,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "PlatformConfig_pkey" PRIMARY KEY ("key")
);

-- These tables are platform-global (no tenantId) — they don't get RLS policies.
-- Access is gated entirely at the application layer via MATFLOW_ADMIN_SECRET.
