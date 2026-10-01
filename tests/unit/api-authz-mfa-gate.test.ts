import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Mandatory-TOTP gate, API half (lib/api-authz.ts, 1 Oct 2026).
 *
 * An owner who has not yet enrolled a second factor (session.requireTotpSetup
 * === true) is refused on every staff/owner-gated route with a 403, so a direct
 * protected API call before enrolment cannot slip past the page gate. The flag
 * is owner-only and TESTING_MODE-suppressed in auth.ts, so a manager, or any
 * session in local/e2e, is unaffected. Red on revert: remove the gate and the
 * first two cases return ok:true.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const session = (role: string, requireTotpSetup?: boolean) =>
  ({ user: { id: "u1", tenantId: "t1", role, requireTotpSetup } }) as never;

beforeEach(() => vi.clearAllMocks());

describe("api-authz — mandatory TOTP for owners", () => {
  it("requireApiOwner → 403 when the owner has not enrolled", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", true));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
  });

  it("requireApiStaff → 403 for a not-enrolled owner", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", true));
    const { requireApiStaff } = await import("@/lib/api-authz");
    const gate = await requireApiStaff();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(403);
  });

  it("requireApiOwner → ok once enrolled (requireTotpSetup false)", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", false));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(true);
  });

  it("requireApiOwner → ok when the flag is absent (TESTING_MODE suppresses it)", async () => {
    mockAuth.mockResolvedValueOnce(session("owner", undefined));
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(true);
  });

  it("a manager is never gated (requireTotpSetup is owner-only, absent here)", async () => {
    mockAuth.mockResolvedValueOnce(session("manager", undefined));
    const { requireApiOwnerOrManager } = await import("@/lib/api-authz");
    const gate = await requireApiOwnerOrManager();
    expect(gate.ok).toBe(true);
  });

  it("an expired session is still a 401, not the 403 enrol message", async () => {
    mockAuth.mockResolvedValueOnce(null as never);
    const { requireApiOwner } = await import("@/lib/api-authz");
    const gate = await requireApiOwner();
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.response.status).toBe(401);
  });
});
