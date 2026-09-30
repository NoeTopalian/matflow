import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Verifier lane 7 (30 Sep 2026), found on the production build:
 *  - a retried Add member after a lost response created a second member
 *    (a member with no email has nothing else unique);
 *  - a retried waiver signature recorded a second signed copy;
 *  - a tier accepted a price of £99,999,999.99;
 *  - a date of birth in 1800 was accepted.
 * Each is pinned here against the route itself.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const m = vi.hoisted(() => ({
  memberCreate: vi.fn(),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn(async () => ({})),
  waiverCreate: vi.fn(),
  waiverFindFirst: vi.fn(),
  tierCreate: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { create: m.memberCreate, findFirst: m.memberFindFirst, findMany: vi.fn(), count: vi.fn(), update: m.memberUpdate },
      magicLinkToken: { create: vi.fn(), updateMany: vi.fn() },
      tenant: { findUnique: vi.fn(async () => ({ name: "Total BJJ", waiverTitle: null, waiverContent: null })) },
      memberStatusEvent: { create: vi.fn(async () => ({ id: "evt" })) },
      signedWaiver: { create: m.waiverCreate, findFirst: m.waiverFindFirst },
      membershipTier: { create: m.tierCreate },
    }),
  withRlsBypass: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/membership-tier", () => ({
  resolveMembershipTier: vi.fn(async () => null),
  membershipTierWrite: () => ({}),
}));
vi.mock("@/lib/waiver-signature-upload", () => ({
  uploadSignatureWithFallback: vi.fn(async () => "https://blob.test/sig.png"),
}));
vi.mock("@/lib/kids-policy", () => ({ MAX_KIDS_PER_PARENT: 10 }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u1" })),
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u1" })),
}));

import { POST as createMember } from "@/app/api/members/route";
import { POST as signWaiver } from "@/app/api/waiver/sign/route";
import { POST as createTier } from "@/app/api/memberships/route";
import { POST as createChild } from "@/app/api/member/children/route";
import { POST as signForChild } from "@/app/api/waiver/sign-for-child/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);

function req(url: string, body: Record<string, unknown>): Request {
  return {
    url,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Request;
}

const P2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(() => {
  vi.clearAllMocks();
  m.memberCreate.mockImplementation(async ({ data }: { data: { name: string; email: string } }) => ({
    id: "m-new", tenantId: "t-A", name: data.name, email: data.email, accountType: "adult",
  }));
  m.memberFindFirst.mockResolvedValue(null);
  m.waiverFindFirst.mockResolvedValue(null);
  m.waiverCreate.mockResolvedValue({ id: "sw-new" });
});

describe("POST /api/members — a retried Add member", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "owner", tenantId: "t-A" } } as never);
  });

  it("writes the request id on the first attempt", async () => {
    const res = await createMember(req("http://localhost/api/members", { name: "Walk-in Wendy", requestId: "req-12345678" }));
    expect(res.status).toBe(201);
    expect(m.memberCreate.mock.calls[0][0].data.createRequestId).toBe("req-12345678");
  });

  it("returns the member already created instead of a second one", async () => {
    m.memberFindFirst.mockResolvedValue({ id: "m-first", name: "Walk-in Wendy" });
    const res = await createMember(req("http://localhost/api/members", { name: "Walk-in Wendy", requestId: "req-12345678" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; replayed: boolean };
    expect(body).toMatchObject({ id: "m-first", replayed: true });
    expect(m.memberCreate).not.toHaveBeenCalled();
    expect(m.memberFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t-A", createRequestId: "req-12345678" } }),
    );
  });

  it("two copies racing: the loser returns the winner's member, not a 409", async () => {
    m.memberFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "m-winner", name: "Walk-in Wendy" });
    m.memberCreate.mockRejectedValue(P2002);
    const res = await createMember(req("http://localhost/api/members", { name: "Walk-in Wendy", requestId: "req-12345678" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe("m-winner");
  });

  it("without a request id a duplicate email is still a 409", async () => {
    m.memberCreate.mockRejectedValue(P2002);
    const res = await createMember(req("http://localhost/api/members", { name: "Jo", email: "jo@example.com" }));
    expect(res.status).toBe(409);
  });

  it("refuses a date of birth before 1900", async () => {
    const res = await createMember(req("http://localhost/api/members", { name: "Old Typo", dateOfBirth: "1800-01-01" }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/after 1900/);
    expect(m.memberCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/waiver/sign — a retried signature", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "member", tenantId: "t-A", memberId: "mem-1" } } as never);
    m.memberFindFirst.mockResolvedValue({
      emergencyContactName: "Bob", emergencyContactPhone: "07700900000", emergencyContactRelation: "Spouse",
    });
  });
  const body = { signatureDataUrl: PNG, signerName: "Alice", agreedTo: true, requestId: "sig-12345678" };

  it("writes the request id on the first signature", async () => {
    const res = await signWaiver(req("http://localhost/api/waiver/sign", body));
    expect(res.status).toBe(201);
    expect(m.waiverCreate.mock.calls[0][0].data.requestId).toBe("sig-12345678");
  });

  it("returns the waiver already signed instead of a second copy", async () => {
    m.waiverFindFirst.mockResolvedValue({ id: "sw-first" });
    const res = await signWaiver(req("http://localhost/api/waiver/sign", body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, replayed: true, signedWaiverId: "sw-first" });
    expect(m.waiverCreate).not.toHaveBeenCalled();
    // Scoped to the signer: another member's key can never match.
    expect(m.waiverFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t-A", memberId: "mem-1", requestId: "sig-12345678" } }),
    );
  });

  // End-user review (30 Sep 2026): the record must say what the member saw.
  it("refuses a signature whose shown text is not the waiver on record", async () => {
    const res = await signWaiver(req("http://localhost/api/waiver/sign", { ...body, shownTitle: "Liability Waiver & Assumption of Risk", shownContent: "placeholder" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "waiver_changed" });
    expect(m.waiverCreate).not.toHaveBeenCalled();
  });

  it("accepts a signature whose shown text is exactly the waiver on record", async () => {
    const { buildDefaultWaiverTitle, buildDefaultWaiverContent } = await import("@/lib/default-waiver");
    const res = await signWaiver(req("http://localhost/api/waiver/sign", {
      ...body, shownTitle: buildDefaultWaiverTitle("Total BJJ"), shownContent: buildDefaultWaiverContent("Total BJJ"),
    }));
    expect(res.status).toBe(201);
    expect(m.waiverCreate.mock.calls[0][0].data.contentSnapshot).toBe(buildDefaultWaiverContent("Total BJJ"));
  });

  it("two copies racing: the loser returns the winner's waiver", async () => {
    m.waiverFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "sw-winner" });
    m.waiverCreate.mockRejectedValue(P2002);
    const res = await signWaiver(req("http://localhost/api/waiver/sign", body));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { signedWaiverId: string }).signedWaiverId).toBe("sw-winner");
  });
});

