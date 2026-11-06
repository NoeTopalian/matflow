/**
 * A class and its mat (plan §5.4). THE WRITE-THROUGH RULE: whenever a write
 * leaves a class on a mat, the same transaction leaves the class's place text
 * equal to that mat's current name. Pinned here on class create and class
 * edit, with the lock order that makes a rename and a class save serial: the
 * club's mats lock is the FIRST statement, and only when the request names a
 * mat.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { ops, tx } = vi.hoisted(() => {
  const ops: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      ops.push(strings.join("?").includes("pg_advisory_xact_lock") ? "mats-lock" : "raw");
      return 1;
    }),
    // The Class row lock that opens the edit transaction.
    $queryRaw: vi.fn(async () => {
      ops.push("class-lock");
      return [{ id: "c1", isActive: true, deletedAt: null, requiredRankId: null, maxRankId: null, matId: null }];
    }),
    mat: { findFirst: vi.fn() },
    tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
    class: { create: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
    classInstance: { createMany: vi.fn(async () => ({ count: 0 })) },
    classRoster: { findMany: vi.fn(async () => []) },
    classSubscription: { findMany: vi.fn(async () => []) },
    classMembershipTier: { findMany: vi.fn(async () => []) },
    rankSystem: { findMany: vi.fn(async () => []) },
    member: { findMany: vi.fn(async () => []) },
  };
  return { ops, tx };
});

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (t: unknown) => unknown) => {
    ops.push("tx");
    return fn(tx);
  }),
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "u1", role: "owner", tenantId: "t1" } })) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => undefined) }));

import { POST } from "@/app/api/classes/route";
import { PATCH } from "@/app/api/classes/[id]/route";
import { logAudit } from "@/lib/audit-log";

const SLOT = { dayOfWeek: 1, startTime: "18:00", endTime: "19:00" };
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://test/api/classes", { method: "POST", body: JSON.stringify({ name: "Gi", duration: 60, schedules: [SLOT], ...body }) }));
const patch = (body: Record<string, unknown>) =>
  PATCH(new Request("http://test/api/classes/c1", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "c1" }) });
/** The class as it is before the edit; the route reads it for ownership, for the snapshot and to answer. */
const classIs = (row: Record<string, unknown>) => {
  const full = { id: "c1", tenantId: "t1", name: "Gi", location: null, matId: null, isActive: true, deletedAt: null, sourceImportJobId: null, schedules: [], allowedTiers: [], rosterMembers: [], ...row };
  tx.class.findFirst.mockResolvedValue(full);
  tx.$queryRaw.mockImplementation(async () => {
    ops.push("class-lock");
    return [{ id: "c1", isActive: true, deletedAt: null, requiredRankId: null, maxRankId: null, matId: full.matId }];
  });
};
const written = () => tx.class.updateMany.mock.calls[0][0].data as Record<string, unknown>;
/** The statements of the transaction that wrote, in order. */
const writeTx = () => ops.slice(ops.lastIndexOf("tx") + 1);

beforeEach(() => {
  vi.clearAllMocks();
  ops.length = 0;
  tx.mat.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) => {
    ops.push("mat-read");
    return where.tenantId === "t1" && where.id === "m1" ? { id: "m1", name: "Mat 1" } : null;
  });
  tx.class.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    ops.push("class-create");
    return { id: "c-new", ...data, schedules: [] };
  });
  tx.class.updateMany.mockImplementation(async () => {
    ops.push("class-update");
    return { count: 1 };
  });
  classIs({});
});

