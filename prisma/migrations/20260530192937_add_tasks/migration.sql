-- Team Tasks MVP v1: user-authored to-do items staff can assign to each other.
-- Status values are String with a CHECK constraint to match the project pattern
-- (see User.role, Member.status).

CREATE TABLE "Task" (
  "id"           TEXT NOT NULL,
  "tenantId"     TEXT NOT NULL,
  "createdById"  TEXT NOT NULL,
  "assignedToId" TEXT NOT NULL,
  "title"        VARCHAR(140) NOT NULL,
  "status"       TEXT NOT NULL DEFAULT 'open',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"  TIMESTAMP(3),
  CONSTRAINT "Task_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Task_status_check" CHECK ("status" IN ('open', 'done'))
);

ALTER TABLE "Task" ADD CONSTRAINT "Task_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Task" ADD CONSTRAINT "Task_assignedToId_fkey"
  FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "Task_tenantId_status_assignedToId_idx"
  ON "Task"("tenantId", "status", "assignedToId");
CREATE INDEX "Task_tenantId_createdAt_idx"
  ON "Task"("tenantId", "createdAt");
