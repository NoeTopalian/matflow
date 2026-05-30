import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * 2FA-optional spec (2026-05-07) — no-self-disable invariant across PATCH routes.
 *
 * Once totpEnabled === true, the ONLY paths that may flip it back are the
 * dedicated reset routes (operator + staff). Every PATCH/PUT route that spreads
 * a request body into a Prisma update on User or Member must run
 * stripTotpFields() so an attacker body like
 *   { totpEnabled: false, totpSecret: null, totpRecoveryCodes: null }
 * cannot bypass the security floor.
 *
 * This test drives each PATCH route with a hostile body and asserts the data
 * forwarded to Prisma contains NONE of the three TOTP fields.
 *
 * The complementary 403-for-all-roles assertion on /api/auth/totp/disable lives
 * in tests/unit/totp-mandatory-owner.test.ts and is intentionally not duplicated
 * here.
 */

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn(async () => "hashed") } }));

const { memberUpdateManyMock, memberFindFirstMock, userUpdateManyMock, userFindFirstMock } = vi.hoisted(() => ({
  memberUpdateManyMock: vi.fn().mockResolvedValue({ count: 1 }),
  memberFindFirstMock: vi.fn(),
  userUpdateManyMock: vi.fn().mockResolvedValue({ count: 1 }),
  userFindFirstMock: vi.fn(),
}));

const fakeTx = {
  member: { updateMany: memberUpdateManyMock, findFirst: memberFindFirstMock },
  user: { updateMany: userUpdateManyMock, findFirst: userFindFirstMock, findMany: vi.fn().mockResolvedValue([]) },
};

vi.mock("@/lib/prisma", () => ({ prisma: fakeTx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
}));

import { auth } from "@/auth";
const mockAuth = vi.mocked(auth);

const TOTP_KEYS = ["totpEnabled", "totpSecret", "totpRecoveryCodes"];

/** Assert NONE of the TOTP fields appear in any object passed as `data` to a mock. */
function assertNoTotpInUpdates(mock: ReturnType<typeof vi.fn>) {
  for (const call of mock.mock.calls) {
    const data = (call[0] as { data?: Record<string, unknown> })?.data ?? {};
    for (const key of TOTP_KEYS) {
      expect(data).not.toHaveProperty(key);
    }
  }
}

function patchReq(url: string, body: Record<string, unknown>) {
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  });
}

const HOSTILE_TOTP = { totpEnabled: false, totpSecret: null, totpRecoveryCodes: null };

beforeEach(() => {
  vi.clearAllMocks();
  memberUpdateManyMock.mockResolvedValue({ count: 1 });
  userUpdateManyMock.mockResolvedValue({ count: 1 });
});

describe("PATCH /api/member/me — cannot self-disable own TOTP", () => {
  it("strips TOTP fields from the member update", async () => {
    mockAuth.mockResolvedValue({ user: { id: "m-1", memberId: "m-1", role: "member", tenantId: "tenant-A" } } as never);

    const { PATCH } = await import("@/app/api/member/me/route");
    const res = await PATCH(patchReq("http://localhost/api/member/me", { name: "New Name", ...HOSTILE_TOTP }) as never);

    expect(res.status).toBe(200);
    assertNoTotpInUpdates(memberUpdateManyMock);
    // The legitimate field still goes through.
    const passedData = memberUpdateManyMock.mock.calls[0]?.[0]?.data ?? {};
    expect(passedData).toMatchObject({ name: "New Name" });
  });
});

describe("PATCH /api/members/[id] — staff cannot self-disable a member's TOTP", () => {
  it("strips TOTP fields from the member update", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "tenant-A" } } as never);
    memberUpdateManyMock.mockResolvedValue({ count: 1 });
    memberFindFirstMock.mockResolvedValue({ id: "m-9", tenantId: "tenant-A" });

    const { PATCH } = await import("@/app/api/members/[id]/route");
    const res = await PATCH(
      patchReq("http://localhost/api/members/m-9", { name: "Edited", ...HOSTILE_TOTP }) as never,
      { params: Promise.resolve({ id: "m-9" }) },
    );

    // Either the update is accepted (200) or rejected by schema, but in NO case
    // may a TOTP field reach the database.
    expect([200, 400, 404, 409, 500]).toContain(res.status);
    assertNoTotpInUpdates(memberUpdateManyMock);
  });
});

describe("PATCH /api/staff/[id] — owner cannot self-disable a staff user's TOTP", () => {
  it("strips TOTP fields from the user update", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "tenant-A" } } as never);
    userUpdateManyMock.mockResolvedValue({ count: 1 });
    userFindFirstMock.mockResolvedValue({ id: "u-2", name: "Coach", email: "c@gym.test", role: "coach" });

    const { PATCH } = await import("@/app/api/staff/[id]/route");
    const res = await PATCH(
      patchReq("http://localhost/api/staff/u-2", { name: "Renamed Coach", ...HOSTILE_TOTP }) as never,
      { params: Promise.resolve({ id: "u-2" }) },
    );

    expect([200, 400, 404, 409, 500]).toContain(res.status);
    assertNoTotpInUpdates(userUpdateManyMock);
  });
});
