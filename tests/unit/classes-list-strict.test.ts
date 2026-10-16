import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * GET /api/classes?strict=1 (onboarding batch 1, 16 Oct 2026). The setup
 * wizard decides from this list whether a class whose save got no answer was
 * made anyway, so an empty list must mean "no classes": a read failure is
 * answered as a failure for it. Other callers keep the old empty-list answer.
 */

const h = vi.hoisted(() => ({ fail: false }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: "u1", tenantId: "t1", role: "owner" } }) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => {
    if (h.fail) throw new Error("connection terminated");
    return fn({ class: { findMany: async () => [{ id: "c1", name: "Fundamentals" }] } });
  },
}));

import { GET } from "@/app/api/classes/route";

beforeEach(() => { h.fail = false; });

describe("GET /api/classes strict mode", () => {
  it("answers a read failure as 503 when strict=1", async () => {
    h.fail = true;
    const res = await GET(new Request("http://localhost/api/classes?strict=1"));
    expect(res.status).toBe(503);
  });

  it("keeps the empty-list answer for other callers", async () => {
    h.fail = true;
    const res = await GET(new Request("http://localhost/api/classes"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns the list either way when the read works", async () => {
    for (const url of ["http://localhost/api/classes?strict=1", "http://localhost/api/classes"]) {
      const res = await GET(new Request(url));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([{ id: "c1", name: "Fundamentals" }]);
    }
  });
});
