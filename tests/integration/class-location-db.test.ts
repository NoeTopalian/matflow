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
//    only the saved class moves (the club's other classes that type the name
//    stay as they are);
//  - the twelfth-mat cap holds and writes nothing past it;
//  - another club's mat id is refused, and another club's mat of the same
//    name is never used;
//  - two saves naming the same new place at once make one mat, not two.
// Synthetic data only; skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/revalidate-tag-logged", () => ({ revalidateTagLogged: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as classPOST } from "@/app/api/classes/route";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { LOCATION_ERRORS, MAT_LIMIT } from "@/lib/mats";

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
  const matAudits = (tenantId: string) =>
    withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, action: "mat.create" }, orderBy: { createdAt: "asc" }, select: { entityId: true, metadata: true } }));
  const addMatRow = (tenantId: string, name: string, sortOrder: number) =>
    withRlsBypass((tx) => tx.mat.create({ data: { tenantId, name, nameKey: name.toLowerCase(), sortOrder }, select: { id: true, name: true } }));

  afterAll(async () => {
    if (tenants.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.mat.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });

  it("create: a new name adds one mat, puts the class on it with the mat's name, and records one mat.create", async () => {
    const T = await club("create");
    as(T);
    const res = await create({ matName: "  Mat   1 " });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; locationAdded: { id: string; name: string } | null };
    const [mat] = await mats(T);
    expect(await mats(T)).toEqual([{ id: mat.id, name: "Mat 1", nameKey: "mat 1", sortOrder: 0 }]);
    expect(body.locationAdded).toEqual({ id: mat.id, name: "Mat 1" });
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

  it("edit: a typed place picked from the list becomes a mat for this class only", async () => {
    const T = await club("edit");
    as(T);
    const a = await classRow(T, "A", "Upstairs");
    const b = await classRow(T, "B", "Upstairs");
    expect((await edit(a.id, { matName: "Upstairs" })).status).toBe(200);
    const [mat] = await mats(T);
    expect(mat).toMatchObject({ name: "Upstairs", nameKey: "upstairs" });
    const rows = await classes(T);
    expect(rows.find((c) => c.id === a.id)).toMatchObject({ matId: mat.id, location: "Upstairs" });
    expect(rows.find((c) => c.id === b.id)).toMatchObject({ matId: null, location: "Upstairs" });
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
});
