// Mats and the same-time split against real Postgres (the Neon TEST branch),
// through the real route handlers and the real audit writer. Run alone, as
// both roles: node .claude/skills/matflow-verify-local/scripts/db-tests.mjs tests/integration/mats-db.test.ts
//
// Proved here, because a mock cannot prove them:
//  - isolation: one club can never read, rename, reorder, remove or adopt
//    another club's mats, nor put a class on one;
//  - the write-through rule on real rows: rename, adopt, remove, class edit,
//    Undo;
//  - the per-club lock under real concurrency: two adds, two adopts, the cap,
//    a rename against a class save, an undo against a rename, with no deadlock;
//  - the choice is stored only by its own route;
//  - one audit row per write, with which rows; none for a refusal or a no-op.
// Synthetic data only; skips without TEST_DATABASE_URL.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/revalidate-tag-logged", () => ({ revalidateTagLogged: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { GET as matsGET, POST as matsPOST } from "@/app/api/mats/route";
import { PATCH as matPATCH, DELETE as matDELETE } from "@/app/api/mats/[id]/route";
import { PUT as orderPUT } from "@/app/api/mats/order/route";
import { GET as suggestionsGET } from "@/app/api/mats/suggestions/route";
import { POST as adoptPOST } from "@/app/api/mats/adopt/route";
import { PATCH as layoutPATCH } from "@/app/api/timetable/layout/route";
import { POST as classPOST } from "@/app/api/classes/route";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { executeUndo } from "@/lib/undo-batch";
import { decideUndo, type AuditRowLike } from "@/lib/undo-registry";

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

