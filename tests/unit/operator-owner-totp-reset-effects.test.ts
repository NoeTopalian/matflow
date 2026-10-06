// What the operator's "Reset owner 2FA" action changes, and what it does not
// (Sean verification, 4 Oct 2026). POST /api/admin/customers/[id]/totp-reset.
//
// The pending owner account carries an authenticator the operator enrolled
// during set-up. The proposed containment is this action, so its exact effect
// on the row is pinned here: second factor, secret and recovery codes cleared,
// every session evicted — and the password and the forced-change flag left
// alone, so the temporary password already handed over keeps working and still
// has to be replaced at the next sign-in.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));

const { logAuditMock, isAdminAuthedMock, tenantFindUnique, userFindFirst, userUpdate } = vi.hoisted(() => ({
  logAuditMock: vi.fn(async () => {}),
  isAdminAuthedMock: vi.fn(async () => true),
  tenantFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userUpdate: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: isAdminAuthedMock }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: vi.fn(async () => ({ operatorId: "op-1" })) }));
// Step-up re-authentication (6 Oct 2026) is pinned in
// tests/unit/operator-step-up.test.ts; here it is passed so the row effects
// stay the subject. The call itself is asserted below.
const { requireStepUpMock } = vi.hoisted(() => ({ requireStepUpMock: vi.fn(async () => null) }));
vi.mock("@/lib/operator-step-up", () => ({
  requireStepUp: requireStepUpMock,
  stepUpTarget: (t: string, s?: string) => (s ? `${t}/${s}` : t),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ tenant: { findUnique: tenantFindUnique }, user: { findFirst: userFindFirst, update: userUpdate } })),
}));

function post(body: Record<string, unknown>) {
  return new Request("http://localhost/api/admin/customers/t1/totp-reset", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isAdminAuthedMock.mockResolvedValue(true);
  tenantFindUnique.mockResolvedValue({ id: "t1", name: "Club Name" });
  userFindFirst.mockResolvedValue({ id: "u-owner", email: "o@example.test", name: "Owner", totpEnabled: true });
  userUpdate.mockResolvedValue({});
});

describe("POST /api/admin/customers/[id]/totp-reset", () => {
  it("clears the factor, the secret and the recovery codes, and evicts every session", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/totp-reset/route");
    const res = await POST(post({ reason: "Operator-enrolled factor before handover", confirmName: "Club Name" }), { params: Promise.resolve({ id: "t1" }) });
    expect(res.status).toBe(200);
    expect(userUpdate).toHaveBeenCalledTimes(1);
    const data = (userUpdate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(data.totpEnabled).toBe(false);
    expect(data.totpSecret).toBeNull();
    expect(data.totpRecoveryCodes).toBe(Prisma.JsonNull);
    expect(data.sessionVersion).toEqual({ increment: 1 });
    // Fresh operator re-authentication, bound to this action on this club.
    expect(requireStepUpMock).toHaveBeenCalledWith(expect.any(Request), expect.objectContaining({ operatorId: "op-1" }), "owner.totp_reset", "t1");
  });

  it("leaves the password and the forced-change flag exactly as they were", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/totp-reset/route");
    await POST(post({ reason: "Operator-enrolled factor before handover", confirmName: "Club Name" }), { params: Promise.resolve({ id: "t1" }) });
    const data = (userUpdate.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(Object.keys(data).sort()).toEqual(["sessionVersion", "totpEnabled", "totpRecoveryCodes", "totpSecret"]);
  });

  it("writes admin.owner.totp_reset attributed to the operator", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/totp-reset/route");
    await POST(post({ reason: "Operator-enrolled factor before handover", confirmName: "Club Name" }), { params: Promise.resolve({ id: "t1" }) });
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.owner.totp_reset", entityId: "u-owner", actAsUserId: "op-1", metadata: expect.objectContaining({ wasEnrolled: true }) }),
    );
  });

  it("refuses without the club-name confirmation, and without operator auth", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/totp-reset/route");
    const wrong = await POST(post({ reason: "Operator-enrolled factor", confirmName: "Other" }), { params: Promise.resolve({ id: "t1" }) });
    expect(wrong.status).toBe(400);
    isAdminAuthedMock.mockResolvedValueOnce(false);
    const anon = await POST(post({ reason: "Operator-enrolled factor", confirmName: "Club Name" }), { params: Promise.resolve({ id: "t1" }) });
    expect(anon.status).toBe(403);
    expect(userUpdate).not.toHaveBeenCalled();
  });
});
