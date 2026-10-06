/**
 * A password an owner chooses for a member of staff is temporary AND expires
 * (6 Oct 2026, remediation lane B item 8; lane A did the same for operator
 * resets). Both doors — creating staff and resetting a staff password — set
 * User.tempPasswordExpiresAt 72 hours out (lib/temp-password.ts); auth.ts refuses
 * the temporary password after that and /api/auth/set-password refuses and
 * clears it (tests/unit/temp-password-expiry.test.ts, set-password-temp-expiry).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  authMock: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: h.authMock }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("bcryptjs", () => ({ default: { hash: vi.fn().mockResolvedValue("$2a$12$hashed") } }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ user: { updateMany: h.updateMany, findFirst: h.findFirst, create: h.create } }),
}));

import { POST as createStaff } from "@/app/api/staff/route";
import { PATCH as patchStaff } from "@/app/api/staff/[id]/route";
import { TEMP_PASSWORD_TTL_MS, tempPasswordExpiresAt } from "@/lib/temp-password";

const HOURS_72 = 72 * 60 * 60 * 1000;
function jsonReq(method: string, url: string, body: Record<string, unknown>) {
  return new Request(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const near72h = (d: unknown) => {
  expect(d).toBeInstanceOf(Date);
  const delta = (d as Date).getTime() - Date.now();
  expect(delta).toBeGreaterThan(HOURS_72 - 60_000);
  expect(delta).toBeLessThanOrEqual(HOURS_72);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.authMock.mockResolvedValue({ user: { id: "u-owner", role: "owner", tenantId: "t-1" } });
  h.updateMany.mockResolvedValue({ count: 1 });
  h.findFirst.mockResolvedValue({ id: "u-staff", name: "Della", email: "della@example.test", role: "manager" });
  h.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "u-new", name: data.name, email: data.email, role: data.role, createdAt: new Date(), mustChangePassword: true,
  }));
});

describe("the rule", () => {
  it("is 72 hours", () => {
    expect(TEMP_PASSWORD_TTL_MS).toBe(HOURS_72);
    expect(tempPasswordExpiresAt(0).getTime()).toBe(HOURS_72);
  });
});

describe("POST /api/staff — creating staff with an owner-chosen password", () => {
  it("sets mustChangePassword AND tempPasswordExpiresAt 72 h out", async () => {
    const res = await createStaff(
      jsonReq("POST", "http://localhost/api/staff", { name: "Della", email: "della@example.test", role: "manager", password: "TempPass123" }),
    );
    expect(res.status).toBeLessThan(300);
    const data = h.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.mustChangePassword).toBe(true);
    near72h(data.tempPasswordExpiresAt);
  });
});

describe("PATCH /api/staff/[id] — an owner resetting a staff password", () => {
  const params = { params: Promise.resolve({ id: "u-staff" }) };

  it("sets mustChangePassword AND tempPasswordExpiresAt 72 h out", async () => {
    const res = await patchStaff(jsonReq("PATCH", "http://localhost/api/staff/u-staff", { newPassword: "TempPass123" }), params);
    expect(res.status).toBe(200);
    const data = h.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data.mustChangePassword).toBe(true);
    near72h(data.tempPasswordExpiresAt);
  });

  it("an edit that does not touch the password sets no expiry", async () => {
    await patchStaff(jsonReq("PATCH", "http://localhost/api/staff/u-staff", { name: "Della Desk" }), params);
    const data = h.updateMany.mock.calls[0][0].data as Record<string, unknown>;
    expect(data).not.toHaveProperty("tempPasswordExpiresAt");
  });
});
