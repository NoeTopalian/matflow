-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "preferredPaymentMethod" TEXT NOT NULL DEFAULT 'card';

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "acceptsBacs" BOOLEAN NOT NULL DEFAULT false;
