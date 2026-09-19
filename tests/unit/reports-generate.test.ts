/**
 * POST /api/reports/generate — an unconfigured report provider.
 *
 * Lane L-F round 2. The written summary comes from a model
 * (lib/ai-causal-report.ts:235 throws "ANTHROPIC_API_KEY not configured"), and
 * the route caught that throw with `apiError(…, 500)`. An owner pressing
 * Generate on a deployment that was never given a key was handed a crash
 * reference for a feature that was simply not set up — and the refusal still
 * cost one of the club's five generations an hour.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "tenant-A", userId: "usr-1" })),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ ok: false, error: msg }) }),
}));
vi.mock("@/lib/ai-causal-report", () => ({ generateMonthlyReport: vi.fn() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn(async () => ({ id: "tenant-A", name: "Total BJJ" })) },
    monthlyReport: { create: vi.fn(async () => ({ id: "rep-1" })) },
  },
}));

import { checkRateLimit } from "@/lib/rate-limit";
import { generateMonthlyReport } from "@/lib/ai-causal-report";
import { prisma } from "@/lib/prisma";

const mockRateLimit = vi.mocked(checkRateLimit);
const mockGenerate = vi.mocked(generateMonthlyReport);
const mockReportCreate = vi.mocked(prisma.monthlyReport.create);

const req = { headers: { get: () => null } } as unknown as Request;
const KEY = "ANTHROPIC_API_KEY";
let saved: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  saved = process.env[KEY];
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("POST /api/reports/generate — provider not configured", () => {
  it("answers 503 in plain words rather than a 500 with a crash reference", async () => {
    delete process.env[KEY];
    const { POST } = await import("@/app/api/reports/generate/route");
    const res = await POST(req);

    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/not set up/i);
    // It says what still works, so the owner does not think the page is broken.
    expect(body.error).toMatch(/figures on this page are live/i);
  });

  it("writes no report row and never calls the model", async () => {
    delete process.env[KEY];
    const { POST } = await import("@/app/api/reports/generate/route");
    await POST(req);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(mockReportCreate).not.toHaveBeenCalled();
  });

  it("does not spend one of the club's five generations an hour on a refusal", async () => {
    delete process.env[KEY];
    const { POST } = await import("@/app/api/reports/generate/route");
    await POST(req);

    expect(mockRateLimit).not.toHaveBeenCalled();
  });

  it("with a key configured it goes on to generate as before", async () => {
    process.env[KEY] = "test-key-not-a-secret";
    mockGenerate.mockResolvedValue({
      modelUsed: "test", costPence: 0, summary: "s", wins: [], watchOuts: [],
      recommendations: [], metricSnapshot: {}, driveFilesUsed: [], initiativesUsed: [],
      driveAvailable: false, insufficientData: false,
    } as never);

    const { POST } = await import("@/app/api/reports/generate/route");
    const res = await POST(req);

    expect(mockRateLimit).toHaveBeenCalledTimes(1);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
  });
});
