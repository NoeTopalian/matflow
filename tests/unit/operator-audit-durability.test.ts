/**
 * Operator security audit, 5 Oct 2026 (Q9): can a sensitive action succeed
 * without a durable audit record?
 *
 * lib/audit-log.ts `logAudit` WAS fire-and-forget for every caller: it started
 * the insert, did not await it, and swallowed every failure into console.warn.
 * These tests drive the REAL `logAudit` underneath real operator routes, with
 * only the database mocked, so they show what each route does when the audit
 * insert fails or has not finished.
 *
 * "VERIFIED" tests pin properties that hold. The tests named "FIXED (was GAP
 * ISSUE Q9-n)" were GAP pins of the unsafe behaviour; lane D (6 Oct 2026)
 * made high-impact writes durable (`logAudit({ tx })` inside the change's own
 * transaction, or `logAudit({ durable: true })` before a side effect outside
 * the database) and each pin was inverted to assert the protection. The old
 * pin's wording is kept in a comment above each.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const h = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  auditStaffLookup: vi.fn(),
  userUpdate: vi.fn(),
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  tenantFindUnique: vi.fn(),
  historyCreate: vi.fn(),
  readImpersonationCookie: vi.fn(),
  startSupportSession: vi.fn(),
  endSupportSession: vi.fn(),
  getOperatorContext: vi.fn(),
}));

// Operator-plane writes run through withRlsBypass (opTx); a durable row in its
// own transaction for a tenant goes through withTenantContext (auditTx). Both
// share h.auditCreate, so "was a row written" is one question.
const opTx = {
  tenant: { findUnique: h.tenantFindUnique },
  user: { findFirst: h.userFindFirst, findUnique: h.userFindUnique, update: h.userUpdate },
  passwordHistory: { create: h.historyCreate },
  auditLog: { create: h.auditCreate },
  // AuditLog.operatorId (lane C, 9 Oct 2026) is checked against the Operator table.
  operator: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
};
const auditTx = {
  user: { findFirst: h.auditStaffLookup },
  auditLog: { create: h.auditCreate },
  operator: { findUnique: async ({ where }: { where: { id: string } }) => ({ id: where.id }) },
};

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(opTx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(auditTx),
}));
vi.mock("@/lib/impersonation", () => ({
  readImpersonationCookie: h.readImpersonationCookie,
  readImpersonationCookieForStop: vi.fn(async () => null),
  startSupportSession: h.startSupportSession,
  endSupportSession: h.endSupportSession,
  clearImpersonationCookie: vi.fn(),
}));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: h.getOperatorContext }));
vi.mock("@/lib/operator-auth", () => ({
  OP_SESSION_COOKIE: "matflow_op_session",
  resolveOperatorFromCookie: async () => ({ id: "op-noe", sessionVersion: 1 }),
}));
vi.mock("@/lib/tenant-admission", () => ({
  tenantAdmission: () => ({ admits: true }),
  admissionMessage: () => "refused",
}));
// Lane A (6 Oct 2026): Danger Zone actions now demand a step-up grant. Passed
// here so audit durability stays the subject; pinned in operator-step-up.test.ts.
vi.mock("@/lib/operator-step-up", () => ({
  // Lane C (9 Oct 2026): requireStepUp returns the verified grant and the
  // spend is consumeStepUpGrant inside the route's transaction.
  requireStepUp: async () => ({ operatorId: "op-noe", sessionVersion: 0, action: "x", targetId: "t", tenantId: "t", versionDigest: "v", requestId: "rq-test" }),
  consumeStepUpGrant: async () => ({ kind: "spent" }),
  refuseStepUp: () => new Response(null, { status: 403 }),
  StepUpRefusedError: class StepUpRefusedError extends Error {},
  stepUpTarget: (t: string, s?: string) => (s ? `${t}/${s}` : t),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/auth-cookie", () => ({ SESSION_COOKIE_NAME: "authjs.session-token" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "op-cookie" }), delete: vi.fn(), set: vi.fn() }) }));

import { logAudit } from "@/lib/audit-log";

const flush = () => new Promise((r) => setTimeout(r, 0));

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function forceReset(headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/admin/customers/[id]/force-password-reset/route");
  return POST(post("http://localhost/api/admin/customers/t-club/force-password-reset", { reason: "owner locked out" }, headers), {
    params: Promise.resolve({ id: "t-club" }),
  });
}

async function startImpersonation() {
  const { POST } = await import("@/app/api/admin/impersonate/route");
  return POST(post("http://localhost/api/admin/impersonate", { targetUserId: "u-sean", reason: "support ticket 41 owner" }));
}

const NAMED_OPERATOR = { operatorId: "op-noe", operatorEmail: "op@example.test", operatorName: "Op", authed: true, named: true };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  h.readImpersonationCookie.mockResolvedValue(null);
  h.getOperatorContext.mockResolvedValue(NAMED_OPERATOR);
  h.tenantFindUnique.mockResolvedValue({ id: "t-club", name: "Club" });
  h.userFindFirst.mockResolvedValue({ id: "u-sean", email: "o@example.test", name: "Owner" });
  h.userFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === "u-sean"
      ? {
          id: "u-sean",
          tenantId: "t-club",
          email: "o@example.test",
          name: "Owner",
          role: "owner",
          passwordHash: "old-hash",
          sessionVersion: 3,
          tenant: { subscriptionStatus: "active", deletedAt: null },
        }
      : null,
  );
  h.userUpdate.mockResolvedValue({});
  h.auditStaffLookup.mockResolvedValue({ id: "u-sean" });
  h.auditCreate.mockResolvedValue({});
  h.startSupportSession.mockResolvedValue({ expiresAt: new Date("2026-10-06T12:00:00Z") });
});

describe("logAudit's contract", () => {
  it("VERIFIED (unchanged for low-impact call sites): best-effort mode never reaches the caller — it resolves and only console.warns", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    await expect(
      logAudit({ tenantId: "t-club", userId: "u-sean", action: "member.update", entityType: "Member", entityId: "m1" }),
    ).resolves.toBeUndefined();
    await flush();
    expect(warn).toHaveBeenCalledWith("[audit-log] write failed", "member.update", expect.any(Error));
  });

  // Was "GAP (ISSUE Q9-1): a failed insert never reaches the caller".
  it("FIXED (was GAP ISSUE Q9-1): in the caller's transaction (`tx`) a failed insert throws to the caller", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    await expect(
      logAudit({ tx: opTx as never, tenantId: "t-club", userId: "u-sean", action: "member.dsar_erase", entityType: "Member", entityId: "m1" }),
    ).rejects.toThrow("db down");
  });

  it("FIXED (was GAP ISSUE Q9-1): in durable mode (own transaction) a failed insert throws to the caller", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    await expect(
      logAudit({ durable: true, tenantId: "t-club", userId: null, action: "member.dsar_export", entityType: "Member", entityId: "m1" }),
    ).rejects.toThrow("db down");
  });

  it("durable rows carry actor, actor type, effective user, request id and outcome", async () => {
    await logAudit({
      durable: true,
      outcome: "requested",
      tenantId: "t-club",
      userId: "u-sean",
      actAsUserId: "op-noe",
      action: "admin.tenant.soft_delete.requested",
      entityType: "Tenant",
      entityId: "t-club",
      metadata: { reason: "r" },
      req: new Request("http://localhost/x", { headers: { "x-vercel-id": "lhr1::req-1" } }),
    });
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.metadata).toMatchObject({
      reason: "r",
      actingAs: "op-noe",
      actor: "op-noe",
      actorType: "operator",
      effectiveUserId: "u-sean",
      requestId: "lhr1::req-1",
      outcome: "requested",
    });
    // Lane C (9 Oct 2026): actor and correlation are COLUMNS too, not only metadata.
    expect(row).toMatchObject({ operatorId: "op-noe", requestId: "lhr1::req-1" });
  });

  it("a durable row without a platform request id gets a generated one", async () => {
    await logAudit({ durable: true, tenantId: "t-club", action: "admin.tenant.restored", entityType: "Tenant", entityId: "t-club" });
    expect(h.auditCreate.mock.calls[0][0].data.metadata.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("never records secrets, whatever a caller passes: temporary passwords, TOTP secrets, recovery codes, tokens", async () => {
    await logAudit({
      tx: opTx as never,
      tenantId: "t-club",
      action: "admin.owner.force_password_reset",
      entityType: "User",
      entityId: "u-sean",
      metadata: {
        reason: "kept",
        tempPassword: "TEMPPASSWORD",
        password: "PLAIN",
        totpSecret: "JBSWY3DPEHPK3PXP",
        recoveryCodes: ["code-1"],
        totpRecoveryCodes: ["code-2"],
        token: "tok",
        stepUpToken: "grant-token",
        grant: "g",
        cookie: "c",
      },
    });
    const row = h.auditCreate.mock.calls[0][0].data;
    const text = JSON.stringify(row);
    for (const s of ["TEMPPASSWORD", "PLAIN", "JBSWY3DPEHPK3PXP", "code-1", "code-2", "tok", "grant-token"]) {
      expect(text).not.toContain(s);
    }
    expect(row.metadata.reason).toBe("kept");
  });

  // Was "GAP (ISSUE Q9-1): so dsar/erase's 'refuse to erase if the audit write fails' branch is unreachable".
  it("FIXED (was GAP ISSUE Q9-1): dsar/erase's guard is reachable — the fulfilment row is the first statement of the erase transaction", () => {
    const src = readFileSync(path.join(process.cwd(), "app/api/admin/dsar/erase/route.ts"), "utf8");
    // The request row is durable and refuses the erase when it fails...
    expect(src).toMatch(/await logAudit\(\{\s*durable: true,[\s\S]*?action: "member\.dsar_erase\.requested"[\s\S]*?\} catch \(err\) \{[\s\S]*?refusing to erase/);
    // ...and the fulfilment row opens the erase transaction.
    expect(src).toMatch(/const erasedOk = await withTenantContext\(tenantId, async \(tx\) => \{\s*await logAudit\(\{ \.\.\.fulfilmentRecord, tx \}\);/);
    // logAudit no longer swallows in these modes. Behaviour, with injected
    // failures: tests/unit/dsar-erase-audit-durability.test.ts.
    const lib = readFileSync(path.join(process.cwd(), "lib/audit-log.ts"), "utf8");
    expect(lib).toMatch(/if \(args\.tx\) \{\s*await insert\(args\.tx, data\);/);
  });
});

describe("Danger Zone: force-password-reset", () => {
  // Was "GAP (ISSUE Q9-2): the reset succeeds and hands out the temp password while the audit insert fails".
  it("FIXED (was GAP ISSUE Q9-2): an audit failure fails the reset — 500, no temporary password, written in the reset's own transaction", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    const res = await forceReset();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.tempPassword).toBeUndefined();
    expect(body.error).toMatch(/nothing was changed/);
    // The insert ran on the reset's transaction client (opTx), so in Postgres
    // the password change rolls back with it.
    expect(h.auditStaffLookup).not.toHaveBeenCalled();
    expect(h.userFindFirst).toHaveBeenCalled();
  });

  // Was "GAP (ISSUE Q9-2): the response does not wait for the audit row".
  it("FIXED (was GAP ISSUE Q9-2): the response waits for the audit row — no answer while the insert is pending", async () => {
    h.auditCreate.mockReturnValue(new Promise(() => {}));
    const outcome = await Promise.race([
      forceReset().then(() => "answered"),
      new Promise((r) => setTimeout(() => r("still waiting"), 50)),
    ]);
    expect(outcome).toBe("still waiting");
  });

  it("VERIFIED: the audit row names the real operator and never contains the temporary password", async () => {
    const res = await forceReset();
    const { tempPassword } = await res.json();
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.action).toBe("admin.owner.force_password_reset");
    expect(row.metadata.actingAs).toBe("op-noe");
    expect(row.metadata.actorType).toBe("operator");
    expect(JSON.stringify(row)).not.toContain(tempPassword);
  });

  it("VERIFIED (development/test only — production refuses the secret): through the shared-secret header the row says so", async () => {
    h.getOperatorContext.mockResolvedValue({ operatorId: "__matflow_super_admin__", operatorEmail: null, operatorName: null, authed: true, named: false });
    await forceReset({ "x-admin-secret": "redacted" });
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.metadata.via).toBe("shared-secret-header");
    expect(row.metadata.actingAs).toBe("__matflow_super_admin__");
    expect(row.metadata.actorType).toBe("shared-secret");
  });

  // Operator audit Q12: "secret-cookie audit lacks `via`".
  it("FIXED: through the shared-secret COOKIE (no header) the row says so too", async () => {
    await logAudit({ durable: true, tenantId: "t-club", action: "admin.tenant.suspended", entityType: "Tenant", entityId: "t-club", actAsUserId: "__matflow_super_admin__" });
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.metadata.via).toBe("shared-secret");
    expect(row.metadata.actorType).toBe("shared-secret");
  });
});

describe("impersonation start", () => {
  // Was "GAP (ISSUE Q9-3): the impersonation cookie is minted BEFORE the audit
  // write, and the start succeeds when that write fails".
  it("FIXED (was GAP ISSUE Q9-3): the audit row is written first; if it fails no support session starts", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    const res = await startImpersonation();
    expect(res.status).toBe(500);
    expect(h.startSupportSession).not.toHaveBeenCalled();
  });

  it("the start row commits BEFORE the support session is minted", async () => {
    const order: string[] = [];
    h.auditCreate.mockImplementation(async () => {
      order.push("audit");
      return {};
    });
    h.startSupportSession.mockImplementation(async () => {
      order.push("session");
      return { expiresAt: new Date() };
    });
    const res = await startImpersonation();
    expect(res.status).toBe(200);
    expect(order).toEqual(["audit", "session"]);
  });

  it("VERIFIED: the row carries operator id, operator email, reason and the effective user", async () => {
    await startImpersonation();
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.action).toBe("admin.impersonate.start");
    expect(row.metadata).toMatchObject({
      actingAs: "op-noe",
      operatorEmail: "op@example.test",
      reason: "support ticket 41 owner",
      effectiveUserId: "u-sean",
      outcome: "authorised",
    });
  });
});

describe("retention", () => {
  // Was "GAP (ISSUE Q9-4): the nightly sweep deletes EVERY audit row over 365
  // days old — operator and erasure evidence included".
  it("FIXED (was GAP ISSUE Q9-4): the sweep keeps operator, support-session and erasure evidence for six years", async () => {
    const src = readFileSync(path.join(process.cwd(), "app/api/cron/retention/route.ts"), "utf8");
    expect(src).not.toMatch(/AUDIT_LOG_RETENTION_MS = 365 \* DAY_MS/);
    expect(src).toMatch(/tx\.auditLog as unknown as BatchDeletable,\s*auditLogRetentionWhere\(now\)/);
    const { AUDIT_EVIDENCE_ACTION_PREFIXES, AUDIT_EVIDENCE_RETENTION_MS } = await import("@/lib/audit-log");
    expect(AUDIT_EVIDENCE_ACTION_PREFIXES).toEqual(["admin.", "member.dsar_erase"]);
    expect(AUDIT_EVIDENCE_RETENTION_MS).toBe(6 * 365 * 24 * 60 * 60 * 1000);
    // Row-level behaviour on Postgres: tests/integration/audit-durability-db.test.ts.
  });

  it("VERIFIED: the tenant purge keeps AuditLog — evidence outlives the club it attests to", () => {
    const src = readFileSync(path.join(process.cwd(), "lib/tenant-purge.ts"), "utf8");
    expect(src).not.toMatch(/auditLog\.(deleteMany|delete)\(/);
    expect(src).toMatch(/AuditLog is deliberately\s*\n?\s*\*?\s*kept/);
  });
});
