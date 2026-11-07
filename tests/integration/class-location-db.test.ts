// The class form's Location by name against real Postgres (the Neon TEST
// branch), through the real class routes and the real audit writer, under RLS.
// Run alone, as both roles:
//   node .claude/skills/matflow-verify-local/scripts/db-tests.mjs tests/integration/class-location-db.test.ts
//
// Proved here, because a mock cannot prove them:
//  - a new name adds exactly one mat and puts the class on it in one
//    transaction, with one `mat.create` audit row; a refused save leaves
//    neither a mat nor a class behind;
//  - a name matching a mat whatever its capitals and spacing reuses it, and
//    only the saved class moves;
//  - a NEW mat takes every class of the club that types its name (capitals and
//    spacing aside), in the same transaction, with one mat.adopt row; no other
//    club's class is touched;
//  - the Mat name-key unique index refuses a duplicate in the shape the routes
//    read as a Location clash (isMatNameClash), under both roles;
//  - the twelfth-mat cap holds and writes nothing past it;
//  - another club's mat id is refused, and another club's mat of the same
//    name is never used;
//  - two saves naming the same new place at once make one mat, not two, on
//    create and on edit;
//  - Undo of an edit that put a class on a mat by name returns the class to
//    its typed place and leaves the mat;
//  - a support session uses an existing mat by name and adds none.
// Synthetic data only; skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/revalidate-tag-logged", () => ({ revalidateTagLogged: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { executeUndo } from "@/lib/undo-batch";
import { decideUndo, type AuditRowLike } from "@/lib/undo-registry";
import { POST as classPOST } from "@/app/api/classes/route";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { LOCATION_ERRORS, MAT_LIMIT } from "@/lib/mats";
import { isMatNameClash } from "@/lib/class-refs";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://test.local${path}`, {
    method,
    headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (tenantId: string, over: Record<string, unknown> = {}) =>
  vi.mocked(auth).mockResolvedValue({ user: { id: "synthetic-owner", role: "owner", tenantId, ...over } } as never);
const SLOT = { dayOfWeek: 1, startTime: "18:00", endTime: "19:00" };
const create = (body: Record<string, unknown>) => classPOST(request("/api/classes", "POST", { name: "Gi", duration: 60, schedules: [SLOT], ...body }));
const edit = (id: string, body: Record<string, unknown>) => classPATCH(request(`/api/classes/${id}`, "PATCH", body), params(id));

