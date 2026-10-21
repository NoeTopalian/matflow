// The coach attendance door (the register tick) marks without performCheckin,
// so it runs class eligibility itself: under the Class row lock, the squad
// list and then the membership list, refuse-only (owner decision, 20 Oct
// 2026). A refused tick answers with the sentence the member reads and writes
// nothing; there is no confirmation that admits past it.
//
// lockedClassEligibility is the REAL one from lib/checkin.ts, run against a
// recording transaction, so the lock order is the code's, not a mock's.

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
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

const h = vi.hoisted(() => ({
  order: [] as string[],
  upsert: vi.fn(),
  findUnique: vi.fn(),
  memberFindFirst: vi.fn(),
  instanceFindFirst: vi.fn(),
  rosterCount: vi.fn(),
  rosterFindUnique: vi.fn(),
  tierFindMany: vi.fn(),
  queryRaw: vi.fn(),
  logAudit: vi.fn(),
  requireApiStaff: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: h.requireApiStaff }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
// T7: the allowance read after the Member lock; no plan allowance here, so
// the ask is open and the eligibility verdict is the only thing judged.
vi.mock("@/lib/class-allowance-count", () => ({
  readAllowanceSnapshot: vi.fn(async () => ({ alreadyIn: false, allowance: null, visits: [] })),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      classInstance: { findFirst: h.instanceFindFirst },
      member: { findFirst: h.memberFindFirst },
      attendanceRecord: { findUnique: h.findUnique, upsert: h.upsert, findMany: vi.fn(async () => []), deleteMany: vi.fn() },
      classRoster: { count: h.rosterCount, findUnique: h.rosterFindUnique },
      classMembershipTier: { findMany: h.tierFindMany },
      $queryRaw: h.queryRaw,
    }),
}));

import { POST } from "@/app/api/coach/instances/[id]/attendance/route";

const req = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;
const params = Promise.resolve({ id: "inst_1" });

function setMemberTier(tierId: string | null, tierName: string | null) {
  h.memberFindFirst.mockResolvedValue({ id: "mem_1", membershipTierId: tierId, membershipTier: tierName ? { name: tierName } : null });
}
function setRoster(rows: number, onIt: boolean) {
  h.rosterCount.mockImplementation(async () => { h.order.push("roster"); return rows; });
  h.rosterFindUnique.mockResolvedValue(onIt ? { id: "r_1" } : null);
}
function setTiers(ids: string[]) {
  h.tierFindMany.mockImplementation(async () => { h.order.push("tiers"); return ids.map((tierId) => ({ tierId })); });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  h.requireApiStaff.mockResolvedValue({ ok: true, tenantId: "tenant_a", userId: "user_coach", role: "coach" });
  h.instanceFindFirst.mockResolvedValue({
    id: "inst_1", classId: "cls_adv", date: new Date("2026-10-19T00:00:00.000Z"), startTime: "18:00", class: { name: "Advanced" },
  });
  setMemberTier("tier_beg", "Beginners");
  h.findUnique.mockResolvedValue(null);
  h.upsert.mockImplementation(async () => { h.order.push("write"); return { id: "rec_1", checkInMethod: "admin", checkedInById: "user_coach" }; });
  // The Class lock (eligibility), then — only once eligible — the Member lock (allowance).
  h.queryRaw.mockImplementation(async (strings: unknown) => {
    const text = Array.isArray(strings) ? (strings as string[]).join("?") : String(strings);
    if (text.includes('FROM "Member"')) { h.order.push("member-lock"); return [{ id: "mem_1" }]; }
    h.order.push("lock");
    return [{ id: "cls_adv" }];
  });
  setRoster(0, false);
  setTiers(["tier_adv"]);
});

describe("coach tick — class eligibility, no override", () => {
  it("refuses a plan the class excludes (403, the member's sentence) and writes nothing", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Advanced isn't included in your Beginners membership. Ask staff about a membership that includes it.",
      reason: "tier_not_included",
    });
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an old client's acknowledged: ['tier_not_included'] is ignored: still refused, nothing written or audited", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: true, acknowledged: ["tier_not_included"] }), { params });
    expect(res.status).toBe(403);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("the roster gate runs under the Class lock: a member not on the squad list is refused before any write", async () => {
    setTiers([]);
    setRoster(3, false);
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "You're not on the roster for this class.", reason: "roster_not_listed" });
    expect(h.order).toEqual(["lock", "roster"]);
    expect(h.upsert).not.toHaveBeenCalled();
    expect(h.rosterCount).toHaveBeenCalledWith({ where: { tenantId: "tenant_a", classId: "cls_adv" } });
  });

  it("both gates combine: a rostered member on an excluded plan is refused on the plan", async () => {
    setRoster(3, true);
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("tier_not_included");
    expect(h.order).toEqual(["lock", "roster", "tiers"]);
  });

  it("a rostered member on an included plan is marked, after the lock and both checks; no overrides on the audit row", async () => {
    setRoster(3, true);
    setMemberTier("tier_adv", "Advanced");
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.order).toEqual(["lock", "roster", "tiers", "member-lock", "write"]);
    const audit = h.logAudit.mock.calls[0][0] as { action: string; metadata: Record<string, unknown> };
    expect(audit.action).toBe("attendance.mark");
    expect(audit.metadata).toMatchObject({ created: true, recordId: "rec_1" });
    expect(audit.metadata).not.toHaveProperty("overrides");
  });

  it("a class with neither restriction admits anyone, as before", async () => {
    setTiers([]);
    setMemberTier(null, null);
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.upsert).toHaveBeenCalledTimes(1);
  });

  it("a member already on the register is not re-judged: the tick writes nothing new", async () => {
    h.findUnique.mockResolvedValue({ id: "rec_scan" });
    h.upsert.mockResolvedValue({ id: "rec_scan", checkInMethod: "qr", checkedInById: null });
    const res = await POST(req({ memberId: "mem_1", attended: true }), { params });
    expect(res.status).toBe(200);
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.logAudit.mock.calls[0][0].metadata).toMatchObject({ created: false });
  });

  it("an un-tick never checks eligibility", async () => {
    const res = await POST(req({ memberId: "mem_1", attended: false }), { params });
    expect(res.status).toBe(200);
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.rosterCount).not.toHaveBeenCalled();
  });
});
