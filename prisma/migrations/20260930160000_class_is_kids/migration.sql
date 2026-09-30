-- All-or-nothing (see tests/unit/migrations-are-atomic.test.ts).
BEGIN;

-- A kids class: adults refused at self/kiosk check-in, asked about at the
-- register. Constant default: metadata-only on PostgreSQL 11+.
ALTER TABLE "Class" ADD COLUMN "isKids" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
