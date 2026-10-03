import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Second-factor CHALLENGE on the API (lib/api-authz.ts, 3 Oct 2026 handover
 * review, P0). `totpPending` is the state between a successful password or
 * magic-link sign-in and the authenticator code for that sign-in. proxy.ts
 * redirected PAGES to /login/totp; nothing refused the API, and /api/admin/*
 * is a public prefix for the proxy, so an enrolled owner's code-less session
 * could roll back an import or erase a member. requireApiSession now refuses
 * that state before any role or route is considered. Red on revert: remove
 * the check and the first three cases return ok:true.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const session = (role: string, extra: Record<string, unknown> = {}) =>
  ({ user: { id: "u1", tenantId: "t1", role, ...extra } }) as never;

beforeEach(() => vi.clearAllMocks());

describe("api-authz — the authenticator challenge is owed on the API too", () => {
  it("requireApiSession → 403 while totpPending, whatever the role", async () => {
    const { requireApiSession } = await import("@/lib/api-authz");
    for (const role of ["owner", "manager", "coach", "admin", "member"]) {
      mockAuth.mockResolvedValueOnce(session(role, { totpPending: true }));
      const gate = await requireApiSession();
      expect(gate.ok, role).toBe(false);
      if (!gate.ok) {
        expect(gate.response.status).toBe(403);
        const body = (await gate.response.json()) as { ok: boolean; error: string };
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/authenticator code/i);
      }
    }
  });

  it("requireApiOwner → 403 for an enrolled owner who has not entered the code (the /api/admin case)", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", { totpPending: true, totpEnabled: true }));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
  });

  it("the challenge is refused before the temporary-password and enrolment gates", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", { totpPending: true, mustChangePassword: true, requireTotpSetup: true }));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      const body = (await gate.response.json()) as { error: string };
      expect(body.error).toMatch(/authenticator code/i);
    }
  });

  it("requireApiSession → ok once the code has been entered (totpPending false)", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", { totpPending: false }));
    const { requireApiSession } = await import("@/lib/api-authz");
    expect((await requireApiSession()).ok).toBe(true);
  });

  it("requireApiSession → ok when the claim is absent (a session that never had a second factor)", async () => {
    mockAuth.mockResolvedValueOnce(session("coach"));
    const { requireApiSession } = await import("@/lib/api-authz");
    expect((await requireApiSession()).ok).toBe(true);
  });

  it("still 401 with no session", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { requireApiSession } = await import("@/lib/api-authz");
    const gate = await requireApiSession();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });
});
