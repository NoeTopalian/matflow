/**
 * Lane L-G round 1, defect 1 (and the audit half of defect 2).
 *
 * The defect: `logAudit` stamped `metadata.actingAs` ONLY when a call site
 * passed `actAsUserId`, and only the `app/api/admin/**` sites do. Every
 * ordinary tenant route calls `logAudit` without it, so a member edited, a
 * payment taken or a class cancelled during an impersonated session was
 * recorded in the gym's own log as the owner's own work.
 *
 * The fix: `logAudit` resolves the impersonation claim itself, from the same
 * signed cookie `auth.ts` reads (`lib/impersonation.ts`), so EVERY row written
 * during an impersonated session names the real actor. `auth.ts` is not
 * touched — it is another lane's file this round.
 *
 * Two contracts this file pins that are easy to break later:
 *   - no impersonation → NO `actingAs` key at all (not `null`, not undefined)
 *   - an explicit `actAsUserId` argument WINS over the cookie, so the nine
 *     operator mutations keep stamping the operator id they already resolve
 *   - resolving the claim can never block or fail the audited action
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(),
  withRlsBypass: vi.fn(),
}));

vi.mock("@/lib/impersonation", () => ({
  readImpersonationCookie: vi.fn(),
}));

import { withTenantContext } from "@/lib/prisma-tenant";
import { readImpersonationCookie } from "@/lib/impersonation";
import { logAudit } from "@/lib/audit-log";

const mockedWithTenantContext = vi.mocked(withTenantContext);
const mockedReadImpersonation = vi.mocked(readImpersonationCookie);

/** Run the callback logAudit handed to withTenantContext and return the row. */
async function capturedRow(): Promise<Record<string, unknown>> {
  const call = mockedWithTenantContext.mock.calls[0];
  expect(call, "logAudit reached the database layer").toBeDefined();
  const fn = call[1] as (tx: unknown) => Promise<unknown>;
  const create = vi.fn().mockResolvedValue({});
  await fn({ auditLog: { create } });
  expect(create).toHaveBeenCalledTimes(1);
  return (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedWithTenantContext.mockImplementation((async () => {}) as never);
  mockedReadImpersonation.mockResolvedValue(null);
});

describe("logAudit — impersonation attribution", () => {
  it("stamps metadata.actingAs on an ORDINARY tenant write made during an impersonated session", async () => {
    mockedReadImpersonation.mockResolvedValue({
      adminUserId: "__matflow_super_admin__",
      targetUserId: "owner-1",
      targetTenantId: "tenant-A",
      reason: "support call",
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    // No actAsUserId: exactly how app/api/members, app/api/payments and every
    // other tenant route calls it.
    await logAudit({
      tenantId: "tenant-A",
      userId: "owner-1",
      action: "member.update",
      entityType: "Member",
      entityId: "member-1",
    });

    const row = await capturedRow();
    expect(row.metadata).toEqual({ actingAs: "__matflow_super_admin__" });
  });

  it("merges the attribution into metadata the caller already supplied", async () => {
    mockedReadImpersonation.mockResolvedValue({
      adminUserId: "operator-7",
      targetUserId: "owner-1",
      targetTenantId: "tenant-A",
      reason: "support call",
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    await logAudit({
      tenantId: "tenant-A",
      userId: "owner-1",
      action: "payment.refund",
      entityType: "Payment",
      entityId: "pay-1",
      metadata: { amountPence: 2500 },
    });

    const row = await capturedRow();
    expect(row.metadata).toEqual({ amountPence: 2500, actingAs: "operator-7" });
  });

  it("no impersonation → no actingAs key at all", async () => {
    mockedReadImpersonation.mockResolvedValue(null);

    await logAudit({
      tenantId: "tenant-A",
      userId: "owner-1",
      action: "member.update",
      entityType: "Member",
      entityId: "member-1",
      metadata: { field: "belt" },
    });

    const row = await capturedRow();
    expect(row.metadata).toEqual({ field: "belt" });
    expect(Object.keys(row.metadata as object)).not.toContain("actingAs");
  });

  it("no impersonation and no metadata → metadata stays absent, not an empty object", async () => {
    mockedReadImpersonation.mockResolvedValue(null);

    await logAudit({
      tenantId: "tenant-A",
      userId: "owner-1",
      action: "member.update",
      entityType: "Member",
      entityId: "member-1",
    });

    const row = await capturedRow();
    expect(row.metadata).toBeUndefined();
  });

  it("an explicit actAsUserId WINS over the cookie — the nine operator mutations keep their identity", async () => {
    mockedReadImpersonation.mockResolvedValue({
      adminUserId: "cookie-operator",
      targetUserId: "owner-1",
      targetTenantId: "tenant-A",
      reason: "support call",
      exp: Math.floor(Date.now() / 1000) + 600,
    });

    await logAudit({
      tenantId: "tenant-A",
      userId: "owner-1",
      actAsUserId: "explicit-operator",
      action: "admin.owner.totp_reset",
      entityType: "User",
      entityId: "owner-1",
      metadata: { reason: "lost device" },
    });

    const row = await capturedRow();
    expect(row.metadata).toEqual({ reason: "lost device", actingAs: "explicit-operator" });
  });

  it("a thrown cookie read never blocks or fails the audited action", async () => {
    // `cookies()` throws outside a request scope — a cron, a script, a
    // background job. The audit must still be written, without the claim.
    mockedReadImpersonation.mockRejectedValue(new Error("cookies() outside a request scope"));

    await expect(
      logAudit({
        tenantId: "tenant-A",
        userId: null,
        action: "cron.retention.run",
        entityType: "Tenant",
        entityId: "tenant-A",
        metadata: { deleted: 3 },
      }),
    ).resolves.toBeUndefined();

    const row = await capturedRow();
    expect(row.metadata).toEqual({ deleted: 3 });
  });
});

describe("logAudit — the shared-secret header leaves a mark", () => {
  it("stamps metadata.via when the row was written through the x-admin-secret door", async () => {
    // Defect 2. The header door stays open (scripts rely on it), but a row
    // written through it must say so, because the identity behind it is a
    // shared constant rather than a person.
    const req = new Request("http://localhost:3847/api/admin/customers/t1/suspend", {
      method: "POST",
      headers: { "x-admin-secret": "not-the-real-one-in-this-test" },
    });

    await logAudit({
      tenantId: "tenant-A",
      userId: null,
      actAsUserId: "__matflow_super_admin__",
      action: "admin.tenant.suspended",
      entityType: "Tenant",
      entityId: "tenant-A",
      metadata: { reason: "non-payment" },
      req,
    });

    const row = await capturedRow();
    expect(row.metadata).toEqual({
      reason: "non-payment",
      actingAs: "__matflow_super_admin__",
      via: "shared-secret-header",
    });
  });

  it("a cookie-door operator row carries no via marker", async () => {
    const req = new Request("http://localhost:3847/api/admin/customers/t1/suspend", {
      method: "POST",
    });

    await logAudit({
      tenantId: "tenant-A",
      userId: null,
      actAsUserId: "__matflow_super_admin__",
      action: "admin.tenant.suspended",
      entityType: "Tenant",
      entityId: "tenant-A",
      req,
    });

    const row = await capturedRow();
    expect(row.metadata).toEqual({ actingAs: "__matflow_super_admin__" });
    expect(Object.keys(row.metadata as object)).not.toContain("via");
  });
});
