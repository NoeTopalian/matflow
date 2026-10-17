// T6a (Q3): each door hands the engine the right tier mode, and records a
// staff override the same way existing desk overrides are recorded.
//  - POST /api/checkin: member/parent "refuse"; staff "ask", confirmed by
//    acknowledged: ["tier_not_included"], which lands on attendance.mark.
//  - POST /api/checkin/card: "ask"; an unconfirmed scan is needs_confirmation
//    with the question; the confirmed resend is admitted and audited.
//  - POST /api/kiosk/[token]/checkin: "refuse", with the class and plan named.
import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "checkin-tier-doors-secret";

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

const SUCCESS = { kind: "success", record: { id: "rec-1", tenantId: "t1", memberId: "mem-1", classInstanceId: "inst-1", checkInMethod: "admin" }, coverage: { kind: "manual" } };
const REFUSED = (askable: boolean) => ({ kind: "tier_not_included", className: "Advanced", tierName: "Beginners Unlimited", askable });

function req(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://test" }, body: JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.memberFindFirst.mockResolvedValue({ id: "mem-1" });
  h.instanceFindFirst.mockResolvedValue({ id: "inst-1", isCancelled: false });
});

describe("POST /api/checkin", () => {
  it("a member's own check-in is refused (tierGate refuse), 403 tier_not_included naming class and plan", async () => {
    h.auth.mockResolvedValue({ user: { id: "u-m", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@x" } });
    h.performCheckin.mockResolvedValue(REFUSED(false));
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "self", tierGate: "refuse", tierOverrideConfirmed: false });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("tier_not_included");
    expect(body.error).toContain("Advanced");
    expect(body.error).toContain("Beginners Unlimited");
  });

  it("a member cannot smuggle a confirmation through acknowledged", async () => {
    h.auth.mockResolvedValue({ user: { id: "u-m", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@x" } });
    h.performCheckin.mockResolvedValue(REFUSED(false));
    const { POST } = await import("@/app/api/checkin/route");
    await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", acknowledged: ["tier_not_included"] }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ tierGate: "refuse", tierOverrideConfirmed: false });
  });

  it("a staff mark asks: unconfirmed is a 403 with askable: true", async () => {
    h.auth.mockResolvedValue({ user: { id: "coach-1", role: "coach", tenantId: "t1" } });
    h.performCheckin.mockResolvedValue(REFUSED(true));
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "admin", tierGate: "ask", tierOverrideConfirmed: false });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "tier_not_included", askable: true });
  });

  it("a confirmed staff mark is admitted and the override is on the attendance.mark audit row", async () => {
    h.auth.mockResolvedValue({ user: { id: "coach-1", role: "coach", tenantId: "t1" } });
    h.performCheckin.mockResolvedValue({ ...SUCCESS, overrides: ["tier_not_included"] });
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", {
      classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin", acknowledged: ["tier_not_included"],
    }));
    expect(res.status).toBe(201);
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ tierGate: "ask", tierOverrideConfirmed: true });
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "attendance.mark",
      metadata: { acknowledged: ["tier_not_included"], overrides: ["tier_not_included"] },
    });
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

  it("an unconfirmed scan asks: needs_confirmation with the question, nothing recorded", async () => {
    h.performCheckin.mockResolvedValue(REFUSED(true));
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token] }))).json();
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "qr", tierGate: "ask", tierOverrideConfirmed: false });
    expect(body.recorded).toBe(0);
    expect(body.results[0]).toMatchObject({
      status: "needs_confirmation",
      reason: "tier_not_included",
      question: "Advanced isn't included in Ava Green's Beginners Unlimited membership. Admit anyway?",
    });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("the confirmed resend is admitted and the override is on the card_scan audit row", async () => {
    h.performCheckin.mockResolvedValue({ ...SUCCESS, overrides: ["tier_not_included"] });
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token], acknowledged: ["tier_not_included"] }))).json();
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ tierGate: "ask", tierOverrideConfirmed: true });
    expect(body.results[0].status).toBe("success");
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      action: "attendance.card_scan",
      metadata: { overrides: [{ memberId: "mem-1", reasons: ["tier_not_included"] }] },
    });
  });
});

describe("POST /api/kiosk/[token]/checkin", () => {
  it("refuses with the class and plan named", async () => {
    h.tenantFindFirst.mockResolvedValue({ id: "t1", subscriptionStatus: "active", deletedAt: null });
    h.verifyKioskMemberToken.mockReturnValue({ ok: true, memberId: "mem-1" });
    h.performCheckin.mockResolvedValue(REFUSED(false));
    const { POST } = await import("@/app/api/kiosk/[token]/checkin/route");
    const res = await POST(
      req("http://test/api/kiosk/x/checkin", { kioskMemberToken: "kiosk-member-token", classInstanceId: "inst-1" }),
      { params: Promise.resolve({ token: "a".repeat(32) }) },
    );
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "kiosk", tierGate: "refuse" });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("tier_not_included");
    expect(body.error).toBe("Advanced isn't included in your Beginners Unlimited membership. Ask staff about a membership that includes it.");
  });
});
