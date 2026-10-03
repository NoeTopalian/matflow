import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

/**
 * GET /api/settings/import-reconciliation — owner-only, rate-limited, scoped
 * to the caller's club. Another club's job id reads exactly like a missing one.
 */

const gateMock = vi.fn();
const rateMock = vi.fn();
const listMock = vi.fn();
const reconcileMock = vi.fn();

vi.mock("@/lib/api-authz", () => ({ requireApiOwner: () => gateMock() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...a: unknown[]) => rateMock(...a) }));
vi.mock("@/lib/import-reconciliation", () => ({
  listReconcilableImports: (...a: unknown[]) => listMock(...a),
  reconcileImport: (...a: unknown[]) => reconcileMock(...a),
}));

const url = (q = "") => new Request(`https://localhost/api/settings/import-reconciliation${q}`);

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u-owner", role: "owner" });
  rateMock.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  listMock.mockResolvedValue([
    { id: "newest", source: "teamup", status: "complete", createdAt: "2026-10-03T10:00:00.000Z", rolledBack: true },
    { id: "older", source: "teamup", status: "complete", createdAt: "2026-10-02T10:00:00.000Z", rolledBack: false },
  ]);
  reconcileMock.mockResolvedValue({ job: { id: "older" }, checks: [], planLabels: [], summary: {} });
});

describe("GET /api/settings/import-reconciliation", () => {
  it("refuses anyone the owner gate refuses", async () => {
    gateMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) });
    const { GET } = await import("@/app/api/settings/import-reconciliation/route");
    const res = await GET(url());
    expect(res.status).toBe(403);
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("is rate-limited per club", async () => {
    rateMock.mockResolvedValue({ allowed: false, retryAfterSeconds: 120 });
    const { GET } = await import("@/app/api/settings/import-reconciliation/route");
    const res = await GET(url());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(rateMock.mock.calls[0][0]).toBe("import:reconcile:t1");
  });

  it("rejects a malformed job id before touching the database", async () => {
    const { GET } = await import("@/app/api/settings/import-reconciliation/route");
    const res = await GET(url("?jobId=" + encodeURIComponent("x' OR 1=1")));
    expect(res.status).toBe(400);
    expect(listMock).not.toHaveBeenCalled();
  });

  it("defaults to the newest import that was not rolled back, in the caller's club", async () => {
    const { GET } = await import("@/app/api/settings/import-reconciliation/route");
    const res = await GET(url());
    expect(res.status).toBe(200);
    expect(reconcileMock).toHaveBeenCalledWith("t1", "older");
    expect(listMock).toHaveBeenCalledWith("t1");
  });

  it("answers 404 for a job that is not this club's", async () => {
    reconcileMock.mockResolvedValue(null);
    const { GET } = await import("@/app/api/settings/import-reconciliation/route");
    const res = await GET(url("?jobId=cmotherclubjob0001"));
    expect(res.status).toBe(404);
    expect(reconcileMock).toHaveBeenCalledWith("t1", "cmotherclubjob0001");
  });

  it("says so when the club has no import to reconcile", async () => {
    listMock.mockResolvedValue([]);
    const { GET } = await import("@/app/api/settings/import-reconciliation/route");
    const res = await GET(url());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobs: [], result: null });
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("a database failure is a 500 with a reference, never an empty result", async () => {
    reconcileMock.mockRejectedValue(new Error("connection reset"));
    const { GET } = await import("@/app/api/settings/import-reconciliation/route");
    const res = await GET(url());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Couldn't reconcile the import. Try again.");
    expect(JSON.stringify(body)).not.toContain("connection reset");
  });
});
