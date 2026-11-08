// MatFlow support sets up mats and the split (Noe, 7 Nov 2026: "Yes, allow
// support"; RULES §5b) against real Postgres (the Neon TEST branch), through
// the real route handlers, under RLS, and the real audit writer. Run alone, as
// both roles:
//   node .claude/skills/matflow-verify-local/scripts/db-tests.mjs tests/integration/support-mats-db.test.ts
//
// Proved here, because a mock cannot prove them:
//  - an EDIT support session adds a mat, adopts typed places, renames,
//    reorders and removes a mat, switches the split, and adds a location from
//    the class form, all inside the club's RLS context;
//  - every one of those audit rows is in the club's own tenantId and names the
//    operator (operatorId column and metadata.actingAs), so the club's Activity
//    reads it as MatFlow support; the other club gets nothing;
//  - a VIEW (read-only) support session writes nothing.
// The session comes from a mocked auth() and the operator from a mocked
// impersonation cookie (in production both come from the HMAC-verified token:
// support-session-binding-db). Synthetic data only; skips without TEST_DATABASE_URL.
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
import { POST as matsPOST } from "@/app/api/mats/route";
import { PATCH as matPATCH, DELETE as matDELETE } from "@/app/api/mats/[id]/route";
import { PUT as orderPUT } from "@/app/api/mats/order/route";
import { POST as adoptPOST } from "@/app/api/mats/adopt/route";
import { PATCH as layoutPATCH } from "@/app/api/timetable/layout/route";
import { POST as classPOST } from "@/app/api/classes/route";
import { sourceOf, emptyLookups, type FeedRow } from "@/lib/activity-feed";

