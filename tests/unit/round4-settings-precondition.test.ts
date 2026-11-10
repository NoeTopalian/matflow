// Round 4 (10 Nov 2026), CONCURRENCY-1: the per-field settings precondition.
import { describe, it, expect } from "vitest";
import { resolveSettingsPreconditions, sameSettingValue } from "@/lib/settings-precondition";

describe("sameSettingValue", () => {
  it("treats null and absent alike, ignores JSON key order, and compares text exactly", () => {
    expect(sameSettingValue(null, undefined)).toBe(true);
    expect(sameSettingValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameSettingValue("Waiver text", "Waiver text ")).toBe(false);
    expect(sameSettingValue(0, null)).toBe(false);
    expect(sameSettingValue(false, null)).toBe(false);
  });
});

describe("resolveSettingsPreconditions", () => {
  const stored = { primaryColor: "#111111", name: "Club", waiverContent: null, checkinWindow: { before: 30, after: 15 } };

  it("writes a field whose stored value is the expected one", () => {
    expect(resolveSettingsPreconditions(stored, { primaryColor: "#aa0000" }, { primaryColor: "#111111" }))
      .toEqual({ apply: { primaryColor: "#aa0000" }, conflicts: [] });
  });

  it("a retried save whose value is already stored writes nothing and is not a conflict", () => {
    expect(resolveSettingsPreconditions({ ...stored, primaryColor: "#aa0000" }, { primaryColor: "#aa0000" }, { primaryColor: "#111111" }))
      .toEqual({ apply: {}, conflicts: [] });
  });

  it("any other stored value is a conflict naming it, and nothing is applied", () => {
    const r = resolveSettingsPreconditions({ ...stored, primaryColor: "#00bb00" }, { primaryColor: "#aa0000", name: "New" }, { primaryColor: "#111111", name: "Club" });
    expect(r.conflicts).toEqual([{ field: "primaryColor", current: "#00bb00" }]);
  });

  it("a field sent without an expected value is written as before (last write wins)", () => {
    expect(resolveSettingsPreconditions(stored, { name: "New", primaryColor: "#aa0000" }, { primaryColor: "#111111" }).apply)
      .toEqual({ name: "New", primaryColor: "#aa0000" });
  });

  it("JSON settings compare by content: the same window in another key order is the expected one", () => {
    expect(resolveSettingsPreconditions(stored, { checkinWindow: { before: 45, after: 15 } }, { checkinWindow: { after: 15, before: 30 } }).apply)
      .toEqual({ checkinWindow: { before: 45, after: 15 } });
  });

  it("an empty stored text and an expected null are the same (a waiver never set)", () => {
    expect(resolveSettingsPreconditions(stored, { waiverContent: "New" }, { waiverContent: null }).apply).toEqual({ waiverContent: "New" });
  });
});
