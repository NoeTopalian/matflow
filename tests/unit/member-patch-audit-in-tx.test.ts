import { vi, describe, it, expect, beforeEach } from "vitest";
import { addLoginClaimSql } from "./login-claim-fake";

/**
 * Admin hub AH-H1/H2 (9 Oct 2026) — the staff member PATCH's main audit row.
 *
 * Before: the `member.update` row was written AFTER the transaction committed
 * (best-effort), so a change could land with no record of it; and the row's
 * `changes` block carried the member's old and new login address in clear
 * (undo depended on it). Now the row is written INSIDE the transaction — an
 * audit failure rolls the change back — and a login-address change appears
 * only as keyed digests, the way PATCH /api/staff/[id] records it.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { findFirstMock, updateManyMock, tenantFindMock, logAuditMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
  tenantFindMock: vi.fn(),
  logAuditMock: vi.fn(async () => {}),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: findFirstMock, updateMany: updateManyMock },
    tenant: { findUnique: tenantFindMock },
    passwordResetToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    magicLinkToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
  },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(addLoginClaimSql(prisma));
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/totp-immutable", () => ({ stripTotpFields: (b: unknown) => b }));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: true, cancelAt: null })),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn().mockReturnValue("203.0.113.9"),
}));

import { PATCH } from "@/app/api/members/[id]/route";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);
const params = Promise.resolve({ id: "mem-1" });
const OLD = "old.address@example.com";
const NEW = "new.address@example.com";

function patchReq(body: object) {
  return new Request("http://localhost/api/members/mem-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The one `member.update` audit call. */
type AuditArgs = { action: string; tx?: unknown; metadata: Record<string, unknown> };
function auditCall(): AuditArgs {
  const calls = (logAuditMock.mock.calls as unknown as AuditArgs[][]).filter((c) => c[0].action === "member.update");
  expect(calls, "exactly one member.update audit row").toHaveLength(1);
  return calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "u1", role: "owner", tenantId: "t-A" },
  } as unknown as Awaited<ReturnType<typeof auth>>);
  tenantFindMock.mockResolvedValue({ stripeAccountId: null });
  // The row as the route sees it: the before-read and the post-update
  // re-fetch both go through findFirst, so the fake carries state across the
  // write. Holder reads for the claim (`where.email`) find nobody.
  const row: Record<string, unknown> = {
    id: "mem-1", email: OLD, status: "active", stripeSubscriptionId: null,
    name: "Alex", phone: null, membershipType: null, paymentStatus: "paid",
    emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
    dateOfBirth: null, nextDueAt: null, updatedAt: new Date(), passwordHash: null,
  };
  findFirstMock.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    "email" in args.where ? null : { ...row });
  updateManyMock.mockImplementation(async (args: { data: Record<string, unknown> }) => {
    for (const [k, v] of Object.entries(args.data)) if (typeof v === "string") row[k] = v;
    return { count: 1 };
  });
});

describe("PATCH /api/members/[id] — the audit row is part of the change", () => {
  it("writes the member.update row inside the transaction", async () => {
    const res = await PATCH(patchReq({ name: "Alexandra" }), { params });
    expect(res.status).toBe(200);
    const call = auditCall();
    expect(call.tx, "logAudit received the transaction client").toBe(prisma);
    expect(call.metadata.changes).toEqual({ name: { from: "Alex", to: "Alexandra" } });
    expect(call.metadata.oldEmailSha256).toBeUndefined();
    expect(call.metadata.unverified).toBeUndefined();
  });

  it("an audit failure fails the request — nothing is reported as changed", async () => {
    logAuditMock.mockRejectedValueOnce(new Error("audit insert refused"));
    const res = await PATCH(patchReq({ name: "Alexandra" }), { params });
    expect(res.status).toBe(500);
    // The write and the audit shared one transaction client, so the real
    // transaction rolls the write back with the failed insert.
    expect(auditCall().tx).toBe(prisma);
  });

  it("a login-address change is recorded as digests, never as the addresses", async () => {
    const res = await PATCH(patchReq({ email: NEW }), { params });
    expect(res.status).toBe(200);
    const { metadata } = auditCall();
    const changes = metadata.changes as Record<string, unknown> | undefined;
    expect(changes?.email, "the clear address is not in the diff").toBeUndefined();
    expect(metadata.oldEmailSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.newEmailSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(metadata.oldEmailSha256).not.toBe(metadata.newEmailSha256);
    const serialised = JSON.stringify(metadata);
    expect(serialised).not.toContain(OLD);
    expect(serialised).not.toContain(NEW);
    expect(metadata.unverified).toBe(true);
    expect(metadata.sessionsRevoked).toBe(true);
    const bump = updateManyMock.mock.calls.find((c) => "passwordHash" in (c[0] as { where: Record<string, unknown> }).where);
    expect(bump, "sessions revoked by a conditional update inside the transaction").toBeDefined();
  });
});
