import { vi, describe, it, expect, beforeEach } from "vitest";

// ── Mocks ──────────────────────────────────────────────────────────────────────

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
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  })),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit-log";

const mockAuth = vi.mocked(auth);
const mockFindFirst = vi.mocked(prisma.member.findFirst);
const mockFindMany = vi.mocked(prisma.member.findMany);
const mockUpdateMany = vi.mocked(prisma.member.updateMany);
const mockCreate = vi.mocked(prisma.member.create);
const mockLogAudit = vi.mocked(logAudit);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeReq(body: unknown, url = "http://localhost/api/members/parent-1/link-child") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const ownerSession = (tenantId: string) => ({
  user: { id: "user-1", role: "owner", tenantId, name: "Owner", memberId: "parent-1" },
});

const memberSession = (tenantId: string, memberId = "parent-1") => ({
  user: { id: "user-1", role: "member", tenantId, name: "Member", memberId },
});

// ── Test 1: cross-tenant child read 404 ────────────────────────────────────────

describe("GET /api/member/children/[id] — cross-tenant", () => {
  it("returns 404 when child belongs to a different tenant", async () => {
    const { GET } = await import("@/app/api/member/children/[id]/route");
    mockAuth.mockResolvedValue(memberSession("tenant-A") as never);
    mockFindFirst.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "child-from-tenant-B" }) });
    expect(res.status).toBe(404);
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-A" }),
    }));
  });
});

// ── Test 2: cross-parent child read 404 ────────────────────────────────────────

describe("GET /api/member/children/[id] — cross-parent", () => {
  it("returns 404 when parent X tries to fetch parent Y's kid (same tenant)", async () => {
    const { GET } = await import("@/app/api/member/children/[id]/route");
    mockAuth.mockResolvedValue(memberSession("tenant-A", "parent-X") as never);
    mockFindFirst.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "kid-of-Y" }) });
    expect(res.status).toBe(404);
    expect(mockFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ parentMemberId: "parent-X" }),
    }));
  });
});

// ── Test 3: link-child role gates ──────────────────────────────────────────────

describe("POST /api/members/[id]/link-child — role gates", () => {
  it("rejects member-role with 403", async () => {
    const { POST } = await import("@/app/api/members/[id]/link-child/route");
    mockAuth.mockResolvedValue(memberSession("tenant-A") as never);

    const res = await POST(makeReq({ childMemberId: "child-1" }), { params: Promise.resolve({ id: "parent-1" }) });
    expect(res.status).toBe(403);
    expect(mockFindFirst).not.toHaveBeenCalled();
  });

  it("rejects manager (non-owner) with 403", async () => {
    const { POST } = await import("@/app/api/members/[id]/link-child/route");
    mockAuth.mockResolvedValue({
      user: { id: "u-1", role: "manager", tenantId: "tenant-A", name: "M" },
    } as never);

    const res = await POST(makeReq({ childMemberId: "child-1" }), { params: Promise.resolve({ id: "parent-1" }) });
    expect(res.status).toBe(403);
  });
});

// ── Test 4: link rejects when child already has parentMemberId ─────────────────

describe("POST /api/members/[id]/link-child — already-linked child", () => {
  it("returns 404 when child has parentMemberId already set", async () => {
    const { POST } = await import("@/app/api/members/[id]/link-child/route");
    mockAuth.mockResolvedValue(ownerSession("tenant-A") as never);

    // Parent exists and is top-level
    mockFindFirst.mockResolvedValueOnce({ id: "parent-1", parentMemberId: null } as never);
    // Child lookup returns null because findFirst filters parentMemberId=null
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ childMemberId: "already-linked" }), { params: Promise.resolve({ id: "parent-1" }) });
    expect(res.status).toBe(404);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });
});

// ── Test 5: passwordHash IS NULL invariant ─────────────────────────────────────

describe("POST /api/members/[id]/link-child — passwordless invariant", () => {
  it("rejects when child has a passwordHash (loginable adult)", async () => {
    const { POST } = await import("@/app/api/members/[id]/link-child/route");
    mockAuth.mockResolvedValue(ownerSession("tenant-A") as never);

    mockFindFirst.mockResolvedValueOnce({ id: "parent-1", parentMemberId: null } as never);
    // Child lookup filters passwordHash:null — adult with passwordHash returns null here
    mockFindFirst.mockResolvedValueOnce(null);

    const res = await POST(makeReq({ childMemberId: "adult-with-password" }), { params: Promise.resolve({ id: "parent-1" }) });
    expect(res.status).toBe(404);

    // Confirm WHERE clause includes passwordHash: null
    expect(mockFindFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ passwordHash: null }),
    }));
  });
});

// ── Test 6: unlink does NOT delete the child Member ────────────────────────────

