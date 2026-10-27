/**
 * G4: POST /api/checkin with `oneOff`. A coach's one-off is a deliberate
 * register action: staff only, the admin method only, a reason of 3 to 200
 * characters, granted by the signed-in user (never the body), audited as
 * attendance.one_off with the reason. The hold, waiver and kids-class
 * questions are not bypassed: one the register did not confirm is refused.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

const h = vi.hoisted(() => ({
  auth: vi.fn(),
  performCheckin: vi.fn(),
  logAudit: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(async () => ({})),
  memberFindFirst: vi.fn(),
  instanceFindFirst: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.auth }));
vi.mock("@/lib/checkin", () => ({ performCheckin: h.performCheckin }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: h.memberFindFirst },
      classInstance: { findFirst: h.instanceFindFirst },
      tenant: { findUnique: async () => ({ memberAppCheckin: true, paymentRail: null, timezone: "Europe/London" }) },
    }),
}));

import { POST } from "@/app/api/checkin/route";
import { ONE_OFF_METHOD_ERROR, ONE_OFF_REASON_ERROR } from "@/lib/one-off";

function req(body: unknown) {
  return new Request("http://test/api/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test" },
    body: JSON.stringify(body),
  });
}

const COACH = { user: { id: "coach-1", role: "coach", tenantId: "t1", name: "Coach Jo" } };
const ONE_OFF_BODY = { classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin", oneOff: { reason: "Trial for the comp squad" } };

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.mockResolvedValue(COACH);
  h.memberFindFirst.mockResolvedValue({ id: "mem-1", name: "Ada Lovelace" });
  h.instanceFindFirst.mockResolvedValue({ id: "inst-1" });
  h.performCheckin.mockResolvedValue({
    kind: "success", record: { id: "rec-1" }, coverage: { kind: "subscription" },
    oneOff: { id: "oo-1", reason: "Trial for the comp squad" },
  });
});

describe("POST /api/checkin with a one-off", () => {
  it("passes the reason and the SESSION user as the grantor to the engine", async () => {
    const res = await POST(req({ ...ONE_OFF_BODY, oneOff: { reason: "  Trial for the comp squad  ", grantedById: "someone-else" } }));
    // An unknown key inside oneOff is refused (strict), so a body can never name a grantor.
    expect(res.status).toBe(400);
    expect(h.performCheckin).not.toHaveBeenCalled();

    const ok = await POST(req({ ...ONE_OFF_BODY, oneOff: { reason: "  Trial for the comp squad  " } }));
    expect(ok.status).toBe(201);
    expect(h.performCheckin).toHaveBeenCalledTimes(1);
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({
      method: "admin",
      memberId: "mem-1",
      checkedInByUserId: "coach-1",
      oneOff: { reason: "Trial for the comp squad", grantedById: "coach-1" },
      allowanceGate: "refuse",
    });
    expect(await ok.json()).toMatchObject({ success: true, oneOff: { id: "oo-1", reason: "Trial for the comp squad" } });
  });

  it("writes the attendance.one_off audit row with the reason, the session, the member and the record", async () => {
    await POST(req(ONE_OFF_BODY));
    expect(h.logAudit).toHaveBeenCalledTimes(1);
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({
      tenantId: "t1",
      userId: "coach-1",
      action: "attendance.one_off",
      entityType: "AttendanceRecord",
      entityId: "inst-1:mem-1",
      metadata: {
        classInstanceId: "inst-1", memberId: "mem-1", recordId: "rec-1", created: true,
        oneOffId: "oo-1", reason: "Trial for the comp squad", method: "admin",
      },
    });
  });

  it.each([
    ["missing", {}],
    ["too short", { reason: "ok" }],
    ["blank", { reason: "     " }],
    ["too long", { reason: "x".repeat(201) }],
    ["not text", { reason: 42 }],
  ])("a reason that is %s answers 400 with the reason sentence", async (_label, oneOff) => {
    const res = await POST(req({ ...ONE_OFF_BODY, oneOff }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ONE_OFF_REASON_ERROR, reason: "one_off_reason_invalid" });
    expect(h.performCheckin).not.toHaveBeenCalled();
  });

  it("accepts exactly 3 and exactly 200 characters", async () => {
    expect((await POST(req({ ...ONE_OFF_BODY, oneOff: { reason: "abc" } }))).status).toBe(201);
    expect((await POST(req({ ...ONE_OFF_BODY, oneOff: { reason: "y".repeat(200) } }))).status).toBe(201);
  });

  it.each([
    ["the member's own check-in", { classInstanceId: "inst-1", oneOff: { reason: "Let me in please" } }],
    ["a parent's check-in", { classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1", oneOff: { reason: "Let me in please" } }],
    ["the auto method", { ...ONE_OFF_BODY, checkInMethod: "auto" }],
    ["the self method with a member id", { ...ONE_OFF_BODY, checkInMethod: "self" }],
  ])("refuses a one-off on %s (400, nothing judged)", async (_label, body) => {
    h.auth.mockResolvedValue({ user: { id: "u-mem", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@example.test" } });
    const res = await POST(req(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: ONE_OFF_METHOD_ERROR, reason: "one_off_not_allowed" });
    expect(h.performCheckin).not.toHaveBeenCalled();
  });

  it("a member account sending a staff-shaped one-off is forbidden", async () => {
    h.auth.mockResolvedValue({ user: { id: "u-mem", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@example.test" } });
    const res = await POST(req(ONE_OFF_BODY));
    expect(res.status).toBe(403);
    expect(h.performCheckin).not.toHaveBeenCalled();
  });

  it("asks the hold, waiver and kids-class questions: unconfirmed ones are enforced, confirmed ones are not", async () => {
    await POST(req(ONE_OFF_BODY));
    expect(h.performCheckin.mock.calls[0][0]).toMatchObject({ enforceHoldGate: true, enforceWaiverGate: true, enforceKidsGate: true });
    await POST(req({ ...ONE_OFF_BODY, acknowledged: ["on_hold", "waiver_unsigned", "kids_class"] }));
    expect(h.performCheckin.mock.calls[1][0]).toMatchObject({ enforceHoldGate: false, enforceWaiverGate: false, enforceKidsGate: false });
    // An ordinary staff mark is unchanged: the register asks, the server does not.
    await POST(req({ classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(h.performCheckin.mock.calls[2][0]).toMatchObject({ enforceHoldGate: false, enforceWaiverGate: false, enforceKidsGate: false });
    expect(h.performCheckin.mock.calls[2][0]).not.toHaveProperty("oneOff");
  });

  it.each([
    ["on_hold", { kind: "on_hold", holdUntil: null }, "Ada Lovelace's membership is on hold."],
    ["waiver_unsigned", { kind: "waiver_unsigned" }, "Ada Lovelace hasn't signed the waiver."],
    ["kids_class", { kind: "kids_class" }, "Ada Lovelace is an adult and this is a kids class."],
  ])("an unconfirmed %s is a 403 in the staff's words, and nothing is audited", async (reason, result, fact) => {
    h.performCheckin.mockResolvedValue(result);
    const res = await POST(req(ONE_OFF_BODY));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: `${fact} Confirm that before adding them as a one-off.`, reason });
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a member already in the session is 409 already_checked_in, as now", async () => {
    h.performCheckin.mockResolvedValue({ kind: "duplicate" });
    const res = await POST(req(ONE_OFF_BODY));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "already_checked_in" });
  });
});
