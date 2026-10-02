/**
 * Verification for commit 7677687 — administrator-controlled families.
 *
 * These call the real route handlers with a mocked session and a mocked prisma,
 * so the refusals are proven at the route rather than inferred from the helper's
 * unit tests. No database: the e2e proof (plan Task 4) is separate and needs a
 * sound connection.
 *
 * Pattern copied from tests/unit/kids-tenant-scope.test.ts.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

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

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    memberStatusEvent: { create: vi.fn().mockResolvedValue({ id: "evt" }) },
  },
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((message: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: message }),
  })),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth);
const mockFindFirst = vi.mocked(prisma.member.findFirst);
const mockCreate = vi.mocked(prisma.member.create);
const mockUpdate = vi.mocked(prisma.member.update);
const mockCount = vi.mocked(prisma.member.count);

beforeEach(() => {
  vi.clearAllMocks();
});

const memberSession = (memberId = "parent-1") => ({
  user: { id: "user-1", role: "member", tenantId: "tenant-A", name: "Parent", memberId },
});
const ownerSession = () => ({
  user: { id: "user-9", role: "owner", tenantId: "tenant-A", name: "Owner", memberId: "owner-m" },
});
const coachSession = () => ({
  user: { id: "user-8", role: "coach", tenantId: "tenant-A", name: "Coach", memberId: "coach-m" },
});

function jsonReq(body: unknown, method = "POST") {
  return new Request("http://localhost/x", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── A member-made link is SUGGESTED, never confirmed ──────────────────────────

describe("POST /api/member/children", () => {
  it("creates the child with a SUGGESTED link, never a confirmation timestamp", async () => {
    const { POST } = await import("@/app/api/member/children/route");
    mockAuth.mockResolvedValue(memberSession() as never);
    mockFindFirst.mockResolvedValue({ id: "parent-1", parentMemberId: null } as never);
    mockCount.mockResolvedValue(0 as never);
    mockCreate.mockResolvedValue({
      id: "kid-1", name: "Ada", dateOfBirth: null, accountType: "kids",
    } as never);

    const res = await POST(jsonReq({ name: "Ada" }));

    expect(res.status).toBe(201);
    const data = (await res.json()) as { guardianPending?: boolean };
    expect(data.guardianPending, "the portal must be told the link is pending").toBe(true);

    const createArg = mockCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(createArg.data.guardianConfirmedAt, "a member must not confirm their own guardianship").toBeNull();
    expect(createArg.data.guardianSuggestedBy).toBe("member");
    expect(createArg.data.parentMemberId).toBe("parent-1");
  });
});

// ── Forged family fields are REFUSED, not silently dropped ────────────────────

describe("PATCH /api/member/children/[id] — forged fields", () => {
  for (const field of [
    "parentMemberId",
    "accountType",
    "guardianConfirmedAt",
    "guardianSuggestedBy",
    "tenantId",
  ]) {
    it(`refuses a body carrying ${field} and writes nothing`, async () => {
      const { PATCH } = await import("@/app/api/member/children/[id]/route");
      mockAuth.mockResolvedValue(memberSession() as never);

      const res = await PATCH(jsonReq({ name: "Ada", [field]: "x" }, "PATCH"), {
        params: Promise.resolve({ id: "kid-1" }),
      });

      expect(res.status, `${field} must be refused`).toBe(403);
      expect(mockUpdate, `${field} must not reach the database`).not.toHaveBeenCalled();
    });
  }

  it("still allows a permitted edit", async () => {
    const { PATCH } = await import("@/app/api/member/children/[id]/route");
    mockAuth.mockResolvedValue(memberSession() as never);
    mockFindFirst.mockResolvedValue({ id: "kid-1", parentMemberId: "parent-1" } as never);
    mockUpdate.mockResolvedValue({ id: "kid-1", name: "Ada Renamed" } as never);

    const res = await PATCH(jsonReq({ name: "Ada Renamed" }, "PATCH"), {
      params: Promise.resolve({ id: "kid-1" }),
    });

    expect(res.status).not.toBe(403);
  });
});

// ── Removing a child is an administrator action ───────────────────────────────

describe("DELETE /api/member/children/[id] — who may remove", () => {
  it("refuses a member before it reads anything", async () => {
    const { DELETE } = await import("@/app/api/member/children/[id]/route");
    mockAuth.mockResolvedValue(memberSession() as never);

    const res = await DELETE(jsonReq({}, "DELETE"), { params: Promise.resolve({ id: "kid-1" }) });

    expect(res.status).toBe(403);
    expect(mockFindFirst, "refused before any read, so nothing leaks").not.toHaveBeenCalled();
  });

  it("refuses a coach", async () => {
    const { DELETE } = await import("@/app/api/member/children/[id]/route");
    mockAuth.mockResolvedValue(coachSession() as never);

    const res = await DELETE(jsonReq({}, "DELETE"), { params: Promise.resolve({ id: "kid-1" }) });
    expect(res.status).toBe(403);
  });

  it("lets an owner past the authority gate", async () => {
    const { DELETE } = await import("@/app/api/member/children/[id]/route");
    mockAuth.mockResolvedValue(ownerSession() as never);
    mockFindFirst.mockResolvedValue(null as never);

    const res = await DELETE(jsonReq({}, "DELETE"), { params: Promise.resolve({ id: "kid-1" }) });

    // Past the gate: it proceeds to the lookup and 404s on a missing child
    // rather than refusing on authority.
    expect(res.status).not.toBe(403);
    expect(mockFindFirst, "an owner reaches the read").toHaveBeenCalled();
  });
});

// ── The same refusal on the self-service profile route ────────────────────────

describe("PATCH /api/member/me — forged family fields", () => {
  for (const field of ["parentMemberId", "accountType", "guardianConfirmedAt", "tenantId"]) {
    it(`refuses a self-service profile body carrying ${field}`, async () => {
      const { PATCH } = await import("@/app/api/member/me/route");
      mockAuth.mockResolvedValue(memberSession() as never);

      const res = await PATCH(jsonReq({ name: "Me", [field]: "x" }, "PATCH"));

      expect(res.status, `${field} must be refused`).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  }
});
