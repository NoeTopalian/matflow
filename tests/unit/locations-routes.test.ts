/**
 * Locations (ADR-001 D2, slice 1): a venue inside a club. Pins tenant
 * scoping on every read and write, the role gates, name uniqueness per
 * club, the first-is-default rule, and the two refusals that keep the
 * timetable honest — the default cannot go, and a location with classes
 * cannot go until they are moved.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { staffGate, ownerMgrGate, locFindFirst, locFindMany, locCount, locCreate, locUpdate, locUpdateMany, locDelete, classCount, logAuditMock } = vi.hoisted(() => ({
  staffGate: vi.fn(), ownerMgrGate: vi.fn(),
  locFindFirst: vi.fn(), locFindMany: vi.fn(), locCount: vi.fn(), locCreate: vi.fn(), locUpdate: vi.fn(), locUpdateMany: vi.fn(), locDelete: vi.fn(),
  classCount: vi.fn(), logAuditMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }));
vi.mock("@/lib/api-authz", () => ({ requireApiStaff: () => staffGate(), requireApiOwnerOrManager: () => ownerMgrGate() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      location: { findFirst: locFindFirst, findMany: locFindMany, count: locCount, create: locCreate, update: locUpdate, updateMany: locUpdateMany, delete: locDelete },
      class: { count: classCount },
    })),
}));

import { GET, POST } from "@/app/api/locations/route";
import { PATCH, DELETE } from "@/app/api/locations/[id]/route";

const OK = { ok: true as const, tenantId: "tenant-A", userId: "user-owner", role: "owner" };
const REFUSED = { ok: false as const, response: { status: 403, json: async () => ({ error: "no" }) } };
const req = (method: string, body?: unknown) => new Request("http://localhost/api/locations", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const MAIN = { id: "loc-main", name: "Main", address: null, isDefault: true, createdAt: new Date() };

beforeEach(() => {
  vi.clearAllMocks();
  staffGate.mockResolvedValue(OK);
  ownerMgrGate.mockResolvedValue(OK);
  locFindMany.mockResolvedValue([MAIN]);
  locFindFirst.mockResolvedValue(null);
  locCount.mockResolvedValue(1);
  locCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "loc-new", ...data, createdAt: new Date() }));
  locUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...MAIN, ...data }));
  locUpdateMany.mockResolvedValue({ count: 1 });
  locDelete.mockResolvedValue({});
  classCount.mockResolvedValue(0);
});

describe("GET /api/locations", () => {
  it("reads only the caller's club, default first", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(locFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "tenant-A" }, orderBy: [{ isDefault: "desc" }, { name: "asc" }] }));
  });
  it("is refused without a staff session", async () => {
    staffGate.mockResolvedValue(REFUSED);
    expect((await GET()).status).toBe(403);
    expect(locFindMany).not.toHaveBeenCalled();
  });
});

describe("POST /api/locations", () => {
  it("creates inside the caller's club, trimmed, not default when one exists, audited", async () => {
    const res = await POST(req("POST", { name: "  Northside  ", address: "12 High St" }));
    expect(res.status).toBe(201);
    expect(locCreate).toHaveBeenCalledWith(expect.objectContaining({ data: { tenantId: "tenant-A", name: "Northside", address: "12 High St", isDefault: false } }));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "location.create" }));
  });
  it("the first location a club ever has becomes its default", async () => {
    locCount.mockResolvedValue(0);
    await POST(req("POST", { name: "Main" }));
    expect(locCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isDefault: true }) }));
  });
  it("a duplicate name in the same club is refused; an empty or oversize name is refused", async () => {
    locFindFirst.mockResolvedValue({ id: "loc-x" });
    expect((await POST(req("POST", { name: "Main" }))).status).toBe(409);
    expect((await POST(req("POST", { name: "" }))).status).toBe(400);
    expect((await POST(req("POST", { name: "x".repeat(81) }))).status).toBe(400);
    expect(locCreate).not.toHaveBeenCalled();
  });
  it("a coach cannot create", async () => {
    ownerMgrGate.mockResolvedValue(REFUSED);
    expect((await POST(req("POST", { name: "Annex" }))).status).toBe(403);
  });
});

describe("PATCH /api/locations/[id]", () => {
  it("renames within the club and audits before/after", async () => {
    locFindFirst.mockResolvedValueOnce(MAIN).mockResolvedValueOnce(null);
    const res = await PATCH(req("PATCH", { name: "Dojo" }), params("loc-main"));
    expect(res.status).toBe(200);
    expect(locUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "loc-main" }, data: { name: "Dojo" } }));
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "location.update" }));
  });
  it("making a location the default clears the previous default first", async () => {
    locFindFirst.mockResolvedValueOnce({ ...MAIN, id: "loc-2", name: "Annex", isDefault: false });
    await PATCH(req("PATCH", { isDefault: true }), params("loc-2"));
    expect(locUpdateMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-A", isDefault: true }, data: { isDefault: false } });
    expect(locUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { isDefault: true } }));
  });
  it("cannot un-default, cannot rename onto another location, and a foreign id is not found", async () => {
    // zod refuses isDefault:false before any read, so nothing is consumed.
    expect((await PATCH(req("PATCH", { isDefault: false }), params("loc-main"))).status).toBe(400);
    expect(locFindFirst).not.toHaveBeenCalled();
    locFindFirst.mockResolvedValueOnce(MAIN).mockResolvedValueOnce({ id: "loc-2" });
    expect((await PATCH(req("PATCH", { name: "Annex" }), params("loc-main"))).status).toBe(409);
    locFindFirst.mockResolvedValueOnce(null);
    expect((await PATCH(req("PATCH", { name: "Any" }), params("loc-other-club"))).status).toBe(404);
    expect(locUpdate).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/locations/[id]", () => {
  it("the default cannot be removed", async () => {
    locFindFirst.mockResolvedValue({ id: "loc-main", name: "Main", isDefault: true });
    expect((await DELETE(req("DELETE"), params("loc-main"))).status).toBe(409);
    expect(locDelete).not.toHaveBeenCalled();
  });
  it("a location with classes on it cannot be removed until they are moved", async () => {
    locFindFirst.mockResolvedValue({ id: "loc-2", name: "Annex", isDefault: false });
    classCount.mockResolvedValue(3);
    const res = await DELETE(req("DELETE"), params("loc-2"));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/3 classes are/);
    expect(classCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-A", locationId: "loc-2", deletedAt: null } });
    expect(locDelete).not.toHaveBeenCalled();
  });
  it("an empty non-default location is removed and audited; a foreign id is not found", async () => {
    locFindFirst.mockResolvedValueOnce({ id: "loc-2", name: "Annex", isDefault: false });
    expect((await DELETE(req("DELETE"), params("loc-2"))).status).toBe(200);
    expect(locDelete).toHaveBeenCalledWith({ where: { id: "loc-2" } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "location.delete" }));
    locFindFirst.mockResolvedValueOnce(null);
    expect((await DELETE(req("DELETE"), params("loc-other"))).status).toBe(404);
  });
});
