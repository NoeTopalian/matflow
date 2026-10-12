/**
 * Security lane D (9 Oct 2026) — lane C SF-C5 in lane D's file:
 * app/api/admin/import/attendance POST must answer 400 (not 500) to a JSON body
 * that is not an object — null, an array, a string, a number — and must not
 * touch the database or the rate limiter's import paths for it. Positive
 * control: an object with an unknown action reaches dispatch (400 "Unknown action").
 */
import { vi, describe, it, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: "t_secd", userId: "u_secd", session: {} })) }));
const tenantCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async () => { tenantCalls.n += 1; throw new Error("database must not be reached"); }),
  withRlsBypass: vi.fn(async () => { tenantCalls.n += 1; throw new Error("database must not be reached"); }),
}));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => null) }));

import { POST } from "@/app/api/admin/import/attendance/route";

const call = async (raw: string) => {
  const res = (await POST(new Request("http://localhost/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: raw }))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
};

describe("attendance import route — JSON body shape (SF-C5)", () => {
  it.each(["null", "[]", '["commit"]', '"commit"', "42", "true"])("body %s → 400, database untouched", async (raw) => {
    tenantCalls.n = 0;
    const r = await call(raw);
    expect(r.status).toBe(400);
    expect(tenantCalls.n).toBe(0);
  });

  it("POSITIVE CONTROL: an object reaches dispatch (unknown action → 400 'Unknown action')", async () => {
    const r = await call('{"action":"nope"}');
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("Unknown action");
  });
});
