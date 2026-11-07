/**
 * The class form's Location by name (Noe, 7 Nov 2026: "save whats written into
 * it as a Location"). POST /api/classes and PATCH /api/classes/[id] take
 * `matName`: the class goes on the club's mat of that name whatever its
 * capitals and spacing, and a mat is added when there is none, under the mats
 * lock and in the SAME transaction as the class write, recorded as
 * `mat.create` exactly as POST /api/mats records one. A mat added this way
 * takes every other class of the club that types the name, in the same
 * transaction, recorded as adopt records it. Past the twelfth mat the
 * save is refused in plain words and nothing is written. A MatFlow support
 * session (which may edit a class but not set up mats) keeps a new name as a
 * typed place. Another club's mat id is refused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { ops, tx, session } = vi.hoisted(() => {
  const ops: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      ops.push(strings.join("?").includes("pg_advisory_xact_lock") ? "mats-lock" : "raw");
      return 1;
    }),
    $queryRaw: vi.fn(async () => {
      ops.push("class-lock");
      return [{ id: "c1", isActive: true, deletedAt: null, requiredRankId: null, maxRankId: null, matId: null }];
    }),
    mat: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    tenant: { findUnique: vi.fn(async () => ({ timezone: "Europe/London" })) },
    class: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    classInstance: { createMany: vi.fn(async () => ({ count: 0 })) },
    classRoster: { findMany: vi.fn(async () => []) },
    classSubscription: { findMany: vi.fn(async () => []) },
    classMembershipTier: { findMany: vi.fn(async () => []) },
    rankSystem: { findMany: vi.fn(async () => []) },
    member: { findMany: vi.fn(async () => []) },
  };
  const session = { user: { id: "u1", role: "owner", tenantId: "t1" } as Record<string, unknown> };
  return { ops, tx, session };
});

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (t: unknown) => unknown) => {
    ops.push("tx");
    return fn(tx);
  }),
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session) }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (args: { action: string; tx?: unknown }) => {
    ops.push(`audit:${args.action}${args.tx ? ":in-tx" : ""}`);
  }),
}));

import { POST } from "@/app/api/classes/route";
import { PATCH } from "@/app/api/classes/[id]/route";
import { logAudit } from "@/lib/audit-log";
import { LOCATION_ERRORS, MAT_LIMIT } from "@/lib/mats";

type MatRow = { id: string; tenantId: string; name: string; nameKey: string; sortOrder: number };
let clubMats: MatRow[] = [];
/** Classes of both clubs on no mat, with what they type (what the attach step reads). */
let typedClasses: { id: string; tenantId: string; location: string | null; matId: string | null; sourceImportJobId: string | null }[] = [];
const mat = (id: string, name: string, sortOrder: number, tenantId = "t1"): MatRow => ({ id, tenantId, name, nameKey: name.toLowerCase(), sortOrder });

const SLOT = { dayOfWeek: 1, startTime: "18:00", endTime: "19:00" };
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://test/api/classes", { method: "POST", body: JSON.stringify({ name: "Gi", duration: 60, schedules: [SLOT], ...body }) }));
const patch = (body: Record<string, unknown>) =>
  PATCH(new Request("http://test/api/classes/c1", { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: "c1" }) });
/** The statements of the last transaction, in order. */
const lastTx = () => ops.slice(ops.lastIndexOf("tx") + 1);
const created = () => tx.class.create.mock.calls[0][0].data as Record<string, unknown>;
/** The write of the class being saved (an attach of other classes, when there is one, is a separate call). */
const written = () => (tx.class.updateMany.mock.calls.find((c) => (c[0] as { where: { id?: unknown } }).where.id === "c1") ?? tx.class.updateMany.mock.calls[0])[0].data as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  ops.length = 0;
  session.user = { id: "u1", role: "owner", tenantId: "t1" };
  clubMats = [mat("m1", "Mat 1", 0), mat("theirs", "Mat 9", 0, "t2")];
  tx.mat.findMany.mockImplementation(async ({ where }: { where: { tenantId: string } }) => {
    ops.push("mats-read");
    return clubMats.filter((m) => m.tenantId === where.tenantId).map(({ id, name, nameKey, sortOrder }) => ({ id, name, nameKey, sortOrder }));
  });
  tx.mat.findFirst.mockImplementation(async ({ where }: { where: { id: string; tenantId: string } }) => {
    ops.push("mat-read");
    const m = clubMats.find((x) => x.id === where.id && x.tenantId === where.tenantId);
    return m ? { id: m.id, name: m.name } : null;
  });
  tx.mat.create.mockImplementation(async ({ data }: { data: Omit<MatRow, "id"> }) => {
    ops.push("mat-create");
    const row = { id: "m-new", ...data };
    clubMats.push(row);
    return { id: row.id, name: row.name };
  });
  tx.class.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    ops.push("class-create");
    return { id: "c-new", ...data, schedules: [] };
  });
  tx.class.updateMany.mockImplementation(async () => {
    ops.push("class-update");
    return { count: 1 };
  });
  const row = { id: "c1", tenantId: "t1", name: "Gi", location: "Sports hall", matId: null, isActive: true, deletedAt: null, sourceImportJobId: null, schedules: [], allowedTiers: [], rosterMembers: [] };
  tx.class.findFirst.mockResolvedValue(row);
  typedClasses = [];
  tx.class.findMany.mockImplementation(async ({ where }: { where: { tenantId: string; matId: null; sourceImportJobId: null } }) => {
    ops.push("typed-read");
    return typedClasses
      .filter((c) => c.tenantId === where.tenantId && c.matId === null && c.sourceImportJobId === null && c.location !== null)
      .map(({ id, location }) => ({ id, location }));
  });
});

