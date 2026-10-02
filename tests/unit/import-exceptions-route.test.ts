import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * GET /api/admin/import/[id]/exceptions (2 Oct 2026): owner-only, tenant-
 * scoped, reads the stored exception rows (manifest first, then the preview),
 * answers CSV with the formula guard, and audits the download.
 */
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return actual;
});
const { gateMock, auditMock, findFirstMock, tenantMock } = vi.hoisted(() => ({
  gateMock: vi.fn(),
  auditMock: vi.fn(async () => {}),
  findFirstMock: vi.fn(),
  tenantMock: vi.fn(async () => ({ name: "Total BJJ" })),
}));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: gateMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: auditMock }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ importJob: { findFirst: findFirstMock }, tenant: { findUnique: tenantMock } })),
}));

import { GET } from "@/app/api/admin/import/[id]/exceptions/route";

const req = () => new Request("http://localhost/api/admin/import/j1/exceptions");
const params = { params: Promise.resolve({ id: "j1" }) };
const rows = [{ kind: "decision_required", name: "=Dan", email: "dan@example.test", action: "Choose", detail: "A or B", sourceRows: [2, 3] }];

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u1" });
});

describe("import exceptions download", () => {
  it("refuses a non-owner", async () => {
    gateMock.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await GET(req(), params)).status).toBe(403);
    expect(findFirstMock).not.toHaveBeenCalled();
  });

  it("looks the job up inside the caller's tenant only; 404 otherwise", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    expect((await GET(req(), params)).status).toBe(404);
    expect(findFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "j1", tenantId: "t1" } }));
  });

  it("409 when neither the preview nor the manifest carries a list yet", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "j1", source: "teamup", fileName: "f.csv", sourceExportedAt: null, manifest: null, dryRunSummary: {} });
    expect((await GET(req(), params)).status).toBe(409);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("answers CSV from the committed manifest, formula-guarded, and audits", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "j1", source: "teamup", fileName: "report.csv", sourceExportedAt: new Date("2026-10-02T11:27:00Z"),
      manifest: { teamup2: { exceptionRows: rows } },
      dryRunSummary: { teamup2: { exceptionRows: [] } },
    });
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="teamup-import-exceptions-j1.csv"/);
    const text = await res.text();
    expect(text).toContain("Total BJJ,report.csv,as of 2026-10-02");
    expect(text).toContain("'=Dan");
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "import.exceptions.download", entityId: "j1", tenantId: "t1" }));
  });

  it("falls back to the preview's list before a commit", async () => {
    findFirstMock.mockResolvedValueOnce({ id: "j1", source: "teamup", fileName: "f.csv", sourceExportedAt: null, manifest: null, dryRunSummary: { teamup2: { exceptionRows: rows } } });
    const res = await GET(req(), params);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("export date not given");
  });
});
