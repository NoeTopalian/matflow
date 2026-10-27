// T7: the coach tick route (POST /api/coach/instances/[id]/attendance) marks
// without performCheckin, so it judges the plan allowance itself: after the
// eligibility check (which takes the Class lock and refuses only), under the
// Member lock, and only when the tick would admit someone. Owner decision,
// 27 Oct 2026: it REFUSES like every door — no "Admit anyway" — and a usable
// class pack pays instead (staffAllowanceGate spends it under the locks); the
// tick ties the credit to the row it creates, or gives it back.
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
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  memberFindFirst: vi.fn(),
  instanceFindFirst: vi.fn(),
  redemptionCreate: vi.fn(),
  logAudit: vi.fn(),
  requireApiStaff: vi.fn(),
  lockedClassEligibility: vi.fn(),
  staffAllowanceGate: vi.fn(),
  returnClaimedPack: vi.fn(),
  restorePackCreditsForAttendance: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: h.requireApiStaff }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/checkin", () => ({
  restorePackCreditsForAttendance: h.restorePackCreditsForAttendance,
  lockedClassEligibility: h.lockedClassEligibility,
  staffAllowanceGate: h.staffAllowanceGate,
  returnClaimedPack: h.returnClaimedPack,
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      classInstance: { findFirst: h.instanceFindFirst },
      member: { findFirst: h.memberFindFirst },
      attendanceRecord: { findUnique: h.findUnique, upsert: h.upsert, findMany: h.findMany, deleteMany: h.deleteMany },
      classPackRedemption: { create: h.redemptionCreate },
    }),
}));

import { POST } from "@/app/api/coach/instances/[id]/attendance/route";

const FACTS = {
  used: 4, limit: 4, basis: "weeks", weeks: 4, period: { start: "2026-09-28", end: "2026-10-26" }, resetsOn: "2026-10-26",
};
const STAFF_SENTENCE =
  "Sam Taylor has used all 4 classes this 4-week period (resets on Monday 26 October) and has no class-pack credit, so they can't be checked in.";
const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;
const params = Promise.resolve({ id: "inst_1" });

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.requireApiStaff.mockResolvedValue({ ok: true, tenantId: "tenant_a", userId: "user_coach", role: "coach" });
  h.instanceFindFirst.mockResolvedValue({
    id: "inst_1", classId: "cls_1", date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00", class: { name: "Fundamentals", tenant: { timezone: "Europe/London" } },
  });
  h.memberFindFirst.mockResolvedValue({ id: "mem_1", name: "Sam Taylor" });
  h.findUnique.mockResolvedValue(null);
  h.findMany.mockResolvedValue([]);
  h.upsert.mockImplementation(async () => { h.order.push("upsert"); return { id: "rec_1", checkInMethod: "admin", checkedInById: "user_coach" }; });
  h.redemptionCreate.mockImplementation(async () => { h.order.push("redemption"); return {}; });
  h.lockedClassEligibility.mockImplementation(async () => { h.order.push("eligibility"); return null; });
  h.staffAllowanceGate.mockImplementation(async () => { h.order.push("allowance"); return { kind: "allowance_reached", ...FACTS }; });
  h.returnClaimedPack.mockImplementation(async () => { h.order.push("pack-returned"); });
  h.restorePackCreditsForAttendance.mockImplementation(async () => { h.order.push("pack-restored"); return 1; });
});

describe("coach tick - the allowance refuses (no staff override)", () => {
  it("refuses after the eligibility check (Class lock, then Member lock) with the staff sentence, and writes nothing", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(h.order).toEqual(["eligibility", "allowance"]);
    expect(h.staffAllowanceGate).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant_a", memberId: "mem_1", timeZone: "Europe/London" },
      { id: "inst_1", date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00" },
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ reason: "allowance_reached", allowance: FACTS });
    expect(body).not.toHaveProperty("askable");
    expect(body.error).toBe(STAFF_SENTENCE);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an old client's acknowledged: ['allowance_reached'] is not a 400 and admits no one", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true, acknowledged: ["allowance_reached", "tier_not_included"] }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("allowance_reached");
    expect(h.staffAllowanceGate.mock.calls[0][1]).not.toHaveProperty("confirmed");
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an unknown billing period is refused with the staff period sentence (the gate spends no pack for it)", async () => {
    h.staffAllowanceGate.mockResolvedValue({ kind: "allowance_reached", used: 0, limit: 4, basis: "billing", periodUnknown: true });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "No renewal date is recorded for Sam Taylor, so their 4 classes per billing period can't be counted and they can't be checked in.",
    );
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("within the allowance (or Unlimited) the tick writes the row, spends nothing and records no override", async () => {
    h.staffAllowanceGate.mockResolvedValue({ kind: "open", pack: null });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.redemptionCreate).not.toHaveBeenCalled();
    expect(h.returnClaimedPack).not.toHaveBeenCalled();
    const meta = h.logAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ created: true, recordId: "rec_1" });
    expect(meta).not.toHaveProperty("overrides");
    expect(meta).not.toHaveProperty("overAllowance");
  });

  it("a usable pack pays instead of a refusal: the redemption is written for the row the tick created", async () => {
    h.staffAllowanceGate.mockImplementation(async () => { h.order.push("allowance+pack"); return { kind: "open", pack: { id: "pack_1", creditsRemaining: 2 } }; });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.order).toEqual(["eligibility", "allowance+pack", "upsert", "redemption"]);
    expect(h.redemptionCreate).toHaveBeenCalledWith({ data: { memberPackId: "pack_1", attendanceRecordId: "rec_1" } });
    expect(h.returnClaimedPack).not.toHaveBeenCalled();
    const meta = h.logAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta).toMatchObject({ created: true, paidByClassPack: true });
    expect(meta).not.toHaveProperty("overrides");
  });

  it("if the upsert found a row another device made, the spent credit is given back and no redemption is written", async () => {
    h.staffAllowanceGate.mockResolvedValue({ kind: "open", pack: { id: "pack_1", creditsRemaining: 2 } });
    h.upsert.mockImplementation(async () => { h.order.push("upsert"); return { id: "rec_9", checkInMethod: "qr", checkedInById: "other" }; });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.redemptionCreate).not.toHaveBeenCalled();
    expect(h.returnClaimedPack).toHaveBeenCalledWith(expect.anything(), "tenant_a", { id: "pack_1", creditsRemaining: 2 });
    expect(h.logAudit.mock.calls[0][0].metadata).toMatchObject({ created: false });
  });

  it("unmarking a tick a pack paid for restores the credit before the row is deleted", async () => {
    h.findMany.mockResolvedValue([{ id: "rec_1" }]);
    h.deleteMany.mockImplementation(async () => { h.order.push("delete"); return { count: 1 }; });
    const res = await POST(req({ memberId: "mem_1", attended: false }), { params });
    expect(res.status).toBe(200);
    expect(h.restorePackCreditsForAttendance).toHaveBeenCalledWith(expect.anything(), ["rec_1"]);
    expect(h.order).toEqual(["pack-restored", "delete"]);
  });

  it("does not re-judge a member who is already in", async () => {
    h.findUnique.mockResolvedValue({ id: "rec_0" });
    h.upsert.mockResolvedValue({ id: "rec_0", checkInMethod: "qr", checkedInById: null });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.staffAllowanceGate).not.toHaveBeenCalled();
  });

  it("a member removed before the Member lock was granted is a 404, nothing written", async () => {
    h.staffAllowanceGate.mockResolvedValue({ kind: "member_not_found" });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(404);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
