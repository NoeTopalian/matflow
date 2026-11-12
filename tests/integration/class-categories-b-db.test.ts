// Club-managed class categories, Release B (12 Nov 2026), against real Postgres. Synthetic data only.
// Needs migration 20261112120000_class_category_stale_writer (the stale-writer refusal in the bridge).
//
// Proved here:
//  - the switch: with CLASS_CATEGORY_MANAGEMENT off every management write is refused and nothing changes;
//  - create, rename, archive, restore, reorder: owner and manager only; names unique per club whatever their capitals
//    and spacing, archived names included; 32 characters at most; each recorded in Activity (no Undo);
//  - stale edits: a write carrying an old version is refused and changes nothing; of two renames racing on the same
//    version exactly one lands;
//  - archive keeps the category on its classes and stops new assignments; restore makes it assignable again;
//  - tenant isolation: another club's category cannot be renamed, archived, ordered or assigned;
//  - stale clients: an old page (old key only) cannot change the category of a class on a club-made category, through
//    the route or straight at the database; an old page's unrelated save, and its choice on a class whose category is
//    a starting one, still work.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/revalidate-tag-logged", () => ({ revalidateTagLogged: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { GET as listGET, POST as createPOST } from "@/app/api/class-categories/route";
import { PATCH as categoryPATCH } from "@/app/api/class-categories/[id]/route";
import { PUT as orderPUT } from "@/app/api/class-categories/order/route";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { CATEGORY_ERRORS, seedClassCategories } from "@/lib/class-category-store";
import { decideUndo } from "@/lib/undo-registry";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
// Several cases make 20-40 database round trips; measured alone against the test endpoint from Bali (about 226 ms
// each) two ran 29.3 s and 32.0 s, over the 30 s default (12 Nov 2026). A harness limit, not an assertion.
vi.setConfig({ testTimeout: 180_000 });
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://test.local${path}`, {
    method,
    headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (role: "owner" | "manager" | "coach", tenantId: string) =>
  vi.mocked(auth).mockResolvedValue({ user: { id: `synthetic-${role}-${tenantId.slice(-6)}`, role, tenantId } } as never);
const errorText = async (p: Promise<unknown>) => {
  try { await p; return "no error"; } catch (e) { return `${(e as Error).message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}`; }
};

