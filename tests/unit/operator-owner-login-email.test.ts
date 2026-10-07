import { vi, describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";

// POST /api/admin/customers/[id]/login-email (7 Oct 2026, US-001/US-002).
// Operator control of the club owner's login email: mark provisional, clear
// provisional (operator attestation), change. Pins: reason >= 10, step-up
// bound to "owner.login_email" on tenant/ownerUserId, state checks before the
// grant is spent, collisions across User AND Member refused without saying
// whose, audit in the same transaction, digests not addresses in the audit.

const h = vi.hoisted(() => ({
  isAdminAuthed: vi.fn(async () => true),
  requireStepUp: vi.fn(async () => null as unknown),
  logAudit: vi.fn(async () => {}),
  owner: null as null | Record<string, unknown>,
  userCollision: null as null | { id: string },
  memberCollision: null as null | { id: string },
}));

const tx = {
  user: {
    findFirst: vi.fn(async (args: { where: { role?: string; id?: unknown } }) =>
      args.where.role === "owner" ? h.owner : h.userCollision),
    update: vi.fn(async () => ({})),
    // The change is a conditional update on {id, email} (review defect 6).
    updateMany: vi.fn(async () => ({ count: 1 })),
  },
  member: { findFirst: vi.fn(async () => h.memberCollision) },
  passwordResetToken: { updateMany: vi.fn(async () => ({ count: 2 })) },
  magicLinkToken: { updateMany: vi.fn(async () => ({ count: 1 })) },
};

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: h.isAdminAuthed }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: async () => ({ operatorId: "op-1", named: true }),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "127.0.0.1",
}));
// The REAL stepUpTarget (review defect 7): the binding string is what is pinned.
vi.mock("@/lib/operator-step-up", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operator-step-up")>()),
  requireStepUp: h.requireStepUp,
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));

import { POST } from "@/app/api/admin/customers/[id]/login-email/route";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SINCE = new Date("2026-10-07T08:00:00Z");
const call = (body: unknown) =>
  POST(
    new Request("http://localhost/api/admin/customers/tenant-A/login-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "tenant-A" }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  h.isAdminAuthed.mockResolvedValue(true);
  h.requireStepUp.mockResolvedValue(null);
  h.owner = { id: "owner-1", email: "provisional@club.example", loginEmailProvisionalSince: null };
  h.userCollision = null;
  h.memberCollision = null;
});

describe("operator login-email — gates", () => {
  it("refuses a non-operator before anything else", async () => {
    h.isAdminAuthed.mockResolvedValue(false);
    const res = await call({ action: "mark_provisional", reason: "owner verified by call-back" });
    expect(res.status).toBe(403);
    expect(tx.user.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "mark_provisional", reason: "too short" }],
    [{ action: "change", reason: "owner verified by call-back", newEmail: "not-an-email" }],
    [{ action: "clear_provisional", reason: "owner verified by call-back" }], // no attestation
    [{ action: "clear_provisional", reason: "owner verified by call-back", attestMailboxVerified: false }],
    [{ action: "delete_owner", reason: "owner verified by call-back" }],
  ])("400 on %j, nothing read or spent", async (body) => {
    const res = await call(body);
    expect(res.status).toBe(400);
    expect(h.requireStepUp).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it("demands a step-up grant for owner.login_email bound to tenant/ownerUserId/sub-action; refusal changes nothing", async () => {
    h.requireStepUp.mockResolvedValue(new Response(JSON.stringify({ stepUpRequired: true }), { status: 403 }));
    const res = await call({ action: "mark_provisional", reason: "owner verified by call-back" });
    expect(res.status).toBe(403);
    expect(h.requireStepUp).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ operatorId: "op-1" }), "owner.login_email", "tenant-A/owner-1/mark_provisional");
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("each sub-action has its own target: a grant for one cannot be spent on another", async () => {
    h.owner = { ...h.owner!, loginEmailProvisionalSince: SINCE };
    await call({ action: "clear_provisional", reason: "owner verified by call-back", attestMailboxVerified: true });
    await call({ action: "change", reason: "owner verified by call-back", newEmail: "real@owner.example" });
    const targets = h.requireStepUp.mock.calls.map((c) => (c as unknown as unknown[])[3]);
    expect(targets).toEqual(["tenant-A/owner-1/clear_provisional", "tenant-A/owner-1/change"]);
  });

  it("clearing a mark that is not set is 409 BEFORE the grant is spent", async () => {
    const res = await call({ action: "clear_provisional", reason: "owner verified by call-back", attestMailboxVerified: true });
    expect(res.status).toBe(409);
    expect(h.requireStepUp).not.toHaveBeenCalled();
  });

  it("changing to the same address is 400 BEFORE the grant is spent", async () => {
    const res = await call({ action: "change", reason: "owner verified by call-back", newEmail: "Provisional@Club.example " });
    expect(res.status).toBe(400);
    expect(h.requireStepUp).not.toHaveBeenCalled();
  });

  it("no owner on the club is 404", async () => {
    h.owner = null;
    const res = await call({ action: "mark_provisional", reason: "owner verified by call-back" });
    expect(res.status).toBe(404);
  });
});

