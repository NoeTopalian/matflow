-- AlterTable
ALTER TABLE "Member" ADD COLUMN     "membershipTierId" TEXT;

-- CreateIndex
CREATE INDEX "Member_membershipTierId_idx" ON "Member"("membershipTierId");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_membershipTierId_fkey" FOREIGN KEY ("membershipTierId") REFERENCES "MembershipTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