describe("DELETE /api/members/[id]/unlink-child — non-destructive", () => {
  it("nulls parentMemberId, never deletes the child row", async () => {
    const { DELETE } = await import("@/app/api/members/[id]/unlink-child/route");
    mockAuth.mockResolvedValue(ownerSession("tenant-A") as never);
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);

    const req = new Request("http://localhost/x", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childMemberId: "child-1" }),
    });
    const res = await DELETE(req, { params: Promise.resolve({ id: "parent-1" }) });
    expect(res.status).toBe(200);

    // updateMany must set parentMemberId: null
    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "child-1",
        tenantId: "tenant-A",
        parentMemberId: "parent-1",
      }),
      data: { parentMemberId: null },
    }));
  });
});

// ── Test 7: hasKidsHint PATCH whitelist ────────────────────────────────────────

describe("PATCH /api/member/me — hasKidsHint whitelist", () => {
  it("persists hasKidsHint:true when the body includes it", async () => {
    const { PATCH } = await import("@/app/api/member/me/route");
    mockAuth.mockResolvedValue(memberSession("tenant-A", "member-1") as never);
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);

    const req = new Request("http://localhost/api/member/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hasKidsHint: true }),
    });
    const res = await PATCH(req);
    expect(res.status).toBe(200);

    expect(mockUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ hasKidsHint: true }),
    }));
  });
});

// ── Test 8: audit metadata includes both IDs ───────────────────────────────────

describe("Audit metadata", () => {
  it("link.child logs both parentMemberId and childMemberId", async () => {
    const { POST } = await import("@/app/api/members/[id]/link-child/route");
    mockAuth.mockResolvedValue(ownerSession("tenant-A") as never);
    mockFindFirst.mockResolvedValueOnce({ id: "parent-1", parentMemberId: null } as never);
    mockFindFirst.mockResolvedValueOnce({ id: "child-1" } as never);
    mockUpdateMany.mockResolvedValue({ count: 1 } as never);

    await POST(makeReq({ childMemberId: "child-1" }), { params: Promise.resolve({ id: "parent-1" }) });

    expect(mockLogAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "member.link.child",
      metadata: { parentMemberId: "parent-1", childMemberId: "child-1" },
    }));
  });
});

// ── Test 9: synthesised kid email format ───────────────────────────────────────

describe("Synthesised kid email format", () => {
  it("matches kid-{nanoid}@no-login.matflow.local (no tenantId leak)", async () => {
    const { POST } = await import("@/app/api/members/route");
    mockAuth.mockResolvedValue(ownerSession("tenant-A") as never);
    mockFindFirst.mockResolvedValueOnce({ id: "parent-1", parentMemberId: null } as never);
    mockCreate.mockImplementation(async ({ data }: { data: { email: string; passwordHash: string | null; parentMemberId: string | null; accountType: string } }) => ({
      id: "kid-1",
      ...data,
    } as never));

    const req = new Request("http://localhost/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Lily",
        accountType: "kids",
        parentMemberId: "parent-1",
        dateOfBirth: "2017-05-12",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(201);

    const created = mockCreate.mock.calls[0][0].data as { email: string; passwordHash: string | null; parentMemberId: string | null; accountType: string };
    expect(created.email).toMatch(/^kid-[a-f0-9]+@no-login\.matflow\.local$/);
    expect(created.email).not.toContain("tenant-A"); // P1 fix: no tenantId leak
    expect(created.passwordHash).toBeNull();          // passwordless invariant
    expect(created.parentMemberId).toBe("parent-1");
    expect(created.accountType).toBe("kids");
  });
});

// ── Test 10: hierarchy depth cap ───────────────────────────────────────────────

describe("Hierarchy depth cap", () => {
  it("rejects link when target parent already has parentMemberId set", async () => {
    const { POST } = await import("@/app/api/members/[id]/link-child/route");
    mockAuth.mockResolvedValue(ownerSession("tenant-A") as never);
    // Parent is itself a sub-account
    mockFindFirst.mockResolvedValueOnce({ id: "parent-but-also-child", parentMemberId: "grandparent" } as never);

    const res = await POST(makeReq({ childMemberId: "child-1" }), { params: Promise.resolve({ id: "parent-but-also-child" }) });
    expect(res.status).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("rejects POST /api/members kid creation when parent itself has a parent", async () => {
    const { POST } = await import("@/app/api/members/route");
    mockAuth.mockResolvedValue(ownerSession("tenant-A") as never);
    mockFindFirst.mockResolvedValueOnce({ id: "p", parentMemberId: "grandparent" } as never);

    const req = new Request("http://localhost/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Lily",
        accountType: "kids",
        parentMemberId: "p",
        dateOfBirth: "2017-05-12",
      }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
