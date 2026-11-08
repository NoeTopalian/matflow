/**
 * MatFlow support sets up mats and the split (Noe, 7 Nov 2026: "Yes, allow
 * support"; RULES §5b). Every mats write and the layout write, run through the
 * REAL route gates (lib/api-authz.ts, lib/support-session.ts) and the REAL
 * logAudit, with only the session and the impersonation cookie stood in:
 *
 *  - an EDIT support session may add, rename, reorder and remove mats, "Add
 *    these as mats" and choose the split, and each audit row names MatFlow
 *    support (metadata.actingAs + operatorId), in the club's own tenantId, so
 *    the club's Activity says "MatFlow support";
 *  - a VIEW (read-only) support session is refused in the route itself, and
 *    nothing is written;
 *  - a coach is still refused.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const { db, session, claim } = vi.hoisted(() => ({
  db: {
    mats: [] as Record<string, unknown>[],
    classes: [] as Record<string, unknown>[],
    tenants: [] as Record<string, unknown>[],
    audits: [] as Record<string, unknown>[],
    writes: 0,
    seq: 0,
  },
  session: { current: null as null | { user: Record<string, unknown> } },
  claim: { current: null as null | Record<string, unknown> },
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

// A small stand-in for the tables the routes and logAudit touch (as tests/unit/mats-routes.test.ts).
const tx = {
  $executeRaw: async () => 1,
  $queryRaw: async (_s: TemplateStringsArray, ...values: unknown[]) =>
    db.classes
      .filter((c) => c.tenantId === values[0] && c.matId == null && c.sourceImportJobId == null && c.location != null)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .map((c) => ({ id: c.id, location: c.location, deletedAt: c.deletedAt ?? null })),
  mat: {
    findMany: async ({ where }: { where: Row }) =>
      db.mats.filter((m) => matches(m, where)).sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number)).map((m) => ({ ...m })),
    findFirst: async ({ where }: { where: Row }) => {
      const row = db.mats.find((m) => matches(m, where));
      return row ? { ...row } : null;
    },
    create: async ({ data }: { data: Row }) => {
      db.writes++;
      const row = { id: `mat-${++db.seq}`, ...data };
      db.mats.push(row);
      return row;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      db.writes++;
      const rows = db.mats.filter((m) => matches(m, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    deleteMany: async ({ where }: { where: Row }) => {
      db.writes++;
      const gone = db.mats.filter((m) => matches(m, where));
      db.mats = db.mats.filter((m) => !gone.includes(m));
      db.classes.forEach((c) => { if (gone.some((g) => g.id === c.matId)) c.matId = null; });
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
      db.writes++;
      const rows = db.classes.filter((c) => matches(c, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
  },
  tenant: {
    findFirst: async ({ where }: { where: Row }) => db.tenants.find((t) => matches(t, where)) ?? null,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      db.writes++;
      const row = db.tenants.find((t) => matches(t, where))!;
      Object.assign(row, data);
      return row;
    },
  },
  // logAudit's own reads and its insert (lib/audit-log.ts insert).
  user: { findFirst: async ({ where }: { where: Row }) => (where.id === "user-owner" && where.tenantId === A ? { id: "user-owner" } : null) },
  operator: { findUnique: async ({ where }: { where: Row }) => (where.id === "op-1" ? { id: "op-1" } : null) },
  auditLog: {
    create: async ({ data }: { data: Row }) => {
      db.audits.push(data);
      return data;
    },
  },
};

vi.mock("@/auth", () => ({ auth: async () => session.current }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: async () => claim.current }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (t: unknown) => unknown) => Promise.resolve(fn(tx)),
  withRlsBypass: (fn: (t: unknown) => unknown) => Promise.resolve(fn(tx)),
}));

import { POST as addPOST } from "@/app/api/mats/route";
import { PATCH as renamePATCH, DELETE as removeDELETE } from "@/app/api/mats/[id]/route";
import { PUT as orderPUT } from "@/app/api/mats/order/route";
import { POST as adoptPOST } from "@/app/api/mats/adopt/route";
import { PATCH as layoutPATCH } from "@/app/api/timetable/layout/route";
import { sourceOf, emptyLookups, type FeedRow } from "@/lib/activity-feed";

const A = "tenant-A";
const owner = (extra: Row = {}) => ({ user: { id: "user-owner", tenantId: A, role: "owner", ...extra } });
const EDIT = owner({ impersonatedBy: "op-1", supportScope: "edit" });
const VIEW = owner({ impersonatedBy: "op-1", supportScope: "view" });
const COACH = { user: { id: "user-coach", tenantId: A, role: "coach" } };
const CLAIM = { adminUserId: "op-1", targetUserId: "user-owner", targetTenantId: A, reason: "Sean asked", exp: Math.floor(Date.now() / 1000) + 600, v: 3, scope: "edit", opSv: 0, tsv: 0, n: "test-nonce-0123456789" };

const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/mats", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const mat = (id: string, name: string, sortOrder: number) => ({ id, tenantId: A, name, nameKey: name.toLowerCase(), sortOrder });
const cls = (id: string, location: string | null, extra: Row = {}) => ({ id, tenantId: A, location, matId: null, isActive: true, deletedAt: null, sourceImportJobId: null, ...extra });

const WRITES: [string, string, () => Promise<Response>][] = [
  ["POST /api/mats", "mat.create", () => addPOST(req("POST", { name: "Cage" }))],
  ["PATCH /api/mats/[id]", "mat.update", () => renamePATCH(req("PATCH", { name: "Main mat" }), params("m1"))],
  ["DELETE /api/mats/[id]", "mat.delete", () => removeDELETE(req("DELETE"), params("m2"))],
  ["PUT /api/mats/order", "mat.reorder", () => orderPUT(req("PUT", { ids: ["m2", "m1"] }))],
  ["POST /api/mats/adopt", "mat.adopt", () => adoptPOST(req("POST", { keys: ["upstairs"] }))],
  ["PATCH /api/timetable/layout", "timetable.layout.update", () => layoutPATCH(req("PATCH", { layout: "mat" }))],
];

beforeEach(() => {
  db.mats = [mat("m1", "Mat 1", 0), mat("m2", "Mat 2", 1)];
  db.classes = [cls("c1", "Mat 1", { matId: "m1" }), cls("c2", "Mat 2", { matId: "m2" }), cls("c3", "Upstairs")];
  db.tenants = [{ id: A, timetableLayout: null }];
  db.audits = [];
  db.writes = 0;
  db.seq = 0;
  session.current = EDIT;
  claim.current = CLAIM;
});

describe("an EDIT support session sets up mats and the split, recorded as MatFlow support", () => {
  it.each(WRITES)("%s is made, and its audit row names MatFlow support in the club's tenant", async (_name, action, call) => {
    const res = await call();
    expect(res.status).toBeLessThan(300);
    const rows = db.audits.filter((a) => a.action === action);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({ tenantId: A, userId: "user-owner", operatorId: "op-1" });
    expect(row.metadata).toMatchObject({ actingAs: "op-1", actorType: "operator", effectiveUserId: "user-owner" });
    // The club's Activity reads it as MatFlow support (lib/activity-feed.ts sourceOf).
    const feedRow: FeedRow = { id: "a1", action, entityType: String(row.entityType), entityId: String(row.entityId), metadata: row.metadata, createdAt: new Date(), userId: "user-owner", operatorId: "op-1" };
    expect(sourceOf(feedRow, emptyLookups()).label).toBe("MatFlow support");
  });

  it("the writes really happen: a mat added, renamed and removed, typed places adopted, the split stored", async () => {
    // The order is left out: it must name exactly the club's mats, which the add before it changes.
    for (const [name, , call] of WRITES) {
      if (name === "PUT /api/mats/order") continue;
      expect((await call()).status, name).toBeLessThan(300);
    }
    expect(db.mats.map((m) => m.name).sort()).toEqual(["Cage", "Main mat", "Upstairs"]);
    expect(db.classes.find((c) => c.id === "c3")).toMatchObject({ matId: expect.any(String), location: "Upstairs" });
    // Removing Mat 2 left its class on the timetable with the mat's name as its place.
    expect(db.classes.find((c) => c.id === "c2")).toMatchObject({ matId: null, location: "Mat 2" });
    expect(db.tenants[0].timetableLayout).toBe("mat");
  });

  it("the reorder really happens", async () => {
    expect((await orderPUT(req("PUT", { ids: ["m2", "m1"] }))).status).toBe(200);
    expect(db.mats.map((m) => [m.id, m.sortOrder])).toEqual([["m1", 1], ["m2", 0]]);
  });
});

describe("refused in the route itself", () => {
  it.each(WRITES)("%s refuses a VIEW (read-only) support session and writes nothing", async (_name, _action, call) => {
    session.current = VIEW;
    claim.current = { ...CLAIM, scope: "view" };
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, supportReadOnly: true });
    expect(db.writes).toBe(0);
    expect(db.audits).toEqual([]);
  });

  it.each(WRITES)("%s still refuses a coach", async (_name, _action, call) => {
    session.current = COACH;
    claim.current = null;
    expect((await call()).status).toBe(403);
    expect(db.writes).toBe(0);
    expect(db.audits).toEqual([]);
  });

  it.each(WRITES)("%s refuses a support session whose scope is anything but the literal edit", async (_name, _action, call) => {
    session.current = owner({ impersonatedBy: "op-1", supportScope: "EDIT" });
    expect((await call()).status).toBe(403);
    expect(db.writes).toBe(0);
  });
});
