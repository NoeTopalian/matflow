import { vi, describe, it, expect, beforeEach } from "vitest";

// Lane 1 iter-1 CSRF-sweep follow-up (matches announcement-auth.test.ts):
// short-circuit the guard so test Requests (no browser-set Origin) don't 403.
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

const { mockUpdateMany, mockFindFirst } = vi.hoisted(() => ({
  mockUpdateMany: vi.fn(),
  mockFindFirst: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    announcement: {
      updateMany: mockUpdateMany,
      findFirst: mockFindFirst,
    },
  },
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async () => ({})),
}));

import { auth } from "@/auth";
import { PATCH } from "@/app/api/announcements/[id]/route";

const mockAuth = vi.mocked(auth);
const params = Promise.resolve({ id: "ann-1" });

function makeReq(body: unknown) {
  return new Request("http://localhost/api/announcements/ann-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "t1", id: "u1" } } as never);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockFindFirst.mockResolvedValue({ id: "ann-1", pinned: false, expiresAt: null });
});

describe("PATCH /api/announcements/[id] — durationDays extend + pinned", () => {
  it("a numeric durationDays recomputes expiresAt from NOW, not from whatever it already was", async () => {
    const before = Date.now();

    const res = await PATCH(makeReq({ durationDays: 14 }), { params });

    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledTimes(1);
    const written = mockUpdateMany.mock.calls[0][0].data.expiresAt as Date;
    expect(written).toBeInstanceOf(Date);
    const daysFromNow = (written.getTime() - before) / (24 * 60 * 60 * 1000);
    // "Extend" is absolute-from-now, not additive on top of the existing
    // expiresAt — assert the invariant on the offset, not a literal timestamp.
    expect(daysFromNow).toBeGreaterThan(13.99);
    expect(daysFromNow).toBeLessThan(14.01);
  });

  it("durationDays: null clears expiresAt back to permanent", async () => {
    await PATCH(makeReq({ durationDays: null }), { params });

    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data.expiresAt).toBeNull();
  });

  it("omitting durationDays entirely leaves expiresAt untouched (not nulled, not recomputed)", async () => {
    await PATCH(makeReq({ pinned: true }), { params });

    const data = mockUpdateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("expiresAt");
    expect(data.pinned).toBe(true);
  });

  it("pinned: true pins", async () => {
    const res = await PATCH(makeReq({ pinned: true }), { params });
    expect(res.status).toBe(200);
    expect(mockUpdateMany.mock.calls[0][0].data.pinned).toBe(true);
  });

  it("pinned: false unpins — previously impossible since the schema had no field for it", async () => {
    const res = await PATCH(makeReq({ pinned: false }), { params });
    expect(res.status).toBe(200);
    expect(mockUpdateMany.mock.calls[0][0].data.pinned).toBe(false);
  });

  it("rejects durationDays outside 1..365", async () => {
    const res = await PATCH(makeReq({ durationDays: 400 }), { params });
    expect(res.status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("forbids a non-manager role (coach)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "coach", tenantId: "t1", id: "u1" } } as never);
    const res = await PATCH(makeReq({ pinned: true }), { params });
    expect(res.status).toBe(403);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("returns 401 when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await PATCH(makeReq({ pinned: true }), { params });
    expect(res.status).toBe(401);
  });
});