describe("POST /api/memberships — tier price cap", () => {
  const tier = { name: "Adults", pricePence: 9_999_999_999, currency: "GBP", billingCycle: "monthly", isKids: false };

  it("refuses a price above £100,000 with a sentence a person can act on", async () => {
    const res = await createTier(req("http://localhost/api/memberships", tier));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("Price must be £100,000 or less");
    expect(m.tierCreate).not.toHaveBeenCalled();
  });
});

// Verifier lane 2 (30 Sep 2026): the other two doors that write on a retry.
describe("POST /api/member/children — a retried welcome-flow Finish", () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "member", tenantId: "t-A", memberId: "par-1" } } as never);
  });

  it("returns the child already created instead of a second one", async () => {
    m.memberFindFirst
      .mockResolvedValueOnce({ id: "par-1", parentMemberId: null })
      .mockResolvedValueOnce({ id: "kid-first", name: "Mo", dateOfBirth: null, accountType: "kids" });
    const res = await createChild(req("http://localhost/api/member/children", { name: "Mo", requestId: "kid-12345678" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "kid-first", replayed: true });
    expect(m.memberCreate).not.toHaveBeenCalled();
    // Scoped to this parent: another parent's key can never match.
    expect(m.memberFindFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { tenantId: "t-A", parentMemberId: "par-1", createRequestId: "kid-12345678" } }),
    );
  });

  it("writes the request id on the first attempt", async () => {
    m.memberFindFirst.mockResolvedValueOnce({ id: "par-1", parentMemberId: null }).mockResolvedValueOnce(null);
    m.memberCreate.mockResolvedValue({ id: "kid-new", name: "Mo", dateOfBirth: null, accountType: "kids" });
    const res = await createChild(req("http://localhost/api/member/children", { name: "Mo", requestId: "kid-12345678" }));
    expect(res.status).toBe(201);
    expect(m.memberCreate.mock.calls[0][0].data.createRequestId).toBe("kid-12345678");
  });
});

describe("POST /api/waiver/sign-for-child — a guardian's retry", () => {
  const body = { childMemberId: "kid-1", signatureDataUrl: PNG, signerName: "Pat Parent", agreedTo: true, requestId: "gsig-12345678" };
  beforeEach(() => {
    mockAuth.mockResolvedValue({ user: { id: "u1", role: "member", tenantId: "t-A", memberId: "par-1" } } as never);
    m.memberFindFirst
      .mockResolvedValueOnce({ id: "kid-1", name: "Mo", waiverAccepted: false })
      .mockResolvedValueOnce({ emergencyContactName: "Bob", emergencyContactPhone: "07700900000", emergencyContactRelation: "Spouse" });
  });

  it("returns the waiver already signed instead of a second copy", async () => {
    m.waiverFindFirst.mockResolvedValue({ id: "sw-first" });
    const res = await signForChild(req("http://localhost/api/waiver/sign-for-child", body));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ replayed: true, signedWaiverId: "sw-first" });
    expect(m.waiverCreate).not.toHaveBeenCalled();
    expect(m.waiverFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t-A", memberId: "kid-1", collectedBy: "par-1", requestId: "gsig-12345678" } }),
    );
  });

  it("writes the request id on the first signature", async () => {
    const res = await signForChild(req("http://localhost/api/waiver/sign-for-child", body));
    expect(res.status).toBe(201);
    expect(m.waiverCreate.mock.calls[0][0].data.requestId).toBe("gsig-12345678");
  });
});
