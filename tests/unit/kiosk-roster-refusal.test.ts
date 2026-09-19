// A member who is simply not on a class's roster must not see a crash.
//
// `lib/checkin.ts` returns `{ kind: "roster_not_listed" }` when a class has an
// allow-list and the member is not on it, and the kiosk route asks for that
// gate to be enforced (`enforceRosterGate: true`). Its switch had no case for
// the kind, so the result fell through `default:` to a 500 and the tablet said
// "Could not check in — please ask staff." — the copy reserved for a genuine
// failure. A competition squad's comp class, working exactly as configured,
// read as a broken kiosk.
//
// The staff route has said the right thing since Task 10
// (`app/api/checkin/route.ts:192-193`). These tests hold the kiosk to it.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";
const KIOSK_TOKEN = "kiosk_token_abcdefghijklmnop";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { mockTenantFindFirst, mockRateLimit, mockPerformCheckin, mockVerify, mockLogAudit } =
  vi.hoisted(() => ({
    mockTenantFindFirst: vi.fn(),
    mockRateLimit: vi.fn(),
    mockPerformCheckin: vi.fn(),
    mockVerify: vi.fn(),
    mockLogAudit: vi.fn(),
  }));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { findFirst: mockTenantFindFirst } }),
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (t: string) => `hash_${t}` }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mockRateLimit, getClientIp: () => "203.0.113.7" }));
vi.mock("@/lib/kiosk-token", () => ({ verifyKioskMemberToken: mockVerify }));
vi.mock("@/lib/checkin", () => ({ performCheckin: mockPerformCheckin }));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockLogAudit }));
vi.mock("@/lib/login-fingerprint", () => ({
  normaliseIp: () => "203.0.113.0/24",
  summariseUa: () => "a tablet",
}));

let POST: typeof import("@/app/api/kiosk/[token]/checkin/route")["POST"];
beforeAll(async () => {
  ({ POST } = await import("@/app/api/kiosk/[token]/checkin/route"));
});

const req = () =>
  new Request(`https://matflow.studio/api/kiosk/${KIOSK_TOKEN}/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kioskMemberToken: "signed_value", classInstanceId: "inst_1" }),
  });
const params = Promise.resolve({ token: KIOSK_TOKEN });

beforeEach(() => {
  vi.clearAllMocks();
  mockRateLimit.mockResolvedValue({ allowed: true });
  mockTenantFindFirst.mockResolvedValue({ id: TENANT, subscriptionStatus: "active", deletedAt: null });
  mockVerify.mockReturnValue({ ok: true, memberId: "mem_1" });
});

describe("kiosk check-in — a member not on the roster", () => {
  it("is refused with a 403, not a 500", async () => {
    mockPerformCheckin.mockResolvedValue({ kind: "roster_not_listed" });

    const res = await POST(req(), { params });

    expect(res.status).toBe(403);
  });

  it("is told, in a sentence, what is wrong", async () => {
    mockPerformCheckin.mockResolvedValue({ kind: "roster_not_listed" });

    const body = await (await POST(req(), { params })).json();

    // The staff route's sentence, so the two surfaces say the same thing about
    // the same state.
    expect(body.error).toBe("You're not on the roster for this class.");
    expect(body.error).not.toContain("Could not check in");
  });

  it("writes no audit row for a refusal", async () => {
    mockPerformCheckin.mockResolvedValue({ kind: "roster_not_listed" });
    await POST(req(), { params });
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("a genuine failure is still a 500 with the ask-staff copy", async () => {
    mockPerformCheckin.mockResolvedValue({ kind: "error", error: new Error("boom") });

    const res = await POST(req(), { params });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Could not check in — please ask staff.");
  });

  it("no_coverage is still forgiven into the same ask-staff 500 it always was", async () => {
    // The kiosk is configured `requireCoverage: false`, so this kind should be
    // unreachable from here; it stays mapped rather than silently changing.
    mockPerformCheckin.mockResolvedValue({ kind: "no_coverage" });
    expect((await POST(req(), { params })).status).toBe(500);
  });

  it("a successful tap is unaffected", async () => {
    mockPerformCheckin.mockResolvedValue({
      kind: "success",
      record: { id: "att_1" },
      coverage: { kind: "manual" },
    });
    expect((await POST(req(), { params })).status).toBe(201);
    expect(mockLogAudit).toHaveBeenCalled();
  });
});
