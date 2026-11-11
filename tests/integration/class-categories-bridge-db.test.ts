// Club-managed class categories, Release A, against real Postgres (the Neon TEST branch). Run alone, as both roles:
//   node .claude/skills/matflow-verify-local/scripts/db-tests.mjs tests/integration/class-categories-bridge-db.test.ts
//
// Proved here, because a mock cannot prove them (migration 20261111120000_class_categories):
//  - seeding: the eight starting categories, repeatable, never duplicated, also under concurrent writes;
//  - the bridge trigger's exact rules: old key only, reference only, both (agreeing or not), nulls, unrelated edits;
//  - archived categories: a new assignment is refused, an existing one is kept;
//  - what a build from before this release does to a class on a category the club made;
//  - tenant isolation in the database itself: no class can take another club's category through the trigger, a
//    direct write or a route, and neither function has rights beyond its caller;
//  - archive against assignment, both orders, on two real connections;
//  - Undo of a class edit recorded before this release, against a newer assignment.
// Synthetic data only; skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/revalidate-tag-logged", () => ({ revalidateTagLogged: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { POST as classPOST } from "@/app/api/classes/route";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { seedClassCategories, classCategoryDbError, CATEGORY_ERRORS } from "@/lib/class-category-store";
import { CLASS_CATEGORIES, CLASS_CATEGORY_LABELS } from "@/lib/class-category";
import { executeUndo } from "@/lib/undo-batch";
import { decideUndo, REASON, type AuditRowLike } from "@/lib/undo-registry";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://test.local${path}`, {
    method,
    headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (role: "owner" | "manager" | "coach", tenantId: string) =>
  vi.mocked(auth).mockResolvedValue({ user: { id: `synthetic-${role}`, role, tenantId } } as never);

