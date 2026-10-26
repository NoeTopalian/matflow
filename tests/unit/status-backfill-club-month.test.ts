/**
 * Review F4 (batch-c review, 23 Oct 2026): the back-fill's month rule is the
 * Reports month rule. lib/status-backfill.ts used to keep its own clubMonthKey
 * (built on zoneOffsetMs) under the same name as lib/club-month.ts's; the
 * preview's byMonth, the apply-time "months match preview" check and
 * detectBackfill now bucket by the one rule Reports uses, so the two cannot
 * drift apart.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clubMonthKey as backfillMonthKey } from "@/lib/status-backfill";
import { clubMonthKey } from "@/lib/club-month";

describe("status back-fill month rule (review F4)", () => {
  it("is lib/club-month's clubMonthKey, not a second copy", () => {
    expect(backfillMonthKey).toBe(clubMonthKey);
  });

  it("lib/status-backfill.ts defines no month rule of its own", () => {
    const src = readFileSync(join(process.cwd(), "lib", "status-backfill.ts"), "utf8");
    expect(src).not.toMatch(/function\s+clubMonthKey\s*\(/);
  });

  it("buckets a month boundary the same way in both zones that matter", () => {
    // 31 Oct 23:30 UTC: still October in London (GMT), already November in Auckland.
    const at = new Date("2026-10-31T23:30:00.000Z");
    expect(backfillMonthKey(at, "Europe/London")).toBe("2026-10");
    expect(backfillMonthKey(at, "Pacific/Auckland")).toBe("2026-11");
  });
});
