-- CreateTable
CREATE TABLE "ClassRoster" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "addedByUserId" TEXT,

    CONSTRAINT "ClassRoster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClassRoster_classId_memberId_key" ON "ClassRoster"("classId", "memberId");

-- CreateIndex
CREATE INDEX "ClassRoster_tenantId_classId_idx" ON "ClassRoster"("tenantId", "classId");

-- CreateIndex
CREATE INDEX "ClassRoster_tenantId_memberId_idx" ON "ClassRoster"("tenantId", "memberId");

-- AddForeignKey
ALTER TABLE "ClassRoster" ADD CONSTRAINT "ClassRoster_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassRoster" ADD CONSTRAINT "ClassRoster_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassRoster" ADD CONSTRAINT "ClassRoster_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassRoster" ADD CONSTRAINT "ClassRoster_addedByUserId_fkey" FOREIGN KEY ("addedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