describe("POST /api/classes with a mat", () => {
  it("writes the mat's name as the class's place, over whatever place was sent", async () => {
    const res = await post({ matId: "m1", location: "the old hall" });
    expect(res.status).toBe(201);
    expect(tx.class.create.mock.calls[0][0].data).toMatchObject({ tenantId: "t1", matId: "m1", location: "Mat 1" });
  });

  it("takes the club's mats lock first, then reads the mat, before it writes anything", async () => {
    await post({ matId: "m1" });
    expect(writeTx().slice(0, 3)).toEqual(["mats-lock", "mat-read", "class-create"]);
    expect(tx.mat.findFirst).toHaveBeenLastCalledWith({ where: { id: "m1", tenantId: "t1" }, select: { name: true } });
  });

  it("refuses another club's mat, and one that does not exist, with one sentence and no class", async () => {
    for (const matId of ["theirs", "gone"]) {
      const res = await post({ matId });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That mat is not one of this club's mats." });
    }
    expect(tx.class.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("answers a mat removed between the check and the write as the same 400, not a 500", async () => {
    // The pre-flight sees the mat; the write transaction, under the lock, does not.
    tx.mat.findFirst.mockResolvedValueOnce({ id: "m1" }).mockResolvedValueOnce(null);
    const res = await post({ matId: "m1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That mat is not one of this club's mats." });
    expect(tx.class.create).not.toHaveBeenCalled();
  });

  it("answers the foreign key's own refusal as the same 400", async () => {
    tx.class.create.mockRejectedValueOnce(Object.assign(new Error("fk"), { code: "P2003", meta: { constraint: "Class_matId_fkey" } }));
    const res = await post({ matId: "m1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That mat is not one of this club's mats." });
  });

  it("a class with no mat keeps its typed place and takes no mats lock", async () => {
    for (const body of [{ location: "Sports hall" }, { location: "Sports hall", matId: null }]) {
      ops.length = 0;
      tx.class.create.mockClear();
      expect((await post(body)).status).toBe(201);
      expect(tx.class.create.mock.calls[0][0].data).toMatchObject({ location: "Sports hall" });
      expect(ops).not.toContain("mats-lock");
      expect(ops).not.toContain("mat-read");
    }
  });
});

describe("PATCH /api/classes/[id] with a mat", () => {
  it("putting a class on a mat writes the mat's name over a sent place, under the mats lock taken before the class lock", async () => {
    classIs({ location: "Sports hall" });
    const res = await patch({ matId: "m1", location: "Sports hall" });
    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ matId: "m1", location: "Mat 1" });
    expect(writeTx().slice(0, 3)).toEqual(["mats-lock", "class-lock", "mat-read"]);
    expect(writeTx().indexOf("mat-read")).toBeLessThan(writeTx().indexOf("class-update"));
  });

  it("an edit that does not name a mat, on a class that is on one, leaves the mat's name and takes no mats lock", async () => {
    classIs({ matId: "m1", location: "Mat 1" });
    const res = await patch({ name: "Gi Fundamentals", location: "typed over it" });
    expect(res.status).toBe(200);
    expect(written().name).toBe("Gi Fundamentals");
    // `undefined` is "leave alone" to the database: the place stays the mat's name.
    expect(written().location).toBeUndefined();
    expect(written().matId).toBeUndefined();
    expect(ops).not.toContain("mats-lock");
    expect(ops).not.toContain("mat-read");
  });

  it("an edit that does not name a mat, on a class that is on none, still takes the typed place", async () => {
    classIs({ location: null });
    await patch({ location: "Sports hall" });
    expect(written().location).toBe("Sports hall");
    expect(ops).not.toContain("mats-lock");
  });

  it("taking a class off its mat keeps the sent text, or the old text when none is sent, and takes no mats lock", async () => {
    classIs({ matId: "m1", location: "Mat 1" });
    await patch({ matId: null, location: "Sports hall" });
    expect(written()).toMatchObject({ matId: null, location: "Sports hall" });
    tx.class.updateMany.mockClear();
    await patch({ matId: null });
    expect(written().matId).toBeNull();
    expect(written().location).toBeUndefined();
    tx.class.updateMany.mockClear();
    await patch({ matId: null, location: null });
    expect(written()).toMatchObject({ matId: null, location: null });
    expect(ops).not.toContain("mats-lock");
  });

  it("refuses another club's mat before any write", async () => {
    const res = await patch({ matId: "theirs" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That mat is not one of this club's mats." });
    expect(tx.class.updateMany).not.toHaveBeenCalled();
    expect(ops).not.toContain("class-lock");
  });

  it("answers a mat removed between the pre-flight and the write as the same 400, with nothing written", async () => {
    tx.mat.findFirst.mockResolvedValueOnce({ id: "m1" }).mockResolvedValueOnce(null);
    const res = await patch({ matId: "m1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That mat is not one of this club's mats." });
    expect(tx.class.updateMany).not.toHaveBeenCalled();
  });

  it("records the mat and the place, before and after, for the owner's Undo", async () => {
    // Before: no mat, a typed place. After: on the mat, with its name.
    tx.class.findFirst
      .mockResolvedValueOnce({ id: "c1", sourceImportJobId: null, requiredRankId: null, maxRankId: null })
      .mockResolvedValueOnce({ id: "c1", tenantId: "t1", name: "Gi", location: "Sports hall", matId: null, isActive: true, deletedAt: null })
      .mockResolvedValueOnce({ id: "c1", tenantId: "t1", name: "Gi", location: "Mat 1", matId: "m1", isActive: true, deletedAt: null, schedules: [], allowedTiers: [], rosterMembers: [] });
    await patch({ matId: "m1" });
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "class.updated",
      metadata: expect.objectContaining({ before: { matId: null, location: "Sports hall" }, after: { matId: "m1", location: "Mat 1" } }),
    }));
  });

  it("refuses a matId that is not a string", async () => {
    expect((await patch({ matId: 7 })).status).toBe(400);
    expect((await patch({ matId: "" })).status).toBe(400);
    expect(tx.class.updateMany).not.toHaveBeenCalled();
  });
});
