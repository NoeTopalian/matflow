// T7 (Sean note 5): each door hands the engine the right allowance mode and
// says the refusal in its own words. No door admits past a used-up allowance
// (owner decision, 27 Oct 2026):
//  - POST /api/checkin: member/parent and staff alike "refuse"; the staff
//    refusal is the staff sentence naming the member; an old register's
//    acknowledged: ["allowance_reached"] is dropped and admits no one;
//  - POST /api/checkin/card: "refuse"; the card's row is "refused" with the
//    staff sentence; an old scanner's acknowledgement is dropped;
//  - POST /api/kiosk/[token]/checkin: "refuse", with the count and the date.
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "checkin-allowance-doors-secret";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  performCheckin: vi.fn(),
  logAudit: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  memberFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  instanceFindFirst: vi.fn(),
  tenantFindFirst: vi.fn(),
  requireApiStaff: vi.fn(),
  verifyKioskMemberToken: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/checkin", () => ({
  performCheckin: h.performCheckin,
  loadCheckinInstance: (tx: { classInstance: { findFirst: (a: unknown) => unknown } }, tenantId: string, id: string) => tx.classInstance.findFirst({ where: { id, class: { tenantId } } }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/api-authz", () => ({ requireApiStaff: h.requireApiStaff }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true })),
  getClientIp: () => "1.2.3.4",
}));
vi.mock("@/lib/kiosk-token", () => ({ verifyKioskMemberToken: h.verifyKioskMemberToken }));
vi.mock("@/lib/tenant-admission", () => ({ tenantAdmission: () => ({ admits: true }), admissionMessage: () => "" }));
vi.mock("@/lib/prisma-tenant", () => {
  const tx = () => ({
    member: { findFirst: h.memberFindFirst, findMany: h.memberFindMany },
    classInstance: { findFirst: h.instanceFindFirst },
    tenant: { findFirst: h.tenantFindFirst, findUnique: vi.fn(async () => ({ paymentRail: null })) },
  });
  return {
    withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
    withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx()),
  };
});

const FACTS = {
  used: 4, limit: 4, basis: "weeks", weeks: 4, period: { start: "2026-09-28", end: "2026-10-26" }, resetsOn: "2026-10-26",
};
const SUCCESS = { kind: "success", record: { id: "rec-1", tenantId: "t1", memberId: "mem-1", classInstanceId: "inst-1", checkInMethod: "admin" }, coverage: { kind: "manual" } };
const REFUSED = { kind: "allowance_reached", ...FACTS };
const MEMBER_SENTENCE =
  "You've used all 4 of your classes for this 4-week period; it resets on Monday 26 October. For further information, please speak to a coach.";
const STAFF_SENTENCE =
  "Ava Green has used all 4 classes this 4-week period (resets on Monday 26 October) and has no class-pack credit, so they can't be checked in.";

function req(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://test" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.memberFindFirst.mockResolvedValue({ id: "mem-1" });
  h.instanceFindFirst.mockResolvedValue({ id: "inst-1", isCancelled: false });
});

describe("POST /api/checkin", () => {
  const member = { user: { id: "u-m", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@x" } };
  const coach = { user: { id: "coach-1", role: "coach", tenantId: "t1" } };

  it("a member's own check-in is refused (allowanceGate refuse): 403 allowance_reached with the count and the date", async () => {
    h.auth.mockResolvedValue(member);
    h.performCheckin.mockResolvedValue(REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "self", allowanceGate: "refuse" });
    expect(h.performCheckin.mock.calls[0][0]).not.toHaveProperty("allowanceOverrideConfirmed");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ reason: "allowance_reached", error: MEMBER_SENTENCE });
    expect(body.askable).toBeUndefined();
  });

  it("a parent checking in a child is the child's check-in, judged on the child's allowance", async () => {
    h.auth.mockResolvedValue({ user: { id: "u-p", role: "member", tenantId: "t1", memberId: "parent-1", email: "p@x" } });
    h.memberFindFirst.mockResolvedValue({ id: "kid-1" });
    h.performCheckin.mockResolvedValue(REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ memberId: "kid-1", method: "self", allowanceGate: "refuse" });
  });

  it("the parent's refusal names the child whose allowance is used up", async () => {
    h.auth.mockResolvedValue({ user: { id: "u-p", role: "member", tenantId: "t1", memberId: "parent-1", email: "p@x" } });
    h.memberFindFirst.mockResolvedValue({ id: "kid-1", name: "Sam" });
    h.performCheckin.mockResolvedValue(REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "allowance_reached",
      error: "Sam has used all 4 of their classes for this 4-week period; it resets on Monday 26 October. For further information, please speak to a coach.",
    });
  });

  it("a member cannot smuggle a confirmation through acknowledged: it is dropped and the request is still judged", async () => {
    h.auth.mockResolvedValue(member);
    h.performCheckin.mockResolvedValue(REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", acknowledged: ["allowance_reached"] }));
    expect(res.status).toBe(403);
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ allowanceGate: "refuse" });
  });

  it("a staff mark refuses at the limit (allowanceGate refuse): 403 with the staff sentence and the count, nothing audited", async () => {
    h.auth.mockResolvedValue(coach);
    h.memberFindFirst.mockResolvedValue({ id: "mem-1", name: "Ava Green" });
    h.performCheckin.mockResolvedValue(REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "admin", allowanceGate: "refuse" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ reason: "allowance_reached", error: STAFF_SENTENCE, allowance: FACTS });
    expect(body.askable).toBeUndefined();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an old register's acknowledged: [\"allowance_reached\"] is not a 400 and admits no one: dropped, refused, nothing written", async () => {
    h.auth.mockResolvedValue(coach);
    h.memberFindFirst.mockResolvedValue({ id: "mem-1", name: "Ava Green" });
    h.performCheckin.mockResolvedValue(REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", {
      classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin", acknowledged: ["on_hold", "allowance_reached"],
    }));
    expect(res.status).toBe(403);
    const args = h.performCheckin.mock.calls[0][0];
    expect(args).toMatchObject({ allowanceGate: "refuse" });
    expect(args).not.toHaveProperty("allowanceOverrideConfirmed");
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a staff mark a class pack paid for is audited without any override or overAllowance", async () => {
    h.auth.mockResolvedValue(coach);
    h.performCheckin.mockResolvedValue({ ...SUCCESS, coverage: { kind: "pack", creditsRemaining: 3 } });
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", {
      classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin", acknowledged: ["allowance_reached"],
    }));
    expect(res.status).toBe(201);
    const meta = h.logAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({ action: "attendance.mark" });
    expect(meta).not.toHaveProperty("overrides");
    expect(meta).not.toHaveProperty("overAllowance");
    // The dropped answer is not recorded either.
    expect(meta).not.toHaveProperty("acknowledged");
  });

  it("a staff 'auto' mark is not audited as an override (there is none), but it is attributed and audited as a mark", async () => {
    // W6 (28 Oct 2026): this used to assert that an "auto" mark wrote NO audit
    // row at all, which let a staff member write an unattributed, unaudited
    // attendance row by sending checkInMethod "auto". The mark is now audited
    // like every staff mark; it still carries no override.
    h.auth.mockResolvedValue(coach);
    h.performCheckin.mockResolvedValue(SUCCESS);
    const { POST } = await import("@/app/api/checkin/route");
    await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "auto" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "auto", allowanceGate: "refuse", checkedInByUserId: coach.user.id });
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    const entry = h.logAudit.mock.calls[0][0] as { action: string; userId: string; metadata: Record<string, unknown> };
    expect(entry).toMatchObject({ action: "attendance.mark", userId: coach.user.id });
    expect(entry.metadata).toMatchObject({ method: "auto" });
    expect(entry.metadata).not.toHaveProperty("overrides");
    expect(entry.metadata).not.toHaveProperty("overAllowance");
    expect(entry.metadata).not.toHaveProperty("acknowledged");
  });
});

