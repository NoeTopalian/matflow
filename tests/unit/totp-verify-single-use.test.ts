/**
 * /api/auth/totp/verify spends each code once (7 Oct 2026, handover lane P
 * residual). The code that completed a sign-in must not be accepted a second
 * time inside its 30-second window — on this or another instance — for
 * example to confirm a login-email change.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { generateSecret, generateSync } from "otplib";

const SECRET = generateSecret();
const h = vi.hoisted(() => ({
  row: { id: "u1", totpSecret: "", totpEnabled: true, totpLastUsedStep: null as number | null },
}));

vi.mock("next-auth/jwt", () => ({
  getToken: vi.fn(async () => ({ id: "u1", tenantId: "t1", totpPending: true })),
  encode: vi.fn(async () => "encoded"),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => "203.0.113.9"),
}));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret" }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) =>
    fn({
      user: {
        findUnique: async () => ({ ...h.row }),
        // Mirrors the conditional update in consumeUserTotp.
        updateMany: async ({ where, data }: { where: { OR: Array<{ totpLastUsedStep: null | { lt: number } }> }; data: { totpLastUsedStep: number } }) => {
          void where;
          const last = h.row.totpLastUsedStep;
          if (last === null || last < data.totpLastUsedStep) {
            h.row.totpLastUsedStep = data.totpLastUsedStep;
            return { count: 1 };
          }
          return { count: 0 };
        },
      },
    }),
}));

import { POST } from "@/app/api/auth/totp/verify/route";

function req(code: string) {
  return new Request("http://localhost/api/auth/totp/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ code }),
  }) as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  h.row = { id: "u1", totpSecret: SECRET, totpEnabled: true, totpLastUsedStep: null };
});

// SF-37 (lane A2): the route now asks the revocation question first; this
// file is about single use, so the session is live here.
// tests/integration/sec-a2-verify-disown-db.test.ts drives the gate for real.
vi.mock("@/lib/auth-pending-gate", () => ({ refuseRevokedPendingToken: async () => null }));

describe("POST /api/auth/totp/verify — single-use codes", () => {
  it("accepts a valid code once", async () => {
    const res = await POST(req(generateSync({ secret: SECRET })));
    expect(res.status).toBe(200);
    expect(h.row.totpLastUsedStep).not.toBeNull();
  });

  it("refuses the same code a second time", async () => {
    const code = generateSync({ secret: SECRET });
    expect((await POST(req(code))).status).toBe(200);
    const again = await POST(req(code));
    expect(again.status).toBe(400);
  });

  it("refuses a wrong code without spending anything", async () => {
    const res = await POST(req("000000" === generateSync({ secret: SECRET }) ? "111111" : "000000"));
    expect(res.status).toBe(400);
    expect(h.row.totpLastUsedStep).toBeNull();
  });
});
