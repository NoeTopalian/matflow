// G5 (owner decision, 27 Oct 2026): "In app sign ins are optionally set up by
// the gym owners, and they should be able to turn it off in their gym
// settings. It should be on as default."
//
// POST /api/checkin refuses the member's own path when the club has turned
// app check-in off (a parent checking in a child included), with 403 and
// reason "app_checkin_off". The staff path (admin / auto) is unaffected, and
// the kiosk route and the card scanner never read the switch.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

const { authMock, performCheckinMock, memberFindFirstMock, instanceFindFirstMock, tenantFindUniqueMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  performCheckinMock: vi.fn(),
  memberFindFirstMock: vi.fn(),
  instanceFindFirstMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: authMock }));
vi.mock("@/lib/checkin", () => ({ performCheckin: performCheckinMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => ({})) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: memberFindFirstMock },
      classInstance: { findFirst: instanceFindFirstMock },
      tenant: { findUnique: tenantFindUniqueMock },
    }),
}));

import { POST } from "@/app/api/checkin/route";
import { APP_CHECKIN_OFF_MESSAGE } from "@/lib/checkin-refusal";

function req(body: unknown) {
  return new Request("http://test/api/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://test" },
    body: JSON.stringify(body),
  });
}

const MEMBER = { user: { id: "u-mem", role: "member", tenantId: "t1", memberId: "mem-1", email: "m@example.test" } };
const PARENT = { user: { id: "u-par", role: "member", tenantId: "t1", memberId: "par-1", email: "p@example.test" } };
const COACH = { user: { id: "coach-1", role: "coach", tenantId: "t1" } };

function clubSwitch(on: boolean) {
  tenantFindUniqueMock.mockResolvedValue({ memberAppCheckin: on });
}

beforeEach(() => {
  vi.clearAllMocks();
  performCheckinMock.mockResolvedValue({ kind: "success", record: { id: "rec-1" }, coverage: null });
  memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Member" });
  instanceFindFirstMock.mockResolvedValue({ id: "inst-1" });
});

describe("POST /api/checkin when the club has turned app check-in off", () => {
  it("refuses a member checking themselves in: 403, app_checkin_off, the owner's sentence, nothing recorded", async () => {
    clubSwitch(false);
    authMock.mockResolvedValue(MEMBER);
    const res = await POST(req({ classInstanceId: "inst-1", checkInMethod: "self" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.reason).toBe("app_checkin_off");
    expect(body.error).toBe("Check-ins from the app are turned off at this club. Please check in at the desk or the kiosk.");
    expect(body.error).toBe(APP_CHECKIN_OFF_MESSAGE);
    expect(performCheckinMock).not.toHaveBeenCalled();
  });

  it("refuses a parent checking in their child, before the child is even looked up", async () => {
    clubSwitch(false);
    authMock.mockResolvedValue(PARENT);
    const res = await POST(req({ classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1" }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toBe("app_checkin_off");
    expect(memberFindFirstMock).not.toHaveBeenCalled();
    expect(performCheckinMock).not.toHaveBeenCalled();
  });

  it("refuses a client that claims checkInMethod admin without a memberId (it is still the member's own path)", async () => {
    clubSwitch(false);
    authMock.mockResolvedValue(MEMBER);
    const res = await POST(req({ classInstanceId: "inst-1", checkInMethod: "admin" }));
    expect(res.status).toBe(403);
    expect(performCheckinMock).not.toHaveBeenCalled();
  });

  it("does not touch a staff mark (admin): the switch is not even read", async () => {
    clubSwitch(false);
    authMock.mockResolvedValue(COACH);
    const res = await POST(req({ classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "admin" }));
    expect(res.status).toBe(201);
    expect(tenantFindUniqueMock).not.toHaveBeenCalled();
    expect(performCheckinMock).toHaveBeenCalledWith(expect.objectContaining({ memberId: "mem-1", method: "admin" }));
  });

  it("does not touch a system mark (auto)", async () => {
    clubSwitch(false);
    authMock.mockResolvedValue(COACH);
    const res = await POST(req({ classInstanceId: "inst-1", memberId: "mem-1", checkInMethod: "auto" }));
    expect(res.status).toBe(201);
    expect(performCheckinMock).toHaveBeenCalledWith(expect.objectContaining({ method: "auto" }));
  });
});

describe("POST /api/checkin when app check-in is on (the default)", () => {
  it("admits a member checking themselves in", async () => {
    clubSwitch(true);
    authMock.mockResolvedValue(MEMBER);
    const res = await POST(req({ classInstanceId: "inst-1" }));
    expect(res.status).toBe(201);
    expect(performCheckinMock).toHaveBeenCalledWith(expect.objectContaining({ memberId: "mem-1", method: "self" }));
  });

  it("admits a parent checking in their child", async () => {
    clubSwitch(true);
    authMock.mockResolvedValue(PARENT);
    memberFindFirstMock.mockResolvedValue({ id: "kid-1", name: "Kid" });
    const res = await POST(req({ classInstanceId: "inst-1", onBehalfOfMemberId: "kid-1" }));
    expect(res.status).toBe(201);
    expect(performCheckinMock).toHaveBeenCalledWith(expect.objectContaining({ memberId: "kid-1", method: "self" }));
  });
});

describe("the other doors never read the switch", () => {
  // The kiosk route, the card scanner and the coach register mark through
  // their own routes (or the staff branch above). Pinned at source level so a
  // later edit cannot quietly put the member-app switch on a staff door.
  const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it.each([
    "app/api/kiosk/[token]/checkin/route.ts",
    "app/api/checkin/card/route.ts",
    "lib/checkin.ts",
  ])("%s does not mention memberAppCheckin", (p) => {
    expect(src(p)).not.toMatch(/memberAppCheckin|app_checkin_off/);
  });
});