describe.skipIf(!HAS_DB)("club-managed class categories, Release B — real database", () => {
  const tenants: string[] = [];
  const before = process.env.CLASS_CATEGORY_MANAGEMENT;
  async function club(label: string): Promise<string> {
    const t = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `Synthetic categories B ${label}`, slug: `mfv-catb-${randomUUID()}` } }));
    tenants.push(t.id);
    await withRlsBypass((tx) => seedClassCategories(tx, t.id));
    return t.id;
  }
  const cats = (tenantId: string) => withRlsBypass((tx) => tx.classCategory.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] }));
  const audits = (tenantId: string, action: string) => withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, action } }));
  const classRow = (tenantId: string, name: string, data: Record<string, unknown> = {}) =>
    withTenantContext(tenantId, (tx) => tx.class.create({ data: { tenantId, name, duration: 60, ...data }, select: { id: true } }));
  const readClass = (tenantId: string, id: string) => withRlsBypass((tx) => tx.class.findFirstOrThrow({ where: { id, tenantId }, select: { name: true, category: true, categoryId: true } }));
  const create = async (tenantId: string, name: string) => {
    as("owner", tenantId);
    const res = await createPOST(request("/api/class-categories", "POST", { name }));
    return { status: res.status, body: (await res.json()) as { id: string; version: number; error?: string } };
  };
  const patch = async (tenantId: string, id: string, body: Record<string, unknown>, role: "owner" | "manager" | "coach" = "owner") => {
    as(role, tenantId);
    const res = await categoryPATCH(request(`/api/class-categories/${id}`, "PATCH", body), params(id));
    return { status: res.status, body: (await res.json()) as { version?: number; error?: string; name?: string; archived?: boolean } };
  };

  beforeAll(() => { process.env.CLASS_CATEGORY_MANAGEMENT = "on"; });
  afterAll(async () => {
    process.env.CLASS_CATEGORY_MANAGEMENT = before;
    await withRlsBypass(async (tx) => {
      for (const t of tenants) {
        await tx.class.deleteMany({ where: { tenantId: t } });
        await tx.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {});
        await tx.classCategory.deleteMany({ where: { tenantId: t } });
        await tx.tenant.deleteMany({ where: { id: t } });
      }
    });
  });

  it("switched off: create, rename, archive and reorder are refused (404) and change nothing; the list still reads", async () => {
    const T = await club("off");
    const [first] = await cats(T);
    process.env.CLASS_CATEGORY_MANAGEMENT = "off";
    try {
      expect((await create(T, "Intermediate")).status).toBe(404);
      expect((await patch(T, first.id, { version: first.version, name: "Beginners" })).status).toBe(404);
      as("owner", T);
      expect((await orderPUT(request("/api/class-categories/order", "PUT", { items: [{ id: first.id, version: first.version }] }))).status).toBe(404);
      const list = await (await listGET()).json();
      expect(list.managementEnabled).toBe(false);
      expect(list.categories).toHaveLength(8);
      expect((await cats(T)).some((c) => c.name === "Beginners" || c.name === "Intermediate")).toBe(false);
    } finally {
      process.env.CLASS_CATEGORY_MANAGEMENT = "on";
    }
  });

  it("create: owner or manager adds a category at the end; a coach is refused; the name is unique whatever its capitals and spacing (archived names too), 32 characters at most; recorded in Activity, with no Undo", async () => {
    const T = await club("create");
    const made = await create(T, "  Intermediate ");
    expect(made.status).toBe(201);
    const rows = await cats(T);
    expect(rows.at(-1)).toMatchObject({ id: made.body.id, name: "Intermediate", legacyKey: null });
    expect((await create(T, "intermediate")).status).toBe(409);
    as("coach", T);
    expect((await createPOST(request("/api/class-categories", "POST", { name: "Advanced" }))).status).toBe(403);
    expect((await create(T, "x".repeat(33))).status).toBe(400);
    expect((await create(T, "   ")).status).toBe(400);
    const gi = rows.find((r) => r.legacyKey === "gi")!;
    expect((await patch(T, gi.id, { version: gi.version, archived: true })).status).toBe(200);
    const again = await create(T, "GI");
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/archived/);
    const a = await audits(T, "class_category.create");
    expect(a).toHaveLength(1);
    expect(decideUndo({ ...a[0], metadata: a[0].metadata } as never, false).ok).toBe(false);
  });

  it("rename: the version the caller saw must be current; a stale one changes nothing; two renames racing on one version — exactly one lands", async () => {
    const T = await club("rename");
    const fund = (await cats(T)).find((c) => c.legacyKey === "fundamentals")!;
    const ok = await patch(T, fund.id, { version: fund.version, name: "Beginners" });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(fund.version + 1);
    const stale = await patch(T, fund.id, { version: fund.version, name: "Novices" });
    expect(stale.status).toBe(409);
    expect((await cats(T)).find((c) => c.id === fund.id)!.name).toBe("Beginners");
    const kids = (await cats(T)).find((c) => c.legacyKey === "kids")!;
    expect((await patch(T, kids.id, { version: kids.version, name: "beginners" })).status).toBe(409); // a name the club has
    const now = (await cats(T)).find((c) => c.id === fund.id)!;
    const [r1, r2] = await Promise.all([patch(T, fund.id, { version: now.version, name: "Beginners A" }), patch(T, fund.id, { version: now.version, name: "Beginners B" })]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const audit = await audits(T, "class_category.rename");
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => (a.metadata as { after: { name: string } }).after.name)).toContain("Beginners");
  });

  it("the starting category renamed keeps every class on it (Fundamentals → Beginners keeps its classes)", async () => {
    const T = await club("keep");
    const fund = (await cats(T)).find((c) => c.legacyKey === "fundamentals")!;
    const c = await classRow(T, "Fundamentals Gi", { categoryId: fund.id });
    expect((await patch(T, fund.id, { version: fund.version, name: "Beginners" })).status).toBe(200);
    expect(await readClass(T, c.id)).toMatchObject({ name: "Fundamentals Gi", categoryId: fund.id, category: "fundamentals" });
  });

  it("archive keeps the category on its classes and stops new assignments; restore makes it assignable again", async () => {
    const T = await club("archive");
    const made = await create(T, "Competition Team");
    const kept = await classRow(T, "Comp class", { categoryId: made.body.id });
    const other = await classRow(T, "Open class");
    const arch = await patch(T, made.body.id, { version: made.body.version, archived: true });
    expect(arch.status).toBe(200);
    expect((await readClass(T, kept.id)).categoryId).toBe(made.body.id);
    as("owner", T);
    const assign = await classPATCH(request(`/api/classes/${other.id}`, "PATCH", { categoryId: made.body.id }), params(other.id));
    expect(assign.status).toBe(409);
    expect((await readClass(T, other.id)).categoryId).toBeNull();
    // An edit of the class that keeps it does not trip over the archived category.
    const keepEdit = await classPATCH(request(`/api/classes/${kept.id}`, "PATCH", { name: "Comp class (Sat)" }), params(kept.id));
    expect(keepEdit.status).toBe(200);
    const restored = await patch(T, made.body.id, { version: arch.body.version!, archived: false });
    expect(restored.status).toBe(200);
    const assign2 = await classPATCH(request(`/api/classes/${other.id}`, "PATCH", { categoryId: made.body.id }), params(other.id));
    expect(assign2.status).toBe(200);
    expect(await audits(T, "class_category.archive")).toHaveLength(1);
    expect(await audits(T, "class_category.restore")).toHaveLength(1);
  });

  it("reorder: exactly the club's categories with current versions; a missing one or an old version is refused and nothing moves", async () => {
    const T = await club("order");
    const rows = await cats(T);
    const reversed = [...rows].reverse().map((r) => ({ id: r.id, version: r.version }));
    as("manager", T);
    expect((await orderPUT(request("/api/class-categories/order", "PUT", { items: reversed }))).status).toBe(200);
    expect((await cats(T)).map((r) => r.id)).toEqual(reversed.map((r) => r.id));
    const now = await cats(T);
    const missing = now.slice(1).map((r) => ({ id: r.id, version: r.version }));
    expect((await orderPUT(request("/api/class-categories/order", "PUT", { items: missing }))).status).toBe(409);
    const old = now.map((r, i) => ({ id: r.id, version: i === 0 ? r.version - 1 : r.version }));
    expect((await orderPUT(request("/api/class-categories/order", "PUT", { items: [...old].reverse() }))).status).toBe(409);
    expect((await cats(T)).map((r) => r.id)).toEqual(now.map((r) => r.id));
    expect(await audits(T, "class_category.reorder")).toHaveLength(1);
  });

  it("tenant isolation: another club's category cannot be renamed, archived, ordered or assigned", async () => {
    const A = await club("iso-A");
    const B = await club("iso-B");
    const theirs = (await cats(B))[0];
    expect((await patch(A, theirs.id, { version: theirs.version, name: "Hijacked" })).status).toBe(404);
    expect((await patch(A, theirs.id, { version: theirs.version, archived: true })).status).toBe(404);
    const mine = await cats(A);
    as("owner", A);
    const mixed = [...mine.slice(1), theirs].map((r) => ({ id: r.id, version: r.version }));
    expect((await orderPUT(request("/api/class-categories/order", "PUT", { items: mixed }))).status).toBe(409);
    const cls = await classRow(A, "A class");
    const res = await classPATCH(request(`/api/classes/${cls.id}`, "PATCH", { categoryId: theirs.id }), params(cls.id));
    expect(res.status).toBe(400);
    expect((await cats(B))[0]).toMatchObject({ name: theirs.name, archivedAt: null, sortOrder: theirs.sortOrder });
    as("owner", A);
    const list = await (await listGET()).json();
    expect(list.categories.every((c: { id: string }) => mine.some((m) => m.id === c.id))).toBe(true);
  });

  it("stale client, route: an old page cannot change the category of a class on a club-made category (old key or null); its unrelated save and its choice on a starting category still work", async () => {
    const T = await club("stale-route");
    const made = await create(T, "Advanced");
    const onMade = await classRow(T, "Advanced Gi", { categoryId: made.body.id });
    const nogi = (await cats(T)).find((c) => c.legacyKey === "nogi")!;
    const onStart = await classRow(T, "No-Gi", { categoryId: nogi.id });
    as("owner", T);
    for (const category of ["gi", null]) {
      const res = await classPATCH(request(`/api/classes/${onMade.id}`, "PATCH", { category }), params(onMade.id));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(CATEGORY_ERRORS.stale);
      expect((await readClass(T, onMade.id)).categoryId).toBe(made.body.id);
    }
    // The old form sends no category on an unrelated save: accepted, category kept.
    expect((await classPATCH(request(`/api/classes/${onMade.id}`, "PATCH", { name: "Advanced Gi (Tue)" }), params(onMade.id))).status).toBe(200);
    expect((await readClass(T, onMade.id)).categoryId).toBe(made.body.id);
    // On a class whose category is a starting one, the old page can see it: its choice is applied.
    expect((await classPATCH(request(`/api/classes/${onStart.id}`, "PATCH", { category: "gi" }), params(onStart.id))).status).toBe(200);
    expect((await readClass(T, onStart.id)).category).toBe("gi");
  });

  it("stale client, database: an old-key-only write on a class on a club-made category is refused by the bridge (MF_CLASS_CATEGORY_STALE_WRITER); on a starting category it still applies; an unrelated write is untouched", async () => {
    const T = await club("stale-db");
    const made = await create(T, "Intermediate");
    const onMade = await classRow(T, "Intermediate Gi", { categoryId: made.body.id });
    const oldWrite = (id: string, key: string | null) => withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "category" = ${key} WHERE "id" = ${id} AND "tenantId" = ${T}`);
    expect(await errorText(oldWrite(onMade.id, "gi"))).toContain("MF_CLASS_CATEGORY_STALE_WRITER");
    expect(await readClass(T, onMade.id)).toMatchObject({ category: null, categoryId: made.body.id });
    // Writing the key it already has (NULL) changes no category, but it is stamped: an old writer re-sending the
    // same key is still seen by the observation signal O1 (round 2, B-R6).
    await withRlsBypass((tx) => tx.$executeRaw`UPDATE "Class" SET "categoryKeyWrittenAt" = NULL WHERE "id" = ${onMade.id}`);
    await oldWrite(onMade.id, null);
    expect((await readClass(T, onMade.id)).categoryId).toBe(made.body.id);
    const stamped = await withRlsBypass((tx) => tx.class.findFirstOrThrow({ where: { id: onMade.id, tenantId: T }, select: { categoryKeyWrittenAt: true } }));
    expect(stamped.categoryKeyWrittenAt).not.toBeNull();
    await withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "name" = ${"Intermediate Gi (Thu)"} WHERE "id" = ${onMade.id} AND "tenantId" = ${T}`);
    expect(await readClass(T, onMade.id)).toMatchObject({ name: "Intermediate Gi (Thu)", categoryId: made.body.id });
    const kids = (await cats(T)).find((c) => c.legacyKey === "kids")!;
    const onStart = await classRow(T, "Kids", { categoryId: kids.id });
    await oldWrite(onStart.id, "competition");
    expect((await readClass(T, onStart.id)).category).toBe("competition");
  });
});
