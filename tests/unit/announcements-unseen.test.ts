import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockFindMany, mockFindUnique, mockUpdateMany } = vi.hoisted(() => ({
  mockFindMany:  vi.fn(),
  mockFindUnique: vi.fn(),
  mockUpdateMany: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    announcement: { findMany: mockFindMany },
    member: {
      findUnique: mockFindUnique,
      updateMany: mockUpdateMany,
    },
  },
}));

vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  }),
}));

import { auth } from "@/auth";
import { GET } from "@/app/api/announcements/route";
import { POST } from "@/app/api/member/me/mark-announcements-seen/route";

const mockAuth = vi.mocked(auth);

beforeEach(() => vi.clearAllMocks());

// Shared announcement fixtures
const earlier = new Date("2026-01-01T00:00:00Z");
const later   = new Date("2026-06-01T00:00:00Z");

const ann1 = { id: "a1", title: "Old", body: "body", pinned: false, imageUrl: null, createdAt: earlier };
const ann2 = { id: "a2", title: "New", body: "body", pinned: false, imageUrl: null, createdAt: later };

// ─── GET /api/announcements unseen logic ──────────────────────────────────────

describe("GET /api/announcements — unseen flag", () => {
  it("member with no lastSeenAt: all announcements have unseen=true", async () => {
    mockAuth.mockResolvedValue({
      user: { role: "member", tenantId: "t1", memberId: "m-1" },
    } as never);
    mockFindMany.mockResolvedValue([ann1, ann2]);
    mockFindUnique.mockResolvedValue({ lastAnnouncementSeenAt: null });

    const res = await GET(new Request("http://localhost/api/announcements"));
    const body = await res.json();

    expect(body.announcements).toHaveLength(2);
    expect(body.announcements[0].unseen).toBe(true);
    expect(body.announcements[1].unseen).toBe(true);
  });

  it("member with lastSeenAt=X: announcements before X are unseen=false, after X are unseen=true", async () => {
    const seenAt = new Date("2026-03-01T00:00:00Z"); // between earlier and later
    mockAuth.mockResolvedValue({
      user: { role: "member", tenantId: "t1", memberId: "m-1" },
    } as never);
    mockFindMany.mockResolvedValue([ann1, ann2]);
    mockFindUnique.mockResolvedValue({ lastAnnouncementSeenAt: seenAt });

    const res = await GET(new Request("http://localhost/api/announcements"));
    const body = await res.json();

    const old = body.announcements.find((a: { id: string }) => a.id === "a1");
    const newAnn = body.announcements.find((a: { id: string }) => a.id === "a2");
    expect(old.unseen).toBe(false);   // earlier < seenAt
    expect(newAnn.unseen).toBe(true); // later > seenAt
  });

  it("staff caller: all announcements have unseen=false", async () => {
    mockAuth.mockResolvedValue({
      user: { role: "owner", tenantId: "t1" },
    } as never);
    mockFindMany.mockResolvedValue([ann1, ann2]);

    const res = await GET(new Request("http://localhost/api/announcements"));
    const body = await res.json();

    expect(body.announcements[0].unseen).toBe(false);
    expect(body.announcements[1].unseen).toBe(false);
    // member lookup should NOT be called for staff
    expect(mockFindUnique).not.toHaveBeenCalled();
  });
});

// ─── POST /api/member/me/mark-announcements-seen ──────────────────────────────

describe("POST /api/member/me/mark-announcements-seen", () => {
  it("calls updateMany with session memberId and tenantId", async () => {
    mockAuth.mockResolvedValue({
      user: { role: "member", tenantId: "t1", memberId: "m-1" },
    } as never);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: { id: "m-1", tenantId: "t1" },
      data: { lastAnnouncementSeenAt: expect.any(Date) },
    });
  });

  it("ignores any request body — uses only session memberId", async () => {
    // POST() takes no arguments — body is structurally inaccessible.
    // Assert updateMany is called with session's m-1, not attacker's m-2.
    mockAuth.mockResolvedValue({
      user: { role: "member", tenantId: "t1", memberId: "m-1" },
    } as never);
    mockUpdateMany.mockResolvedValue({ count: 1 });

    const res = await POST();
    expect(res.status).toBe(200);
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m-1", tenantId: "t1" } }),
    );
    expect(mockUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "m-2", tenantId: "t1" } }),
    );
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await POST();
    expect(res.status).toBe(401);
  });

  it("returns 400 when session has no memberId", async () => {
    mockAuth.mockResolvedValue({
      user: { role: "staff", tenantId: "t1", memberId: undefined },
    } as never);
    const res = await POST();
    expect(res.status).toBe(400);
  });
});
