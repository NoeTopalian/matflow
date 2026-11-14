// MatFlow support manages a club's class categories (Noe, 14 Nov 2026: "allow me to edit this as the admin";
// RULES §5b) against real Postgres (the Neon TEST branch), through the real route handlers, under RLS, and the real
// audit writer. Run alone, as both roles:
//   node .claude/skills/matflow-verify-local/scripts/db-tests.mjs tests/integration/support-class-categories-db.test.ts
//
// Proved here, because a mock cannot prove them:
//  - a VIEW (read-only) support session is refused every category write and nothing changes;
//  - an EDIT support session renames the club's starting Fundamentals category to Beginners: the same row (id,
//    legacy key) and every class on it keep their link, and nothing else on those classes changes; it can also add,
//    reorder, archive and restore;
//  - every one of those audit rows is in the club's own tenantId and names the operator, so the club's Activity reads
//    it as MatFlow support; the other club gets nothing.
// The session comes from a mocked auth() and the operator from a mocked impersonation cookie (in production both come
// from the HMAC-verified token: support-session-binding-db). Synthetic data only; skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { claim } = vi.hoisted(() => ({ claim: { current: null as null | Record<string, unknown> } }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/revalidate-tag-logged", () => ({ revalidateTagLogged: vi.fn() }));
vi.mock("@/lib/impersonation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/impersonation")>()),
  readImpersonationCookie: vi.fn(async () => claim.current),
}));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as createPOST } from "@/app/api/class-categories/route";
import { PATCH as categoryPATCH } from "@/app/api/class-categories/[id]/route";
import { PUT as orderPUT } from "@/app/api/class-categories/order/route";
import { sourceOf, emptyLookups, type FeedRow } from "@/lib/activity-feed";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const STAMP = randomUUID().slice(0, 8);
const OPERATOR = `mfv-op-cats-${STAMP}`;
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://test.local${path}`, {
    method,
    headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const CATEGORY_ACTIONS = ["class_category.create", "class_category.rename", "class_category.archive", "class_category.restore", "class_category.reorder"];

