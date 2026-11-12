// Club-managed class categories, Release B (12 Nov 2026): editors left open while the club's categories change.
// Against real Postgres. Synthetic data only. Needs migration 20261112120000_class_category_stale_writer.
//
// Three kinds of writer, each against each change the club can make:
//  - an OLD PAGE: a browser holding a page from before club-managed categories. It knows only the eight old keys and
//    sends `category` (an old key or null) only when its select changed;
//  - a CURRENT FORM opened before the change: it sends `categoryId` with `categoryBaseId` (the category it saw on
//    the class) only when its select changed;
//  - a DIRECT DATABASE WRITER that knows only the old key column (a build from before Release A, or a script).
//
// The changes: Fundamentals renamed to Beginners; a starting category archived; a category the club made; another
// person changing the class's category. For each: unrelated saves keep the class's current category; an explicit
// change the writer made without seeing the current category is a conflict (409, or the bridge's refusal) and
// changes nothing; an explicit change made with the current category in view is applied.
//
// Every case runs with management switched on and switched off: the switch gates the management routes only,
// never these protections.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/revalidate-tag-logged", () => ({ revalidateTagLogged: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { CATEGORY_ERRORS, seedClassCategories } from "@/lib/class-category-store";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
// Each case makes ten to twenty route calls; against the test branch from far away that is over 30 s.
vi.setConfig({ testTimeout: 180_000 });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const errorText = async (p: Promise<unknown>) => {
  try { await p; return "no error"; } catch (e) { return `${(e as Error).message} ${JSON.stringify((e as { meta?: unknown }).meta ?? {})}`; }
};

