// Campaign lane L-B, J62: `startDate` was typed `z.string().min(1)`, so any
// non-empty string passed validation and was handed straight to `new Date()`.
// "not-a-date" became an Invalid Date, Prisma rejected it, and the bare catch
// answered 500 "Failed to create initiative" — with no `apiError`, so no
// reference was minted and nothing reached the owner's diagnostics. A body the
// caller got wrong is a 400.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { create, updateMany, findFirst } = vi.hoisted(() => ({
  create: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: { initiative: { create, updateMany, findFirst } },
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

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));

import { POST } from "@/app/api/initiatives/route";
import { PATCH } from "@/app/api/initiatives/[id]/route";

function post(body: unknown) {
  return POST(
    new Request("http://localhost:3847/api/initiatives", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3847" },
      body: JSON.stringify(body),
    }),
  );
}

function patch(body: unknown) {
  return PATCH(
    new Request("http://localhost:3847/api/initiatives/i-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3847" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "i-1" }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  create.mockResolvedValue({ id: "i-1", type: "other", attachments: [] });
  updateMany.mockResolvedValue({ count: 1 });
  findFirst.mockResolvedValue({ id: "i-1", type: "other", attachments: [] });
});

describe("initiative dates are validated, not handed raw to new Date()", () => {
  it.each([
    ["a non-date string", "not-a-date"],
    ["a sentence", "next Tuesday"],
    ["an empty string", ""],
    ["a number", 20260101],
  ])("POST refuses %s with 400, never 500", async (_label, startDate) => {
    const res = await post({ type: "other", startDate });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST refuses an end date before the start date", async () => {
    const res = await post({ type: "other", startDate: "2026-01-02", endDate: "2026-01-01" });
    expect(res.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("PATCH refuses a malformed date with 400, never 500", async () => {
    const res = await patch({ startDate: "not-a-date" });
    expect(res.status).toBe(400);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("still accepts a real date", async () => {
    const res = await post({ type: "marketing", startDate: "2026-01-02T00:00:00.000Z" });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