describe.skipIf(!HAS_DB)("MatFlow support manages class categories — real database", () => {
  const tenants: string[] = [];
  let A = "";
  let B = "";
  let ownerA = "";
  const previousSwitch = process.env.CLASS_CATEGORY_MANAGEMENT;

  const support = (scope: "edit" | "view") => {
    vi.mocked(auth).mockResolvedValue({ user: { id: ownerA, role: "owner", tenantId: A, impersonatedBy: OPERATOR, supportScope: scope } } as never);
    claim.current = { adminUserId: OPERATOR, targetUserId: ownerA, targetTenantId: A, reason: "Rename Fundamentals for the club", exp: Math.floor(Date.now() / 1000) + 600, v: 3, scope, opSv: 0, tsv: 0, n: `nonce-${STAMP}-0123456789` };
  };
  const categories = (tenantId: string) =>
    withRlsBypass((tx) => tx.classCategory.findMany({ where: { tenantId }, orderBy: { sortOrder: "asc" }, select: { id: true, name: true, legacyKey: true, version: true, archivedAt: true, sortOrder: true } }));
  const fundamentals = async (tenantId: string) => (await categories(tenantId)).find((c) => c.legacyKey === "fundamentals")!;
  const audits = (where: Record<string, unknown>) =>
    withRlsBypass((tx) => tx.auditLog.findMany({ where: { action: { in: CATEGORY_ACTIONS }, ...where }, orderBy: { createdAt: "asc" } }));
  const classRow = (id: string) =>
    withRlsBypass((tx) => tx.class.findUniqueOrThrow({ where: { id }, select: { id: true, name: true, categoryId: true, category: true, color: true, isKids: true, isActive: true, deletedAt: true, maxCapacity: true, duration: true } }));

  beforeAll(async () => {
    process.env.CLASS_CATEGORY_MANAGEMENT = "on";
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `Synthetic support cats A ${STAMP}`, slug: `mfv-scats-a-${STAMP}` } });
      const b = await tx.tenant.create({ data: { name: `Synthetic support cats B ${STAMP}`, slug: `mfv-scats-b-${STAMP}` } });
      A = a.id;
      B = b.id;
      tenants.push(A, B);
      // The eight starting categories, as every club-creation path makes them.
      await tx.$executeRaw`SELECT matflow_seed_class_categories(${A})`;
      await tx.$executeRaw`SELECT matflow_seed_class_categories(${B})`;
      ownerA = (await tx.user.create({ data: { tenantId: A, email: `owner-${STAMP}@example.test`, passwordHash: "synthetic-not-a-hash", name: "Synthetic Owner", role: "owner" }, select: { id: true } })).id;
      await tx.operator.create({ data: { id: OPERATOR, email: `${OPERATOR}@example.test`, name: "Synthetic Operator", passwordHash: "x" } });
    });
  }, 60_000);

  afterAll(async () => {
    claim.current = null;
    if (previousSwitch === undefined) delete process.env.CLASS_CATEGORY_MANAGEMENT;
    else process.env.CLASS_CATEGORY_MANAGEMENT = previousSwitch;
    if (tenants.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classCategory.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.operator.deleteMany({ where: { id: OPERATOR } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  }, 60_000);

  it("a VIEW support session is refused every category write, and nothing changes", async () => {
    const before = await categories(A);
    const f = await fundamentals(A);
    support("view");
    expect((await categoryPATCH(request(`/api/class-categories/${f.id}`, "PATCH", { version: f.version, name: "Beginners" }), params(f.id))).status).toBe(403);
    expect((await createPOST(request("/api/class-categories", "POST", { name: "Intermediate" }))).status).toBe(403);
    expect((await orderPUT(request("/api/class-categories/order", "PUT", { items: before.map((c) => ({ id: c.id, version: c.version })).reverse() }))).status).toBe(403);
    expect(await categories(A)).toEqual(before);
    expect(await audits({ tenantId: A })).toEqual([]);
  });

  it("an EDIT support session renames Fundamentals to Beginners: the same category, both classes still on it, nothing else changed; every row is MatFlow support's in the club's tenant", async () => {
    const f = await fundamentals(A);
    // Two classes on Fundamentals, as the club in the report has them.
    const made = await withRlsBypass(async (tx) => Promise.all(["Beginners Course Gi", "Beginners Course NoGi"].map((name) =>
      tx.class.create({ data: { tenantId: A, name, duration: 50, color: "#3b82f6", categoryId: f.id, schedules: { create: [{ dayOfWeek: 1, startTime: "12:00", endTime: "12:50" }] } }, select: { id: true } }))));
    const before = await Promise.all(made.map((c) => classRow(c.id)));
    const otherBefore = await categories(B);
    support("edit");

    const rename = await categoryPATCH(request(`/api/class-categories/${f.id}`, "PATCH", { version: f.version, name: "Beginners" }), params(f.id));
    expect(rename.status).toBe(200);
    const after = await fundamentals(A);
    expect(after).toMatchObject({ id: f.id, name: "Beginners", legacyKey: "fundamentals", archivedAt: null, version: f.version + 1 });
    expect((await categories(A)).filter((c) => c.name.toLowerCase() === "beginners")).toHaveLength(1);
    for (const [i, c] of made.entries()) {
      expect(await classRow(c.id)).toEqual(before[i]); // same category id, same old key, same title, colour, flags
      expect(before[i].categoryId).toBe(f.id);
    }

    // The rest of the sheet works too: add, reorder, archive, restore.
    const added = await createPOST(request("/api/class-categories", "POST", { name: "Intermediate" }));
    expect(added.status).toBe(201);
    const addedId = ((await added.json()) as { id: string }).id;
    const now = await categories(A);
    expect((await orderPUT(request("/api/class-categories/order", "PUT", { items: now.map((c) => ({ id: c.id, version: c.version })).reverse() }))).status).toBe(200);
    const v1 = (await categories(A)).find((c) => c.id === addedId)!.version;
    expect((await categoryPATCH(request(`/api/class-categories/${addedId}`, "PATCH", { version: v1, archived: true }), params(addedId))).status).toBe(200);
    const v2 = (await categories(A)).find((c) => c.id === addedId)!.version;
    expect((await categoryPATCH(request(`/api/class-categories/${addedId}`, "PATCH", { version: v2, archived: false }), params(addedId))).status).toBe(200);

    const rows = await audits({ tenantId: A });
    expect(rows.map((r) => r.action).sort()).toEqual(
      ["class_category.rename", "class_category.create", "class_category.reorder", "class_category.archive", "class_category.restore"].sort(),
    );
    for (const row of rows) {
      expect(row, row.action).toMatchObject({ tenantId: A, userId: ownerA, operatorId: OPERATOR });
      expect(row.metadata, row.action).toMatchObject({ actingAs: OPERATOR, actorType: "operator", effectiveUserId: ownerA });
      const feed: FeedRow = { id: row.id, action: row.action, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, createdAt: row.createdAt, userId: row.userId, operatorId: row.operatorId };
      expect(sourceOf(feed, emptyLookups()).label, row.action).toBe("MatFlow support");
    }
    // Nothing in the other club, and none of the support rows anywhere but the club's.
    expect(await categories(B)).toEqual(otherBefore);
    expect(await audits({ tenantId: B })).toEqual([]);
    expect((await audits({ operatorId: OPERATOR })).every((r) => r.tenantId === A)).toBe(true);
  }, 120_000);
});
