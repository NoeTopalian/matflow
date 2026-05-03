-- RB-005: Member notification preferences (per-channel opt-out from /member/profile).
-- All three default to true (existing rows opt in by default; UI lets members opt out).
ALTER TABLE "Member"
  ADD COLUMN "classReminders" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "beltPromotions" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "gymAnnouncements" BOOLEAN NOT NULL DEFAULT true;
