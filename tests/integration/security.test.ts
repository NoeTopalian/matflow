import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    user: { findFirst: vi.fn(), create: vi.fn(), findMany: vi.fn() },
    member: { findFirst: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
    attendanceRecord: { create: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
    classInstance: { findFirst: vi.fn() },
    passwordResetToken: { updateMany: vi.fn(), create: vi.fn() },
    memberRank: { findFirst: vi.fn() },
    memberClassPack: { findFirst: vi.fn() },
    announcement: { findMany: vi.fn() },
  },
}));
// Sprint 5 US-501: QR check-in requires a valid HMAC token (US-012). Mock the
// verifier so F3 can exercise the tenant-scope branch without forging a real token.
// Don't mock @/lib/rate-limit — F10 forgot-password test depends on the real
// in-memory fallback path (Prisma mock has no rateLimitHit model, so the DB
// path throws and the memory store kicks in correctly).
vi.mock("@/lib/checkin-token", () => ({
  verifyCheckinToken: vi.fn(),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { verifyCheckinToken } from "@/lib/checkin-token";
import { POST as postCheckin } from "@/app/api/checkin/route";
import { GET as getStats } from "@/app/api/dashboard/stats/route";
import { POST as postStaff } from "@/app/api/staff/route";
import { POST as postForgotPassword } from "@/app/api/auth/forgot-password/route";
import { POST as postCheckout } from "@/app/api/member/checkout/route";
import { GET as getMeGym } from "@/app/api/me/gym/route";
import { GET as getSettings } from "@/app/api/settings/route";
import { GET as getAnnouncements } from "@/app/api/announcements/route";

const mockAuth = vi.mocked(auth);
const mockTenantFindUnique = vi.mocked(prisma.tenant.findUnique);
const mockMemberFindFirst = vi.mocked(prisma.member.findFirst);
const mockInstanceFindFirst = vi.mocked(prisma.classInstance.findFirst);
const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockUserCreate = vi.mocked(prisma.user.create);
const mockPrtUpdateMany = vi.mocked(prisma.passwordResetToken.updateMany);
const mockPrtCreate = vi.mocked(prisma.passwordResetToken.create);

beforeEach(() => vi.clearAllMocks());

// ── F3: QR check-in tenant isolation ─────────────────────────────────────────

describe("F3 — QR checkin: memberId must belong to tenant", () => {
  it("returns 404 when memberId belongs to a different tenant", async () => {
    mockAuth.mockResolvedValue(null as never);
    mockTenantFindUnique.mockResolvedValue({ id: "tenant-A" } as never);
    vi.mocked(verifyCheckinToken).mockReturnValue({ memberId: "member-from-tenant-B", tenantId: "tenant-A", exp: Math.floor(Date.now() / 1000) + 300 });
    // Member lookup returns null — memberId is from tenant-B
    mockMemberFindFirst.mockResolvedValue(null);

    const req = new Request("http://localhost/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classInstanceId: "inst-1",
        token: "fake-but-mocked-as-valid",
        checkInMethod: "qr",
        tenantSlug: "tenant-a-gym",
      }),
    });

    const res = await postCheckin(req);
    expect(res.status).toBe(404);
    // Crucially: no attendance record should have been created
    expect(prisma.attendanceRecord.create).not.toHaveBeenCalled();
  });

  it("allows QR checkin when memberId belongs to the correct tenant", async () => {
    mockAuth.mockResolvedValue(null as never);
    mockTenantFindUnique.mockResolvedValue({ id: "tenant-A" } as never);
    vi.mocked(verifyCheckinToken).mockReturnValue({ memberId: "member-a1", tenantId: "tenant-A", exp: Math.floor(Date.now() / 1000) + 300 });
    mockMemberFindFirst.mockResolvedValue({ id: "member-a1", tenantId: "tenant-A" } as never);
    mockInstanceFindFirst.mockResolvedValue({
      id: "inst-1",
      isCancelled: false,
      class: { tenantId: "tenant-A", requiredRankId: null, requiredRank: null, maxRankId: null, maxRank: null },
      date: new Date(),
      startTime: "10:00",
      endTime: "11:00",
    } as never);
    vi.mocked(prisma.member.findUnique as (...args: unknown[]) => unknown).mockResolvedValue({ paymentStatus: "paid", stripeSubscriptionId: "sub_x" } as never);
    vi.mocked(prisma.attendanceRecord.create).mockResolvedValue({ id: "rec-1" } as never);

    const req = new Request("http://localhost/api/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classInstanceId: "inst-1",
        token: "fake-but-mocked-as-valid",
        checkInMethod: "qr",
        tenantSlug: "tenant-a-gym",
      }),
    });

    const res = await postCheckin(req);
    expect(res.status).toBe(201);
  });
});

// ── F8: dashboard/stats role guard ───────────────────────────────────────────

describe("F8 — dashboard/stats: member role returns 403", () => {
  it("returns 403 for member role", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "member" } } as never);
    const res = await getStats();
    expect(res.status).toBe(403);
  });

  it("returns 200 for owner role", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "owner" } } as never);
    vi.mocked(prisma.member.count).mockResolvedValue(0);
    vi.mocked(prisma.attendanceRecord.count).mockResolvedValue(0);
    const res = await getStats();
    expect(res.status).toBe(200);
  });

  it("returns 403 for unauthenticated request (null session)", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await getStats();
    expect(res.status).toBe(401);
  });
});

// ── F5: staff creation response must not include password ────────────────────