describe.skipIf(!HAS_DB)("Release B — editors left open while categories change (route and database)", () => {
  const tenants: string[] = [];
  const before = process.env.CLASS_CATEGORY_MANAGEMENT;

  async function club(label: string): Promise<string> {
    const t = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `Synthetic categories B stale ${label}`, slug: `mfv-catbs-${randomUUID()}` } }));
    tenants.push(t.id);
    await withRlsBypass((tx) => seedClassCategories(tx, t.id));
    return t.id;
  }
  const catByKey = async (T: string, key: string) =>
    withRlsBypass((tx) => tx.classCategory.findFirstOrThrow({ where: { tenantId: T, legacyKey: key } }));
  const classOn = (T: string, name: string, categoryId: string | null) =>
    withTenantContext(T, (tx) => tx.class.create({ data: { tenantId: T, name, duration: 60, categoryId }, select: { id: true } }));
  const readClass = (T: string, id: string) =>
    withRlsBypass((tx) => tx.class.findFirstOrThrow({ where: { id, tenantId: T }, select: { name: true, category: true, categoryId: true } }));
  // The club's changes, made the way Release B's management routes make them (the routes' own suite covers the
  // routes; here only the resulting state matters, so the switch can be off).
  const rename = (T: string, id: string, name: string) =>
    withTenantContext(T, (tx) => tx.classCategory.update({ where: { id, tenantId: T }, data: { name, nameKey: name.toLowerCase(), version: { increment: 1 } } }));
  const archive = (T: string, id: string) =>
    withTenantContext(T, (tx) => tx.classCategory.update({ where: { id, tenantId: T }, data: { archivedAt: new Date(), version: { increment: 1 } } }));
  const made = async (T: string, name: string) => {
    const max = await withRlsBypass((tx) => tx.classCategory.aggregate({ where: { tenantId: T }, _max: { sortOrder: true } }));
    return withTenantContext(T, (tx) => tx.classCategory.create({ data: { tenantId: T, name, nameKey: name.toLowerCase(), sortOrder: (max._max.sortOrder ?? 0) + 1 } }));
  };
  // Another person moving the class, by reference (this release's form).
  const moveTo = (T: string, id: string, categoryId: string | null) =>
    withTenantContext(T, (tx) => tx.class.update({ where: { id, tenantId: T }, data: { categoryId } }));

  // Writers.
  const save = async (T: string, id: string, body: Record<string, unknown>) => {
    vi.mocked(auth).mockResolvedValue({ user: { id: `synthetic-owner-${T.slice(-6)}`, role: "owner", tenantId: T } } as never);
    const res = await classPATCH(new Request(`https://test.local/api/classes/${id}`, {
      method: "PATCH",
      headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
      body: JSON.stringify(body),
    }), params(id));
    return { status: res.status, error: res.ok ? undefined : ((await res.json()) as { error?: string }).error };
  };
  const oldPage = (T: string, id: string, category: string | null) => save(T, id, { category });
  // A Release A page: sends the category by id, but not the category it saw.
  const releaseAPage = (T: string, id: string, categoryId: string | null) => save(T, id, { categoryId });
  const currentForm = (T: string, id: string, categoryId: string | null, seen: string | null) =>
    save(T, id, { categoryId, categoryBaseId: seen });
  const unrelated = (T: string, id: string, name: string) => save(T, id, { name });
  const directKey = (T: string, id: string, key: string | null) =>
    withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "category" = ${key} WHERE "id" = ${id} AND "tenantId" = ${T}`);
  const directName = (T: string, id: string, name: string) =>
    withTenantContext(T, (tx) => tx.$executeRaw`UPDATE "Class" SET "name" = ${name} WHERE "id" = ${id} AND "tenantId" = ${T}`);

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

  for (const sw of ["on", "off"] as const) {
    describe(`management switched ${sw}`, () => {
      const setSwitch = () => { if (sw === "on") process.env.CLASS_CATEGORY_MANAGEMENT = "on"; else delete process.env.CLASS_CATEGORY_MANAGEMENT; };

      it("Fundamentals renamed to Beginners while editors are open: the old page still sees it (as Fundamentals) and its choices apply; the current form's choice applies; unrelated saves keep it", async () => {
        setSwitch();
        const T = await club(`rename-${sw}`);
        const fund = await catByKey(T, "fundamentals");
        const gi = await catByKey(T, "gi");
        const a = await classOn(T, "Fundamentals Gi", fund.id);
        const b = await classOn(T, "Gi", gi.id);
        await rename(T, fund.id, "Beginners");

        // Old page: unrelated save keeps it; choosing another starting category on it applies (it can show it).
        expect((await unrelated(T, a.id, "Fundamentals Gi (Mon)")).status).toBe(200);
        expect((await readClass(T, a.id)).categoryId).toBe(fund.id);
        expect((await oldPage(T, a.id, "gi")).status).toBe(200);
        expect(await readClass(T, a.id)).toMatchObject({ categoryId: gi.id, category: "gi" });
        // Old page choosing "fundamentals" lands on the renamed category, the same row.
        expect((await oldPage(T, b.id, "fundamentals")).status).toBe(200);
        expect(await readClass(T, b.id)).toMatchObject({ categoryId: fund.id, category: "fundamentals" });
        // Current form opened before the rename: its choice is by id, so it lands on Beginners.
        expect((await currentForm(T, a.id, fund.id, gi.id)).status).toBe(200);
        expect((await readClass(T, a.id)).categoryId).toBe(fund.id);
        // Direct old-key writer: same as the old page.
        await directKey(T, b.id, "kids");
        expect((await readClass(T, b.id)).category).toBe("kids");
        await directKey(T, b.id, "fundamentals");
        expect((await readClass(T, b.id)).categoryId).toBe(fund.id);
      });

      it("a starting category archived while editors are open: choosing it is refused (route 409, bridge ARCHIVED); a class on it keeps it through unrelated saves and re-sends", async () => {
        setSwitch();
        const T = await club(`archive-${sw}`);
        const comp = await catByKey(T, "competition");
        const gi = await catByKey(T, "gi");
        const onComp = await classOn(T, "Comp", comp.id);
        const onGi = await classOn(T, "Gi", gi.id);
        await archive(T, comp.id);

        const r1 = await oldPage(T, onGi.id, "competition");
        expect(r1).toMatchObject({ status: 409, error: CATEGORY_ERRORS.archived });
        const r2 = await currentForm(T, onGi.id, comp.id, gi.id);
        expect(r2).toMatchObject({ status: 409, error: CATEGORY_ERRORS.archived });
        expect(await errorText(directKey(T, onGi.id, "competition"))).toContain("MF_CLASS_CATEGORY_ARCHIVED");
        expect((await readClass(T, onGi.id)).categoryId).toBe(gi.id);

        // A class already on it keeps it: unrelated saves (route and direct), and the old page re-sending its key.
        expect((await unrelated(T, onComp.id, "Comp (Sat)")).status).toBe(200);
        await directName(T, onComp.id, "Comp (Sun)");
        expect((await oldPage(T, onComp.id, "competition")).status).toBe(200);
        await directKey(T, onComp.id, "competition");
        expect(await readClass(T, onComp.id)).toMatchObject({ name: "Comp (Sun)", categoryId: comp.id, category: "competition" });
      });

      it("a category the club made: an old page or direct old-key writer cannot change a class on it (key or null); unrelated saves keep it; the current form can", async () => {
        setSwitch();
        const T = await club(`made-${sw}`);
        const adv = await made(T, "Advanced");
        const gi = await catByKey(T, "gi");
        const c = await classOn(T, "Advanced Gi", adv.id);

        for (const key of ["gi", null]) {
          expect(await oldPage(T, c.id, key)).toMatchObject({ status: 409, error: CATEGORY_ERRORS.stale });
        }
        for (const key of ["gi", "nogi"]) {
          expect(await errorText(directKey(T, c.id, key))).toContain("MF_CLASS_CATEGORY_STALE_WRITER");
        }
        // A direct write of the key the class already has (NULL, on a club-made category) is no change.
        await directKey(T, c.id, null);
        expect(await readClass(T, c.id)).toMatchObject({ categoryId: adv.id, category: null });
        expect((await unrelated(T, c.id, "Advanced Gi (Wed)")).status).toBe(200);
        await directName(T, c.id, "Advanced Gi (Thu)");
        expect(await readClass(T, c.id)).toMatchObject({ name: "Advanced Gi (Thu)", categoryId: adv.id });
        // The current form saw it, so its explicit change applies.
        expect((await currentForm(T, c.id, gi.id, adv.id)).status).toBe(200);
        expect(await readClass(T, c.id)).toMatchObject({ categoryId: gi.id, category: "gi" });
      });

      it("another person changed the class's category: the current form's explicit change made without seeing it is a 409 and changes nothing; its unrelated save keeps theirs", async () => {
        setSwitch();
        const T = await club(`moved-${sw}`);
        const gi = await catByKey(T, "gi");
        const nogi = await catByKey(T, "nogi");
        const kids = await catByKey(T, "kids");
        const adv = await made(T, "Advanced");
        const c = await classOn(T, "Mixed", gi.id);

        // Opened on Gi; someone else moves it to No-Gi; this form then chooses Kids.
        await moveTo(T, c.id, nogi.id);
        expect(await currentForm(T, c.id, kids.id, gi.id)).toMatchObject({ status: 409, error: CATEGORY_ERRORS.changed });
        expect((await readClass(T, c.id)).categoryId).toBe(nogi.id);
        // Clearing it is an explicit change too.
        expect(await currentForm(T, c.id, null, gi.id)).toMatchObject({ status: 409, error: CATEGORY_ERRORS.changed });
        // Opened uncategorised; someone else gives it a club-made category.
        await moveTo(T, c.id, adv.id);
        expect(await currentForm(T, c.id, kids.id, null)).toMatchObject({ status: 409, error: CATEGORY_ERRORS.changed });
        expect((await readClass(T, c.id)).categoryId).toBe(adv.id);
        // Its unrelated save sends no category: theirs is kept.
        expect((await unrelated(T, c.id, "Mixed (Fri)")).status).toBe(200);
        expect((await readClass(T, c.id)).categoryId).toBe(adv.id);
        // Reloaded (sees Advanced): applied.
        expect((await currentForm(T, c.id, kids.id, adv.id)).status).toBe(200);
        expect((await readClass(T, c.id)).categoryId).toBe(kids.id);
        // Choosing the category the class already has changes nothing: never refused, even from a stale form.
        expect((await currentForm(T, c.id, kids.id, gi.id)).status).toBe(200);
        expect((await readClass(T, c.id)).categoryId).toBe(kids.id);
      });

      it("a Release A page left open (categoryId without categoryBaseId): refused on a class on a club-made category, applied on a starting one", async () => {
        setSwitch();
        const T = await club(`release-a-${sw}`);
        const adv = await made(T, "Advanced");
        const gi = await catByKey(T, "gi");
        const nogi = await catByKey(T, "nogi");
        const onMade = await classOn(T, "Advanced Gi", adv.id);
        const onStart = await classOn(T, "Gi", gi.id);
        for (const target of [gi.id, null]) {
          expect(await releaseAPage(T, onMade.id, target)).toMatchObject({ status: 409, error: CATEGORY_ERRORS.stale });
        }
        expect((await readClass(T, onMade.id)).categoryId).toBe(adv.id);
        // Re-sending the category it already has, and an unrelated save: accepted, nothing changes.
        expect((await releaseAPage(T, onMade.id, adv.id)).status).toBe(200);
        expect((await unrelated(T, onMade.id, "Advanced Gi (Sat)")).status).toBe(200);
        expect((await readClass(T, onMade.id)).categoryId).toBe(adv.id);
        // On a starting category it could show: applied, as Release A does.
        expect((await releaseAPage(T, onStart.id, nogi.id)).status).toBe(200);
        expect((await readClass(T, onStart.id)).categoryId).toBe(nogi.id);
      });
    });
  }

  it("the observation signal: a category change from a page older than Release B (old key, or a Release A page) is marked categoryOldKey with who made it; the current form's save and an unrelated save are not", async () => {
    process.env.CLASS_CATEGORY_MANAGEMENT = "on";
    const T = await club("signal");
    const gi = await catByKey(T, "gi");
    const kids = await catByKey(T, "kids");
    const c = await classOn(T, "Signal", gi.id);
    const marked = async () => (await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: T, action: "class.updated", entityId: c.id }, orderBy: { createdAt: "asc" } })))
      .map((r) => {
        const m = (r.metadata ?? {}) as { categoryOldKey?: boolean; actorId?: string };
        // A synthetic session user is not a staff User row, so the audit log keeps it as metadata.actorId.
        return { userId: r.userId ?? m.actorId, oldKey: m.categoryOldKey === true };
      });
    expect((await currentForm(T, c.id, kids.id, gi.id)).status).toBe(200);
    expect((await unrelated(T, c.id, "Signal (Tue)")).status).toBe(200);
    expect((await oldPage(T, c.id, "gi")).status).toBe(200);
    expect((await releaseAPage(T, c.id, kids.id)).status).toBe(200);
    const who = `synthetic-owner-${T.slice(-6)}`;
    // The two older pages' rows are written awaited, before the save answers: present at once, no waiting.
    expect((await marked()).filter((r) => r.oldKey)).toEqual([{ userId: who, oldKey: true }, { userId: who, oldKey: true }]);
    // The other two are ordinary best-effort rows: they land shortly, unmarked. Compared as a set (they land in any order).
    const count = (rows: { oldKey: boolean }[]) => ({ marked: rows.filter((r) => r.oldKey).length, unmarked: rows.filter((r) => !r.oldKey).length });
    await expect.poll(async () => count(await marked()), { timeout: 20_000, interval: 500 }).toEqual({ marked: 2, unmarked: 2 });
  });

  it("the limit that remains: an old page carries no record of what it saw, so on a class whose category is a starting one (which it can show) its explicit change applies even if someone changed that class since", async () => {
    process.env.CLASS_CATEGORY_MANAGEMENT = "on";
    const T = await club("old-page-limit");
    const gi = await catByKey(T, "gi");
    const nogi = await catByKey(T, "nogi");
    const c = await classOn(T, "Gi", gi.id);
    await moveTo(T, c.id, nogi.id);
    expect((await oldPage(T, c.id, "kids")).status).toBe(200);
    expect((await readClass(T, c.id)).category).toBe("kids");
  });
});