describe.skipIf(!HAS_DB)("mats — real database", () => {
  const tenants: string[] = [];
  /** A fresh synthetic club for each group, so no test depends on another's rows. */
  async function club(label: string): Promise<string> {
    const tenant = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `Synthetic mats ${label}`, slug: `mfv-mats-${randomUUID()}` } }));
    tenants.push(tenant.id);
    return tenant.id;
  }
  /** A class row written directly: the routes under test here are the mats routes. */
  const classRow = (tenantId: string, name: string, location: string | null, over: Record<string, unknown> = {}) =>
    withRlsBypass((tx) => tx.class.create({ data: { tenantId, name, location, duration: 60, ...over }, select: { id: true } }));
  const mats = (tenantId: string) =>
    withRlsBypass((tx) => tx.mat.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, nameKey: true, sortOrder: true } }));
  const classes = (tenantId: string) =>
    withRlsBypass((tx) => tx.class.findMany({ where: { tenantId }, orderBy: { name: "asc" }, select: { id: true, name: true, matId: true, location: true } }));
  const audits = (tenantId: string, action?: string) =>
    withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, ...(action ? { action } : { action: { in: ["mat.create", "mat.update", "mat.delete", "mat.reorder", "mat.adopt", "timetable.layout.update"] } }) }, orderBy: { createdAt: "asc" } }));
  const addMat = async (tenantId: string, name: string) => {
    as("owner", tenantId);
    const res = await matsPOST(request("/api/mats", "POST", { name }));
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; name: string };
  };

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

  describe("isolation between two clubs", () => {
    let A = "";
    let B = "";
    let theirs = { id: "", name: "" };
    let mine = { id: "", name: "" };
    let theirClass = "";
    beforeAll(async () => {
      A = await club("A");
      B = await club("B");
      theirs = await addMat(B, "Their mat");
      mine = await addMat(A, "Mat 1");
      theirClass = (await classRow(B, "Their class", "Shared name")).id;
      await classRow(A, "My class", "Shared name");
    });

    it("lists only the caller's mats, and both clubs may have a mat of the same name", async () => {
      await addMat(B, "Mat 1");
      as("owner", A);
      const body = (await (await matsGET()).json()) as { mats: { id: string; name: string }[] };
      expect(body.mats).toEqual([{ id: mine.id, name: "Mat 1", classCount: 0 }]);
    });

    it("cannot rename or remove another club's mat: 404, and the row is as it was (its own it can)", async () => {
      as("owner", A);
      expect((await matPATCH(request(`/api/mats/${theirs.id}`, "PATCH", { name: "Mine now" }), params(theirs.id))).status).toBe(404);
      expect((await matDELETE(request(`/api/mats/${theirs.id}`, "DELETE"), params(theirs.id))).status).toBe(404);
      expect((await mats(B)).map((m) => m.name)).toContain("Their mat");
      // Positive control: the same calls on its own mat work.
      const ok = await matPATCH(request(`/api/mats/${mine.id}`, "PATCH", { name: "Main mat" }), params(mine.id));
      expect(ok.status).toBe(200);
      expect((await mats(A)).map((m) => m.name)).toEqual(["Main mat"]);
    });

    it("cannot reorder with another club's mat in the list", async () => {
      as("owner", A);
      const res = await orderPUT(request("/api/mats/order", "PUT", { ids: [mine.id, theirs.id] }));
      expect(res.status).toBe(409);
      expect((await mats(B)).map((m) => m.sortOrder)).toEqual([0, 1]);
    });

    it("adopting a place another club also types touches only the caller's classes", async () => {
      as("owner", A);
      const res = await adoptPOST(request("/api/mats/adopt", "POST", { keys: ["shared name"] }));
      expect(res.status).toBe(200);
      expect((await classes(B)).find((c) => c.id === theirClass)).toMatchObject({ matId: null, location: "Shared name" });
      expect((await classes(A)).find((c) => c.name === "My class")?.matId).toBeTruthy();
      expect((await mats(B)).map((m) => m.name)).not.toContain("Shared name");
    });

    it("cannot put a class on another club's mat, on create or on edit", async () => {
      as("owner", A);
      const create = await classPOST(request("/api/classes", "POST", { name: "Gi", duration: 60, matId: theirs.id, schedules: [{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }] }));
      expect(create.status).toBe(400);
      expect(await create.json()).toEqual({ error: "That mat is not one of this club's mats." });
      const own = await classRow(A, "Gi", null);
      const edit = await classPATCH(request(`/api/classes/${own.id}`, "PATCH", { matId: theirs.id }), params(own.id));
      expect(edit.status).toBe(400);
      expect((await classes(A)).find((c) => c.id === own.id)?.matId).toBeNull();
      expect((await classes(A)).filter((c) => c.name === "Gi")).toHaveLength(1);
    });

    it.runIf(process.env.RLS_ENFORCED === "1")("row security backs it up: an unfiltered read in club A's context returns none of club B's mats", async () => {
      const seen = await withTenantContext(A, (tx) => tx.mat.findMany({ select: { tenantId: true } }));
      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((m) => m.tenantId === A)).toBe(true);
    });
  });

  describe("the write-through rule on real rows", () => {
    let T = "";
    beforeAll(async () => {
      T = await club("write-through");
    });

    it("adopting three spellings makes one mat, puts all three classes on it and rewrites all three places; mats are created in name order", async () => {
      await classRow(T, "A", "Mat 1");
      await classRow(T, "B", "mat  1 ");
      await classRow(T, "C", "MAT 1");
      await classRow(T, "D", "Mat 2");
      await classRow(T, "E", "Mat 2", { deletedAt: new Date(), isActive: false }); // archived: attached too
      as("owner", T);
      const res = await adoptPOST(request("/api/mats/adopt", "POST", { keys: ["mat 2", "mat 1"] }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ matsAdded: 2, classesAttached: 5, layoutChanged: true, layout: { stored: null, effective: "mat" } });
      const list = await mats(T);
      expect(list.map((m) => [m.name, m.nameKey, m.sortOrder])).toEqual([["Mat 1", "mat 1", 0], ["Mat 2", "mat 2", 1]]);
      const rows = await classes(T);
      expect(rows.map((c) => [c.name, c.matId, c.location])).toEqual([
        ["A", list[0].id, "Mat 1"], ["B", list[0].id, "Mat 1"], ["C", list[0].id, "Mat 1"], ["D", list[1].id, "Mat 2"], ["E", list[1].id, "Mat 2"],
      ]);
      const [row] = await audits(T, "mat.adopt");
      expect(row.metadata).toMatchObject({ mats: [{ name: "Mat 1", created: true }, { name: "Mat 2", created: true }] });
      expect((row.metadata as { mats: { classIds: string[] }[] }).mats.map((m) => m.classIds.length)).toEqual([3, 2]);
      // Repeating it changes nothing and records nothing.
      expect((await adoptPOST(request("/api/mats/adopt", "POST", { keys: ["mat 2", "mat 1"] }))).status).toBe(200);
      expect(await audits(T, "mat.adopt")).toHaveLength(1);
      expect(await mats(T)).toHaveLength(2);
    });

    it("renaming a mat renames the place of exactly its classes, in one write with its record", async () => {
      const [mat1, mat2] = await mats(T);
      as("owner", T);
      const res = await matPATCH(request(`/api/mats/${mat2.id}`, "PATCH", { name: "Cage" }), params(mat2.id));
      expect(res.status).toBe(200);
      const rows = await classes(T);
      expect(rows.filter((c) => c.matId === mat2.id).map((c) => c.location)).toEqual(["Cage", "Cage"]);
      expect(rows.filter((c) => c.matId === mat1.id).map((c) => c.location)).toEqual(["Mat 1", "Mat 1", "Mat 1"]);
      const [row] = await audits(T, "mat.update");
      expect(row.entityId).toBe(mat2.id);
      expect(row.metadata).toMatchObject({ before: { name: "Mat 2" }, after: { name: "Cage" }, classesRenamed: 2 });
      // The name already stored: no write, no record.
      expect((await matPATCH(request(`/api/mats/${mat2.id}`, "PATCH", { name: "Cage" }), params(mat2.id))).status).toBe(200);
      expect(await audits(T, "mat.update")).toHaveLength(1);
    });

    it("the suggestions list offers only what is typed and not on a mat", async () => {
      await classRow(T, "F", "Sauna");
      await classRow(T, "G", "cage"); // says the mat's name, is not on it
      await classRow(T, "H", null);
      as("owner", T);
      const body = (await (await suggestionsGET()).json()) as { suggestions: { name: string; classCount: number; matId: string | null }[]; noPlaceCount: number };
      const cage = (await mats(T)).find((m) => m.name === "Cage");
      expect(body.suggestions).toEqual([
        { name: "cage", key: "cage", classCount: 1, tooLong: false, matId: cage?.id },
        { name: "Sauna", key: "sauna", classCount: 1, tooLong: false, matId: null },
      ]);
      expect(body.noPlaceCount).toBe(1);
    });

    it("a class edit that names a mat takes the mat's name; one that names none, on a class on a mat, keeps it", async () => {
      const [mat1] = await mats(T);
      const h = (await classes(T)).find((c) => c.name === "H")!;
      as("owner", T);
      expect((await classPATCH(request(`/api/classes/${h.id}`, "PATCH", { matId: mat1.id, location: "typed" }), params(h.id))).status).toBe(200);
      expect((await classes(T)).find((c) => c.id === h.id)).toMatchObject({ matId: mat1.id, location: "Mat 1" });
      expect((await classPATCH(request(`/api/classes/${h.id}`, "PATCH", { name: "H2", location: "typed again" }), params(h.id))).status).toBe(200);
      expect((await classes(T)).find((c) => c.id === h.id)).toMatchObject({ name: "H2", matId: mat1.id, location: "Mat 1" });
    });

    it("removing a mat never removes a class: its classes stay, on no mat, with the mat's name as their place", async () => {
      const cage = (await mats(T)).find((m) => m.name === "Cage")!;
      const before = (await classes(T)).length;
      as("owner", T);
      const res = await matDELETE(request(`/api/mats/${cage.id}`, "DELETE"), params(cage.id));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, name: "Cage", classCount: 2 });
      const rows = await classes(T);
      expect(rows).toHaveLength(before);
      expect(rows.filter((c) => ["D", "E"].includes(c.name)).map((c) => [c.matId, c.location])).toEqual([[null, "Cage"], [null, "Cage"]]);
      const [row] = await audits(T, "mat.delete");
      expect(row.metadata).toMatchObject({ name: "Cage" });
      expect(((row.metadata as { classIds: string[] }).classIds).sort()).toEqual(rows.filter((c) => ["D", "E"].includes(c.name)).map((c) => c.id).sort());
    });

    it("Undo of a class edit takes the mat's name as it is today, and is refused onto a mat that has gone", async () => {
      const [mat1] = await mats(T);
      const gym = await addMat(T, "Gym floor");
      const cls = await classRow(T, "Undo me", null);
      as("owner", T);
      // Mat 1, then Gym floor: the second edit is the one to undo.
      expect((await classPATCH(request(`/api/classes/${cls.id}`, "PATCH", { matId: mat1.id }), params(cls.id))).status).toBe(200);
      expect((await classPATCH(request(`/api/classes/${cls.id}`, "PATCH", { matId: gym.id }), params(cls.id))).status).toBe(200);
      const edits = (await audits(T, "class.updated")).filter((r) => r.entityId === cls.id);
      const last = edits[edits.length - 1] as unknown as AuditRowLike;
      expect((last.metadata as { before: unknown }).before).toEqual({ location: "Mat 1", matId: mat1.id });
      // Mat 1 is renamed after the edit: the undo must take the NEW name.
      expect((await matPATCH(request(`/api/mats/${mat1.id}`, "PATCH", { name: "Main mat" }), params(mat1.id))).status).toBe(200);
      await withTenantContext(T, (tx) => executeUndo(tx, [{ row: last, decision: decideUndo(last, false) }], { tenantId: T, userId: "synthetic-owner" }));
      expect((await classes(T)).find((c) => c.id === cls.id)).toMatchObject({ matId: mat1.id, location: "Main mat" });
      // Back onto Gym floor by hand, then Gym floor is removed: undoing the first edit (onto Mat 1 from none) still works,
      // but an undo that would put the class back onto the removed mat is refused.
      expect((await classPATCH(request(`/api/classes/${cls.id}`, "PATCH", { matId: gym.id }), params(cls.id))).status).toBe(200);
      expect((await classPATCH(request(`/api/classes/${cls.id}`, "PATCH", { matId: mat1.id }), params(cls.id))).status).toBe(200);
      const again = (await audits(T, "class.updated")).filter((r) => r.entityId === cls.id);
      const ontoGymGone = again[again.length - 1] as unknown as AuditRowLike; // before: Gym floor
      expect((await matDELETE(request(`/api/mats/${gym.id}`, "DELETE"), params(gym.id))).status).toBe(200);
      await expect(
        withTenantContext(T, (tx) => executeUndo(tx, [{ row: ontoGymGone, decision: decideUndo(ontoGymGone, false) }], { tenantId: T, userId: "synthetic-owner" })),
      ).rejects.toThrow("That mat no longer exists.");
      expect((await classes(T)).find((c) => c.id === cls.id)).toMatchObject({ matId: mat1.id, location: "Main mat" });
    }, 120_000);
  });

  describe("the per-club lock under real concurrency", () => {
    it("'Mat 1' against 'mat 1' at once gives one mat and one refusal", async () => {
      const T = await club("race-name");
      as("owner", T);
      const results = await Promise.all([matsPOST(request("/api/mats", "POST", { name: "Mat 1" })), matsPOST(request("/api/mats", "POST", { name: "mat 1" }))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await mats(T)).toHaveLength(1);
      expect(await audits(T, "mat.create")).toHaveLength(1);
    });

    it("two adds at the cap give twelve mats, never thirteen, with positions 0 to 11", async () => {
      const T = await club("race-cap");
      as("owner", T);
      for (let i = 1; i <= 11; i++) expect((await matsPOST(request("/api/mats", "POST", { name: `Area ${i}` }))).status).toBe(201);
      const results = await Promise.all([matsPOST(request("/api/mats", "POST", { name: "Twelfth" })), matsPOST(request("/api/mats", "POST", { name: "Thirteenth" }))]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const list = await mats(T);
      expect(list).toHaveLength(12);
      expect(list.map((m) => m.sortOrder)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    }, 120_000);

    it("two adopts at once leave one set of mats, no server error and one record", async () => {
      const T = await club("race-adopt");
      await classRow(T, "A", "Mat 1");
      await classRow(T, "B", "Mat 2");
      as("owner", T);
      const results = await Promise.all([
        adoptPOST(request("/api/mats/adopt", "POST", { keys: ["mat 1", "mat 2"] })),
        adoptPOST(request("/api/mats/adopt", "POST", { keys: ["mat 1", "mat 2"] })),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect((await mats(T)).map((m) => m.name)).toEqual(["Mat 1", "Mat 2"]);
      expect((await classes(T)).every((c) => c.matId !== null)).toBe(true);
      expect(await audits(T, "mat.adopt")).toHaveLength(1);
    });

    it("a rename racing a class save leaves the class with the mat's final name, and neither fails: with and without matId in the body", async () => {
      const T = await club("race-rename");
      const mat = await addMat(T, "Mat 1");
      const onIt = await classRow(T, "On it", "Mat 1", { matId: mat.id });
      const joining = await classRow(T, "Joining", null);
      as("owner", T);
      const results = await Promise.all([
        matPATCH(request(`/api/mats/${mat.id}`, "PATCH", { name: "Main mat" }), params(mat.id)),
        // Names the mat: takes the mats lock first, so it is serial with the rename.
        classPATCH(request(`/api/classes/${joining.id}`, "PATCH", { matId: mat.id }), params(joining.id)),
        // Names no mat: takes no mats lock, and drops the place it sends.
        classPATCH(request(`/api/classes/${onIt.id}`, "PATCH", { name: "On it still", location: "typed over" }), params(onIt.id)),
      ]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      const rows = await classes(T);
      expect(rows.map((c) => [c.matId, c.location])).toEqual([[mat.id, "Main mat"], [mat.id, "Main mat"]]);
    });

    it("an undo that puts a class back onto a mat, against a rename of that mat, ends on the mat's final name with no deadlock", async () => {
      const T = await club("race-undo");
      const one = await addMat(T, "Mat 1");
      const two = await addMat(T, "Mat 2");
      const cls = await classRow(T, "Mover", "Mat 1", { matId: one.id });
      as("owner", T);
      expect((await classPATCH(request(`/api/classes/${cls.id}`, "PATCH", { matId: two.id }), params(cls.id))).status).toBe(200);
      const [edit] = (await audits(T, "class.updated")) as unknown as AuditRowLike[];
      const [undo, rename] = await Promise.allSettled([
        withTenantContext(T, (tx) => executeUndo(tx, [{ row: edit, decision: decideUndo(edit, false) }], { tenantId: T, userId: "synthetic-owner" })),
        matPATCH(request(`/api/mats/${one.id}`, "PATCH", { name: "Main mat" }), params(one.id)),
      ]);
      expect(undo.status).toBe("fulfilled");
      expect(rename.status === "fulfilled" && rename.value.status).toBe(200);
      expect((await classes(T))[0]).toMatchObject({ matId: one.id, location: "Main mat" });
    });
  });

  describe("the choice", () => {
    let T = "";
    const stored = async () => (await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: T }, select: { timetableLayout: true } })))?.timetableLayout;
    beforeAll(async () => {
      T = await club("choice");
    });

    it("by mat is refused while no class is on a mat, and nothing is stored or recorded", async () => {
      await addMat(T, "Mat 1");
      as("owner", T);
      const res = await layoutPATCH(request("/api/timetable/layout", "PATCH", { layout: "mat" }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Put a class on a mat first." });
      expect(await stored()).toBeNull();
      expect(await audits(T, "timetable.layout.update")).toEqual([]);
    });

    it("nothing is stored by putting classes on a second mat: the split is worked out, not saved", async () => {
      const [mat1] = await mats(T);
      const mat2 = await addMat(T, "Mat 2");
      await classRow(T, "Gi", "Mat 1", { matId: mat1.id });
      await classRow(T, "No-Gi", "Mat 2", { matId: mat2.id });
      as("coach", T);
      const body = (await (await matsGET()).json()) as { layout: unknown };
      expect(body.layout).toEqual({ stored: null, effective: "mat" });
      expect(await stored()).toBeNull();
    });

    it("a coach can read the mats but cannot choose, set up mats or see the typed places", async () => {
      as("coach", T);
      expect((await matsGET()).status).toBe(200);
      expect((await layoutPATCH(request("/api/timetable/layout", "PATCH", { layout: "time" }))).status).toBe(403);
      expect((await matsPOST(request("/api/mats", "POST", { name: "Coach mat" }))).status).toBe(403);
      expect((await suggestionsGET()).status).toBe(403);
      expect((await adoptPOST(request("/api/mats/adopt", "POST", { keys: ["mat 1"] }))).status).toBe(403);
      expect(await stored()).toBeNull();
      expect((await mats(T)).map((m) => m.name)).toEqual(["Mat 1", "Mat 2"]);
    });

    it("a manager's choice is stored, recorded once with before and after, and saving it again writes nothing", async () => {
      as("manager", T);
      const res = await layoutPATCH(request("/api/timetable/layout", "PATCH", { layout: "time" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ layout: { stored: "time", effective: "time" }, changed: true });
      expect(await stored()).toBe("time");
      expect((await layoutPATCH(request("/api/timetable/layout", "PATCH", { layout: "time" }))).status).toBe(200);
      const rows = await audits(T, "timetable.layout.update");
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ before: { stored: null, effective: "mat" }, after: { stored: "time", effective: "time" } });
    });

    it("the database refuses any other value in the column", async () => {
      await expect(withRlsBypass((tx) => tx.tenant.update({ where: { id: T }, data: { timetableLayout: "grid" } }))).rejects.toThrow();
      expect(await stored()).toBe("time");
    });
  });

  describe("records", () => {
    it("each write leaves exactly one row; a refusal and a no-op leave none; a reorder records both orders", async () => {
      const T = await club("audit");
      const a = await addMat(T, "Mat 1");
      const b = await addMat(T, "Mat 2");
      as("owner", T);
      expect((await matsPOST(request("/api/mats", "POST", { name: "mat 1" }))).status).toBe(409);
      expect((await matsPOST(request("/api/mats", "POST", { name: "" }))).status).toBe(400);
      expect((await orderPUT(request("/api/mats/order", "PUT", { ids: [a.id, b.id] }))).status).toBe(200); // the order it already has
      expect((await orderPUT(request("/api/mats/order", "PUT", { ids: [b.id] }))).status).toBe(409);
      expect((await orderPUT(request("/api/mats/order", "PUT", { ids: [b.id, a.id] }))).status).toBe(200);
      expect((await mats(T)).map((m) => m.name)).toEqual(["Mat 2", "Mat 1"]);
      const rows = await audits(T);
      expect(rows.map((r) => r.action)).toEqual(["mat.create", "mat.create", "mat.reorder"]);
      expect(rows[0]).toMatchObject({ entityType: "Mat", entityId: a.id, metadata: expect.objectContaining({ name: "Mat 1" }) });
      expect(rows[2].metadata).toMatchObject({ before: [a.id, b.id], after: [b.id, a.id] });
    });
  });
});
