-- B10 — Persist /apply form submissions instead of just console.log-ing them.
-- Status transitions: new → contacted → approved | rejected.
-- IP and user-agent are captured for spam triage.

CREATE TABLE "GymApplication" (
  "id"          TEXT PRIMARY KEY,
  "gymName"     TEXT NOT NULL,
  "contactName" TEXT NOT NULL,
  "email"       TEXT NOT NULL,
  "phone"       TEXT,
  "discipline"  TEXT NOT NULL,
  "memberCount" TEXT NOT NULL,
  "notes"       TEXT,
  "status"      TEXT NOT NULL DEFAULT 'new',
  "ipAddress"   TEXT,
  "userAgent"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

CREATE INDEX "GymApplication_status_createdAt_idx" ON "GymApplication" ("status", "createdAt");
CREATE INDEX "GymApplication_email_idx" ON "GymApplication" ("email");

ALTER TABLE "GymApplication" ADD CONSTRAINT "GymApplication_status_check"
  CHECK ("status" IN ('new', 'contacted', 'approved', 'rejected')) NOT VALID;
ALTER TABLE "GymApplication" VALIDATE CONSTRAINT "GymApplication_status_check";
