// Speed quick win 2i (6 Nov 2026): a class start puts a whole class through one
// front-desk tablet in a minute or two. The kiosk check-in allowed 30 a minute
// per tablet (token + IP) and refused the rest of the queue; it now allows 150.
// Only check-in changes: the name search and the timetable read stay at 60, and
// the sign-in, magic-link and lockout limits are untouched.
//
// The limiter itself is the real lib/rate-limit.ts elsewhere; here the routes'
// own arguments are pinned, and a refusal is answered before anything else runs.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const KIOSK_TOKEN = "kiosk_token_abcdefghijklmnop";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

const h = vi.hoisted(() => ({
  rateLimit: vi.fn(),
  tenantFindFirst: vi.fn(),
  memberFindMany: vi.fn(),
  instanceFindMany: vi.fn(),
  performCheckin: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({ tenant: { findFirst: h.tenantFindFirst } }),
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ member: { findMany: h.memberFindMany }, classInstance: { findMany: h.instanceFindMany } }),
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (t: string) => `hash_${t}` }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: h.rateLimit, getClientIp: () => "203.0.113.7" }));
vi.mock("@/lib/kiosk-token", () => ({
  signKioskMemberToken: () => "signed_token",
  verifyKioskMemberToken: () => ({ ok: true, memberId: "mem_1" }),
}));
vi.mock("@/lib/checkin", () => ({ performCheckin: h.performCheckin }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/login-fingerprint", () => ({ normaliseIp: () => "203.0.113.0/24", summariseUa: () => "a tablet" }));

let membersGET: typeof import("@/app/api/kiosk/[token]/members/route")["GET"];
let checkinPOST: typeof import("@/app/api/kiosk/[token]/checkin/route")["POST"];
let classesGET: typeof import("@/app/api/kiosk/[token]/classes/route")["GET"];

beforeAll(async () => {
  ({ GET: membersGET } = await import("@/app/api/kiosk/[token]/members/route"));
  ({ POST: checkinPOST } = await import("@/app/api/kiosk/[token]/checkin/route"));
  ({ GET: classesGET } = await import("@/app/api/kiosk/[token]/classes/route"));
});

const params = Promise.resolve({ token: KIOSK_TOKEN });
const checkinReq = () =>
  new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kioskMemberToken: "signed_token_value", classInstanceId: "inst_1" }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.rateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
});

describe("kiosk limits per tablet (token + IP), per minute", () => {
  it("check-in: 150", async () => {
    const res = await checkinPOST(checkinReq(), { params });
    expect(res.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith(expect.stringMatching(/^kiosk:checkin:[^:]+:203\.0\.113\.7$/), 150, 60_000);
    // Refused before any work: no tenant lookup, no check-in.
    expect(h.tenantFindFirst).not.toHaveBeenCalled();
    expect(h.performCheckin).not.toHaveBeenCalled();
  });

  it("name search: unchanged at 60", async () => {
    const res = await membersGET(new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/members?q=sam`), { params });
    expect(res.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith(expect.stringMatching(/^kiosk:lookup:[^:]+:203\.0\.113\.7$/), 60, 60_000);
    expect(h.memberFindMany).not.toHaveBeenCalled();
  });

  it("timetable read: unchanged at 60", async () => {
    const res = await classesGET(new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/classes`), { params });
    expect(res.status).toBe(429);
    expect(h.rateLimit).toHaveBeenCalledWith(expect.stringMatching(/^kiosk:classes:/), 60, 60_000);
  });
});
