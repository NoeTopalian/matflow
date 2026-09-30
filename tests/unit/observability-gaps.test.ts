// Connection register gaps 2 and 25 (30 Sep 2026): a check-in outage and a
// reports failure were invisible — every check-in door answered a 500 with
// nothing logged, and the reports route had no catch at all.
import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ capture: vi.fn(), reports: vi.fn(), auth: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureException: m.capture, captureMessage: vi.fn(), withScope: vi.fn() }));
vi.mock("@/auth", () => ({ auth: m.auth }));
vi.mock("@/lib/reports", () => ({ getReportsDataCached: m.reports }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

// The database fails on the first read of the check-in.
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async () => {
    throw Object.assign(new Error("connection terminated"), { code: "P1001" });
  }),
}));

import { performCheckin } from "@/lib/checkin";
import { GET as reportsGET } from "@/app/api/reports/route";

beforeEach(() => vi.clearAllMocks());

describe("a failed check-in is logged, whichever door called it", () => {
  it("reports the unexpected error to Sentry and still answers kind:error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await performCheckin({
      tenantId: "t-1", memberId: "m-1", classInstanceId: "ci-1",
      enforceRankGate: false, enforceRosterGate: false, enforceTimeWindow: false,
      requireCoverage: false, enforceWaiverGate: false, checkedInByUserId: null,
    } as Parameters<typeof performCheckin>[0]);
    expect(out.kind).toBe("error");
    expect(m.capture).toHaveBeenCalledTimes(1);
    expect(m.capture.mock.calls[0][1]).toMatchObject({ tags: { area: "checkin" } });
  });
});

describe("a failed report answers with a reference", () => {
  it("returns 500 with an MF- reference instead of throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.auth.mockResolvedValue({ user: { tenantId: "t-1", role: "owner" } });
    m.reports.mockRejectedValue(new Error("query timed out"));
    const res = (await reportsGET(new Request("http://localhost/api/reports?weeks=12"))) as unknown as {
      status: number; json: () => Promise<{ error: string; reference?: string }>;
    };
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(JSON.stringify(body)).toMatch(/MF-[A-Z0-9]+/);
  });
});