describe("POST /api/classes with a Location by name", () => {
  it("a new name adds one mat and puts the class on it, in one transaction: mats lock, then the mat and its audit row, then the class", async () => {
    const res = await post({ matName: "  Mat   2 " });
    expect(res.status).toBe(201);
    expect(tx.mat.create).toHaveBeenCalledTimes(1);
    expect(tx.mat.create.mock.calls[0][0].data).toEqual({ tenantId: "t1", name: "Mat 2", nameKey: "mat 2", sortOrder: 1 });
    expect(created()).toMatchObject({ tenantId: "t1", matId: "m-new", location: "Mat 2" });
    expect(created()).not.toHaveProperty("matName");
    // One transaction holds all of it (the only one this request opened).
    expect(ops.filter((o) => o === "tx")).toHaveLength(1);
    expect(lastTx().slice(0, 6)).toEqual(["mats-lock", "mats-read", "mat-create", "audit:mat.create:in-tx", "typed-read", "class-create"]);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "u1", action: "mat.create", entityType: "Mat", entityId: "m-new", metadata: { name: "Mat 2" },
    }));
    expect((await res.json()).locationAdded).toEqual({ id: "m-new", name: "Mat 2", classIds: [], savedAt: expect.any(String) });
  });

  it("a new mat takes every class of the club that types the name, in the same transaction; other clubs' classes and other names are untouched", async () => {
    typedClasses = [
      { id: "k1", tenantId: "t1", location: "Upstairs", matId: null, sourceImportJobId: null },
      { id: "k2", tenantId: "t1", location: "  upstairs ", matId: null, sourceImportJobId: null },
      { id: "k3", tenantId: "t1", location: "Upstairs room", matId: null, sourceImportJobId: null },
      { id: "k4", tenantId: "t1", location: "Upstairs", matId: null, sourceImportJobId: "import-1" },
      { id: "theirs", tenantId: "t2", location: "Upstairs", matId: null, sourceImportJobId: null },
    ];
    const res = await post({ matName: "Upstairs" });
    expect(res.status).toBe(201);
    expect(ops.filter((o) => o === "tx")).toHaveLength(1);
    const attach = tx.class.updateMany.mock.calls.map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> });
    expect(attach).toEqual([{ where: { tenantId: "t1", id: { in: ["k1", "k2"] }, matId: null }, data: { matId: "m-new", location: "Upstairs" } }]);
    expect(lastTx().slice(0, 8)).toEqual(["mats-lock", "mats-read", "mat-create", "audit:mat.create:in-tx", "typed-read", "class-update", "audit:mat.adopt:in-tx", "class-create"]);
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", action: "mat.adopt", entityType: "Tenant", entityId: "t1",
      metadata: { mats: [{ id: "m-new", name: "Upstairs", created: false, classIds: ["k1", "k2"] }] },
    }));
    expect(created()).toMatchObject({ matId: "m-new", location: "Upstairs" });
    expect((await res.json()).locationAdded).toMatchObject({ id: "m-new", name: "Upstairs", classIds: ["k1", "k2"] });
  });

  it("a mat that is already there takes only the class being saved", async () => {
    typedClasses = [{ id: "k1", tenantId: "t1", location: "Mat 1", matId: null, sourceImportJobId: null }];
    expect((await post({ matName: "mat 1" })).status).toBe(201);
    expect(tx.class.findMany).not.toHaveBeenCalled();
    expect(tx.class.updateMany).not.toHaveBeenCalled();
  });

  it("a name that matches a mat whatever its capitals and spacing reuses that mat and adds none", async () => {
    const res = await post({ matName: " mat    1" });
    expect(res.status).toBe(201);
    expect(tx.mat.create).not.toHaveBeenCalled();
    expect(created()).toMatchObject({ matId: "m1", location: "Mat 1" });
    expect(ops).not.toContain("audit:mat.create:in-tx");
    expect((await res.json()).locationAdded).toBeNull();
  });

  it(`past ${MAT_LIMIT} mats: a plain refusal beside the field, and nothing is written`, async () => {
    clubMats = Array.from({ length: MAT_LIMIT }, (_, i) => mat(`m${i}`, `Mat ${i + 1}`, i));
    const res = await post({ matName: "Upstairs" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: LOCATION_ERRORS.limit, reason: "location" });
    expect(tx.mat.create).not.toHaveBeenCalled();
    expect(tx.class.create).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("refuses a blank name, an over-long one, and a mat id with a name, before anything is read", async () => {
    for (const [body, error] of [
      [{ matName: "   " }, LOCATION_ERRORS.empty],
      [{ matName: "x".repeat(25) }, LOCATION_ERRORS.tooLong],
      [{ matName: "Mat 2", matId: "m1" }, LOCATION_ERRORS.both],
    ] as const) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error, reason: "location" });
    }
    expect(ops).toEqual([]);
  });

  it("refuses another club's mat id, and writes no class", async () => {
    const res = await post({ matId: "theirs" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That mat is not one of this club's mats." });
    expect(tx.class.create).not.toHaveBeenCalled();
  });

  it("another club's mat of the same name is never used: the caller's club gets its own", async () => {
    const res = await post({ matName: "Mat 9" });
    expect(res.status).toBe(201);
    expect(tx.mat.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }));
    expect(created()).toMatchObject({ matId: "m-new", location: "Mat 9" });
  });

  it("a coach cannot create a class at all: 403 and nothing read or written", async () => {
    session.user = { id: "u2", role: "coach", tenantId: "t1" };
    const res = await post({ matName: "Mat 2" });
    expect(res.status).toBe(403);
    expect(ops).toEqual([]);
  });

  it("a support session keeps a new name as the class's typed place, adds no mat and is not refused; a saved one it uses", async () => {
    session.user = { id: "u1", role: "owner", tenantId: "t1", impersonatedBy: "op-1" };
    const res = await post({ matName: "The beach" });
    expect(res.status).toBe(201);
    expect(tx.mat.create).not.toHaveBeenCalled();
    expect(created()).toMatchObject({ matId: null, location: "The beach" });
    tx.class.create.mockClear();
    expect((await post({ matName: "mat 1" })).status).toBe(201);
    expect(created()).toMatchObject({ matId: "m1", location: "Mat 1" });
    expect(tx.mat.create).not.toHaveBeenCalled();
  });

  it("a support session may keep a typed place longer than a mat name", async () => {
    session.user = { id: "u1", role: "owner", tenantId: "t1", impersonatedBy: "op-1" };
    const res = await post({ matName: "The sports hall down the road" });
    expect(res.status).toBe(201);
    expect(created()).toMatchObject({ matId: null, location: "The sports hall down the road" });
  });

  it("a mat-name clash on the unique index is a Location refusal; any other unique refusal is not", async () => {
    tx.mat.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002", meta: { modelName: "Mat", target: ["tenantId", "nameKey"] } }));
    const clash = await post({ matName: "Cage" });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ error: "Couldn't save the location. Try again.", reason: "location" });
    // The same code from another table, on a save that also names a location: not the Location's to explain.
    tx.class.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002", meta: { modelName: "ClassInstance", target: ["classId", "date", "startTime"] } }));
    const other = await post({ matName: "Mat 1" });
    expect(other.status).toBe(500);
    expect(await other.json()).toEqual({ error: "Failed to create class" });
  });
});