describe("F5 — staff creation: no password in response", () => {
  it("response does not contain temporaryPassword or passwordHash", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "owner" } } as never);
    mockUserCreate.mockResolvedValue({
      id: "u1", name: "Test User", email: "test@gym.com", role: "coach", createdAt: new Date(),
    } as never);

    const req = new Request("http://localhost/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test User", email: "test@gym.com", role: "coach" }),
    });

    const res = await postStaff(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).not.toHaveProperty("temporaryPassword");
    expect(body).not.toHaveProperty("passwordHash");
    expect(body).not.toHaveProperty("password");
  });

  it("response includes mustChangePassword: true when no password supplied", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "owner" } } as never);
    mockUserCreate.mockResolvedValue({
      id: "u1", name: "Test User", email: "test@gym.com", role: "coach", createdAt: new Date(),
    } as never);

    const req = new Request("http://localhost/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test User", email: "test@gym.com", role: "coach" }),
    });

    const res = await postStaff(req);
    const body = await res.json();
    expect(body.mustChangePassword).toBe(true);
  });
});

// ── F10: forgot-password rate limiting ───────────────────────────────────────

describe("F10 — forgot-password: rate limiting", () => {
  it("returns 429 after 3 requests for same email within window", async () => {
    mockTenantFindUnique.mockResolvedValue({ id: "t1" } as never);
    mockUserFindFirst.mockResolvedValue(null); // user not found — returns 200 early

    // Use a unique email to avoid collisions with other test runs
    const email = `rl-test-${Math.random().toString(36).slice(2)}@gym.com`;
    const makeRlRequest = () =>
      postForgotPassword(
        new Request("http://localhost/api/auth/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, tenantSlug: "rl-test-gym" }),
        })
      );

    const r1 = await makeRlRequest();
    const r2 = await makeRlRequest();
    const r3 = await makeRlRequest();
    const r4 = await makeRlRequest();

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
    expect((r4.headers as unknown as Record<string, string>)["Retry-After"]).toBeDefined();
  });
});

// ── F4: checkout price validation ────────────────────────────────────────────

describe("F4 — checkout: client-manipulated prices rejected", () => {
  it("returns 400 when item price does not match server price", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1" } } as never);

    const req = new Request("http://localhost/api/member/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "6", name: "Club Hoodie", price: 0.01, quantity: 1 }], // real price is 45
        successUrl: "http://localhost/success",
        cancelUrl: "http://localhost/cancel",
      }),
    }) as never;

    const res = await postCheckout(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid item price");
  });

  it("returns 400 for unknown item id", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1" } } as never);

    const req = new Request("http://localhost/api/member/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{ id: "999", name: "Fake Item", price: 1, quantity: 1 }],
        successUrl: "http://localhost/success",
        cancelUrl: "http://localhost/cancel",
      }),
    }) as never;

    const res = await postCheckout(req);
    expect(res.status).toBe(400);
  });
});

// ── L1: staff/member endpoint boundary regression ───────────────────────────
//
// Pin the public/private surface so future drift is caught:
//  - /api/settings GET is staff-only → 403 for member
//  - /api/me/gym GET is intentionally member-accessible (branding + billing
//    contact for the member portal) → 200
//  - /api/announcements GET is intentionally member-accessible → 200

describe("L1 — staff/member endpoint boundary", () => {
  it("/api/settings GET returns 403 for member role", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "member" } } as never);
    const res = await getSettings();
    expect(res.status).toBe(403);
  });

  it("/api/settings GET returns 200 for owner role", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "owner" } } as never);
    mockTenantFindUnique.mockResolvedValue({
      id: "t1", name: "G", slug: "g", logoUrl: null, logoSize: "md",
      primaryColor: "#000000", secondaryColor: "#000000", textColor: "#ffffff", bgColor: "#000000",
      fontFamily: "Inter", subscriptionStatus: "active", subscriptionTier: "free", createdAt: new Date(),
      _count: { members: 0, users: 0, classes: 0 },
    } as never);
    const res = await getSettings();
    expect(res.status).toBe(200);
  });

  it("/api/me/gym GET returns 200 for member role (branding is intentionally member-readable)", async () => {
    mockAuth.mockResolvedValue({
      user: { tenantId: "t1", role: "member", tenantName: "Gym", primaryColor: "#3b82f6", secondaryColor: "#2563eb", textColor: "#ffffff" },
    } as never);
    mockTenantFindUnique.mockResolvedValue({
      name: "Gym", logoUrl: null,
      primaryColor: "#3b82f6", secondaryColor: "#2563eb", textColor: "#ffffff", bgColor: "#111111",
      fontFamily: "Inter", memberSelfBilling: false,
      billingContactEmail: null, billingContactUrl: null,
      privacyContactEmail: null, privacyPolicyUrl: null,
      instagramUrl: null, facebookUrl: null, tiktokUrl: null, youtubeUrl: null, twitterUrl: null, websiteUrl: null,
    } as never);
    const res = await getMeGym();
    expect(res.status).toBe(200);
    const body = await res.json();
    // Sensitive staff fields must NOT be present in the member-readable shape.
    expect(body).not.toHaveProperty("subscriptionStatus");
    expect(body).not.toHaveProperty("subscriptionTier");
    expect(body).not.toHaveProperty("_count");
  });

  it("/api/announcements GET returns 200 for member role (announcements are intentionally member-readable)", async () => {
    mockAuth.mockResolvedValue({ user: { tenantId: "t1", role: "member", memberId: "m1" } } as never);
    vi.mocked(prisma.announcement.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.member.findUnique as (...args: unknown[]) => unknown).mockResolvedValue({ lastAnnouncementSeenAt: null } as never);
    const res = await getAnnouncements();
    expect(res.status).toBe(200);
  });
});
