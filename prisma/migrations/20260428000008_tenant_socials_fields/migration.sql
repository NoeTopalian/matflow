-- Sprint 3 L: Tenant social media + website URLs (https-only validated server-side).

ALTER TABLE "Tenant" ADD COLUMN "instagramUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "facebookUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "tiktokUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "youtubeUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "twitterUrl" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "websiteUrl" TEXT;
