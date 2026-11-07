/**
 * Mats and the same-time split (plan §5.4): the routes, run against a small
 * in-memory stand-in for the two tables they touch, so each test states what
 * is in the club before and what is there after.
 *
 * Pins: the role gate on every route; the club's mats lock as the first
 * statement of every write; names (unique whatever the capitals, 24
 * characters, 12 mats); the write-through rule on rename and adopt; removing a
 * mat never removes a class; another club's id answers as a missing one; one
 * audit row per write, in the same transaction, and none for a refusal or a
 * write that changes nothing.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const { db, staffGate, mgrGate, csrf } = vi.hoisted(() => ({
  db: {
    mats: [] as Record<string, unknown>[],
    classes: [] as Record<string, unknown>[],
    tenants: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    ops: [] as string[],
    seq: 0,
    failCreateWith: null as null | { code: string },
  },
  staffGate: vi.fn(),
  mgrGate: vi.fn(),
  csrf: vi.fn(),
}));

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      const cond = v as Row;
      if ("not" in cond) return row[k] !== cond.not;
      if ("in" in cond) return (cond.in as unknown[]).includes(row[k]);
    }
    return row[k] === v;
  });

const tx = {
  // The tagged template of lockClubMats: the namespace and the tenant id are its two values.
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    db.ops.push(`lock:${strings.join("?").includes("pg_advisory_xact_lock") ? "mats" : "?"}:${String(values[1])}`);
    return 1;
  },
  // lib/mats.ts lockTypedClasses: the club's classes on no mat that type a place, imported history excepted, in id
  // order (FOR UPDATE). Its one bind value is the club. Copies, as a database read is.
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join("?").includes('"sourceImportJobId" IS NULL')) throw new Error(`unexpected raw read: ${strings.join("?")}`);
    return db.classes
      .filter((c) => c.tenantId === values[0] && c.matId == null && c.sourceImportJobId == null && c.location != null)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((c) => ({ id: c.id, location: c.location, deletedAt: c.deletedAt ?? null }));
  },
  mat: {
    findMany: async ({ where }: { where: Row }) => {
      db.ops.push("mat.findMany");
      // Copies, as a database read is: a later write must not change what an earlier read returned.
      return db.mats.filter((m) => matches(m, where)).sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number)).map((m) => ({ ...m }));
    },
    findFirst: async ({ where }: { where: Row }) => {
      const row = db.mats.find((m) => matches(m, where));
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      if (db.failCreateWith) throw Object.assign(new Error("unique"), db.failCreateWith);
      const row = { id: `mat-${++db.seq}`, ...data };
      db.mats.push(row);
      db.ops.push("mat.create");
      return row;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = db.mats.find((m) => matches(m, where))!;
      Object.assign(row, data);
      db.ops.push("mat.update");
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = db.mats.filter((m) => matches(m, where));
      rows.forEach((r) => Object.assign(r, data));
      db.ops.push("mat.updateMany");
      return { count: rows.length };
    },
    delete: async ({ where }: { where: Row }) => {
      const i = db.mats.findIndex((m) => matches(m, where));
      const [gone] = db.mats.splice(i, 1);
      // ON DELETE SET NULL
      db.classes.forEach((c) => { if (c.matId === gone.id) c.matId = null; });
      db.ops.push("mat.delete");
      return gone;
    },
    deleteMany: async ({ where }: { where: Row }) => {
      const gone = db.mats.filter((m) => matches(m, where));
      db.mats = db.mats.filter((m) => !gone.includes(m));
      // ON DELETE SET NULL
      db.classes.forEach((c) => { if (gone.some((g) => g.id === c.matId)) c.matId = null; });
      db.ops.push("mat.deleteMany");
      return { count: gone.length };
    },
  },
  class: {
    findMany: async ({ where, distinct }: { where: Row; distinct?: string[] }) => {
      let rows = db.classes.filter((c) => matches(c, where)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (distinct) rows = rows.filter((r, i) => rows.findIndex((o) => o[distinct[0]] === r[distinct[0]]) === i);
      return rows;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = db.classes.filter((c) => matches(c, where));
      rows.forEach((r) => Object.assign(r, data));
      db.ops.push("class.updateMany");
      return { count: rows.length };
    },
    groupBy: async ({ where }: { where: Row }) => {
      const rows = db.classes.filter((c) => matches(c, where));
      return [...new Set(rows.map((r) => r.matId))].map((matId) => ({ matId, _count: { _all: rows.filter((r) => r.matId === matId).length } }));
    },
  },
  tenant: {
    findFirst: async ({ where }: { where: Row }) => db.tenants.find((t) => matches(t, where)) ?? null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = db.tenants.find((t) => matches(t, where))!;
      Object.assign(row, data);
      db.ops.push("tenant.update");
      return row;
    },
  },
};

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, headers: init?.headers ?? {}, json: async () => body }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: (req: Request) => csrf(req) }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: async (args: Record<string, unknown>) => {
    db.audits.push({ ...args, inTx: args.tx === tx });
    db.ops.push(`audit:${String(args.action)}`);
  },
}));
vi.mock("@/lib/api-authz", () => ({ requireApiStaff: () => staffGate(), requireApiOwnerOrManager: () => mgrGate() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (tenantId: string, fn: (t: unknown) => unknown) => {
    db.ops.push(`tx:${tenantId}`);
    return Promise.resolve(fn(tx));
  },
}));

import { GET as listGET, POST as addPOST } from "@/app/api/mats/route";
import { PATCH as renamePATCH, DELETE as removeDELETE } from "@/app/api/mats/[id]/route";
import { PUT as orderPUT } from "@/app/api/mats/order/route";
import { GET as suggestionsGET } from "@/app/api/mats/suggestions/route";
import { POST as adoptPOST } from "@/app/api/mats/adopt/route";
import { PATCH as layoutPATCH } from "@/app/api/timetable/layout/route";

const A = "tenant-A";
const B = "tenant-B";
const OK = { ok: true as const, tenantId: A, userId: "user-owner", role: "owner" };
const refused = (status: number) => ({ ok: false as const, response: { status, json: async () => ({ error: "no" }) } });
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/mats", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const mat = (id: string, name: string, sortOrder: number, tenantId = A) => ({ id, tenantId, name, nameKey: name.toLowerCase(), sortOrder });
const cls = (id: string, location: string | null, extra: Row = {}) => ({ id, tenantId: A, location, matId: null, isActive: true, deletedAt: null, sourceImportJobId: null, ...extra });
const names = () => db.mats.filter((m) => m.tenantId === A).sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number)).map((m) => m.name);
const firstOpAfterTx = () => db.ops[db.ops.findIndex((o) => o.startsWith("tx:")) + 1];
const json = async (res: { json: () => Promise<unknown> }) => (await res.json()) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  db.mats = [];
  db.classes = [];
  db.tenants = [{ id: A, timetableLayout: null }, { id: B, timetableLayout: null }];
  db.audits = [];
  db.ops = [];
  db.seq = 0;
  db.failCreateWith = null;
  staffGate.mockResolvedValue(OK);
  mgrGate.mockResolvedValue(OK);
  csrf.mockReturnValue(null);
});

describe("who may call what", () => {
  const writes: [string, () => Promise<{ status: number }>][] = [
    ["POST /api/mats", () => addPOST(req("POST", { name: "Mat 1" }))],
    ["PATCH /api/mats/[id]", () => renamePATCH(req("PATCH", { name: "Cage" }), params("m1"))],
    ["DELETE /api/mats/[id]", () => removeDELETE(req("DELETE"), params("m1"))],
    ["PUT /api/mats/order", () => orderPUT(req("PUT", { ids: ["m1"] }))],
    ["POST /api/mats/adopt", () => adoptPOST(req("POST", { keys: ["mat 1"] }))],
    ["PATCH /api/timetable/layout", () => layoutPATCH(req("PATCH", { layout: "time" }))],
  ];

  it.each(writes)("%s answers the owner-or-manager gate's refusal and touches nothing", async (_name, call) => {
    db.mats = [mat("m1", "Mat 1", 0)];
    for (const status of [401, 403]) {
      mgrGate.mockResolvedValue(refused(status));
      expect((await call()).status).toBe(status);
    }
    expect(db.ops).toEqual([]);
    expect(db.audits).toEqual([]);
    expect(names()).toEqual(["Mat 1"]);
  });

  it("GET /api/mats/suggestions is for owner and manager; GET /api/mats is for every staff role", async () => {
    mgrGate.mockResolvedValue(refused(403)); // a coach or an admin
    expect((await suggestionsGET()).status).toBe(403);
    expect((await listGET()).status).toBe(200);
    staffGate.mockResolvedValue(refused(401)); // signed out
    expect((await listGET()).status).toBe(401);
    staffGate.mockResolvedValue(refused(403)); // a member
    expect((await listGET()).status).toBe(403);
  });

  it.each(writes)("%s refuses a cross-origin request before anything else", async (_name, call) => {
    csrf.mockReturnValue({ status: 403, json: async () => ({ error: "origin" }) });
    expect((await call()).status).toBe(403);
    expect(mgrGate).not.toHaveBeenCalled();
    expect(db.ops).toEqual([]);
  });

  it("every write takes the club's mats lock as the first statement of its transaction", async () => {
    db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 1)];
    db.classes = [cls("c1", "Mat 1", { matId: "m1" }), cls("c2", "Cage")];
    const calls: (() => Promise<unknown>)[] = [
      () => addPOST(req("POST", { name: "Mat 3" })),
      () => renamePATCH(req("PATCH", { name: "Main mat" }), params("m1")),
      () => orderPUT(req("PUT", { ids: ["m2", "m1", "mat-1"] })),
      () => adoptPOST(req("POST", { keys: ["cage"] })),
      () => layoutPATCH(req("PATCH", { layout: "time" })),
      () => removeDELETE(req("DELETE"), params("m2")),
    ];
    for (const call of calls) {
      db.ops = [];
      await call();
      expect(firstOpAfterTx()).toBe(`lock:mats:${A}`);
    }
  });
});

describe("GET /api/mats", () => {
  it("lists the club's mats in order with their class counts and the split, not cached", async () => {
    db.mats = [mat("m2", "Mat 2", 1), mat("m1", "Mat 1", 0), mat("x", "Theirs", 0, B)];
    db.classes = [cls("c1", "Mat 1", { matId: "m1" }), cls("c2", "Mat 1", { matId: "m1", isActive: false }), cls("c3", "Mat 1", { matId: "m1", deletedAt: new Date() }), cls("c4", "Mat 2", { matId: "m2" })];
    const res = await listGET();
    expect(res.headers).toEqual({ "Cache-Control": "private, no-store" });
    expect(await json(res)).toEqual({
      mats: [{ id: "m1", name: "Mat 1", classCount: 2 }, { id: "m2", name: "Mat 2", classCount: 1 }],
      layout: { stored: null, effective: "mat" },
    });
  });

  it("is split by time while fewer than two mats have a live class, and a paused class does not count", async () => {
    db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 1)];
    db.classes = [cls("c1", "Mat 1", { matId: "m1" }), cls("c2", "Mat 2", { matId: "m2", isActive: false })];
    expect((await json(await listGET())).layout).toEqual({ stored: null, effective: "time" });
  });
});

describe("POST /api/mats", () => {
  it("adds a mat with a clean name at the end of the order, and records it in the same transaction", async () => {
    db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 4)];
    const res = await addPOST(req("POST", { name: "  Competition   Mat " }));
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ id: "mat-1", name: "Competition Mat", classCount: 0 });
    expect(db.mats[2]).toEqual({ id: "mat-1", tenantId: A, name: "Competition Mat", nameKey: "competition mat", sortOrder: 5 });
    expect(db.audits).toEqual([expect.objectContaining({ action: "mat.create", entityType: "Mat", entityId: "mat-1", tenantId: A, userId: "user-owner", metadata: { name: "Competition Mat" }, inTx: true })]);
  });

  it("refuses a name the club already has, whatever its capitals and spacing", async () => {
    db.mats = [mat("m1", "Mat 1", 0)];
    const res = await addPOST(req("POST", { name: "mat  1 " }));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "You already have a mat called Mat 1." });
    expect(names()).toEqual(["Mat 1"]);
    expect(db.audits).toEqual([]);
  });

  it("another club's mat of the same name is no clash", async () => {
    db.mats = [mat("x", "Mat 1", 0, B)];
    expect((await addPOST(req("POST", { name: "Mat 1" }))).status).toBe(201);
    expect(names()).toEqual(["Mat 1"]);
  });

  it("refuses a thirteenth mat", async () => {
    db.mats = Array.from({ length: 12 }, (_, i) => mat(`m${i}`, `Mat ${i + 1}`, i));
    const res = await addPOST(req("POST", { name: "Mat 13" }));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "You can have up to 12 mats." });
    expect(names()).toHaveLength(12);
  });

  it("refuses an empty name, a name over 24 characters and an extra key", async () => {
    expect(await json(await addPOST(req("POST", { name: "   " })))).toEqual({ error: "Give the mat a name." });
    expect((await addPOST(req("POST", {}))).status).toBe(400);
    const long = await addPOST(req("POST", { name: "Competition Mat Upstairs!" }));
    expect(long.status).toBe(400);
    expect(await json(long)).toEqual({ error: "A mat name can be up to 24 characters." });
    expect((await addPOST(req("POST", { name: "Mat 1", sortOrder: 0 }))).status).toBe(400);
    expect(db.mats).toEqual([]);
    expect(db.ops).toEqual([]);
  });

  it("answers the unique index's refusal as the same 409, not a 500", async () => {
    db.failCreateWith = { code: "P2002" };
    const res = await addPOST(req("POST", { name: "Mat 1" }));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "You already have a mat called Mat 1." });
  });
});

describe("PATCH /api/mats/[id]", () => {
  beforeEach(() => {
    db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 1)];
    db.classes = [cls("c1", "Mat 2", { matId: "m2" }), cls("c2", "Mat 2", { matId: "m2", deletedAt: new Date() }), cls("c3", "Mat 1", { matId: "m1" }), cls("c4", "Mat 2")];
  });

  it("renames the mat and rewrites the place of exactly its classes, in one transaction with its record", async () => {
    const res = await renamePATCH(req("PATCH", { name: " Cage " }), params("m2"));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ id: "m2", name: "Cage", changed: true });
    expect(db.mats[1]).toMatchObject({ name: "Cage", nameKey: "cage" });
    expect(db.classes.map((c) => c.location)).toEqual(["Cage", "Cage", "Mat 1", "Mat 2"]);
    expect(db.ops.filter((o) => o.startsWith("tx:"))).toHaveLength(1);
    expect(db.audits).toEqual([expect.objectContaining({ action: "mat.update", entityId: "m2", metadata: { before: { name: "Mat 2" }, after: { name: "Cage" }, classesRenamed: 2 }, inTx: true })]);
  });

  it("the name already stored writes nothing and records nothing", async () => {
    const res = await renamePATCH(req("PATCH", { name: "Mat 2" }), params("m2"));
    expect(await json(res)).toEqual({ id: "m2", name: "Mat 2", changed: false });
    expect(db.ops.filter((o) => /update|audit/.test(o))).toEqual([]);
  });

  it("a change of capitals only is a rename of the same mat", async () => {
    expect((await renamePATCH(req("PATCH", { name: "MAT 2" }), params("m2"))).status).toBe(200);
    expect(db.classes[0].location).toBe("MAT 2");
  });

  it("refuses another mat's name, an empty one and one over 24 characters", async () => {
    const clash = await renamePATCH(req("PATCH", { name: "mat 1" }), params("m2"));
    expect(clash.status).toBe(409);
    expect(await json(clash)).toEqual({ error: "You already have a mat called Mat 1." });
    expect((await renamePATCH(req("PATCH", { name: " " }), params("m2"))).status).toBe(400);
    expect((await renamePATCH(req("PATCH", { name: "x".repeat(25) }), params("m2"))).status).toBe(400);
    expect(names()).toEqual(["Mat 1", "Mat 2"]);
    expect(db.audits).toEqual([]);
  });

  it("another club's mat answers as a missing one and is left alone", async () => {
    db.mats.push(mat("theirs", "Their mat", 0, B));
    for (const id of ["theirs", "nope"]) {
      const res = await renamePATCH(req("PATCH", { name: "Mine now" }), params(id));
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ error: "That mat isn't one of your mats any more." });
    }
    expect(db.mats.find((m) => m.id === "theirs")?.name).toBe("Their mat");
  });
});

describe("DELETE /api/mats/[id]", () => {
  it("removes the mat; its classes stay, on no mat, with the mat's name as their place", async () => {
    db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 1)];
    db.classes = [cls("c1", "Mat 2", { matId: "m2" }), cls("c2", "Mat 2", { matId: "m2", deletedAt: new Date() }), cls("c3", "Mat 1", { matId: "m1" })];
    const res = await removeDELETE(req("DELETE"), params("m2"));
    expect(await json(res)).toEqual({ ok: true, name: "Mat 2", classCount: 2 });
    expect(names()).toEqual(["Mat 1"]);
    expect(db.classes.map((c) => [c.id, c.matId, c.location])).toEqual([["c1", null, "Mat 2"], ["c2", null, "Mat 2"], ["c3", "m1", "Mat 1"]]);
    expect(db.audits).toEqual([expect.objectContaining({ action: "mat.delete", entityId: "m2", metadata: { name: "Mat 2", classIds: ["c1", "c2"] }, inTx: true })]);
  });

  it("another club's mat answers as a missing one and is left alone", async () => {
    db.mats = [mat("theirs", "Their mat", 0, B)];
    expect((await removeDELETE(req("DELETE"), params("theirs"))).status).toBe(404);
    expect(db.mats).toHaveLength(1);
    expect(db.audits).toEqual([]);
  });
});

describe("PUT /api/mats/order", () => {
  beforeEach(() => {
    db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 1), mat("m3", "Mat 3", 2), mat("theirs", "Their mat", 0, B)];
  });

  it("puts the mats in the order given and records both orders", async () => {
    const res = await orderPUT(req("PUT", { ids: ["m3", "m1", "m2"] }));
    expect(await json(res)).toEqual({ ok: true, changed: true });
    expect(names()).toEqual(["Mat 3", "Mat 1", "Mat 2"]);
    expect(db.mats.find((m) => m.id === "theirs")?.sortOrder).toBe(0);
    expect(db.audits).toEqual([expect.objectContaining({ action: "mat.reorder", entityType: "Tenant", entityId: A, metadata: { before: ["m1", "m2", "m3"], after: ["m3", "m1", "m2"] }, inTx: true })]);
  });

  it("the order already stored writes nothing", async () => {
    expect(await json(await orderPUT(req("PUT", { ids: ["m1", "m2", "m3"] })))).toEqual({ ok: true, changed: false });
    expect(db.ops.filter((o) => /update|audit/.test(o))).toEqual([]);
  });

  it.each([
    ["a list missing one", ["m1", "m2"]],
    ["a list with one twice", ["m1", "m2", "m2"]],
    ["a list naming another club's mat", ["m1", "m2", "theirs"]],
    ["a list with an id that is not a mat", ["m1", "m2", "m3", "m4"]],
  ])("refuses %s and leaves the order alone", async (_what, ids) => {
    const res = await orderPUT(req("PUT", { ids }));
    expect(res.status).toBe(409);
    expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 3"]);
    expect(db.audits).toEqual([]);
  });

  it("refuses a body that is not a list of ids, or carries an extra key", async () => {
    expect((await orderPUT(req("PUT", { ids: [] }))).status).toBe(400);
    expect((await orderPUT(req("PUT", { ids: ["m1", "m2", "m3"], by: "name" }))).status).toBe(400);
    expect(db.ops).toEqual([]);
  });
});

describe("GET /api/mats/suggestions", () => {
  it("offers the places typed on live and paused classes that are on no mat, and counts those with none", async () => {
    db.mats = [mat("m1", "Cage", 0)];
    db.classes = [
      cls("c1", "Mat 1"), cls("c2", "mat  1 "), cls("c3", "Mat 2", { isActive: false }), cls("c4", null), cls("c5", "cage"),
      cls("c6", "Mat 9", { deletedAt: new Date() }), // archived: not offered
      cls("c7", "Cage", { matId: "m1" }), // already on a mat
      cls("c8", "Old hall", { sourceImportJobId: "job" }), // imported history
      { ...cls("c9", "Their place"), tenantId: B },
    ];
    const res = await suggestionsGET();
    expect(res.headers).toEqual({ "Cache-Control": "private, no-store" });
    expect(await json(res)).toEqual({
      suggestions: [
        { name: "cage", key: "cage", classCount: 1, tooLong: false, matId: "m1" },
        { name: "Mat 1", key: "mat 1", classCount: 2, tooLong: false, matId: null },
        { name: "Mat 2", key: "mat 2", classCount: 1, tooLong: false, matId: null },
      ],
      noPlaceCount: 1,
      matCount: 1,
    });
  });
});

describe("POST /api/mats/adopt", () => {
  it("makes one mat from three spellings, puts all their classes on it and rewrites their place", async () => {
    db.classes = [cls("c1", "Mat 1"), cls("c2", "mat  1 "), cls("c3", "MAT 1"), cls("c4", "Mat 1")];
    const res = await adoptPOST(req("POST", { keys: ["mat 1"] }));
    expect(await json(res)).toEqual({
      mats: [{ id: "mat-1", name: "Mat 1", created: true, classCount: 4 }],
      matsAdded: 1, classesAttached: 4, skipped: [],
      layout: { stored: null, effective: "time" }, layoutChanged: false,
    });
    expect(names()).toEqual(["Mat 1"]);
    expect(db.classes.map((c) => [c.matId, c.location])).toEqual(Array(4).fill(["mat-1", "Mat 1"]));
    expect(db.audits).toEqual([expect.objectContaining({ action: "mat.adopt", entityType: "Tenant", entityId: A, metadata: { mats: [{ id: "mat-1", name: "Mat 1", created: true, classIds: ["c1", "c2", "c3", "c4"] }] }, inTx: true })]);
  });

  it("creates the mats in number-aware name order whatever order the keys come in, and says the split changed", async () => {
    db.classes = [cls("c1", "Mat 10"), cls("c2", "Mat 2"), cls("c3", "Mat 1")];
    const body = await json(await adoptPOST(req("POST", { keys: ["mat 10", "Mat 2", "MAT 1"] })));
    expect(names()).toEqual(["Mat 1", "Mat 2", "Mat 10"]);
    expect(body.matsAdded).toBe(3);
    expect(body.layout).toEqual({ stored: null, effective: "mat" });
    expect(body.layoutChanged).toBe(true);
  });

  it("attaches archived classes too, leaves imported history and classes already on a mat alone", async () => {
    db.mats = [mat("m9", "Cage", 0)];
    db.classes = [cls("c1", "Mat 1"), cls("c2", "Mat 1", { deletedAt: new Date() }), cls("c3", "Mat 1", { sourceImportJobId: "job" }), cls("c4", "Cage", { matId: "m9" })];
    await adoptPOST(req("POST", { keys: ["mat 1"] }));
    expect(db.classes.map((c) => c.matId)).toEqual(["mat-1", "mat-1", null, "m9"]);
  });

  it("uses a mat that already has the name instead of making a second one", async () => {
    db.mats = [mat("m1", "Mat 1", 0)];
    db.classes = [cls("c1", "mat 1"), cls("c2", "MAT 1")];
    const body = await json(await adoptPOST(req("POST", { keys: ["mat 1"] })));
    expect(body.mats).toEqual([{ id: "m1", name: "Mat 1", created: false, classCount: 2 }]);
    expect(body.matsAdded).toBe(0);
    expect(names()).toEqual(["Mat 1"]);
    expect(db.classes.map((c) => [c.matId, c.location])).toEqual([["m1", "Mat 1"], ["m1", "Mat 1"]]);
  });

  it("ignores a key no class types, and an adopt that changes nothing records nothing", async () => {
    db.classes = [cls("c1", "Mat 1")];
    const none = await json(await adoptPOST(req("POST", { keys: ["sauna"] })));
    expect(none).toMatchObject({ mats: [], matsAdded: 0, classesAttached: 0 });
    expect(db.mats).toEqual([]);
    expect(db.audits).toEqual([]);
    await adoptPOST(req("POST", { keys: ["mat 1"] }));
    expect(db.audits).toHaveLength(1);
    const again = await json(await adoptPOST(req("POST", { keys: ["mat 1"] })));
    expect(again).toMatchObject({ mats: [], classesAttached: 0 });
    expect(db.audits).toHaveLength(1);
    expect(names()).toEqual(["Mat 1"]);
  });

  it("skips a place too long for a mat name and one past the twelfth mat, and says which", async () => {
    db.mats = Array.from({ length: 11 }, (_, i) => mat(`m${i}`, `Area ${i + 1}`, i));
    db.classes = [cls("c1", "The big hall behind reception"), cls("c2", "Mat 1"), cls("c3", "Mat 2")];
    const body = await json(await adoptPOST(req("POST", { keys: ["the big hall behind reception", "mat 1", "mat 2"] })));
    expect(body.matsAdded).toBe(1);
    expect(body.skipped).toEqual([{ key: "mat 2", reason: "limit" }, { key: "the big hall behind reception", reason: "too_long" }]);
    expect(names()).toHaveLength(12);
    expect(db.classes.map((c) => c.matId)).toEqual([null, "mat-1", null]);
  });

  it("never touches another club's classes or mats", async () => {
    db.mats = [mat("theirs", "Mat 1", 0, B)];
    db.classes = [{ ...cls("x1", "Mat 1"), tenantId: B }, cls("c1", "Mat 1")];
    await adoptPOST(req("POST", { keys: ["mat 1"] }));
    expect(db.classes.map((c) => c.matId)).toEqual([null, "mat-1"]);
    expect(db.mats.map((m) => [m.id, m.tenantId])).toEqual([["theirs", B], ["mat-1", A]]);
  });

  it("refuses a body without keys, with too many, or with an extra key", async () => {
    expect((await adoptPOST(req("POST", { keys: [] }))).status).toBe(400);
    expect((await adoptPOST(req("POST", { keys: Array(51).fill("x") }))).status).toBe(400);
    expect((await adoptPOST(req("POST", { keys: ["mat 1"], classIds: ["c1"] }))).status).toBe(400);
    expect(db.ops).toEqual([]);
  });
});

describe("PATCH /api/timetable/layout", () => {
  const twoMats = () => {
    db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 1)];
    db.classes = [cls("c1", "Mat 1", { matId: "m1" }), cls("c2", "Mat 2", { matId: "m2" })];
  };

  it("stores the choice and records what was in effect before and after", async () => {
    twoMats();
    const res = await layoutPATCH(req("PATCH", { layout: "time" }));
    expect(await json(res)).toEqual({ layout: { stored: "time", effective: "time" }, changed: true });
    expect(db.tenants[0].timetableLayout).toBe("time");
    expect(db.tenants[1].timetableLayout).toBeNull();
    expect(db.audits).toEqual([expect.objectContaining({
      action: "timetable.layout.update", entityType: "Tenant", entityId: A, inTx: true,
      metadata: { before: { stored: null, effective: "mat" }, after: { stored: "time", effective: "time" } },
    })]);
  });

  it("pressing the choice already in effect while nothing is stored still stores it", async () => {
    twoMats();
    expect(await json(await layoutPATCH(req("PATCH", { layout: "mat" })))).toEqual({ layout: { stored: "mat", effective: "mat" }, changed: true });
    expect(db.tenants[0].timetableLayout).toBe("mat");
  });

  it("the choice already stored writes nothing and records nothing", async () => {
    twoMats();
    db.tenants[0].timetableLayout = "time";
    expect(await json(await layoutPATCH(req("PATCH", { layout: "time" })))).toEqual({ layout: { stored: "time", effective: "time" }, changed: false });
    expect(db.ops.filter((o) => /update|audit/.test(o))).toEqual([]);
  });

  it("refuses by mat while no class is on a mat", async () => {
    db.mats = [mat("m1", "Mat 1", 0)];
    db.classes = [cls("c1", "Mat 1")];
    const res = await layoutPATCH(req("PATCH", { layout: "mat" }));
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ error: "Put a class on a mat first." });
    expect(db.tenants[0].timetableLayout).toBeNull();
    expect(db.audits).toEqual([]);
  });

  it("by time can always be chosen, and one mat in use is enough for by mat", async () => {
    expect((await layoutPATCH(req("PATCH", { layout: "time" }))).status).toBe(200);
    db.mats = [mat("m1", "Mat 1", 0)];
    db.classes = [cls("c1", "Mat 1", { matId: "m1" })];
    expect(await json(await layoutPATCH(req("PATCH", { layout: "mat" })))).toEqual({ layout: { stored: "mat", effective: "mat" }, changed: true });
  });

  it("refuses any other value and an extra key", async () => {
    expect((await layoutPATCH(req("PATCH", { layout: "grid" }))).status).toBe(400);
    expect((await layoutPATCH(req("PATCH", { layout: "time", tenantId: B }))).status).toBe(400);
    expect((await layoutPATCH(req("PATCH", {}))).status).toBe(400);
    expect(db.ops).toEqual([]);
  });
});
