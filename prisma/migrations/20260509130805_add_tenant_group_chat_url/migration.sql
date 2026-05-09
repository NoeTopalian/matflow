-- Sub-project #5 (2026-05-09): WhatsApp / Telegram / Discord group invite URL.
-- Shown alongside other socials in the member-portal gym card.
ALTER TABLE "Tenant" ADD COLUMN "groupChatUrl" TEXT;
