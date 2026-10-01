import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Bulk PII export must be audited (spec R-PII-1, 1 Oct 2026).
 *
 * GET /api/payments/export.csv hands a manager or owner every member's name,
 * email and payment history in a file. It must write an AuditLog row naming the
 * actor, the time and the row count. Red on revert: remove the logAudit call
 * and these assertions fail.
 */

const logAuditMock = vi.fn().mockResolvedValue(undefined);
const findManyMock = vi.fn();

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn().mockResolvedValue({
    ok: true, tenantId: "t1", userId: "u-manager", role: "manager",
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ payment: { findMany: findManyMock } })),
}));

const rows = [
  { paidAt: new Date("2026-09-01"), createdAt: new Date("2026-09-01"), amountPence: 4500, currency: "GBP", status: "succeeded", description: "", member: { name: "A", email: "a@example.test" } },
  { paidAt: new Date("2026-09-02"), createdAt: new Date("2026-09-02"), amountPence: 5500, currency: "GBP", status: "succeeded", description: "", member: { name: "B", email: "b@example.test" } },
];

beforeEach(() => {
  vi.clearAllMocks();
  findManyMock.mockResolvedValue(rows);
});

describe("GET /api/payments/export.csv — audit", () => {
  it("writes a payments.export audit row with the actor and row count", async () => {
    const { GET } = await import("@/app/api/payments/export.csv/route");
    const res = await GET(new Request("https://localhost/api/payments/export.csv"));
    expect(res.status).toBe(200);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const arg = logAuditMock.mock.calls[0][0];
    expect(arg).toMatchObject({
      tenantId: "t1",
      userId: "u-manager",
      action: "payments.export",
      entityType: "Payment",
    });
    expect(arg.metadata).toMatchObject({ format: "csv", rowCount: 2 });
  });
});