const HAS_DB = !!process.env.TEST_DATABASE_URL;
const STAMP = randomUUID().slice(0, 8);
const OPERATOR = `mfv-op-mats-${STAMP}`;
const request = (path: string, method = "GET", body?: unknown) =>
  new Request(`https://test.local${path}`, {
    method,
    headers: { origin: "https://test.local", host: "test.local", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const MAT_ACTIONS = ["mat.create", "mat.update", "mat.delete", "mat.reorder", "mat.adopt", "timetable.layout.update"];

describe.skipIf(!HAS_DB)("MatFlow support sets up mats and the split — real database", () => {
  const tenants: string[] = [];
  let A = "";
  let B = "";
  let ownerA = "";

  const support = (scope: "edit" | "view") => {
    vi.mocked(auth).mockResolvedValue({ user: { id: ownerA, role: "owner", tenantId: A, impersonatedBy: OPERATOR, supportScope: scope } } as never);
    claim.current = { adminUserId: OPERATOR, targetUserId: ownerA, targetTenantId: A, reason: "Sean asked for a split by mat", exp: Math.floor(Date.now() / 1000) + 600, v: 3, scope, opSv: 0, tsv: 0, n: `nonce-${STAMP}-0123456789` };
  };
  const classRow = (tenantId: string, name: string, location: string | null) =>
    withRlsBypass((tx) => tx.class.create({ data: { tenantId, name, location, duration: 60 }, select: { id: true } }));
  const mats = (tenantId: string) =>
    withRlsBypass((tx) => tx.mat.findMany({ where: { tenantId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true } }));
  const audits = (where: Record<string, unknown>) =>
    withRlsBypass((tx) => tx.auditLog.findMany({ where: { action: { in: MAT_ACTIONS }, ...where }, orderBy: { createdAt: "asc" } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `Synthetic support mats A ${STAMP}`, slug: `mfv-smats-a-${STAMP}` } });
      const b = await tx.tenant.create({ data: { name: `Synthetic support mats B ${STAMP}`, slug: `mfv-smats-b-${STAMP}` } });
      A = a.id;
      B = b.id;
      tenants.push(A, B);
      ownerA = (await tx.user.create({ data: { tenantId: A, email: `owner-${STAMP}@example.test`, passwordHash: "synthetic-not-a-hash", name: "Synthetic Owner", role: "owner" }, select: { id: true } })).id;
      await tx.operator.create({ data: { id: OPERATOR, email: `${OPERATOR}@example.test`, name: "Synthetic Operator", passwordHash: "x" } });
    });
  }, 60_000);

  afterAll(async () => {
    claim.current = null;
    if (tenants.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.mat.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.operator.deleteMany({ where: { id: OPERATOR } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
  }, 60_000);

  it("a VIEW support session is refused every mats write and the split, and nothing is written", async () => {
    await classRow(A, "Typed", "Mat 1");
    support("view");
    expect((await matsPOST(request("/api/mats", "POST", { name: "Cage" }))).status).toBe(403);
    expect((await adoptPOST(request("/api/mats/adopt", "POST", { keys: ["mat 1"] }))).status).toBe(403);
    expect((await layoutPATCH(request("/api/timetable/layout", "PATCH", { layout: "time" }))).status).toBe(403);
    expect(await mats(A)).toEqual([]);
    expect(await audits({ tenantId: A })).toEqual([]);
    expect((await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: A }, select: { timetableLayout: true } })))?.timetableLayout).toBeNull();
  });

  it("an EDIT support session sets up the mats and the split, under RLS, and every row is MatFlow support's in the club's tenant", async () => {
    await classRow(A, "No-Gi", "Mat 2");
    await classRow(A, "Wrestling", "Upstairs");
    support("edit");

    // "Add these as mats": the places typed on classes become mats, the classes go on them.
    const adopt = await adoptPOST(request("/api/mats/adopt", "POST", { keys: ["mat 1", "mat 2"] }));
    expect(adopt.status).toBe(200);
    expect((await mats(A)).map((m) => m.name)).toEqual(["Mat 1", "Mat 2"]);
    // By mat.
    expect((await layoutPATCH(request("/api/timetable/layout", "PATCH", { layout: "mat" }))).status).toBe(200);
    expect((await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: A }, select: { timetableLayout: true } })))?.timetableLayout).toBe("mat");
    // Add, rename, reorder and remove a mat.
    const cage = await matsPOST(request("/api/mats", "POST", { name: "Cage" }));
    expect(cage.status).toBe(201);
    const cageId = ((await cage.json()) as { id: string }).id;
    expect((await matPATCH(request(`/api/mats/${cageId}`, "PATCH", { name: "The cage" }), params(cageId))).status).toBe(200);
    const ids = (await mats(A)).map((m) => m.id);
    expect((await orderPUT(request("/api/mats/order", "PUT", { ids: [...ids].reverse() }))).status).toBe(200);
    expect((await matDELETE(request(`/api/mats/${cageId}`, "DELETE"), params(cageId))).status).toBe(200);
    // A location added from the class form, taking the class that types it.
    const cls = await classPOST(request("/api/classes", "POST", { name: "Judo", duration: 60, schedules: [{ dayOfWeek: 2, startTime: "18:00", endTime: "19:00" }], matName: "upstairs" }));
    expect(cls.status).toBe(201);
    expect((await mats(A)).map((m) => m.name)).toEqual(["Mat 2", "Mat 1", "upstairs"]);

    const rows = await audits({ tenantId: A });
    expect(rows.map((r) => r.action).sort()).toEqual(
      ["mat.adopt", "timetable.layout.update", "mat.create", "mat.update", "mat.reorder", "mat.delete", "mat.create", "mat.adopt"].sort(),
    );
    for (const row of rows) {
      expect(row, row.action).toMatchObject({ tenantId: A, userId: ownerA, operatorId: OPERATOR });
      expect(row.metadata, row.action).toMatchObject({ actingAs: OPERATOR, actorType: "operator", effectiveUserId: ownerA });
      const feed: FeedRow = { id: row.id, action: row.action, entityType: row.entityType, entityId: row.entityId, metadata: row.metadata, createdAt: row.createdAt, userId: row.userId, operatorId: row.operatorId };
      expect(sourceOf(feed, emptyLookups()).label, row.action).toBe("MatFlow support");
    }
    // Nothing in the other club, and none of the support rows anywhere but the club's.
    expect(await mats(B)).toEqual([]);
    expect(await audits({ tenantId: B })).toEqual([]);
    expect((await audits({ operatorId: OPERATOR })).every((r) => r.tenantId === A)).toBe(true);
  }, 60_000);
});
