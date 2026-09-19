/**
 * A locked member of STAFF had no way back in.
 *
 * `POST /api/members/[id]/unlock` recovers a locked Member. There was no
 * equivalent for a `User`, and handing that route a User id 404s (correctly —
 * it is not a member of the club). So an owner, manager, coach or admin who
 * mistyped their password ten times was locked out for a full hour with no
 * gym-side recovery at all: not the password reset the login page names
 * (`app/login/page.tsx:61` — now fixed separately), not an unlock screen, only
 * the operator's `force-password-reset` or the clock.
 *
 * Owner-only, deliberately. Clearing a brute-force lockout is half of the
 * attack the lockout exists to stop, and staff accounts reach money, the member
 * roster and the export. `members/[id]/unlock` is owner+manager because a
 * manager runs the desk; nobody needs to unlock a COLLEAGUE at the desk.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const mockAssertSameOrigin = vi.fn((req: Request) => (req ? null : null) as unknown);
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: (req: Request) => mockAssertSameOrigin(req) }));

const mockGate = vi.fn();
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: () => mockGate() }));

vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findFirst: vi.fn(), update: vi.fn() } },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

const mockLogAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => mockLogAudit(...a) }));
// The stub must not echo its input, or the "no cleartext address in the audit
// row" assertion below would pass or fail on the stub rather than on the route.
vi.mock("@/lib/token-hash", () => ({
  hashToken: (s: string) => `sha256:${s.length.toString(16).padStart(64, "0")}`,
}));

import { prisma } from "@/lib/prisma";

const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
const mockUserUpdate = vi.mocked(prisma.user.update);

const OWNER_SESSION = {
  ok: true as const,
  session: { user: { id: "owner-1", tenantId: "tenant-A", role: "owner" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAssertSameOrigin.mockReturnValue(null);
  mockGate.mockResolvedValue(OWNER_SESSION);
  mockUserFindFirst.mockResolvedValue({
    id: "coach-9",
    name: "Sam Coates",
    email: "sam@totalbjj.com",
    role: "coach",
    failedLoginCount: 0,
    lockedUntil: new Date(Date.now() + 60 * 60_000),
  } as never);
  mockUserUpdate.mockResolvedValue({} as never);
});

function req() {
  return new Request("http://localhost/api/auth/staff-unlock/coach-9", { method: "POST" });
}
const params = { params: Promise.resolve({ id: "coach-9" }) };

async function post() {
  const { POST } = await import("@/app/api/auth/staff-unlock/[id]/route");
  return POST(req(), params);
}

describe("staff unlock", () => {
  it("clears lockedUntil and the failed counter for a locked colleague", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, wasLocked: true });

    expect(mockUserUpdate).toHaveBeenCalledWith({
      where: { id: "coach-9" },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  });

  it("is owner-only — it asks requireApiOwner, not owner-or-manager", async () => {
    await post();
    expect(mockGate).toHaveBeenCalled();
  });

  it("refuses when the gate refuses, and writes nothing", async () => {
    mockGate.mockResolvedValue({
      ok: false,
      response: { status: 403, json: async () => ({ ok: false, error: "Forbidden" }) },
    });
    const res = await post();
    expect(res.status).toBe(403);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin request before touching the database", async () => {
    mockAssertSameOrigin.mockReturnValue({ status: 403, json: async () => ({ ok: false, error: "Forbidden" }) });
    const res = await post();
    expect(res.status).toBe(403);
    expect(mockUserFindFirst).not.toHaveBeenCalled();
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("answers 404 for a staff id in another club, never a 403 that confirms it exists", async () => {
    // The lookup is scoped `{ id, tenantId }`, so a foreign id simply is not
    // found. A 403 here would tell an owner which ids exist in other clubs.
    mockUserFindFirst.mockResolvedValue(null as never);
    const res = await post();
    expect(res.status).toBe(404);
    expect(mockUserUpdate).not.toHaveBeenCalled();
  });

  it("is idempotent and honest: unlocking someone who was not locked says so", async () => {
    mockUserFindFirst.mockResolvedValue({
      id: "coach-9",
      name: "Sam Coates",
      email: "sam@totalbjj.com",
      role: "coach",
      failedLoginCount: 3,
      lockedUntil: null,
    } as never);
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wasLocked: boolean; message: string };
    expect(body.wasLocked).toBe(false);
    expect(body.message).toContain("not locked");
  });

  it("writes an audit row and never puts the colleague's address in it", async () => {
    await post();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-A",
        userId: "owner-1",
        action: "staff.unlock",
        entityType: "User",
        entityId: "coach-9",
      }),
    );
    // GDPR: AuditLog rows outlive an erasure, so the address is hashed exactly
    // as members/[id]/unlock and the DSAR export already do.
    const meta = mockLogAudit.mock.calls[0][0] as { metadata: Record<string, unknown> };
    expect(JSON.stringify(meta.metadata)).not.toContain("sam@totalbjj.com");
    expect(meta.metadata).toHaveProperty("staffEmailHash");
  });
});
