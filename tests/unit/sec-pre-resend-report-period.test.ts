// Pre-Resend adversarial pass (W6, 28 Oct 2026): the Reports / Analysis /
// Members drill-through period parameters (`period`, `from`, `to`, `weeks`,
// `month`) are attacker-chosen URL text. lib/report-period.ts promises
// "Never throws; anything invalid is the default": these cases hold it to
// that for hostile input, and check the cache key stays bounded and
// club-agnostic in shape.

import { describe, it, expect } from "vitest";
import { resolveReportPeriod, reportPeriodCacheKey, rangeAsMonthWindow, MAX_CUSTOM_MONTHS } from "@/lib/report-period";

const NOW = new Date("2026-10-28T12:00:00Z");
const ZONES = ["Europe/London", "Pacific/Kiritimati", "Pacific/Pago_Pago", "Not/AZone", null];

const HOSTILE: Array<Record<string, string | null | undefined>> = [
  { period: "custom", from: "0001-01", to: "0001-12" },
  { period: "custom", from: "0000-01", to: "0000-06" },
  { period: "custom", from: "0099-01", to: "0100-12" },
  { period: "custom", from: "1899-12", to: "1900-01" },
  { period: "custom", from: "1970-01", to: "1970-01" },
  { period: "custom", from: "9999-01", to: "9999-12" },
  { period: "custom", from: "2026-10", to: "2024-10" },
  { period: "custom", from: "2024-09", to: "2026-10" },
  { period: "custom", from: "2026-13", to: "2026-14" },
  { period: "custom", from: "2026-1", to: "2026-10" },
  { period: "custom", from: "2026-10'; DROP TABLE x;--", to: "2026-10" },
  { period: "custom", from: "x".repeat(10_000), to: "2026-10" },
  { period: "custom" },
  { period: "__proto__" },
  { period: "constructor" },
  { period: "12m", from: "0001-01", to: "0001-01" },
  { weeks: "1e309" },
  { weeks: "-Infinity" },
  { weeks: "NaN" },
  { weeks: "-5" },
  { weeks: "0x10" },
  { weeks: " " },
];

describe("W6 report period: hostile URL parameters", () => {
  it("never throws, and always resolves to a run of whole months ending no later than this month", () => {
    for (const tz of ZONES) {
      for (const p of HOSTILE) {
        let r: ReturnType<typeof resolveReportPeriod> | undefined;
        expect(() => { r = resolveReportPeriod(p as never, NOW, tz); }, `${JSON.stringify(p)} ${tz}`).not.toThrow();
        expect(r!.months.length).toBeGreaterThanOrEqual(1);
        expect(r!.months.length).toBeLessThanOrEqual(MAX_CUSTOM_MONTHS);
        expect(r!.fromMonth <= r!.toMonth).toBe(true);
        expect(r!.toMonth <= "2026-10").toBe(true);
        expect(Number.isFinite(new Date(r!.start).getTime())).toBe(true);
        expect(Number.isFinite(new Date(r!.end).getTime())).toBe(true);
        expect(Number.isFinite(new Date(r!.previous.start).getTime())).toBe(true);
        expect(() => rangeAsMonthWindow(r!)).not.toThrow();
      }
    }
  });

  it("a run longer than the cap, or ending after this month, is refused to the default", () => {
    expect(resolveReportPeriod({ period: "custom", from: "2024-09", to: "2026-10" }, NOW, "UTC").key).not.toBe("custom");
    expect(resolveReportPeriod({ period: "custom", from: "2024-11", to: "2026-10" }, NOW, "UTC").key).toBe("custom");
    expect(resolveReportPeriod({ period: "custom", from: "2026-10", to: "2026-11" }, NOW, "UTC").key).not.toBe("custom");
  });

  it("the cache key is short and contains nothing but a preset name or two month keys", () => {
    for (const p of HOSTILE) {
      const k = reportPeriodCacheKey(p as never);
      expect(k.length).toBeLessThanOrEqual(22);
      expect(k).toMatch(/^(this-month|last-month|3m|6m|12m|custom:\d{4}-\d{2}:\d{4}-\d{2})$/);
    }
  });
});
