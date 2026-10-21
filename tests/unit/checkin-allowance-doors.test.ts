// T7 (Sean note 5): each door hands the engine the right allowance mode, says
// the refusal in its own words, and records a staff override with the count.
//  - POST /api/checkin: member/parent "refuse"; staff "ask", confirmed by
//    acknowledged: ["allowance_reached"], which lands on attendance.mark with
//    the count (overAllowance).
//  - POST /api/checkin/card: "ask"; an unconfirmed scan is needs_confirmation
//    with the question; the confirmed resend is admitted and audited.
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
vi.mock("@/lib/checkin", () => ({ performCheckin: h.performCheckin }));
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
const REFUSED = (askable: boolean) => ({ kind: "allowance_reached", askable, ...FACTS });
const MEMBER_SENTENCE =
  "4 of 4 classes used this 4-week period; it resets on Monday 26 October. Ask staff if you need to train before then.";

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
    h.performCheckin.mockResolvedValue(REFUSED(false));
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "self", allowanceGate: "refuse", allowanceOverrideConfirmed: false });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({ reason: "allowance_reached", error: MEMBER_SENTENCE });
    expect(body.askable).toBeUndefined();
  });

  it("a parent checking in a child is the child's check-in, judged on the child's allowance", async () => {
    h.auth.mockResolvedValue({ user: { id: "u-p", role: "member", tenantId: "t1", memberId: "parent-1", email: "p@x" } });
    h.memberFindFirst.mockResolvedValue({ id: "kid-1" });
    h.performCheckin.mockResolvedValue(REFUSED(false));
    const { POST } = await import("@/app/api/checkin/route");
    await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ memberId: "kid-1", method: "self", allowanceGate: "refuse" });
  });

  it("the parent's refusal names the child whose allowance is used up", async () => {
    h.auth.mockResolvedValue({ user: { id: "u-p", role: "member", tenantId: "t1", memberId: "parent-1", email: "p@x" } });
    h.memberFindFirst.mockResolvedValue({ id: "kid-1", name: "Sam" });
    h.performCheckin.mockResolvedValue(REFUSED(false));
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      reason: "allowance_reached",
      error: "Sam: 4 of 4 classes used this 4-week period; it resets on Monday 26 October. Ask staff if Sam needs to train before then.",
    });
  });

  it("a member cannot smuggle a confirmation through acknowledged", async () => {
    h.auth.mockResolvedValue(member);
    h.performCheckin.mockResolvedValue(REFUSED(false));
    const { POST } = await import("@/app/api/checkin/route");
    await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", acknowledged: ["allowance_reached"] }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ allowanceGate: "refuse", allowanceOverrideConfirmed: false });
  });

  it("a staff mark asks: unconfirmed is a 403 with askable: true and the count", async () => {
    h.auth.mockResolvedValue(coach);
    h.performCheckin.mockResolvedValue(REFUSED(true));
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "admin", allowanceGate: "ask", allowanceOverrideConfirmed: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "allowance_reached", askable: true, allowance: FACTS });
  });

  it("a confirmed staff mark is admitted and the override and the count are on the attendance.mark audit row", async () => {
    h.auth.mockResolvedValue(coach);
    h.performCheckin.mockResolvedValue({ ...SUCCESS, overrides: ["allowance_reached"], overAllowance: FACTS });
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", {
      classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin", acknowledged: ["allowance_reached"],
    }));
    expect(res.status).toBe(201);
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ allowanceGate: "ask", allowanceOverrideConfirmed: true });
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "attendance.mark",
      metadata: { acknowledged: ["allowance_reached"], overrides: ["allowance_reached"], overAllowance: FACTS },
    });
  });

  it("a staff 'auto' admission past the allowance is audited too", async () => {
    h.auth.mockResolvedValue(coach);
    h.performCheckin.mockResolvedValue({ ...SUCCESS, overrides: ["allowance_reached"], overAllowance: FACTS });
    const { POST } = await import("@/app/api/checkin/route");
    await POST(req("http://test/api/checkin", {
      classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "auto", acknowledged: ["allowance_reached"],
    }));
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({ action: "attendance.mark", metadata: { overAllowance: FACTS } });
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

  it("an unconfirmed scan asks: needs_confirmation with the count and the date, nothing recorded", async () => {
    h.performCheckin.mockResolvedValue(REFUSED(true));
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token] }))).json();
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "qr", allowanceGate: "ask", allowanceOverrideConfirmed: false });
    expect(body.recorded).toBe(0);
    expect(body.results[0]).toMatchObject({
      status: "needs_confirmation",
      reason: "allowance_reached",
      question: "Ava Green has used 4 of 4 classes this 4-week period (resets on Monday 26 October). Admit anyway?",
    });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("the confirmed resend is admitted and the count is on the card_scan audit row; an old client's tier answer is dropped", async () => {
    h.performCheckin.mockResolvedValue({ ...SUCCESS, overrides: ["allowance_reached"], overAllowance: FACTS });
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({
      classInstanceId: "inst-1", tokens: [token], acknowledged: ["tier_not_included", "allowance_reached"],
    }))).json();
    const args = h.performCheckin.mock.calls[0][0];
    expect(args).toMatchObject({ allowanceOverrideConfirmed: true });
    // The squad list and the membership list have no override flag any more.
    expect(args).not.toHaveProperty("tierOverrideConfirmed");
    expect(args).not.toHaveProperty("tierGate");
    expect(body.results[0].status).toBe("success");
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "attendance.card_scan",
      metadata: { overrides: [{ memberId: "mem-1", reasons: ["allowance_reached"], overAllowance: FACTS }] },
    });
  });

  it("a confirmation answers one card: a stack sent with acknowledged is refused outright, nothing recorded (review L-11)", async () => {
    const tokens = ["mem-1", "mem-2"].map((memberId) => signCardToken({ tenantId: "t1", memberId, cardVersion: 1 }));
    const res = await POST(cardReq({ classInstanceId: "inst-1", tokens, acknowledged: ["allowance_reached"] }));
    expect(res.status).toBe(400);
    expect(h.performCheckin).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});

describe("POST /api/kiosk/[token]/checkin", () => {
  it("refuses with the count and the date the next class frees up", async () => {
    h.tenantFindFirst.mockResolvedValue({ id: "t1", subscriptionStatus: "active", deletedAt: null });
    h.verifyKioskMemberToken.mockReturnValue({ ok: true, memberId: "mem-1" });
    h.performCheckin.mockResolvedValue(REFUSED(false));
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
