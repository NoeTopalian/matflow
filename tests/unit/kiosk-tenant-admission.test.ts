// The kiosk is a door, and a paused club's doors are shut.
//
// Every other entrance to MatFlow asks `tenantAdmission` whether the club's
// account admits anyone: the password provider, the magic link, the Google
// callback. The kiosk asked nothing. It resolves a tenant by
// `Tenant.kioskTokenHash` and serves its branding, its timetable, its roster
// search and its check-ins — so an operator suspending a club left a tablet on
// that club's front desk still taking attendance and still showing the club's
// logo, indefinitely, with no way to notice.
//
// `deletedAt` is the worse half: a soft-deleted club is one the operator
// believes is gone.
//
// These tests drive each of the three kiosk routes with a suspended, a
// cancelled and a soft-deleted club and assert the same two things every time —
// the answer is a refusal, and NOTHING past the tenant lookup ran.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";
import { admissionMessage } from "@/lib/tenant-admission";

const TENANT = "tenant_paused";
const KIOSK_TOKEN = "kiosk_token_abcdefghijklmnop";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  mockTenantFindFirst,
  mockMemberFindMany,
  mockInstanceFindMany,
  mockRateLimit,
  mockPerformCheckin,
  mockVerifyKioskToken,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockTenantFindFirst: vi.fn(),
  mockMemberFindMany: vi.fn(),
  mockInstanceFindMany: vi.fn(),
  mockRateLimit: vi.fn(),
  mockPerformCheckin: vi.fn(),
  mockVerifyKioskToken: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { findFirst: mockTenantFindFirst } }),
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findMany: mockMemberFindMany },
      classInstance: { findMany: mockInstanceFindMany },
    }),
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (t: string) => `hash_${t}` }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockRateLimit,
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/lib/kiosk-token", () => ({
  signKioskMemberToken: () => "signed_token",
  verifyKioskMemberToken: mockVerifyKioskToken,
}));
vi.mock("@/lib/checkin", () => ({ performCheckin: mockPerformCheckin }));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockLogAudit }));
vi.mock("@/lib/login-fingerprint", () => ({
  normaliseIp: () => "203.0.113.0/24",
  summariseUa: () => "a tablet",
}));

let classesGET: typeof import("@/app/api/kiosk/[token]/classes/route")["GET"];
let membersGET: typeof import("@/app/api/kiosk/[token]/members/route")["GET"];
let checkinPOST: typeof import("@/app/api/kiosk/[token]/checkin/route")["POST"];

beforeAll(async () => {
  ({ GET: classesGET } = await import("@/app/api/kiosk/[token]/classes/route"));
  ({ GET: membersGET } = await import("@/app/api/kiosk/[token]/members/route"));
  ({ POST: checkinPOST } = await import("@/app/api/kiosk/[token]/checkin/route"));
});

const params = Promise.resolve({ token: KIOSK_TOKEN });

const classesReq = () => new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/classes`);
const membersReq = () => new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/members?q=sam`);
const checkinReq = () =>
  new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kioskMemberToken: "signed_token_value", classInstanceId: "inst_1" }),
  });

/** A live club, so the happy path is proved by the same fixtures. */
function admissibleTenant() {
  return {
    id: TENANT,
    name: "Total BJJ",
    primaryColor: "#000",
    secondaryColor: "#111",
    textColor: "#fff",
    bgColor: "#000",
    logoUrl: null,
    fontFamily: null,
    subscriptionStatus: "active",
    deletedAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockMemberFindMany.mockResolvedValue([]);
  mockInstanceFindMany.mockResolvedValue([]);
  mockVerifyKioskToken.mockReturnValue({ ok: true, memberId: "mem_1" });
  mockPerformCheckin.mockResolvedValue({
    kind: "success",
    record: { id: "att_1" },
    coverage: { kind: "manual" },
  });
});

const PAUSED = admissionMessage("suspended", "member");

const routes = [
  {
    name: "GET /api/kiosk/[token]/classes",
    run: () => classesGET(classesReq(), { params }),
    /** The query this route must not reach once the club is paused. */
    guarded: () => mockInstanceFindMany,
  },
  {
    name: "GET /api/kiosk/[token]/members",
    run: () => membersGET(membersReq(), { params }),
    guarded: () => mockMemberFindMany,
  },
  {
    name: "POST /api/kiosk/[token]/checkin",
    run: () => checkinPOST(checkinReq(), { params }),
    guarded: () => mockPerformCheckin,
  },
] as const;

describe("the kiosk honours tenant admission", () => {
  for (const state of [
    { label: "suspended", tenant: { subscriptionStatus: "suspended", deletedAt: null } },
    { label: "cancelled", tenant: { subscriptionStatus: "cancelled", deletedAt: null } },
    { label: "soft-deleted", tenant: { subscriptionStatus: "active", deletedAt: new Date() } },
  ]) {
    for (const route of routes) {
      it(`${route.name} refuses a ${state.label} club and reads nothing`, async () => {
        mockTenantFindFirst.mockResolvedValue({ ...admissibleTenant(), ...state.tenant });

        const res = await route.run();

        expect(res.status).toBe(403);
        const body = await res.json();
        // The member-facing sentence: true, actionable, and it tells a stranger
        // nothing about the club's commercial standing with MatFlow.
        expect(body.error).toBe(PAUSED);
        expect(route.guarded()).not.toHaveBeenCalled();
      });
    }

    it(`the ${state.label} club's branding never leaves the server`, async () => {
      mockTenantFindFirst.mockResolvedValue({ ...admissibleTenant(), ...state.tenant });
      const body = await (await classesGET(classesReq(), { params })).json();
      expect(JSON.stringify(body)).not.toContain("Total BJJ");
    });
  }

  it("a past_due club is still admitted — members are still training tonight", async () => {
    mockTenantFindFirst.mockResolvedValue({ ...admissibleTenant(), subscriptionStatus: "past_due" });
    const res = await classesGET(classesReq(), { params });
    expect(res.status).toBe(200);
    expect(mockInstanceFindMany).toHaveBeenCalled();
  });

  it("an active club is unaffected on every route", async () => {
    mockTenantFindFirst.mockResolvedValue(admissibleTenant());

    expect((await classesGET(classesReq(), { params })).status).toBe(200);
    expect((await membersGET(membersReq(), { params })).status).toBe(200);
    expect((await checkinPOST(checkinReq(), { params })).status).toBe(201);
    expect(mockPerformCheckin).toHaveBeenCalled();
  });
});
