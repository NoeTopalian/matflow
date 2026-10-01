import { describe, it, expect } from "vitest";
import { snapshotDiff, updateMetadata } from "@/lib/audit-snapshot";

describe("lib/audit-snapshot", () => {
  it("keeps only the fields that changed, dates as ISO", () => {
    const before = { name: "A", phone: "1", nextDueAt: new Date("2026-10-01T00:00:00Z"), secret: "x" };
    const after = { name: "B", phone: "1", nextDueAt: new Date("2026-11-01T00:00:00Z"), secret: "y" };
    const d = snapshotDiff(before, after, ["name", "phone", "nextDueAt"]);
    expect(d.changed).toEqual(["name", "nextDueAt"]);
    expect(d.before).toEqual({ name: "A", nextDueAt: "2026-10-01T00:00:00.000Z" });
    expect(d.after).toEqual({ name: "B", nextDueAt: "2026-11-01T00:00:00.000Z" });
    expect("secret" in d.before).toBe(false);
  });

  it("null and undefined compare equal; a cleared field is recorded as null", () => {
    const d = snapshotDiff({ a: undefined, b: "x" }, { a: null, b: null }, ["a", "b"]);
    expect(d.changed).toEqual(["b"]);
    expect(d.before).toEqual({ b: "x" });
    expect(d.after).toEqual({ b: null });
  });

  it("updateMetadata omits before/after when nothing changed", () => {
    expect(updateMetadata(["name"], { name: "A" }, { name: "A" }, ["name"])).toEqual({ fields: ["name"] });
    expect(updateMetadata(["name"], { name: "A" }, { name: "B" }, ["name"])).toEqual({ fields: ["name"], before: { name: "A" }, after: { name: "B" } });
  });

  it("missing rows produce an empty diff rather than throwing", () => {
    expect(snapshotDiff(null, { a: 1 }, ["a"]).changed).toEqual([]);
  });
});
