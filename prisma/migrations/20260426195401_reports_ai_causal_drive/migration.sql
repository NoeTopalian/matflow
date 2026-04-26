-- CreateTable
CREATE TABLE "Initiative" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Initiative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InitiativeAttachment" (
    "id" TEXT NOT NULL,
    "initiativeId" TEXT NOT NULL,
    "blobUrl" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InitiativeAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoogleDriveConnection" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "folderId" TEXT NOT NULL,
    "folderName" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'drive.readonly',
    "connectedById" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastIndexedAt" TIMESTAMP(3),

    CONSTRAINT "GoogleDriveConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexedDriveFile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "modifiedAt" TIMESTAMP(3) NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contentText" TEXT,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IndexedDriveFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyReport" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "generationType" TEXT NOT NULL,
    "triggeredById" TEXT,
    "modelUsed" TEXT NOT NULL,
    "costPence" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "wins" TEXT NOT NULL,
    "watchOuts" TEXT NOT NULL,
    "recommendations" TEXT NOT NULL,
    "metricSnapshot" JSONB NOT NULL,
    "driveFilesUsed" JSONB,
    "initiativesUsed" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Initiative_tenantId_startDate_idx" ON "Initiative"("tenantId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "GoogleDriveConnection_tenantId_key" ON "GoogleDriveConnection"("tenantId");

-- CreateIndex
CREATE INDEX "IndexedDriveFile_tenantId_idx" ON "IndexedDriveFile"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedDriveFile_tenantId_driveFileId_key" ON "IndexedDriveFile"("tenantId", "driveFileId");

-- CreateIndex
CREATE INDEX "MonthlyReport_tenantId_periodStart_idx" ON "MonthlyReport"("tenantId", "periodStart");

-- AddForeignKey
ALTER TABLE "InitiativeAttachment" ADD CONSTRAINT "InitiativeAttachment_initiativeId_fkey" FOREIGN KEY ("initiativeId") REFERENCES "Initiative"("id") ON DELETE CASCADE ON UPDATE CASCADE;
