/**
 * Refused-attempt logging for support edit sessions (assurance plan G2, 14 Oct
 * 2026). A field-policy refusal writes ONE operator-plane audit row (tenantId
 * null, entity = operator digest) carrying the route pattern and the refused
 * FIELD NAMES only — never a submitted value; a permitted request writes no
 * such row; an ordinary owner request writes none either.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

const m = vi.hoisted(() => ({
  logAudit: vi.fn(async () => {}),
  memberUpdateMany: vi.fn(async () => ({ count: 1 })),
  memberFindFirst: vi.fn(async () => null as unknown),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: m.logAudit }));
vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "test-secret-000000" }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })), getClientIp: () => "203.0.113.9" }));
vi.mock("@/lib/membership-tier", () => ({ resolveMembershipTier: vi.fn(async () => null), membershipTierWrite: () => ({}) }));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/login-email", () => ({
  LoginIdentityTaken: class LoginIdentityTaken extends Error {},
  claimLoginIdentity: vi.fn(async () => ({ kind: "none" })),
  emailDigest: vi.fn(() => "digest"),
  retireEmailBoundTokens: vi.fn(async () => {}),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: m.memberFindFirst, updateMany: m.memberUpdateMany, findMany: vi.fn(async () => []), count: vi.fn(async () => 0) },
      memberStatusEvent: { create: vi.fn(async () => ({})) },
      $queryRaw: vi.fn(async () => []),
    }),
  withRlsBypass: vi.fn(),
}));

import { PATCH as memberPatch } from "@/app/api/members/[id]/route";
import { auth } from "@/auth";
import { SUPPORT_REFUSAL_ACTION } from "@/lib/support-refusal-audit";

const mockAuth = vi.mocked(auth);
const base = { id: "u-owner", tenantId: "t-A", role: "owner", email: "o@x.test", name: "O" };
const editSession = { user: { ...base, impersonatedBy: "op_secret_id_1", supportScope: "edit" } };
const ownerSession = { user: base };
const req = (body: unknown): Request =>
  ({ url: "https://x/api/members/m-1", headers: new Headers({ "content-type": "application/json" }), json: async () => body }) as unknown as Request;
const params = { params: Promise.resolve({ id: "m-1" }) };
const refusalRows = () =>
  (m.logAudit.mock.calls as unknown as Array<[Record<string, unknown>]>).map((c) => c[0]).filter((r) => r.action === SUPPORT_REFUSAL_ACTION);

beforeEach(() => vi.clearAllMocks());

describe("support.edit.refused rows", () => {
  it("a refusal writes one operator-plane row with field NAMES only, no values, no operator id in the clear", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await memberPatch(req({ name: "Keep", status: "cancelled", email: "secret-value@example.test" }), params);
    expect(res.status).toBe(403);
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.tenantId).toBeNull();
    expect(row.entityType).toBe("Operator");
    expect(String(row.entityId)).toMatch(/^opd_[0-9a-f]{32}$/);
    expect(String(row.entityId)).not.toContain("op_secret_id_1");
    const meta = row.metadata as { route: string; refusedFields: string[]; targetTenantId: string; scope: string };
    expect(meta.route).toBe("PATCH /api/members/[id]");
    expect(meta.refusedFields.sort()).toEqual(["email", "status"]);
    expect(meta.targetTenantId).toBe("t-A");
    expect(meta.scope).toBe("edit");
    expect(JSON.stringify(row)).not.toContain("cancelled");
    expect(JSON.stringify(row)).not.toContain("secret-value");
    expect(m.memberUpdateMany).not.toHaveBeenCalled();
  });

  it("a permitted edit-session request writes no refusal row", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await memberPatch(req({ phone: "07700900123" }), params);
    expect(res.status).not.toBe(403);
    expect(refusalRows()).toHaveLength(0);
  });

  it("an owner request with the same body writes no refusal row (not a support session)", async () => {
    mockAuth.mockResolvedValue(ownerSession as never);
    m.memberFindFirst.mockResolvedValueOnce({ email: "a@x.test", status: "active", stripeSubscriptionId: null } as never);
    await memberPatch(req({ status: "inactive" }), params);
    expect(refusalRows()).toHaveLength(0);
  });

  it("refused field names are bounded and identifier-shaped (M-3): a hostile key cannot bloat the row", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const hostile = "x".repeat(5000);
    const res = await memberPatch(req({ [hostile]: 1, "weird key with spaces": 2, status: "cancelled" }), params);
    expect(res.status).toBe(403);
    const meta = refusalRows()[0].metadata as { refusedFields: string[] };
    expect(meta.refusedFields).toEqual(["<invalid>", "<invalid>", "status"]);
    expect(JSON.stringify(refusalRows()[0]).length).toBeLessThan(2000);
  });

  it("an audit-write failure never turns the refusal into a 500", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    m.logAudit.mockRejectedValueOnce(new Error("db down"));
    const res = await memberPatch(req({ status: "cancelled" }), params);
    expect(res.status).toBe(403);
  });
});
