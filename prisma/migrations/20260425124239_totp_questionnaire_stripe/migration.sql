-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "dateOfBirth" TIMESTAMP(3),
ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "medicalConditions" TEXT,
ADD COLUMN     "stripeCustomerId" TEXT,
ADD COLUMN     "stripeSubscriptionId" TEXT,
ADD COLUMN     "waiverAccepted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "waiverAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "waiverIpAddress" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "onboardingAnswers" JSONB,
ADD COLUMN     "stripeAccountId" TEXT,
ADD COLUMN     "stripeConnected" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecret" TEXT;
