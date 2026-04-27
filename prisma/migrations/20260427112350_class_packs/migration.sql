-- CreateTable
CREATE TABLE "ClassPack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "totalCredits" INTEGER NOT NULL,
    "validityDays" INTEGER NOT NULL,
    "pricePence" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GBP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "stripePriceId" TEXT,
    "stripeProductId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClassPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberClassPack" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "packId" TEXT NOT NULL,
    "creditsRemaining" INTEGER NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "stripePaymentIntentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',

    CONSTRAINT "MemberClassPack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassPackRedemption" (
    "id" TEXT NOT NULL,
    "memberPackId" TEXT NOT NULL,
    "attendanceRecordId" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassPackRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClassPack_tenantId_isActive_idx" ON "ClassPack"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MemberClassPack_stripePaymentIntentId_key" ON "MemberClassPack"("stripePaymentIntentId");

-- CreateIndex
CREATE INDEX "MemberClassPack_memberId_status_idx" ON "MemberClassPack"("memberId", "status");

-- CreateIndex
CREATE INDEX "MemberClassPack_tenantId_expiresAt_idx" ON "MemberClassPack"("tenantId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ClassPackRedemption_attendanceRecordId_key" ON "ClassPackRedemption"("attendanceRecordId");

-- CreateIndex
CREATE INDEX "ClassPackRedemption_memberPackId_idx" ON "ClassPackRedemption"("memberPackId");

-- AddForeignKey
ALTER TABLE "MemberClassPack" ADD CONSTRAINT "MemberClassPack_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberClassPack" ADD CONSTRAINT "MemberClassPack_packId_fkey" FOREIGN KEY ("packId") REFERENCES "ClassPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassPackRedemption" ADD CONSTRAINT "ClassPackRedemption_memberPackId_fkey" FOREIGN KEY ("memberPackId") REFERENCES "MemberClassPack"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