/** A promise and its resolver: the gates that hold one connection's transaction open while the other runs. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!HAS_DB)("club-managed class categories, Release A — real database", () => {
  const tenants: string[] = [];
  /** A fresh synthetic club, created as an older build would (no category rows) unless seeded. */
  async function club(label: string, { seeded = true } = {}): Promise<string> {
    const tenant = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `Synthetic categories ${label}`, slug: `mfv-cat-${randomUUID()}` } }));
    tenants.push(tenant.id);
    if (seeded) await withRlsBypass((tx) => seedClassCategories(tx, tenant.id));
    return tenant.id;
  }
  const categories = (tenantId: string) =>
    withRlsBypass((tx) => tx.classCategory.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] }));
  const byKey = async (tenantId: string, key: string) => (await categories(tenantId)).find((c) => c.legacyKey === key)!;
  /** A category the club made (Release B's create, done directly: there is no route for it in this release). */
  const madeByClub = (tenantId: string, name: string) =>
    withRlsBypass((tx) => tx.classCategory.create({ data: { tenantId, name, nameKey: name.toLowerCase(), sortOrder: 50 } }));
  const archive = (id: string) => withRlsBypass((tx) => tx.classCategory.update({ where: { id }, data: { archivedAt: new Date(), version: { increment: 1 } } }));
  const classRow = (tenantId: string, name: string, data: Record<string, unknown> = {}) =>
    withTenantContext(tenantId, (tx) => tx.class.create({ data: { tenantId, name, duration: 60, ...data }, select: { id: true, category: true, categoryId: true } }));
  const read = (tenantId: string, id: string) =>
    withRlsBypass((tx) => tx.class.findFirstOrThrow({ where: { id, tenantId }, select: { id: true, name: true, category: true, categoryId: true } }));
  /** What a build from before this release writes: the old key, by raw SQL, never the reference. */
  const oldBuildWrite = (tenantId: string, id: string, key: string | null) =>
    withTenantContext(tenantId, (tx) => tx.$executeRaw`UPDATE "Class" SET "category" = ${key} WHERE "id" = ${id} AND "tenantId" = ${tenantId}`);
  const oldBuildRename = (tenantId: string, id: string, name: string) =>
    withTenantContext(tenantId, (tx) => tx.$executeRaw`UPDATE "Class" SET "name" = ${name} WHERE "id" = ${id} AND "tenantId" = ${tenantId}`);
  const errorText = async (p: Promise<unknown>) => {
    try { await p; return "no error"; } catch (e) { return `${(e as Error).message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}`; }
  };

  afterAll(async () => {
    if (tenants.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classCategory.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  });

  describe("seeding", () => {
    it("a new club gets the eight starting categories, in today's order, with \"Open Mat\" and their old keys", async () => {
      const T = await club("seed");
      const rows = await categories(T);
      expect(rows.map((r) => r.legacyKey)).toEqual([...CLASS_CATEGORIES]);
      expect(rows.map((r) => r.name)).toEqual(CLASS_CATEGORIES.map((k) => (k === "open_mat" ? "Open Mat" : CLASS_CATEGORY_LABELS[k])));
      expect(rows.every((r) => r.nameKey === r.name.toLowerCase() && r.archivedAt === null && r.version === 0)).toBe(true);
    });

    it("seeding again adds nothing (repeatable), and two at once still make exactly eight", async () => {
      const T = await club("seed-twice", { seeded: false });
      await Promise.all([
        withRlsBypass((tx) => seedClassCategories(tx, T)),
        withRlsBypass((tx) => seedClassCategories(tx, T)),
        withRlsBypass((tx) => seedClassCategories(tx, T)),
      ]);
      await withRlsBypass((tx) => seedClassCategories(tx, T));
      expect(await categories(T)).toHaveLength(8);
    });

    it("a club with no rows yet (made by an older build) is seeded by its first class with an old key — once, even when two classes arrive at once", async () => {
      const T = await club("lazy", { seeded: false });
      const [a, b] = await Promise.all([classRow(T, "Gi A", { category: "gi" }), classRow(T, "No-Gi B", { category: "nogi" })]);
      const rows = await categories(T);
      expect(rows).toHaveLength(8);
      expect(a.categoryId).toBe(rows.find((r) => r.legacyKey === "gi")!.id);
      expect(b.categoryId).toBe(rows.find((r) => r.legacyKey === "nogi")!.id);
    });
  });

  describe("the bridge's rules", () => {
    let T = "";
    beforeAll(async () => { T = await club("rules"); });

    it("old key only (insert and update): the reference follows; null clears both", async () => {
      const gi = await byKey(T, "gi");
      const comp = await byKey(T, "competition");
      const c = await classRow(T, "Old-style insert", { category: "gi" });
      expect([c.category, c.categoryId]).toEqual(["gi", gi.id]);
      await oldBuildWrite(T, c.id, "competition");
      expect(await read(T, c.id)).toMatchObject({ category: "competition", categoryId: comp.id });
      await oldBuildWrite(T, c.id, null);
      expect(await read(T, c.id)).toMatchObject({ category: null, categoryId: null });
    });

    it("reference only: the old key follows; a category the club made leaves it empty; null clears both", async () => {
      const kids = await byKey(T, "kids");
      const own = await madeByClub(T, `Intermediate ${randomUUID().slice(0, 4)}`);
      const c = await classRow(T, "New-style insert", { categoryId: kids.id });
      expect([c.category, c.categoryId]).toEqual(["kids", kids.id]);
      await withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: own.id } }));
      expect(await read(T, c.id)).toMatchObject({ category: null, categoryId: own.id });
      await withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: null } }));
      expect(await read(T, c.id)).toMatchObject({ category: null, categoryId: null });
    });

    it("both named in one write where one equals its current value: still refused when they disagree (never resolved)", async () => {
      const gi = await byKey(T, "gi");
      const nogi = await byKey(T, "nogi");
      const own = await madeByClub(T, `Made ${randomUUID().slice(0, 4)}`);
      const c = await classRow(T, "Named both", { categoryId: gi.id });
      // The key is named but unchanged ('gi'), the reference moves to a club-made category: they disagree.
      expect(await errorText(withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "categoryId" = ${own.id}, "category" = 'gi' WHERE "id" = ${c.id}`))).toContain("MF_CLASS_CATEGORY_CONFLICT");
      // The reference is named but unchanged (Gi), the key moves to 'nogi': they disagree.
      expect(await errorText(withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "categoryId" = ${gi.id}, "category" = 'nogi' WHERE "id" = ${c.id}`))).toContain("MF_CLASS_CATEGORY_CONFLICT");
      // Through Prisma, which names exactly the fields it is given.
      expect(await errorText(withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: gi.id, category: "nogi" } })))).toContain("MF_CLASS_CATEGORY_CONFLICT");
      expect(await read(T, c.id)).toMatchObject({ category: "gi", categoryId: gi.id });
      // Both named and agreeing (one of them unchanged) is fine.
      await withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "categoryId" = ${nogi.id}, "category" = 'nogi' WHERE "id" = ${c.id}`);
      expect(await read(T, c.id)).toMatchObject({ category: "nogi", categoryId: nogi.id });
      await withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "categoryId" = ${nogi.id}, "category" = 'nogi' WHERE "id" = ${c.id}`);
      // A club-made category with an empty key agrees.
      await withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "categoryId" = ${own.id}, "category" = NULL WHERE "id" = ${c.id}`);
      expect(await read(T, c.id)).toMatchObject({ category: null, categoryId: own.id });
    });

    it("a column named in one statement is not carried into the next statement of the same transaction", async () => {
      const gi = await byKey(T, "gi");
      const comp = await byKey(T, "competition");
      const c = await classRow(T, "Two statements", { categoryId: gi.id });
      await withTenantContext(T, async (tx) => {
        await tx.$executeRaw`UPDATE "Class" SET "categoryId" = ${gi.id} WHERE "id" = ${c.id}`;
        // The next statement names only the key: it must be read as old-key-only, not as "both named".
        await tx.$executeRaw`UPDATE "Class" SET "category" = 'competition' WHERE "id" = ${c.id}`;
      });
      expect(await read(T, c.id)).toMatchObject({ category: "competition", categoryId: comp.id });
    });

    it("an old-key-only write is stamped (categoryKeyWrittenAt); this release's reference writes never are", async () => {
      const gi = await byKey(T, "gi");
      const c = await classRow(T, "Stamp", { categoryId: gi.id });
      const stamp = () => withRlsBypass((tx) => tx.class.findFirstOrThrow({ where: { id: c.id }, select: { categoryKeyWrittenAt: true } }));
      expect((await stamp()).categoryKeyWrittenAt).toBeNull();
      as("owner", T);
      vi.spyOn(console, "info").mockImplementation(() => {});
      // The route translating an old key from an older page writes the reference: no stamp.
      expect((await classPATCH(request(`/api/classes/${c.id}`, "PATCH", { category: "nogi" }), params(c.id))).status).toBe(200);
      expect((await stamp()).categoryKeyWrittenAt).toBeNull();
      // A build from before the release writes the old key itself: stamped.
      await oldBuildWrite(T, c.id, "kids");
      expect((await stamp()).categoryKeyWrittenAt).not.toBeNull();
    });

    it("both in one write: agreeing is accepted; disagreeing is refused whole, never silently resolved", async () => {
      const gi = await byKey(T, "gi");
      const nogi = await byKey(T, "nogi");
      const c = await classRow(T, "Both", { categoryId: gi.id, category: "gi" });
      expect([c.category, c.categoryId]).toEqual(["gi", gi.id]);
      const conflict = await errorText(withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: nogi.id, category: "gi" } })));
      expect(conflict).toContain("MF_CLASS_CATEGORY_CONFLICT");
      const clearedButKeyed = await errorText(withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: null, category: "nogi" } })));
      expect(clearedButKeyed).toContain("MF_CLASS_CATEGORY_CONFLICT");
      const insertConflict = await errorText(classRow(T, "Both, disagreeing", { categoryId: nogi.id, category: "gi" }));
      expect(insertConflict).toContain("MF_CLASS_CATEGORY_CONFLICT");
      // Nothing of the refused writes landed.
      expect(await read(T, c.id)).toMatchObject({ category: "gi", categoryId: gi.id });
    });

    it("an unrelated edit leaves both alone (the trigger does not even fire)", async () => {
      const own = await madeByClub(T, `Advanced ${randomUUID().slice(0, 4)}`);
      const c = await classRow(T, "Unrelated", { categoryId: own.id });
      await withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { name: "Unrelated (renamed)", maxCapacity: 20 } }));
      expect(await read(T, c.id)).toMatchObject({ name: "Unrelated (renamed)", category: null, categoryId: own.id });
    });
  });

  describe("archived categories", () => {
    let T = "";
    beforeAll(async () => { T = await club("archived"); });

    it("a new assignment to an archived category is refused, by reference and by old key", async () => {
      const priv = await byKey(T, "private");
      await archive(priv.id);
      const c = await classRow(T, "Choosing archived");
      expect(await errorText(withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: priv.id } })))).toContain("MF_CLASS_CATEGORY_ARCHIVED");
      expect(await errorText(oldBuildWrite(T, c.id, "private"))).toContain("MF_CLASS_CATEGORY_ARCHIVED");
      expect(await read(T, c.id)).toMatchObject({ category: null, categoryId: null });
    });

    it("a class keeps the archived category it has through any other edit, and through the route", async () => {
      const other = await byKey(T, "other");
      const c = await classRow(T, "Keeping archived", { categoryId: other.id });
      await archive(other.id);
      await withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { name: "Keeping archived (Tue)" } }));
      await oldBuildRename(T, c.id, "Keeping archived (Wed)");
      as("owner", T);
      const res = await classPATCH(request(`/api/classes/${c.id}`, "PATCH", { categoryId: other.id, name: "Keeping archived (Thu)" }), params(c.id));
      expect(res.status).toBe(200);
      expect(await read(T, c.id)).toMatchObject({ name: "Keeping archived (Thu)", categoryId: other.id, category: "other" });
    });

    it("the trigger's real refusal, as Prisma surfaces it, is recognised by classCategoryDbError", async () => {
      const priv = await byKey(T, "private");
      const c = await classRow(T, "Real error");
      let caught: unknown = null;
      await withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: priv.id } })).catch((e) => { caught = e; });
      expect(caught).not.toBeNull();
      expect(classCategoryDbError(caught)).toEqual({ status: 409, error: CATEGORY_ERRORS.archived });
      caught = null;
      await withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: "no-such-category" } })).catch((e) => { caught = e; });
      // The trigger runs before the foreign key, so an unknown id is its NOT_FOUND (400), never a raw P2003.
      expect(classCategoryDbError(caught)).toEqual({ status: 400, error: CATEGORY_ERRORS.notFound });
    });

    it("the route refuses choosing an archived category with a 409 and the sentence the form shows", async () => {
      const priv = await byKey(T, "private");
      const c = await classRow(T, "Route archived");
      as("owner", T);
      const res = await classPATCH(request(`/api/classes/${c.id}`, "PATCH", { categoryId: priv.id }), params(c.id));
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe(CATEGORY_ERRORS.archived);
    });
  });

  describe("a build from before this release, after the club made its own category", () => {
    it("an old edit form's save (no category sent) keeps the club-made category; an explicit old choice replaces it", async () => {
      const T = await club("old-build");
      const own = await madeByClub(T, "Beginners");
      const fund = await byKey(T, "fundamentals");
      const c = await classRow(T, "Fundamentals Gi", { categoryId: own.id });
      // The old class form sends `category` only when its select changed. Its select showed "Uncategorised"
      // (the old key is empty for a club-made category), so an unrelated save sends no category at all.
      await oldBuildRename(T, c.id, "Fundamentals Gi (Mon)");
      expect(await read(T, c.id)).toMatchObject({ category: null, categoryId: own.id });
      // "Uncategorised" again is no change to the old column, so the trigger does not fire and nothing moves.
      await oldBuildWrite(T, c.id, null);
      expect(await read(T, c.id)).toMatchObject({ category: null, categoryId: own.id });
      // A person on the old page explicitly picking "Fundamentals" is a real choice and is applied.
      await oldBuildWrite(T, c.id, "fundamentals");
      expect(await read(T, c.id)).toMatchObject({ category: "fundamentals", categoryId: fund.id });
    });
  });

  describe("tenant isolation in the database", () => {
    let A = "";
    let B = "";
    beforeAll(async () => {
      A = await club("iso-A");
      B = await club("iso-B");
    });

    it("no class can take another club's category: direct write, insert and route", async () => {
      const theirs = await byKey(B, "gi");
      const c = await classRow(A, "Mine");
      const direct = await errorText(withRlsBypass((tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: theirs.id } })));
      expect(direct).toMatch(/MF_CLASS_CATEGORY_NOT_FOUND|Class_categoryId_tenantId_fkey|P2003/);
      const insert = await errorText(withRlsBypass((tx) => tx.class.create({ data: { tenantId: A, name: "Theirs", duration: 60, categoryId: theirs.id } })));
      expect(insert).toMatch(/MF_CLASS_CATEGORY_NOT_FOUND|Class_categoryId_tenantId_fkey|P2003/);
      as("owner", A);
      const res = await classPATCH(request(`/api/classes/${c.id}`, "PATCH", { categoryId: theirs.id }), params(c.id));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe(CATEGORY_ERRORS.notFound);
      const post = await classPOST(request("/api/classes", "POST", { name: "New", duration: 60, categoryId: theirs.id, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }));
      expect(post.status).toBe(400);
      expect(await read(A, c.id)).toMatchObject({ category: null, categoryId: null });
    });

    it("an old key always resolves to the writer's own club's category", async () => {
      const mine = await byKey(A, "nogi");
      const c = await classRow(A, "Key", { category: "nogi" });
      expect(c.categoryId).toBe(mine.id);
      expect(c.categoryId).not.toBe((await byKey(B, "nogi")).id);
    });

    it("acting for one club, the other club's categories are invisible and cannot be seeded or written", async () => {
      const visible = await withTenantContext(A, (tx) => tx.classCategory.findMany({ where: { tenantId: B } }));
      // Row-level security on the restricted role; the owner role is checked for BYPASSRLS below.
      const [{ role, bypass }] = await withRlsBypass((tx) => tx.$queryRaw<{ role: string; bypass: boolean }[]>`SELECT current_user::text AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`);
      console.log(`[class-categories-bridge-db] database role ${role}, BYPASSRLS ${bypass}`);
      // db-tests.mjs runs the restricted pass with RLS_ENFORCED=1: that role must never bypass row-level security.
      if (process.env.RLS_ENFORCED === "1") expect(bypass).toBe(false);
      const C = await club("iso-C", { seeded: false });
      const seedOther = await errorText(withTenantContext(A, (tx) => seedClassCategories(tx, C)));
      if (!bypass) {
        expect(visible).toEqual([]);
        // SECURITY INVOKER: the function inserts with the caller's rights, so row-level security refuses it.
        expect(seedOther).toMatch(/row-level security|violates/i);
        expect(await categories(C)).toHaveLength(0);
      } else {
        // A role that bypasses row-level security sees across clubs: the branch is observed, not skipped silently.
        // Isolation for it rests on the composite key and the trigger's tenant filter, proved by the tests above.
        expect(visible.length).toBe(8);
      }
    });

    it("neither function is SECURITY DEFINER (no elevated rights)", async () => {
      const rows = await withRlsBypass((tx) => tx.$queryRaw<{ name: string; definer: boolean }[]>`
        SELECT p.proname AS name, p.prosecdef AS definer FROM pg_proc p
         WHERE p.proname IN ('matflow_seed_class_categories', 'matflow_class_category_bridge') ORDER BY 1`);
      expect(rows).toEqual([
        { name: "matflow_class_category_bridge", definer: false },
        { name: "matflow_seed_class_categories", definer: false },
      ]);
    });
  });

  describe("archive against assignment, on two connections", () => {
    it("archive first (uncommitted): the assignment waits, then is refused once the archive commits", async () => {
      const T = await club("race-1");
      const comp = await byKey(T, "competition");
      const c = await classRow(T, "Race 1");
      const held = gate();
      const release = gate();
      const archiving = withTenantContext(T, async (tx) => {
        await tx.classCategory.update({ where: { id: comp.id }, data: { archivedAt: new Date(), version: { increment: 1 } } });
        held.open();
        await release.opened;
      }, { timeout: 30_000 });
      await held.opened;
      let assignSettled = false;
      const assigning = errorText(withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: comp.id } }), { timeout: 30_000 }))
        .finally(() => { assignSettled = true; });
      await sleep(700);
      // Still waiting on the category row while the archive is uncommitted: the lock is real, not timing luck.
      expect(assignSettled).toBe(false);
      release.open();
      await archiving;
      const outcome = await assigning;
      expect(outcome).toContain("MF_CLASS_CATEGORY_ARCHIVED");
      expect(await read(T, c.id)).toMatchObject({ categoryId: null });
    }, 60_000);

    it("assignment first (uncommitted): the archive waits, then lands; the class keeps its category", async () => {
      const T = await club("race-2");
      const comp = await byKey(T, "competition");
      const c = await classRow(T, "Race 2");
      const held = gate();
      const release = gate();
      const assigning = withTenantContext(T, async (tx) => {
        await tx.class.update({ where: { id: c.id }, data: { categoryId: comp.id } });
        held.open();
        await release.opened;
      }, { timeout: 30_000 });
      await held.opened;
      let archiveSettled = false;
      const archiving = withTenantContext(T, (tx) => tx.classCategory.update({ where: { id: comp.id }, data: { archivedAt: new Date() } }), { timeout: 30_000 })
        .finally(() => { archiveSettled = true; });
      await sleep(700);
      // The archive waits on the assignment's FOR SHARE (the foreign key's KEY SHARE alone would not stop a non-key
      // UPDATE), so it has not finished while the assignment is uncommitted.
      expect(archiveSettled).toBe(false);
      release.open();
      await assigning;
      await archiving;
      expect(await read(T, c.id)).toMatchObject({ categoryId: comp.id, category: "competition" });
      expect((await byKey(T, "competition")).archivedAt).not.toBeNull();
    }, 60_000);
  });

  describe("Undo of a class edit recorded before this release", () => {
    let T = "";
    let undoer = "";
    beforeAll(async () => {
      T = await club("undo");
      undoer = (await withRlsBypass((tx) => tx.user.create({ data: { tenantId: T, email: `owner-${randomUUID()}@example.test`, passwordHash: "synthetic-not-a-hash", name: "Synthetic Owner", role: "owner" }, select: { id: true } }))).id;
    });
    /** A class.updated row in the shape builds before Release A wrote: old keys in before/after. */
    const oldRow = (classId: string, before: string | null, after: string | null) =>
      withRlsBypass((tx) => tx.auditLog.create({ data: {
        tenantId: T, userId: undoer, action: "class.updated", entityType: "Class", entityId: classId,
        metadata: { fields: ["category"], before: { category: before }, after: { category: after } },
      } })) as unknown as Promise<AuditRowLike>;
    const undo = (row: AuditRowLike) =>
      withTenantContext(T, (tx) => executeUndo(tx, [{ row, decision: decideUndo(row, false) }], { tenantId: T, userId: undoer }));

    it("puts the earlier category back as this club's category with that key, keeping both columns in step", async () => {
      const c = await classRow(T, "Undo plain", { category: "nogi" });
      const row = await oldRow(c.id, "gi", "nogi");
      await undo(row);
      expect(await read(T, c.id)).toMatchObject({ category: "gi", categoryId: (await byKey(T, "gi")).id });
    });

    it("never overwrites a category the club made since — even when the old edit had cleared the category", async () => {
      const own = await madeByClub(T, "Intermediate");
      const c = await classRow(T, "Undo after a newer choice", { category: "gi" });
      await oldBuildWrite(T, c.id, null); // the recorded edit: Gi → uncategorised
      const row = await oldRow(c.id, "gi", null);
      await withTenantContext(T, (tx) => tx.class.update({ where: { id: c.id }, data: { categoryId: own.id } }));
      // The stale refusal itself (lib/undo-registry.ts UndoStale's default sentence), not any error.
      await expect(undo(row)).rejects.toThrow("This has been changed since");
      expect(await read(T, c.id)).toMatchObject({ categoryId: own.id, category: null });
    });

    it("refuses to put back a category archived since", async () => {
      const c = await classRow(T, "Undo onto archived", { category: "kids" });
      await oldBuildWrite(T, c.id, "open_mat");
      const row = await oldRow(c.id, "kids", "open_mat");
      await archive((await byKey(T, "kids")).id);
      await expect(undo(row)).rejects.toThrow(REASON.categoryArchived);
      expect(await read(T, c.id)).toMatchObject({ category: "open_mat" });
    });
  });

  describe("every class the tests wrote is consistent", () => {
    it("old key and reference agree on every row: no key without a reference, and a reference's key is its row's", async () => {
      // A class on a category the club made has a reference and no key; that is agreement, not a gap.
      const bad = await withRlsBypass((tx) => tx.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM "Class" c
          LEFT JOIN "ClassCategory" cc ON cc."id" = c."categoryId" AND cc."tenantId" = c."tenantId"
         WHERE c."tenantId" = ANY(${tenants}::text[])
           AND ((c."categoryId" IS NULL AND c."category" IS NOT NULL)
             OR (c."categoryId" IS NOT NULL AND cc."legacyKey" IS DISTINCT FROM c."category"))`);
      expect(Number(bad[0].n)).toBe(0);
    });
  });
});
