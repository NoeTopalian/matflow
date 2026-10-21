// T7: the coach tick route (POST /api/coach/instances/[id]/attendance) marks
// without performCheckin, so it asks about the plan allowance itself, the way
// the desk register does: after the eligibility check (which takes the Class
// lock and refuses only), under the Member lock, and only when the tick would
// admit someone.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  instanceFindFirst: vi.fn(),
  logAudit: vi.fn(),
  requireApiStaff: vi.fn(),
  lockedClassEligibility: vi.fn(),
  staffAllowanceAsk: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: h.requireApiStaff }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/checkin", () => ({
  restorePackCreditsForAttendance: vi.fn(async () => 0),
  lockedClassEligibility: h.lockedClassEligibility,
  staffAllowanceAsk: h.staffAllowanceAsk,
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      classInstance: { findFirst: h.instanceFindFirst },
      member: { findFirst: h.memberFindFirst },
      attendanceRecord: { findUnique: h.findUnique, upsert: h.upsert, findMany: vi.fn(async () => []), deleteMany: vi.fn() },
    }),
}));

import { POST } from "@/app/api/coach/instances/[id]/attendance/route";

const FACTS = { used: 4, limit: 4, weeks: 4, nextFree: { date: "2026-11-02", time: "18:00" } };
const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;
const params = Promise.resolve({ id: "inst_1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.requireApiStaff.mockResolvedValue({ ok: true, tenantId: "tenant_a", userId: "user_coach", role: "coach" });
  h.instanceFindFirst.mockResolvedValue({
    id: "inst_1", classId: "cls_1", date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00", class: { name: "Fundamentals" },
  });
  h.memberFindFirst.mockResolvedValue({ id: "mem_1" });
  h.findUnique.mockResolvedValue(null);
  h.upsert.mockImplementation(async () => { h.order.push("upsert"); return { id: "rec_1", checkInMethod: "admin", checkedInById: "user_coach" }; });
  h.lockedClassEligibility.mockImplementation(async () => { h.order.push("eligibility"); return null; });
  h.staffAllowanceAsk.mockImplementation(async (_tx: unknown, args: { confirmed: boolean }) => {
    h.order.push("allowance");
    return args.confirmed
      ? { kind: "open", overridden: true, facts: FACTS }
      : { kind: "allowance_reached", askable: true, ...FACTS };
  });
});

describe("coach tick - allowance ask", () => {
  it("asks after the eligibility check (Class lock, then Member lock) and writes nothing until confirmed", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(h.order).toEqual(["eligibility", "allowance"]);
    expect(h.staffAllowanceAsk).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant_a", memberId: "mem_1", confirmed: false },
      { id: "inst_1", date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00" },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "allowance_reached", askable: true, allowance: FACTS });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("admits on acknowledged: ['allowance_reached'] and records the override with the count", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true, acknowledged: ["allowance_reached"] }), { params });
    expect(res.status).toBe(200);
    expect(h.order).toEqual(["eligibility", "allowance", "upsert"]);
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "attendance.mark",
      metadata: { created: true, overrides: ["allowance_reached"], overAllowance: FACTS },
    });
  });

  it("does not re-judge a member who is already in", async () => {
    h.findUnique.mockResolvedValue({ id: "rec_0" });
    h.upsert.mockResolvedValue({ id: "rec_0", checkInMethod: "qr", checkedInById: null });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.staffAllowanceAsk).not.toHaveBeenCalled();
  });

  it("a member removed before the Member lock was granted is a 404, nothing written", async () => {
    h.staffAllowanceAsk.mockResolvedValue({ kind: "member_not_found" });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(404);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