describe.skipIf(!HAS_DB)("class Location by name — real database", () => {
  const tenants: string[] = [];
  async function club(label: string): Promise<string> {
    const tenant = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `Synthetic location ${label}`, slug: `mfv-loc-${randomUUID()}` } }));
    tenants.push(tenant.id);
    return tenant.id;
  }
  const classRow = (tenantId: string, name: string, location: string | null, over: Record<string, unknown> = {}) =>
    withRlsBypass((tx) => tx.class.create({ data: { tenantId, name, location, duration: 60, ...over }, select: { id: true } }));
  const mats = (tenantId: string) =>
    withRlsBypass((tx) => tx.mat.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, nameKey: true, sortOrder: true } }));
  const classes = (tenantId: string) =>
    withRlsBypass((tx) => tx.class.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, matId: true, location: true } }));
  const matAudits = (tenantId: string, action = "mat.create") =>
    withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, action }, orderBy: { createdAt: "asc" }, select: { entityId: true, metadata: true } }));
  const addMatRow = (tenantId: string, name: string, sortOrder: number) =>
    withRlsBypass((tx) => tx.mat.create({ data: { tenantId, name, nameKey: name.toLowerCase(), sortOrder }, select: { id: true, name: true } }));
  /** A class edit's `class.updated` row is written after the response, best effort: wait for it (as mats-db does). */
  const classEdits = async (tenantId: string, classId: string, n: number) => {
    for (let i = 0; i < 100; i++) {
      const rows = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, action: "class.updated", entityId: classId }, orderBy: { createdAt: "asc" } }));
      if (rows.length >= n) return rows as unknown as AuditRowLike[];
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`class ${classId} has fewer than ${n} class.updated rows after 10 s`);
  };
  /** A real staff owner, for Undo (its audit row names the user who undid). */
  const owner = async (tenantId: string) =>
    (await withRlsBypass((tx) => tx.user.create({ data: { tenantId, email: `owner-${randomUUID()}@example.test`, passwordHash: "synthetic-not-a-hash", name: "Synthetic Owner", role: "owner" }, select: { id: true } }))).id;

  afterAll(async () => {
    if (tenants.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.mat.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });

  it("create: a new name adds one mat, puts the class on it with the mat's name, and records one mat.create", async () => {
    const T = await club("create");
    as(T);
    const res = await create({ matName: "  Mat   1 " });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; locationAdded: { id: string; name: string; classIds: string[]; savedAt: string } | null };
    const [mat] = await mats(T);
    expect(await mats(T)).toEqual([{ id: mat.id, name: "Mat 1", nameKey: "mat 1", sortOrder: 0 }]);
    expect(body.locationAdded).toEqual({ id: mat.id, name: "Mat 1", classIds: [], savedAt: expect.any(String) });
    expect((await classes(T)).find((c) => c.id === body.id)).toMatchObject({ matId: mat.id, location: "Mat 1" });
    expect(await matAudits(T)).toEqual([{ entityId: mat.id, metadata: expect.objectContaining({ name: "Mat 1" }) }]);
  });

  it("create and edit: a name matching a mat whatever its capitals reuses it, and only the saved class moves", async () => {
    const T = await club("reuse");
    as(T);
    expect((await create({ name: "First", matName: "Mat 1" })).status).toBe(201);
    const typed = await classRow(T, "Typed", "MAT 1");
    const other = await classRow(T, "Other", "mat 1");
    const second = await create({ name: "Second", matName: "mat 1" });
    expect(second.status).toBe(201);
    expect(await mats(T)).toHaveLength(1);
    const [mat] = await mats(T);
    expect(await edit(typed.id, { matName: "MAT 1" }).then((r) => r.status)).toBe(200);
    const after = await classes(T);
    expect(after.find((c) => c.name === "Second")).toMatchObject({ matId: mat.id, location: "Mat 1" });
    expect(after.find((c) => c.id === typed.id)).toMatchObject({ matId: mat.id, location: "Mat 1" });
    // Not converted: it was not the class saved.
    expect(after.find((c) => c.id === other.id)).toMatchObject({ matId: null, location: "mat 1" });
    expect(await matAudits(T)).toHaveLength(1);
  });

  it("edit: a typed place picked from the list becomes a mat, and every class of the club that types it goes on it; no other club's", async () => {
    const T = await club("edit");
    const other = await club("edit-other");
    const a = await classRow(T, "A", null);
    const b = await classRow(T, "B", "Upstairs");
    const c = await classRow(T, "C", "  UPSTAIRS ");
    const d = await classRow(T, "D", "Upstairs room");
    const theirs = await classRow(other, "Theirs", "Upstairs");
    as(T);
    const res = await edit(a.id, { matName: "Upstairs" });
    expect(res.status).toBe(200);
    const [mat] = await mats(T);
    expect(mat).toMatchObject({ name: "Upstairs", nameKey: "upstairs" });
    const body = (await res.json()) as { locationAdded: { classIds: string[] } };
    expect([...body.locationAdded.classIds].sort()).toEqual([b.id, c.id].sort());
    const rows = await classes(T);
    for (const id of [a.id, b.id, c.id]) expect(rows.find((r) => r.id === id)).toMatchObject({ matId: mat.id, location: "Upstairs" });
    expect(rows.find((r) => r.id === d.id)).toMatchObject({ matId: null, location: "Upstairs room" });
    expect((await classes(other)).find((r) => r.id === theirs.id)).toMatchObject({ matId: null, location: "Upstairs" });
    expect(await mats(other)).toEqual([]);
    expect(await matAudits(T)).toHaveLength(1);
    const adopt = await matAudits(T, "mat.adopt");
    expect(adopt).toHaveLength(1);
    expect((adopt[0].metadata as { mats: { id: string; created: boolean; classIds: string[] }[] }).mats.map((m) => ({ ...m, classIds: [...m.classIds].sort() })))
      .toEqual([expect.objectContaining({ id: mat.id, created: false, classIds: [b.id, c.id].sort() })]);
  });

  it("create: a new mat from a typed name takes the classes that type it too", async () => {
    const T = await club("create-takes");
    const typed = await classRow(T, "Typed", "cage");
    as(T);
    const res = await create({ name: "New", matName: "Cage" });
    expect(res.status).toBe(201);
    const [mat] = await mats(T);
    const rows = await classes(T);
    expect(rows.find((r) => r.id === typed.id)).toMatchObject({ matId: mat.id, location: "Cage" });
    expect(rows.find((r) => r.name === "New")).toMatchObject({ matId: mat.id, location: "Cage" });
  });

  it("the Mat name-key unique index refuses a duplicate in the shape the routes read as a Location clash", async () => {
    const T = await club("p2002");
    await addMatRow(T, "Cage", 0);
    let caught: unknown = null;
    try {
      await withTenantContext(T, (tx) => tx.mat.create({ data: { tenantId: T, name: "CAGE", nameKey: "cage", sortOrder: 1 } }));
    } catch (e) {
      caught = e;
    }
    expect((caught as { code?: string } | null)?.code).toBe("P2002");
    expect(isMatNameClash(caught)).toBe(true);
    // Another unique refusal (a class instance at the same date and start) is not a Location clash.
    expect(isMatNameClash({ code: "P2002", meta: { modelName: "ClassInstance", target: ["classId", "date", "startTime"] } })).toBe(false);
  });

  it(`the cap: past ${MAT_LIMIT} mats a create and an edit are refused in plain words, and nothing is written`, async () => {
    const T = await club("cap");
    for (let i = 0; i < MAT_LIMIT; i++) await addMatRow(T, `Mat ${i + 1}`, i);
    const existing = await classRow(T, "Existing", "Garage");
    as(T);
    const res = await create({ name: "Thirteenth", matName: "Garage" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: LOCATION_ERRORS.limit, reason: "location" });
    const refused = await edit(existing.id, { name: "Renamed", matName: "Garage" });
    expect(refused.status).toBe(409);
    expect(await mats(T)).toHaveLength(MAT_LIMIT);
    const rows = await classes(T);
    expect(rows.map((c) => c.name)).toEqual(["Existing"]);
    expect(rows[0]).toMatchObject({ matId: null, location: "Garage" });
    expect(await matAudits(T)).toEqual([]);
  });

  it("isolation: another club's mat id is refused on create and edit; another club's mat of the same name is never used", async () => {
    const A = await club("A");
    const B = await club("B");
    const theirs = await addMatRow(B, "Mat 1", 0);
    as(A);
    const refused = await create({ matId: theirs.id });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "That mat is not one of this club's mats." });
    const own = await classRow(A, "Own", null);
    expect((await edit(own.id, { matId: theirs.id })).status).toBe(400);
    expect((await classes(A)).find((c) => c.id === own.id)?.matId).toBeNull();
    // By name: club A gets its own Mat 1; club B's is untouched and unused.
    expect((await create({ name: "By name", matName: "Mat 1" })).status).toBe(201);
    const [mine] = await mats(A);
    expect(mine.id).not.toBe(theirs.id);
    expect((await classes(A)).find((c) => c.name === "By name")?.matId).toBe(mine.id);
    expect(await mats(B)).toEqual([{ id: theirs.id, name: "Mat 1", nameKey: "mat 1", sortOrder: 0 }]);
    expect(await classes(B)).toEqual([]);
  });

  it("a support session keeps a new name as a typed place: no mat is added", async () => {
    const T = await club("support");
    as(T, { impersonatedBy: "synthetic-operator" });
    const res = await create({ name: "Beach", matName: "The beach" });
    expect(res.status).toBe(201);
    expect(await mats(T)).toEqual([]);
    expect((await classes(T)).find((c) => c.name === "Beach")).toMatchObject({ matId: null, location: "The beach" });
  });

  it("two saves naming the same new place at once make one mat, and both classes are on it", async () => {
    const T = await club("race");
    as(T);
    const [one, two] = await Promise.all([create({ name: "One", matName: "Cage" }), create({ name: "Two", matName: "cage" })]);
    expect([one.status, two.status]).toEqual([201, 201]);
    const all = await mats(T);
    expect(all).toHaveLength(1);
    const rows = await classes(T);
    expect(rows.map((c) => c.matId)).toEqual([all[0].id, all[0].id]);
    expect(await matAudits(T)).toHaveLength(1);
  });

  it("two edits naming the same new place at once make one mat, and both classes are on it", async () => {
    const T = await club("patch-race");
    const a = await classRow(T, "A", null);
    const b = await classRow(T, "B", null);
    as(T);
    const [one, two] = await Promise.all([edit(a.id, { matName: "Cage" }), edit(b.id, { matName: "CAGE" })]);
    expect([one.status, two.status]).toEqual([200, 200]);
    const all = await mats(T);
    expect(all).toEqual([{ id: all[0].id, name: expect.stringMatching(/^cage$/i), nameKey: "cage", sortOrder: 0 }]);
    expect((await classes(T)).map((c) => c.matId)).toEqual([all[0].id, all[0].id]);
    expect(await matAudits(T)).toHaveLength(1);
  });

  it("edit by name: another club's mat of the same name is never used; the caller's club gets its own", async () => {
    const A = await club("patch-iso-A");
    const B = await club("patch-iso-B");
    const theirs = await addMatRow(B, "Upstairs", 0);
    const theirClass = await classRow(B, "Theirs", "Upstairs", { matId: theirs.id });
    const mine = await classRow(A, "Mine", null);
    as(A);
    expect((await edit(mine.id, { matName: "upstairs" })).status).toBe(200);
    const [own] = await mats(A);
    expect(own.id).not.toBe(theirs.id);
    expect((await classes(A)).find((c) => c.id === mine.id)).toMatchObject({ matId: own.id, location: "upstairs" });
    expect(await mats(B)).toEqual([{ id: theirs.id, name: "Upstairs", nameKey: "upstairs", sortOrder: 0 }]);
    expect((await classes(B)).find((c) => c.id === theirClass.id)).toMatchObject({ matId: theirs.id, location: "Upstairs" });
    // And another club's class id is not the caller's to edit by name either.
    expect((await edit(theirClass.id, { matName: "Cage" })).status).toBe(404);
    expect((await mats(A)).map((m) => m.name)).toEqual(["upstairs"]);
  });

  it("Undo of an edit that put a class on a mat by name returns it to its typed place and leaves the mat", async () => {
    const T = await club("undo");
    const undoer = await owner(T);
    const cls = await classRow(T, "Yoga", "Sports hall");
    as(T);
    expect((await edit(cls.id, { matName: "Studio" })).status).toBe(200);
    const [studio] = await mats(T);
    expect((await classes(T))[0]).toMatchObject({ matId: studio.id, location: "Studio" });
    const [row] = await classEdits(T, cls.id, 1);
    expect((row.metadata as { before: unknown; fields: unknown }).before).toEqual({ matId: null, location: "Sports hall" });
    expect((row.metadata as { fields: unknown }).fields).toEqual(["matId", "location"]);
    await withTenantContext(T, (tx) => executeUndo(tx, [{ row, decision: decideUndo(row, false) }], { tenantId: T, userId: undoer }));
    expect((await classes(T))[0]).toMatchObject({ matId: null, location: "Sports hall" });
    // The mat stays: adding it was its own action (mat.create), recorded apart.
    expect(await mats(T)).toEqual([{ id: studio.id, name: "Studio", nameKey: "studio", sortOrder: 0 }]);
    expect(await matAudits(T)).toHaveLength(1);
  }, 60_000);

  it("a support session's edit naming an existing mat puts the class on it and adds none", async () => {
    const T = await club("support-patch");
    const mat = await addMatRow(T, "Mat 1", 0);
    const cls = await classRow(T, "Gi", null);
    as(T, { impersonatedBy: "synthetic-operator" });
    expect((await edit(cls.id, { matName: "MAT 1" })).status).toBe(200);
    expect((await classes(T))[0]).toMatchObject({ matId: mat.id, location: "Mat 1" });
    expect(await mats(T)).toHaveLength(1);
    // A new name stays the class's typed place.
    expect((await edit(cls.id, { matName: "The beach" })).status).toBe(200);
    expect((await classes(T))[0]).toMatchObject({ matId: null, location: "The beach" });
    expect(await mats(T)).toHaveLength(1);
    expect(await matAudits(T)).toEqual([]);
  });
});
