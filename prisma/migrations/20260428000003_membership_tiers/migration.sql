-- CreateTable
CREATE TABLE "MembershipTier" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "pricePence" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "billingCycle" TEXT NOT NULL DEFAULT 'monthly',
    "maxClassesPerWeek" INTEGER,
    "isKids" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MembershipTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MembershipTier_tenantId_isActive_idx" ON "MembershipTier"("tenantId", "isActive");

-- AddForeignKey
ALTER TABLE "MembershipTier" ADD CONSTRAINT "MembershipTier_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