describe("PATCH /api/classes/[id] with a Location by name", () => {
  it("refuses a mat id with a name, a blank name and an over-long one, before anything is read", async () => {
    for (const [body, error] of [
      [{ matName: "Mat 2", matId: "m1" }, LOCATION_ERRORS.both],
      [{ matName: "\u200B " }, LOCATION_ERRORS.empty],
      [{ matName: "x".repeat(25) }, LOCATION_ERRORS.tooLong],
    ] as const) {
      const res = await patch(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error, reason: "location" });
    }
    expect(ops).toEqual([]);
  });

  it("a mat-name clash on the unique index is a Location refusal; any other unique refusal is not", async () => {
    // The pg driver adapter's shape: no model name, the index's fields under driverAdapterError.
    tx.mat.create.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002", meta: { driverAdapterError: { cause: { constraint: { fields: ["tenantId", "nameKey"] } } } } }));
    const clash = await patch({ matName: "Cage" });
    expect(clash.status).toBe(409);
    expect(await clash.json()).toEqual({ error: "Couldn't save the location. Try again.", reason: "location" });
    tx.class.updateMany.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002", meta: { modelName: "Class", target: ["id"] } }));
    const other = await patch({ matName: "Mat 1" });
    expect(other.status).toBe(500);
    expect(await other.json()).toEqual({ error: "Failed to update class" });
  });

  it("a support session naming an existing mat puts the class on it", async () => {
    session.user = { id: "u1", role: "owner", tenantId: "t1", impersonatedBy: "op-1" };
    const res = await patch({ matName: "mat 1" });
    expect(res.status).toBe(200);
    expect(tx.mat.create).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ matId: "m1", location: "Mat 1" });
  });

  it("a new mat from an edit takes the club's other classes that type the name, not the class being saved twice", async () => {
    typedClasses = [
      { id: "c1", tenantId: "t1", location: "Cage", matId: null, sourceImportJobId: null },
      { id: "k1", tenantId: "t1", location: "cage", matId: null, sourceImportJobId: null },
      { id: "theirs", tenantId: "t2", location: "Cage", matId: null, sourceImportJobId: null },
    ];
    const res = await patch({ matName: "Cage" });
    expect(res.status).toBe(200);
    const calls = tx.class.updateMany.mock.calls.map((c) => c[0] as { where: Record<string, unknown>; data: Record<string, unknown> });
    expect(calls[0]).toEqual({ where: { tenantId: "t1", id: { in: ["k1"] }, matId: null }, data: { matId: "m-new", location: "Cage" } });
    expect(written()).toMatchObject({ matId: "m-new", location: "Cage" });
    expect(calls).toHaveLength(2);
    expect((await res.json()).locationAdded).toMatchObject({ id: "m-new", name: "Cage", classIds: ["k1"] });
  });

  it("a new name adds one mat and puts only this class on it, in the edit's transaction, before the class is written", async () => {
    const res = await patch({ matName: "Mat 2" });
    expect(res.status).toBe(200);
    expect(tx.mat.create).toHaveBeenCalledTimes(1);
    expect(written()).toMatchObject({ matId: "m-new", location: "Mat 2" });
    // Only this class: one update, scoped to its id.
    expect(tx.class.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.class.updateMany.mock.calls[0][0].where).toEqual({ id: "c1", tenantId: "t1" });
    const t = lastTx();
    expect(t.slice(0, 2)).toEqual(["mats-lock", "class-lock"]);
    expect(t.indexOf("mat-create")).toBeLessThan(t.indexOf("class-update"));
    expect(t).toContain("audit:mat.create:in-tx");
    expect((await res.json()).locationAdded).toEqual({ id: "m-new", name: "Mat 2", classIds: [], savedAt: expect.any(String) });
  });

  it("a name matching a mat by its key reuses it", async () => {
    const res = await patch({ matName: "MAT 1" });
    expect(res.status).toBe(200);
    expect(tx.mat.create).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ matId: "m1", location: "Mat 1" });
  });

  it(`past ${MAT_LIMIT} mats: refused in plain words, and nothing of the edit is written`, async () => {
    clubMats = Array.from({ length: MAT_LIMIT }, (_, i) => mat(`m${i}`, `Mat ${i + 1}`, i));
    const res = await patch({ name: "Renamed too", matName: "Upstairs" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: LOCATION_ERRORS.limit, reason: "location" });
    expect(tx.mat.create).not.toHaveBeenCalled();
    expect(tx.class.updateMany).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("refuses another club's mat id before any write", async () => {
    const res = await patch({ matId: "theirs" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That mat is not one of this club's mats." });
    expect(tx.class.updateMany).not.toHaveBeenCalled();
    expect(ops).not.toContain("class-lock");
  });

  it("a support session's new name is the class's typed place, off any mat, with no mat added", async () => {
    session.user = { id: "u1", role: "owner", tenantId: "t1", impersonatedBy: "op-1" };
    const res = await patch({ matName: "The beach" });
    expect(res.status).toBe(200);
    expect(tx.mat.create).not.toHaveBeenCalled();
    expect(written()).toMatchObject({ matId: null, location: "The beach" });
  });

  it("records the Location as the columns it sets, so Activity names them", async () => {
    await patch({ matName: "Mat 2" });
    const edit = vi.mocked(logAudit).mock.calls.map((c) => c[0]).find((a) => a.action === "class.updated");
    expect((edit?.metadata as { fields: string[] }).fields).toEqual(["matId", "location"]);
  });

  it("a coach cannot edit a class at all: 403 and nothing read or written", async () => {
    session.user = { id: "u2", role: "coach", tenantId: "t1" };
    expect((await patch({ matName: "Mat 2" })).status).toBe(403);
    expect(ops).toEqual([]);
  });
});
