// SEC-012 on the OPERATOR plane (security campaign lane A, 9 Oct 2026).
//
// Every operator gate — isAdminAuthed, isAdminPageAuthed, getOperatorContext,
// the step-up issuer, impersonation start — resolves the MFA session through
// lib/operator-auth.ts resolveMfaSessionRow, which reads the Operator row. This
// file pins what happens when that read fails or returns something malformed:
// the gate must never answer "authed". A thrown gate aborts the route before
// any work (Next answers 500 with no body data); the assertion here is that no
// tenant work started, not merely the status. Positive control on the same
// harness: a healthy row admits, and a protected route gets past its gate.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-a-operator-gate-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    operatorFindUnique: vi.fn(),
    withRlsBypass: vi.fn(),
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { operator: { findUnique: h.operatorFindUnique, updateMany: vi.fn() } } }));
vi.mock("@/lib/prisma-tenant", () => ({ withRlsBypass: h.withRlsBypass, withTenantContext: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/lib/impersonation", () => ({ hasImpersonationCookie: vi.fn(async () => false) }));
vi.mock("@/lib/testing-mode", () => ({ isProductionDatabase: () => false, isTestingMode: () => false }));

import { issueOperatorSession, OP_SESSION_COOKIE, resolveOperatorFromCookie } from "@/lib/operator-auth";
import { isAdminAuthed, isAdminPageAuthed } from "@/lib/admin-auth";
import { getOperatorContext } from "@/lib/operator-context";

const OP = { id: "op-secA", email: "op-secA@operator.test", name: "secA operator", sessionVersion: 1, totpEnabled: true };
const ORIGIN = "http://localhost:3847";
const req = (body: unknown = { scope: "club", reason: "synthetic incident drill, lane A" }) =>
  new Request(`${ORIGIN}/api/admin/customers/t-secA/revoke-access`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const FAILURES: [string, Error][] = [
  ["statement timeout", Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })],
  ["connection loss", new Error("Connection terminated unexpectedly")],
  ["pool exhausted", new Error("timeout exceeded when trying to connect")],
  ["server unreachable", Object.assign(new Error("Can't reach database server"), { code: "P1001" })],
];
const MALFORMED: [string, unknown][] = [
  ["version as a string", { ...OP, sessionVersion: "1" }],
  ["totpEnabled as a string", { ...OP, totpEnabled: "true" }],
  ["totpEnabled missing", { id: OP.id, email: OP.email, name: OP.name, sessionVersion: 1 }],
  ["version missing", { id: OP.id, email: OP.email, name: OP.name, totpEnabled: true }],
];

beforeEach(() => {
  vi.clearAllMocks();
  h.jar.clear();
  h.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP.id, 1));
  h.operatorFindUnique.mockResolvedValue(OP);
  // Preflight answers "club not found" — enough to prove the route got past its gate.
  h.withRlsBypass.mockResolvedValue("no_tenant");
});
afterEach(() => vi.unstubAllEnvs());

describe("positive control: a healthy operator row admits", () => {
  it("every gate says yes; the route reaches its preflight", async () => {
    expect(await resolveOperatorFromCookie(h.jar.get(OP_SESSION_COOKIE))).toMatchObject({ id: OP.id });
    expect(await isAdminAuthed(req())).toBe(true);
    expect(await isAdminPageAuthed()).toBe(true);
    expect(await getOperatorContext(req())).toMatchObject({ authed: true, named: true, operatorId: OP.id });
    const { POST } = await import("@/app/api/admin/customers/[id]/revoke-access/route");
    const res = await POST(req(), { params: Promise.resolve({ id: "t-secA" }) });
    expect(res.status).toBe(404);
    expect(h.withRlsBypass).toHaveBeenCalledTimes(1);
  });
});

describe.each(FAILURES)("the Operator read fails: %s", (_l, err) => {
  beforeEach(() => {
    h.operatorFindUnique.mockRejectedValue(err);
  });

  it("no gate answers authed (each one throws)", async () => {
    await expect(resolveOperatorFromCookie(h.jar.get(OP_SESSION_COOKIE))).rejects.toThrow();
    await expect(isAdminAuthed(req())).rejects.toThrow();
    await expect(isAdminPageAuthed()).rejects.toThrow();
    await expect(getOperatorContext(req())).rejects.toThrow();
  });

  it("a protected operator route aborts before any tenant work", async () => {
    const { POST } = await import("@/app/api/admin/customers/[id]/revoke-access/route");
    await expect(POST(req(), { params: Promise.resolve({ id: "t-secA" }) })).rejects.toThrow();
    expect(h.withRlsBypass).not.toHaveBeenCalled();
  });

  it("the /admin page treats it as signed out", async () => {
    // app/admin/page.tsx: resolveOperatorFromCookie(...).catch(() => null)
    const op = await resolveOperatorFromCookie(h.jar.get(OP_SESSION_COOKIE)).catch(() => null);
    expect(op).toBeNull();
  });
});

describe.each(MALFORMED)("the Operator read is malformed: %s", (_l, row) => {
  it("is not an operator session", async () => {
    h.operatorFindUnique.mockResolvedValue(row);
    expect(await resolveOperatorFromCookie(h.jar.get(OP_SESSION_COOKIE))).toBeNull();
    expect(await isAdminAuthed(req())).toBe(false);
    const { POST } = await import("@/app/api/admin/customers/[id]/revoke-access/route");
    const res = await POST(req(), { params: Promise.resolve({ id: "t-secA" }) });
    expect(res.status).toBe(403);
    expect(h.withRlsBypass).not.toHaveBeenCalled();
  });
});

describe("stale authority (SEC-013) on the same harness", () => {
  it("a bumped operator sessionVersion ends the session", async () => {
    h.operatorFindUnique.mockResolvedValue({ ...OP, sessionVersion: 2 });
    expect(await isAdminAuthed(req())).toBe(false);
  });
  it("an operator whose authenticator was removed is not an operator session", async () => {
    h.operatorFindUnique.mockResolvedValue({ ...OP, totpEnabled: false });
    expect(await isAdminAuthed(req())).toBe(false);
  });
  it("production-like with no allowlist: nobody; allow-listed: admitted; de-listed: refused", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("OPERATOR_ALLOWED_IDS", "");
    expect(await isAdminAuthed(req())).toBe(false);
    vi.stubEnv("OPERATOR_ALLOWED_IDS", OP.id);
    expect(await isAdminAuthed(req())).toBe(true);
    vi.stubEnv("OPERATOR_ALLOWED_IDS", "op-someone-else");
    expect(await isAdminAuthed(req())).toBe(false);
  });
});
