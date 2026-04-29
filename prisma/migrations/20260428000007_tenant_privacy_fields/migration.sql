-- Sprint 3 L: Tenant privacy fields (member-portal-only display, https-only validated server-side).

ALTER TABLE "Tenant" ADD COLUMN "privacyContactEmail" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "privacyPolicyUrl" TEXT;
