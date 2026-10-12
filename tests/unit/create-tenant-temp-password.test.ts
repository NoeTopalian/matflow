/**
 * Review of lane I, finding D-I2 (6 Oct 2026, Medium).
 *
 * POST /api/admin/create-tenant takes an OPERATOR-CHOSEN owner password. It used
 * to write it as an ordinary password (no mustChangePassword, no expiry), so the
 * operator could sign in as the new owner, enrol an authenticator and leave
 * every piece of evidence the activation verdict asks for. The owner it creates
 * now carries a temporary password (mustChangePassword + the 72-hour
 * tempPasswordExpiresAt from lib/temp-password.ts), and the audit row names the
 * owner it created so scripts/readiness/activation-verdict.mjs can treat it as
 * an operator-issued credential (tests/unit/activation-verdict-operator-created.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const st = vi.hoisted(() => ({
  createArgs: null as null | { data: Record<string, unknown> },
  audit: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) =>
    fn({
      tenant: {
        create: async (args: { data: Record<string, unknown> }) => {
          st.createArgs = args;
          return { id: "t-new", slug: args.data.slug, name: args.data.name, users: [{ id: "u-new-owner", email: "owner@example.test", role: "owner" }] };
        },
      },
    }),
  withTenantContext: vi.fn(),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: async () => ({ authed: true, named: true, operatorId: "op_1", operatorEmail: "op@example.test" }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (a: Record<string, unknown>) => { st.audit.push(a); }) }));

import { POST } from "@/app/api/admin/create-tenant/route";
import { TEMP_PASSWORD_TTL_MS } from "@/lib/temp-password";

function req() {
  return new Request("http://localhost/api/admin/create-tenant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      gymName: "Example BJJ",
      slug: "example-bjj",
      ownerName: "Owner",
      ownerEmail: "owner@example.test",
      ownerPassword: "OperatorChose123",
    }),
  });
}

beforeEach(() => {
  st.createArgs = null;
  st.audit = [];
});

describe("create-tenant: the operator-chosen owner password is temporary", () => {
  it("the owner it creates must change the password, within the temporary-password window", async () => {
    const before = Date.now();
    const res = await POST(req());
    expect(res.status).toBe(201);
    const users = st.createArgs!.data.users as { create: Record<string, unknown> };
    expect(users.create.mustChangePassword).toBe(true);
    const exp = users.create.tempPasswordExpiresAt as Date;
    expect(exp).toBeInstanceOf(Date);
    expect(exp.getTime()).toBeGreaterThanOrEqual(before + TEMP_PASSWORD_TTL_MS);
    expect(exp.getTime()).toBeLessThanOrEqual(Date.now() + TEMP_PASSWORD_TTL_MS);
  });

  it("the audit row names the owner it created (the activation verdict reads it)", async () => {
    await POST(req());
    const row = st.audit.find((a) => a.action === "admin.tenant.create")!;
    expect(row).toBeDefined();
    expect(row.metadata).toMatchObject({ ownerUserId: "u-new-owner", ownerPasswordChosenBy: "operator" });
  });
});
