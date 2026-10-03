import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/payments/export.csv carries at most 5,000 payments, newest first.
 * Until 3 Oct 2026 a club with more lost its oldest rows silently: nothing in
 * the file, the response, the screen or the audit row said so. Now the cut is
 * detected (take cap+1), disclosed in X-Row-Cap / X-Rows-Truncated, recorded on
 * the payments.export audit row, and turned into on-screen copy by
 * ExportCsvButton. Red on revert: go back to `take: 5000` and the truncated
 * case reports "false".
 */

const logAuditMock = vi.fn().mockResolvedValue(undefined);
const findManyMock = vi.fn();

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn().mockResolvedValue({ ok: true, tenantId: "t1", userId: "u-owner", role: "owner" }),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn({ payment: { findMany: findManyMock } })),
}));

function payments(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    paidAt: new Date(Date.UTC(2026, 8, 1) - i * 60_000),
    createdAt: new Date(Date.UTC(2026, 8, 1) - i * 60_000),
    amountPence: 4500, currency: "GBP", status: "succeeded", description: null,
    stripeInvoiceId: null, stripePaymentIntentId: null, refundedAt: null, refundedAmountPence: null,
    member: { name: `Member ${i}`, email: `m${i}@example.test` },
  }));
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/payments/export.csv — row cap is disclosed", () => {
  it("asks for one row past the cap so a cut can be detected", async () => {
    findManyMock.mockResolvedValue(payments(2));
    const { GET } = await import("@/app/api/payments/export.csv/route");
    await GET(new Request("https://localhost/api/payments/export.csv"));
    expect(findManyMock.mock.calls[0][0]).toMatchObject({ where: { tenantId: "t1" }, take: 5001, orderBy: { createdAt: "desc" } });
  });

  it("under the cap: every row, X-Rows-Truncated false, audit truncated false", async () => {
    findManyMock.mockResolvedValue(payments(3));
    const { GET } = await import("@/app/api/payments/export.csv/route");
    const res = await GET(new Request("https://localhost/api/payments/export.csv"));
    expect(res.headers.get("X-Row-Cap")).toBe("5000");
    expect(res.headers.get("X-Rows-Truncated")).toBe("false");
    const text = await res.text();
    expect(text.split("\r\n")).toHaveLength(4); // header + 3
    expect(logAuditMock.mock.calls[0][0].metadata).toEqual({ format: "csv", rowCount: 3, rowCap: 5000, truncated: false });
  });

  it("over the cap: newest 5,000 rows, X-Rows-Truncated true, audit says so", async () => {
    findManyMock.mockResolvedValue(payments(5001));
    const { GET } = await import("@/app/api/payments/export.csv/route");
    const res = await GET(new Request("https://localhost/api/payments/export.csv"));
    expect(res.headers.get("X-Rows-Truncated")).toBe("true");
    const lines = (await res.text()).split("\r\n");
    expect(lines).toHaveLength(5001); // header + 5,000
    expect(lines[1]).toContain("Member 0,");
    expect(lines[5000]).toContain("Member 4999,");
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      tenantId: "t1", userId: "u-owner", action: "payments.export",
      metadata: { format: "csv", rowCount: 5000, rowCap: 5000, truncated: true },
    });
  });

  it("writes UTF-8 with a BOM and the text/csv charset header", async () => {
    findManyMock.mockResolvedValue([{ ...payments(1)[0], member: { name: "Zoé", email: "z@example.test" } }]);
    const { GET } = await import("@/app/api/payments/export.csv/route");
    const res = await GET(new Request("https://localhost/api/payments/export.csv"));
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toContain("Zoé");
  });
});

describe("ExportCsvButton — exportCapNotice", () => {
  it("says nothing when the file was not cut", async () => {
    const { exportCapNotice } = await import("@/components/dashboard/ExportCsvButton");
    expect(exportCapNotice(new Headers({ "X-Row-Cap": "5000", "X-Rows-Truncated": "false" }))).toBeNull();
    expect(exportCapNotice(new Headers())).toBeNull();
  });
  it("tells the owner the file holds only the newest 5,000", async () => {
    const { exportCapNotice } = await import("@/components/dashboard/ExportCsvButton");
    expect(exportCapNotice(new Headers({ "X-Row-Cap": "5000", "X-Rows-Truncated": "true" }))).toBe(
      "This file holds the newest 5,000 payments only. Older payments are not in it.",
    );
  });
});
