// T6a (Q3): the coach attendance door marks without performCheckin, so it
// asks the tier question itself: a class whose memberships do not include the
// member's plan is answered with the askable sentence (no row written), and a
// confirmed admission is recorded on the audit row as an override, exactly as
// POST /api/checkin records a desk override.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const h = vi.hoisted(() => ({
  upsert: vi.fn(),
  findUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  instanceFindFirst: vi.fn(),
  logAudit: vi.fn(),
  requireApiStaff: vi.fn(),
  staffTierAsk: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: h.requireApiStaff }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/checkin", () => ({
  restorePackCreditsForAttendance: vi.fn(async () => 0),
  staffTierAsk: h.staffTierAsk,
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

const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;
const params = Promise.resolve({ id: "inst_1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.requireApiStaff.mockResolvedValue({ ok: true, tenantId: "tenant_a", userId: "user_coach", role: "coach" });
  h.instanceFindFirst.mockResolvedValue({ id: "inst_1", classId: "cls_adv", class: { name: "Advanced" } });
  h.memberFindFirst.mockResolvedValue({ id: "mem_1" });
  h.findUnique.mockResolvedValue(null);
  h.upsert.mockResolvedValue({ id: "rec_1", checkInMethod: "admin", checkedInById: "user_coach" });
  h.staffTierAsk.mockImplementation(async (_tx: unknown, args: { confirmed: boolean }) =>
    args.confirmed
      ? { kind: "open", overridden: true }
      : { kind: "tier_not_included", className: "Advanced", tierName: "Beginners", askable: true });
});

describe("coach attendance — tier ask", () => {
  it("asks (403, askable, naming class and plan) and writes nothing when staff have not confirmed", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Advanced isn't included in your Beginners membership. Ask staff about a membership that includes it.",
      reason: "tier_not_included",
      askable: true,
    });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
    expect(h.staffTierAsk).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant_a", memberId: "mem_1", confirmed: false },
      "cls_adv",
      "Advanced",
    );
  });

  it("admits on acknowledged: ['tier_not_included'] and records the override on the audit row", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true, acknowledged: ["tier_not_included"] }), { params });
    expect(res.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledTimes(1);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "attendance.mark",
      metadata: expect.objectContaining({ created: true, overrides: ["tier_not_included"] }),
    }));
  });

  it("a member already on the register is not re-judged", async () => {
    h.findUnique.mockResolvedValue({ id: "rec_scan" });
    h.upsert.mockResolvedValue({ id: "rec_scan", checkInMethod: "qr", checkedInById: null });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.staffTierAsk).not.toHaveBeenCalled();
    const meta = h.logAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta.overrides).toBeUndefined();
  });

  it("an un-tick never asks", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: false }), { params });
    expect(res.status).toBe(200);
    expect(h.staffTierAsk).not.toHaveBeenCalled();
  });
});
