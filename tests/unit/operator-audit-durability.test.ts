/**
 * Operator security audit, 5 Oct 2026 (Q9): can a sensitive action succeed
 * without a durable audit record?
 *
 * lib/audit-log.ts `logAudit` is fire-and-forget: it starts the insert, does
 * not await it, and swallows every failure into console.warn. These tests
 * drive the REAL `logAudit` underneath real operator routes, with only the
 * database mocked, so they show what each route does when the audit insert
 * fails or has not finished.
 *
 * "VERIFIED" tests pin properties that hold. "GAP" tests pin current unsafe
 * behaviour; each is an ISSUE in the audit report and should go red — and be
 * inverted — when that issue is fixed.
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
  setImpersonationCookie: vi.fn(),
  readImpersonationCookie: vi.fn(),
  getOperatorContext: vi.fn(),
}));

// Operator-plane writes (withRlsBypass) succeed; the audit insert goes through
// withTenantContext (tenantId set), whose tx is wired to h.auditCreate.
const opTx = {
  tenant: { findUnique: h.tenantFindUnique },
  user: { findFirst: h.userFindFirst, findUnique: h.userFindUnique, update: h.userUpdate },
  passwordHistory: { create: h.historyCreate },
  auditLog: { create: h.auditCreate },
};
const auditTx = {
  user: { findFirst: h.auditStaffLookup },
  auditLog: { create: h.auditCreate },
};

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(opTx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(auditTx),
}));
vi.mock("@/lib/impersonation", () => ({
  readImpersonationCookie: h.readImpersonationCookie,
  setImpersonationCookie: h.setImpersonationCookie,
  clearImpersonationCookie: vi.fn(),
}));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: async () => true }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: h.getOperatorContext }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/auth-cookie", () => ({ SESSION_COOKIE_NAME: "authjs.session-token" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined, delete: vi.fn(), set: vi.fn() }) }));

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
  return POST(post("http://localhost/api/admin/impersonate", { targetUserId: "u-sean", reason: "support ticket 41" }));
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  h.readImpersonationCookie.mockResolvedValue(null);
  h.getOperatorContext.mockResolvedValue({ operatorId: "op-noe", operatorEmail: "op@example.test", operatorName: "Op", authed: true });
  h.tenantFindUnique.mockResolvedValue({ id: "t-club", name: "Club" });
  h.userFindFirst.mockResolvedValue({ id: "u-sean", email: "o@example.test", name: "Owner" });
  h.userFindUnique.mockImplementation(async (args: { where: { id: string } }) =>
    args.where.id === "u-sean"
      ? { id: "u-sean", tenantId: "t-club", email: "o@example.test", name: "Owner", role: "owner", passwordHash: "old-hash" }
      : null,
  );
  h.userUpdate.mockResolvedValue({});
  h.auditStaffLookup.mockResolvedValue({ id: "u-sean" });
  h.auditCreate.mockResolvedValue({});
});

describe("logAudit's contract", () => {
  it("GAP (ISSUE Q9-1): a failed insert never reaches the caller — it resolves and only console.warns", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    await expect(
      logAudit({ tenantId: "t-club", userId: "u-sean", action: "member.dsar_erase", entityType: "Member", entityId: "m1" }),
    ).resolves.toBeUndefined();
    await flush();
    expect(warn).toHaveBeenCalledWith("[audit-log] write failed", "member.dsar_erase", expect.any(Error));
  });

  it("GAP (ISSUE Q9-1): so dsar/erase's 'refuse to erase if the audit write fails' branch is unreachable", () => {
    const src = readFileSync(path.join(process.cwd(), "app/api/admin/dsar/erase/route.ts"), "utf8");
    // The route's guarantee depends on `await logAudit` throwing...
    expect(src).toMatch(/try \{\s*await logAudit\(\{[\s\S]*?action: "member\.dsar_erase"[\s\S]*?\} catch \(err\) \{[\s\S]*?refusing to erase/);
    // ...and logAudit's own source swallows every insert error.
    const lib = readFileSync(path.join(process.cwd(), "lib/audit-log.ts"), "utf8");
    expect(lib).toMatch(/void write\(data\)/);
  });
});

describe("Danger Zone: force-password-reset", () => {
  it("GAP (ISSUE Q9-2): the reset succeeds and hands out the temp password while the audit insert fails", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    const res = await forceReset();
    expect(res.status).toBe(200);
    expect((await res.json()).tempPassword).toMatch(/^[A-Z2-9]{12}$/);
    expect(h.userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ mustChangePassword: true, sessionVersion: { increment: 1 } }) }),
    );
    await flush();
    expect(warn).toHaveBeenCalledWith("[audit-log] write failed", "admin.owner.force_password_reset", expect.any(Error));
  });

  it("GAP (ISSUE Q9-2): the response does not wait for the audit row — it returns while the insert is still pending", async () => {
    h.auditCreate.mockReturnValue(new Promise(() => {}));
    const res = await forceReset();
    expect(res.status).toBe(200);
  });

  it("VERIFIED: the audit row names the real operator and never contains the temporary password", async () => {
    const res = await forceReset();
    const { tempPassword } = await res.json();
    await flush();
    expect(h.auditCreate).toHaveBeenCalledTimes(1);
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.action).toBe("admin.owner.force_password_reset");
    expect(row.metadata.actingAs).toBe("op-noe");
    expect(JSON.stringify(row)).not.toContain(tempPassword);
  });

  it("VERIFIED: through the shared-secret header the row says so (metadata.via) — but the actor is the anonymous sentinel", async () => {
    h.getOperatorContext.mockResolvedValue({ operatorId: "__matflow_super_admin__", operatorEmail: null, operatorName: null, authed: true });
    await forceReset({ "x-admin-secret": "redacted" });
    await flush();
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.metadata.via).toBe("shared-secret-header");
    expect(row.metadata.actingAs).toBe("__matflow_super_admin__");
  });
});

describe("impersonation start", () => {
  it("GAP (ISSUE Q9-3): the impersonation cookie is minted BEFORE the audit write, and the start succeeds when that write fails", async () => {
    h.auditCreate.mockRejectedValue(new Error("db down"));
    const res = await startImpersonation();
    expect(res.status).toBe(200);
    expect(h.setImpersonationCookie).toHaveBeenCalledWith(
      expect.objectContaining({ adminUserId: "op-noe", targetUserId: "u-sean" }),
    );
    await flush();
    expect(warn).toHaveBeenCalledWith("[audit-log] write failed", "admin.impersonate.start", expect.any(Error));
  });

  it("VERIFIED: when the write lands it carries operator id, operator email and reason", async () => {
    await startImpersonation();
    await flush();
    const row = h.auditCreate.mock.calls[0][0].data;
    expect(row.action).toBe("admin.impersonate.start");
    expect(row.metadata).toMatchObject({ actingAs: "op-noe", operatorEmail: "op@example.test", reason: "support ticket 41" });
  });
});

describe("retention", () => {
  it("GAP (ISSUE Q9-4): the nightly sweep deletes EVERY audit row over 365 days old — operator and erasure evidence included", () => {
    const src = readFileSync(path.join(process.cwd(), "app/api/cron/retention/route.ts"), "utf8");
    expect(src).toMatch(/AUDIT_LOG_RETENTION_MS = 365 \* DAY_MS/);
    expect(src).toMatch(/tx\.auditLog as unknown as BatchDeletable,\s*\{ createdAt: \{ lt: ago\(AUDIT_LOG_RETENTION_MS\) \} \}/);
  });
});