describe("operator login-email — mark_provisional", () => {
  it("sets the mark, retires reset codes and sign-in links for the address, audits in the same tx", async () => {
    const res = await call({ action: "mark_provisional", reason: "address supplied by Noe, not verified" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "provisional@club.example", provisional: true });
    const upd = tx.user.update.mock.calls[0] as unknown as [{ where: { id: string }; data: Record<string, unknown> }];
    expect(upd[0].where).toEqual({ id: "owner-1" });
    expect(upd[0].data.loginEmailProvisionalSince).toBeInstanceOf(Date);
    expect(upd[0].data).not.toHaveProperty("sessionVersion");
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: "tenant-A", email: { in: ["provisional@club.example"] }, used: false }),
    }));
    expect(tx.magicLinkToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ purpose: { in: ["login", "first_time_signup"] } }),
    }));
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      action: "admin.owner.login_email.marked_provisional",
      userId: "owner-1",
      actAsUserId: "op-1",
      metadata: expect.objectContaining({ emailSha256: sha("provisional@club.example") }),
    }));
  });

  it("keeps the original provisional-since when already marked", async () => {
    h.owner = { ...h.owner!, loginEmailProvisionalSince: SINCE };
    await call({ action: "mark_provisional", reason: "re-marking after review" });
    const upd = tx.user.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(upd[0].data.loginEmailProvisionalSince).toBe(SINCE);
  });

  it("an audit failure rolls the change back and answers 500", async () => {
    h.logAudit.mockRejectedValueOnce(new Error("audit down"));
    const res = await call({ action: "mark_provisional", reason: "address supplied by Noe, not verified" });
    expect(res.status).toBe(500);
  });
});

describe("operator login-email — clear_provisional (operator attestation)", () => {
  it("clears the mark and records it as the operator's attestation", async () => {
    h.owner = { ...h.owner!, loginEmailProvisionalSince: SINCE };
    const res = await call({
      action: "clear_provisional",
      reason: "video call, owner read back the code I emailed from my own client",
      attestMailboxVerified: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "provisional@club.example", provisional: false });
    const upd = tx.user.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(upd[0].data).toEqual({ loginEmailProvisionalSince: null });
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tx,
      action: "admin.owner.login_email.cleared_provisional",
      metadata: expect.objectContaining({ verification: "operator_attestation", provisionalSince: SINCE.toISOString() }),
    }));
  });
});

describe("operator login-email — change", () => {
  const body = { action: "change", reason: "owner verified by call-back, ticket 12", newEmail: " Real@Owner.Example " };

  it("normalises, sets email + provisional + sessionVersion+1, retires old AND new tokens, audits digests only", async () => {
    const res = await call(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: "real@owner.example", provisional: true });
    expect(tx.user.update).not.toHaveBeenCalled();
    const upd = tx.user.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }];
    // Conditional on the address the operator saw: a concurrent change wins, this one does not overwrite it.
    expect(upd[0].where).toEqual({ id: "owner-1", tenantId: "tenant-A", email: "provisional@club.example" });
    expect(upd[0].data.email).toBe("real@owner.example");
    expect(upd[0].data.loginEmailProvisionalSince).toBeInstanceOf(Date);
    expect(upd[0].data.sessionVersion).toEqual({ increment: 1 });
    // Identity, role, tenant, factor and password are not touched.
    for (const k of ["id", "role", "tenantId", "totpSecret", "totpEnabled", "totpRecoveryCodes", "passwordHash"]) {
      expect(upd[0].data).not.toHaveProperty(k);
    }
    expect(tx.passwordResetToken.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ email: { in: ["provisional@club.example", "real@owner.example"] } }),
    }));
    const audit = (h.logAudit.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(audit).toMatchObject({
      tx,
      action: "admin.owner.login_email.changed",
      metadata: expect.objectContaining({
        oldEmailSha256: sha("provisional@club.example"),
        newEmailSha256: sha("real@owner.example"),
      }),
    });
    expect(JSON.stringify(audit.metadata)).not.toContain("@");
  });

  it("refuses an address another user of the club holds — 409, nothing written, owner not named", async () => {
    h.userCollision = { id: "coach-9" };
    const res = await call(body);
    expect(res.status).toBe(409);
    const msg = (await res.json()).error as string;
    expect(msg).not.toMatch(/coach|member|staff/i);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("refuses an address a member of the club holds — 409", async () => {
    h.memberCollision = { id: "mem-3" };
    const res = await call(body);
    expect(res.status).toBe(409);
    expect(tx.user.updateMany).not.toHaveBeenCalled();
  });

  it("the collision checks are scoped to THIS club", async () => {
    await call(body);
    expect(tx.member.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-A", email: "real@owner.example" },
    }));
  });

  it("a unique-constraint race is a 409, not a 500", async () => {
    tx.user.updateMany.mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await call(body);
    expect(res.status).toBe(409);
  });

  it("the owner address changed since it was read (conditional update matched nothing): 409, no tokens retired, no audit", async () => {
    tx.user.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await call(body);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/changed/i);
    expect(tx.passwordResetToken.updateMany).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
