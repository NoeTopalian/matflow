// Campaign lane L-B, J17 / J62: a database failure must not be dressed up as
// an empty collection.
//
// Both of these routes used to answer a caught error with `200 []`. An owner
// whose database blinked was told "this club has no staff" / "no initiatives
// recorded" — and the obvious response to that screen is to re-create what is
// already there. For staff that means `POST /api/staff` answering 409 on every
// address they type, which reads as a second, unrelated fault.
//
// This is the same defect UI-RULES §7 already drove out of the page layer
// (app/dashboard/reports/page.tsx and app/dashboard/memberships/page.tsx both
// carry the note explaining why their empty fallback was removed). The API
// layer kept doing it.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: new Map(Object.entries(init?.headers ?? {})),
      json: async () => body,
    }),
  },
}));

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findMany }, initiative: { findMany } },
}));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u-1", tenantId: "t-A", role: "owner" } }),
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: async () => ({
    ok: true,
    session: { user: { id: "u-1", tenantId: "t-A", role: "owner" } },
    tenantId: "t-A",
    userId: "u-1",
    role: "owner",
  }),
}));

import { GET as staffGET } from "@/app/api/staff/route";
import { GET as initiativesGET } from "@/app/api/initiatives/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("a read failure is an error, never an empty list", () => {
  it("GET /api/staff answers 500, not 200 []", async () => {
    findMany.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    const res = await staffGET();
    const body = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    // The empty array is the specific lie this test exists to prevent.
    expect(Array.isArray(body)).toBe(false);
  });

  it("GET /api/initiatives answers 500, not 200 []", async () => {
    findMany.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    const res = await initiativesGET();
    const body = (await res.json()) as { ok?: boolean; error?: string };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(Array.isArray(body)).toBe(false);
  });

  it("still answers the list when the read succeeds", async () => {
    findMany.mockResolvedValueOnce([{ id: "u-1", name: "Ann", email: "a@x.test", role: "coach" }]);
    const res = await staffGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
});
