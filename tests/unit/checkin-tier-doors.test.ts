// Class eligibility at each door (owner decision, 20 Oct 2026): the
// membership list and the squad list refuse everywhere, staff doors included,
// with the sentence the member reads. No door hands the engine a mode or a
// confirmation, and a stale client's "tier_not_included" confirmation is
// ignored and recorded nowhere.
//  - POST /api/checkin: member, parent and staff alike get the 403.
//  - POST /api/checkin/card: a refused card is "refused" with the sentence.
//  - POST /api/kiosk/[token]/checkin: the same sentence.
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

const SUCCESS = { kind: "success", record: { id: "rec-1", tenantId: "t1", memberId: "mem-1", classInstanceId: "inst-1", checkInMethod: "admin" }, coverage: { kind: "manual" } };
const TIER_REFUSED = { kind: "tier_not_included", className: "Advanced", tierName: "Beginners Unlimited" };
const ROSTER_REFUSED = { kind: "roster_not_listed" };
const TIER_SENTENCE = "Advanced isn't included in your Beginners Unlimited membership. Ask staff about a membership that includes it.";
const ROSTER_SENTENCE = "You're not on the roster for this class.";
const NO_GATE_ARGS = ["tierGate", "tierOverrideConfirmed", "enforceRosterGate"];

function req(url: string, body: unknown) {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://test" }, body: JSON.stringify(body) });
}
function expectNoGateArgs(args: Record<string, unknown>) {
  for (const k of NO_GATE_ARGS) expect(args).not.toHaveProperty(k);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.memberFindFirst.mockResolvedValue({ id: "mem-1" });
  h.instanceFindFirst.mockResolvedValue({ id: "inst-1", isCancelled: false });
});

describe("POST /api/checkin", () => {
  const asMember = () => h.auth.mockResolvedValue({ user: { id: "u-m", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@x" } });
  const asCoach = () => h.auth.mockResolvedValue({ user: { id: "coach-1", role: "coach", tenantId: "t1" } });

  it("a member's own check-in is refused, 403 tier_not_included naming class and plan", async () => {
    asMember();
    h.performCheckin.mockResolvedValue(TIER_REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "self" });
    expectNoGateArgs(h.performCheckin.mock.calls[0][0]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: TIER_SENTENCE, reason: "tier_not_included" });
  });

  it("a staff mark is refused with the same sentence the member sees — no askable, nothing audited", async () => {
    asCoach();
    h.performCheckin.mockResolvedValue(TIER_REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "admin" });
    expectNoGateArgs(h.performCheckin.mock.calls[0][0]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: TIER_SENTENCE, reason: "tier_not_included" });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a staff mark of someone not on the squad list is refused with the roster sentence", async () => {
    asCoach();
    h.performCheckin.mockResolvedValue(ROSTER_REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ROSTER_SENTENCE, reason: "roster_not_listed" });
  });

  it.each([
    ["staff", () => asCoach(), { memberId: "mem-1", checkInMethod: "admin" }],
    ["staff auto", () => asCoach(), { memberId: "mem-1", checkInMethod: "auto" }],
    ["member", () => asMember(), {}],
  ])("%s: a tier_not_included confirmation is ignored — no 400, nothing passed to the engine, still refused", async (_who, sign, extra) => {
    sign();
    h.performCheckin.mockResolvedValue(TIER_REFUSED);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", { classInstanceId: "inst-1", ...extra, acknowledged: ["tier_not_included"] }));
    expect(res.status).toBe(403);
    expectNoGateArgs(h.performCheckin.mock.calls[0][0]);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a staff mark that succeeds records no tier override, even when the old confirmation was sent", async () => {
    asCoach();
    h.performCheckin.mockResolvedValue(SUCCESS);
    const { POST } = await import("@/app/api/checkin/route");
    const res = await POST(req("http://test/api/checkin", {
      classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin", acknowledged: ["on_hold", "tier_not_included"],
    }));
    expect(res.status).toBe(201);
    const audit = h.logAudit.mock.calls[0][0] as { action: string; metadata: Record<string, unknown> };
    expect(audit.action).toBe("attendance.mark");
    // The other asks are kept exactly as they are; the tier one is gone.
    expect(audit.metadata.acknowledged).toEqual(["on_hold"]);
    expect(audit.metadata).not.toHaveProperty("overrides");
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

  it("a card for a plan the class excludes is refused with the member's sentence; nothing recorded or audited", async () => {
    h.performCheckin.mockResolvedValue(TIER_REFUSED);
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token] }))).json();
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "qr" });
    expectNoGateArgs(h.performCheckin.mock.calls[0][0]);
    expect(body.recorded).toBe(0);
    expect(body.results[0]).toEqual({
      index: 0, memberId: "mem-1", memberName: "Ava Green",
      status: "refused", reason: "tier_not_included", message: TIER_SENTENCE,
    });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a card for someone not on the squad list is refused with the roster sentence", async () => {
    h.performCheckin.mockResolvedValue(ROSTER_REFUSED);
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token] }))).json();
    expect(body.results[0]).toMatchObject({ status: "refused", reason: "roster_not_listed", message: ROSTER_SENTENCE });
  });

  it("a resend carrying the old confirmation is ignored: still refused, no override anywhere", async () => {
    h.performCheckin.mockResolvedValue(TIER_REFUSED);
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token], acknowledged: ["tier_not_included"] }))).json();
    expectNoGateArgs(h.performCheckin.mock.calls[0][0]);
    expect(body.results[0].status).toBe("refused");
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("an admitted card's card_scan audit row carries no overrides", async () => {
    h.performCheckin.mockResolvedValue({ ...SUCCESS, record: { ...SUCCESS.record, checkInMethod: "qr" } });
    const token = signCardToken({ tenantId: "t1", memberId: "mem-1", cardVersion: 1 });
    const body = await (await POST(cardReq({ classInstanceId: "inst-1", tokens: [token], acknowledged: ["tier_not_included"] }))).json();
    expect(body.results[0].status).toBe("success");
    const audit = h.logAudit.mock.calls[0][0] as { action: string; metadata: Record<string, unknown> };
    expect(audit.action).toBe("attendance.card_scan");
    expect(audit.metadata).not.toHaveProperty("overrides");
  });
});

describe("POST /api/kiosk/[token]/checkin", () => {
  const kiosk = async () => {
    h.tenantFindFirst.mockResolvedValue({ id: "t1", subscriptionStatus: "active", deletedAt: null });
    h.verifyKioskMemberToken.mockReturnValue({ ok: true, memberId: "mem-1" });
    const { POST } = await import("@/app/api/kiosk/[token]/checkin/route");
    return POST(
      req("http://test/api/kiosk/x/checkin", { kioskMemberToken: "kiosk-member-token", classInstanceId: "inst-1" }),
      { params: Promise.resolve({ token: "a".repeat(32) }) },
    );
  };

  it("refuses with the class and plan named", async () => {
    h.performCheckin.mockResolvedValue(TIER_REFUSED);
    const res = await kiosk();
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ method: "kiosk" });
    expectNoGateArgs(h.performCheckin.mock.calls[0][0]);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: TIER_SENTENCE, reason: "tier_not_included" });
  });

  it("refuses a member not on the squad list with the same roster sentence", async () => {
    h.performCheckin.mockResolvedValue(ROSTER_REFUSED);
    const res = await kiosk();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ROSTER_SENTENCE, reason: "roster_not_listed" });
  });
});
