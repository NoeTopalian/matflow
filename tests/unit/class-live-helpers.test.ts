// T6b (Sean note 7): the lifecycle predicates every reader shares, the
// refusal sentence the member-decided doors read, and the read-time
// classification of classes archived before T6b.

import { describe, it, expect, vi } from "vitest";
import {
  classLifecycle,
  liveClassWhere,
  liveSessionWhere,
  inactiveClassWhere,
  classNotLiveSentence,
} from "@/lib/class-live";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { legacyArchivedAt } from "@/lib/class-lifecycle";

describe("classLifecycle", () => {
  it("active when isActive and not archived", () => {
    expect(classLifecycle({ isActive: true, deletedAt: null })).toBe("active");
  });
  it("paused when isActive is false and deletedAt is null", () => {
    expect(classLifecycle({ isActive: false, deletedAt: null })).toBe("paused");
  });
  it("archived whenever deletedAt is set, whatever isActive says", () => {
    expect(classLifecycle({ isActive: false, deletedAt: new Date() })).toBe("archived");
    expect(classLifecycle({ isActive: true, deletedAt: "2026-10-01T00:00:00.000Z" })).toBe("archived");
  });
});

describe("liveClassWhere / liveSessionWhere", () => {
  it("a live class is active, not archived and not imported history, in this club", () => {
    expect(liveClassWhere("t1")).toEqual({ tenantId: "t1", isActive: true, deletedAt: null, sourceImportJobId: null });
  });
  it("a live session is a live class's session that is not cancelled and not imported", () => {
    expect(liveSessionWhere("t1")).toEqual({
      isCancelled: false,
      sourceImportJobId: null,
      class: { tenantId: "t1", isActive: true, deletedAt: null, sourceImportJobId: null },
    });
  });
  it("the inactive list is paused OR archived, never imported history", () => {
    expect(inactiveClassWhere("t1")).toEqual({
      tenantId: "t1",
      sourceImportJobId: null,
      OR: [{ isActive: false }, { deletedAt: { not: null } }],
    });
  });
});

describe("class_paused refusal", () => {
  it("names the class and says it is paused", () => {
    const r = checkinRefusal({ kind: "class_paused", className: "Fundamentals", state: "paused" });
    expect(r?.status).toBe(409);
    expect(r?.body.reason).toBe("class_paused");
    expect(r?.body.error).toBe(classNotLiveSentence("Fundamentals", "paused"));
    expect(r?.body.error).toMatch(/Fundamentals is paused/);
  });
  it("an archived class says it is no longer on the timetable", () => {
    const r = checkinRefusal({ kind: "class_paused", className: "No-Gi", state: "archived" });
    expect(r?.body.error).toMatch(/No-Gi is no longer on the timetable/);
  });
});

describe("legacyArchivedAt — classes archived before T6b", () => {
  function txWith(rows: { entityId: string; action: string; createdAt: Date }[]) {
    const findMany = vi.fn(async () => rows);
    return { tx: { auditLog: { findMany } } as never, findMany };
  }

  it("reads nothing when there are no candidates", async () => {
    const { tx, findMany } = txWith([]);
    expect((await legacyArchivedAt(tx, "t1", [])).size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("a class whose latest lifecycle row is class.deleted was archived; tenant-scoped query", async () => {
    const at = new Date("2026-09-01T10:00:00Z");
    const { tx, findMany } = txWith([
      { entityId: "c-old", action: "class.deleted", createdAt: at },
      { entityId: "c-old", action: "class.updated", createdAt: new Date("2026-08-01T10:00:00Z") },
    ]);
    const map = await legacyArchivedAt(tx, "t1", ["c-old"]);
    expect(map.get("c-old")).toEqual(at);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: "t1", entityType: "Class", entityId: { in: ["c-old"] } }),
        orderBy: { createdAt: "desc" },
      }),
    );
  });

  it("a class paused after an old archive (latest row class.updated) is genuinely paused", async () => {
    const { tx } = txWith([
      { entityId: "c-1", action: "class.updated", createdAt: new Date("2026-10-17T10:00:00Z") },
      { entityId: "c-1", action: "class.deleted", createdAt: new Date("2026-09-01T10:00:00Z") },
    ]);
    expect((await legacyArchivedAt(tx, "t1", ["c-1"])).has("c-1")).toBe(false);
  });

  it("a paused class with no audit history at all stays paused", async () => {
    const { tx } = txWith([]);
    expect((await legacyArchivedAt(tx, "t1", ["c-2"])).has("c-2")).toBe(false);
  });
});
