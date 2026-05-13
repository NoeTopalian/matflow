-- US-5: MemberPhoto model — kid evidence + milestone uploads.
--
-- Visible to parent + staff in the same tenant. Cascades on member delete
-- so lib/member-delete.ts sweeps them automatically (the parent kid-delete
-- path AND the staff Member.DELETE path both rely on this).

CREATE TABLE "MemberPhoto" (
  "id"                 TEXT NOT NULL,
  "tenantId"           TEXT NOT NULL,
  "memberId"           TEXT NOT NULL,
  "url"                TEXT NOT NULL,
  "caption"            TEXT,
  "kind"               TEXT NOT NULL DEFAULT 'evidence',
  "uploadedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "uploadedByMemberId" TEXT,
  CONSTRAINT "MemberPhoto_pkey" PRIMARY KEY ("id")
);

-- FK to Member: CASCADE so the helper / parent DELETE flows sweep photos
-- automatically. FK to uploadedByMember: SET NULL so we preserve the row
-- when the uploader's account is removed but the subject kid still exists.
ALTER TABLE "MemberPhoto"
  ADD CONSTRAINT "MemberPhoto_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "Member"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MemberPhoto"
  ADD CONSTRAINT "MemberPhoto_uploadedByMemberId_fkey"
  FOREIGN KEY ("uploadedByMemberId") REFERENCES "Member"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MemberPhoto"
  ADD CONSTRAINT "MemberPhoto_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraint for kind enum. Pattern mirrors 20260430000001 for the
-- existing Member.accountType / status / paymentStatus columns.
ALTER TABLE "MemberPhoto" ADD CONSTRAINT "MemberPhoto_kind_check"
  CHECK ("kind" IN ('evidence', 'milestone', 'promotion')) NOT VALID;
ALTER TABLE "MemberPhoto" VALIDATE CONSTRAINT "MemberPhoto_kind_check";

CREATE INDEX "MemberPhoto_memberId_uploadedAt_idx"
  ON "MemberPhoto" ("memberId", "uploadedAt");
CREATE INDEX "MemberPhoto_tenantId_idx"
  ON "MemberPhoto" ("tenantId");

-- RLS: mirror the Member table's tenant_isolation policy so the same
-- withTenantContext / withRlsBypass mechanics work transparently.
ALTER TABLE "MemberPhoto" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "MemberPhoto" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "MemberPhoto" AS PERMISSIVE FOR ALL
  USING (
    current_setting('app.bypass_rls', true) = 'on'
    OR "tenantId" = current_setting('app.current_tenant_id', true)
  );