describe("POST /api/checkin/card", () => {
  let POST: typeof import("@/app/api/checkin/card/route").POST;
  let signCardToken: typeof import("@/lib/card-token").signCardToken;
  beforeAll(async () => {
    ({ signCardToken } = await import("@/lib/card-token"));
    ({ POST } = await import("@/app/api/checkin/card/route"));
  });
  const cardReq = (body: unknown) => ({ json: async () => body, headers: new Headers() }) as unknown as Request;

  beforeEach(() => {
    h.requireApiStaff.mockResolvedValue({ ok: true, tenantId: "t1", userId: "coach-1", role: "coach" });
    h.memberFindMany.mockResolvedValue([{ id: "mem-1", name: "Ava Green", cardVersion: 1 }]);
  });

  it("a scan at the limit is refused with the staff sentence, nothing recorded or audited", async () => {
    h.performCheckin.mockResolvedValue(REFUSED);
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token] }))).json();
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "qr", allowanceGate: "refuse" });
    expect(body.recorded).toBe(0);
    expect(body.results[0]).toEqual({
      index: 0, memberId: "mem-1", memberName: "Ava Green",
      status: "refused", reason: "allowance_reached", message: STAFF_SENTENCE,
    });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an old scanner's resend with acknowledged is not a 400 and admits no one; the old tier answer is dropped too", async () => {
    h.performCheckin.mockResolvedValue(REFUSED);
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const res = await POST(cardReq({
      classInstanceId: "inst-1", tokens: [token], acknowledged: ["tier_not_included", "allowance_reached"],
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const args = h.performCheckin.mock.calls[0][0];
    expect(args).toMatchObject({ allowanceGate: "refuse" });
    expect(args).not.toHaveProperty("allowanceOverrideConfirmed");
    expect(args).not.toHaveProperty("tierOverrideConfirmed");
    expect(body.results[0]).toMatchObject({ status: "refused", reason: "allowance_reached" });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a stack sent with acknowledged is judged card by card, never refused outright", async () => {
    h.memberFindMany.mockResolvedValue([
      { id: "mem-1", name: "Ava Green", cardVersion: 1 },
      { id: "mem-2", name: "Ben Hill", cardVersion: 1 },
    ]);
    h.performCheckin.mockResolvedValueOnce(SUCCESS).mockResolvedValueOnce(REFUSED);
    const tokens = ["mem-1", "mem-2"].map((memberId) => signCardToken({ tenantId: "t1", memberId, cardVersion: 1 }));
    const res = await POST(cardReq({ classInstanceId: "inst-1", tokens, acknowledged: ["allowance_reached"] }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recorded).toBe(1);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(["success", "refused"]);
    const meta = h.logAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty("overrides");
  });
});

describe("POST /api/kiosk/[token]/checkin", () => {
  it("refuses with the count and the date the next class frees up", async () => {
    h.tenantFindFirst.mockResolvedValue({ id: "t1", subscriptionStatus: "active", deletedAt: null });
    h.verifyKioskMemberToken.mockReturnValue({ ok: true, memberId: "mem-1" });
    h.performCheckin.mockResolvedValue(REFUSED);
    const { POST } = await import("@/app/api/kiosk/[token]/checkin/route");
    const res = await POST(
      req("http://test/api/kiosk/x/checkin", { kioskMemberToken: "kiosk-member-token", classInstanceId: "inst-1" }),
      { params: Promise.resolve({ token: "a".repeat(32) }) },
    );
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "kiosk", allowanceGate: "refuse" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: MEMBER_SENTENCE, reason: "allowance_reached" });
  });
});
