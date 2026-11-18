// Round 3 (10 Nov 2026), review H-1 and M-4: both monthly-report routes give
// each club its own previous month (Tenant.timezone), and the scheduled job
// runs when that month has ended in every zone. At the old 02:00 UTC on the
// 1st it was still the last day of the month in the Americas, so their
// "previous month" was the one before, and their reports ran a month late.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "t-la", userId: "usr-1" })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  checkCronAuthAttempt: vi.fn(async () => ({ allowed: true })),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({ status, json: async () => ({ ok: false, error: msg }) }),
}));

type Input = { tenantId: string; periodStart: Date; periodEnd: Date; timeZone?: string | null };
const inputs: Input[] = [];
vi.mock("@/lib/ai-causal-report", () => ({
  generateMonthlyReport: vi.fn(async (input: Input) => {
    inputs.push(input);
    return {
      summary: "s", wins: "w", watchOuts: "o", recommendations: "r", modelUsed: "test", costPence: 1,
      metricSnapshot: {}, initiativesUsed: [], driveFilesUsed: [], driveAvailable: false, insufficientData: false,
    };
  }),
}));

const TENANTS = [
  { id: "t-london", name: "London club", timezone: "Europe/London" },
  { id: "t-la", name: "LA club", timezone: "America/Los_Angeles" },
  { id: "t-akl", name: "Auckland club", timezone: "Pacific/Auckland" },
  { id: "t-kiri", name: "Kiritimati club", timezone: "Pacific/Kiritimati" },
  { id: "t-baker", name: "UTC-12 club", timezone: "Etc/GMT+12" },
];
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>) => fn({ tenant: { findMany: async () => TENANTS } }),
  withTenantContext: async <T,>(tenantId: string, fn: (tx: unknown) => Promise<T>) =>
    fn({
      tenant: { findUnique: async () => TENANTS.find((t) => t.id === tenantId) ?? null },
      monthlyReport: { create: async () => ({ id: `rep-${tenantId}` }) },
    }),
}));

const iso = (d: Date) => d.toISOString();
const ORIGINAL_TZ = process.env.TZ;
const saved = { key: process.env.ANTHROPIC_API_KEY, secret: process.env.CRON_SECRET };

beforeEach(() => {
  inputs.length = 0;
  process.env.TZ = "UTC";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.CRON_SECRET = "test-cron-secret";
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
  if (saved.secret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = saved.secret;
});

describe("the scheduled monthly report", () => {
  it("is scheduled for 14:00 UTC on the 1st, when the month has ended from UTC-12 to UTC+14", () => {
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.find((c) => c.path === "/api/cron/monthly-reports")?.schedule).toBe("0 14 1 * *");
  });

  it("at that time, every club gets October, from its own midnight on 1 October to its own midnight on 1 November", async () => {
    vi.setSystemTime(new Date("2026-11-01T14:00:00Z"));
    const { GET } = await import("@/app/api/cron/monthly-reports/route");
    const res = await GET(new Request("http://x/api/cron/monthly-reports", { headers: { authorization: "Bearer test-cron-secret" } }));
    expect(res.status).toBe(200);

    const by = Object.fromEntries(inputs.map((i) => [i.tenantId, [iso(i.periodStart), iso(i.periodEnd), i.timeZone]]));
    expect(by["t-london"]).toEqual(["2026-09-30T23:00:00.000Z", "2026-10-31T23:59:59.999Z", "Europe/London"]);
    expect(by["t-la"]).toEqual(["2026-10-01T07:00:00.000Z", "2026-11-01T06:59:59.999Z", "America/Los_Angeles"]);
    expect(by["t-akl"]).toEqual(["2026-09-30T11:00:00.000Z", "2026-10-31T10:59:59.999Z", "Pacific/Auckland"]);
    expect(by["t-kiri"]).toEqual(["2026-09-30T10:00:00.000Z", "2026-10-31T09:59:59.999Z", "Pacific/Kiritimati"]);
    expect(by["t-baker"]).toEqual(["2026-10-01T12:00:00.000Z", "2026-11-01T11:59:59.999Z", "Etc/GMT+12"]);
  });
});

describe("Generate now", () => {
  it("an LA owner on the evening of 31 October gets September: October has not ended in Los Angeles", async () => {
    vi.setSystemTime(new Date("2026-11-01T02:00:00Z")); // 19:00 on 31 Oct in Los Angeles
    const { POST } = await import("@/app/api/reports/generate/route");
    const res = await POST({ headers: { get: () => null } } as unknown as Request);
    expect(res.status).toBe(201);
    expect(inputs).toHaveLength(1);
    expect(iso(inputs[0].periodStart)).toBe("2026-09-01T07:00:00.000Z");
    expect(iso(inputs[0].periodEnd)).toBe("2026-10-01T06:59:59.999Z");
    expect(inputs[0].timeZone).toBe("America/Los_Angeles");
  });

  it("the same owner the next morning gets October", async () => {
    vi.setSystemTime(new Date("2026-11-01T16:00:00Z"));
    const { POST } = await import("@/app/api/reports/generate/route");
    await POST({ headers: { get: () => null } } as unknown as Request);
    expect(iso(inputs[0].periodStart)).toBe("2026-10-01T07:00:00.000Z");
  });
});
