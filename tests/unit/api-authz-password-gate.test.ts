import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Forced password change, API half (lib/api-authz.ts, 3 Oct 2026).
 *
 * After an operator reset the owner signs in on a TEMPORARY password and the
 * row is flagged `mustChangePassword`. That flag used to be enforced by
 * app/dashboard/layout.tsx alone, so a temp-password session could call every
 * protected /api route directly. auth.ts now carries the flag on the token and
 * `requireApiRole` refuses it with a 403 in the same `{ ok:false, error }`
 * shape as the MFA gate. Red on revert: remove the gate and the first three
 * cases return ok:true.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const session = (role: string, flags: { mustChangePassword?: boolean; requireTotpSetup?: boolean } = {}) =>
  ({ user: { id: "u1", tenantId: "t1", role, ...flags } }) as never;

beforeEach(() => vi.clearAllMocks());

describe("api-authz — temporary password must be replaced first", () => {
  it("requireApiOwner → 403 with a clear body while mustChangePassword is set", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", { mustChangePassword: true }));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response.status).toBe(403);
      expect(await gate.response.json()).toEqual({ ok: false, error: "Choose your own password to continue." });
    }
  });

  it("requireApiStaff → 403 for a coach on an owner-set temporary password", async () => {
    mockAuth.mockResolvedValueOnce(session("coach", { mustChangePassword: true }));
    const { requireApiStaff } = await import("@/lib/api-authz");
    const gate = await requireApiStaff();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
  });

  it("both flags set → the password refusal wins (activation order: password, then authenticator)", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", { mustChangePassword: true, requireTotpSetup: true }));
    const { requireApiOwnerOrManager } = await import("@/lib/api-authz");
    const gate = await requireApiOwnerOrManager();
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.response.status).toBe(403);
      expect((await gate.response.json()).error).toMatch(/password/);
    }
  });

  it("password chosen but no authenticator yet → the MFA refusal", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", { mustChangePassword: false, requireTotpSetup: true }));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect((await gate.response.json()).error).toMatch(/authenticator/);
  });

  it("password chosen and authenticator enrolled → ok", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", { mustChangePassword: false, requireTotpSetup: false }));
    const { requireApiOwner } = await import("@/lib/api-authz");
    expect((await requireApiOwner()).ok).toBe(true);
  });

  it("a wrong role is still a plain 403 'permission' refusal, not a password prompt", async () => {
    mockAuth.mockResolvedValueOnce(session("member", { mustChangePassword: true }));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect((await gate.response.json()).error).toMatch(/permission/);
  });

  it("no session → 401, unchanged", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { requireApiStaff } = await import("@/lib/api-authz");
    const gate = await requireApiStaff();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });
});
