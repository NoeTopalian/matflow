// Owner recovery codes, operator 2FA reset and session revocation against a
// REAL database row (Sean verification, 4 Oct 2026).
//
// The unit suites pin these controls with mocked Prisma. This file runs the
// real route handlers and the real revocation check against a disposable club
// on the Neon TEST branch (tests/setup-test-db.ts refuses the production
// endpoint), seeded in the state the pending owner account is in: temporary
// password flagged, authenticator enrolled, 8 recovery codes, sessionVersion 4.
// Only the rate limiter, the audit writer, CSRF and operator auth are stubbed.
// Skips without a database.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn(() => "127.0.0.1"),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/admin-auth", () => ({ isAdminAuthed: vi.fn(async () => true) }));
vi.mock("@/lib/operator-context", () => ({ getOperatorContext: vi.fn(async () => ({ operatorId: "op-test" })) }));
// Lane A (6 Oct 2026): operator Danger Zone actions demand a step-up grant;
// passed here so the row effects stay the subject (pinned in
// tests/unit/operator-step-up.test.ts).
vi.mock("@/lib/operator-step-up", () => ({
  requireStepUp: async () => null,
  stepUpTarget: (t: string, s?: string) => (s ? `${t}/${s}` : t),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { generateRecoveryCodes } from "@/lib/recovery-codes";
import { checkSessionVersion } from "@/lib/session-revocation";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const SLUG = `orr-${STAMP}`;
const NAME = `ORR Club ${STAMP}`;
const EMAIL = `owner-${STAMP}@orr.test`;
const PASSWORD_HASH = "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a"; // never compared here

const json = (body: unknown) =>
  new Request("http://localhost/x", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost", host: "localhost" },
    body: JSON.stringify(body),
  });

describe.skipIf(!HAS_DB)("owner recovery codes, operator 2FA reset, revocation (real rows)", () => {
  let tenantId = "";
  let userId = "";
  const codes = generateRecoveryCodes();

  const row = () =>
    withRlsBypass((tx) =>
      tx.user.findUnique({
        where: { id: userId },
        select: { totpEnabled: true, totpSecret: true, totpRecoveryCodes: true, sessionVersion: true, mustChangePassword: true, passwordHash: true },
      }),
    );

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: NAME, slug: SLUG } });
      tenantId = t.id;
      const u = await tx.user.create({
        data: {
          tenantId, email: EMAIL, name: "Owner", role: "owner", passwordHash: PASSWORD_HASH,
          mustChangePassword: true, totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP",
          totpRecoveryCodes: codes.map((c) => c.hash), sessionVersion: 4,
        },
      });
      userId = u.id;
    });
  });

  afterAll(async () => {
    if (userId) await withRlsBypass((tx) => tx.user.deleteMany({ where: { id: userId } }));
    if (tenantId) await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
  });

  it("a token at the current version is honoured", async () => {
    expect(await checkSessionVersion({ userId, tokenVersion: 4 })).toBe("ok");
  });

  it("a valid recovery code clears the factor, consumes ONE code and evicts sessions — needing no password", async () => {
    const { POST } = await import("@/app/api/auth/totp/recover/route");
    const res = await POST(json({ email: EMAIL, tenantSlug: SLUG, recoveryCode: codes[0].display }));
    expect(res.status).toBe(200);
    const r = (await row())!;
    expect(r.totpEnabled).toBe(false);
    expect(r.totpSecret).toBeNull();
    expect((r.totpRecoveryCodes as string[]).length).toBe(7);
    expect(r.sessionVersion).toBe(5);
    // The temporary-password flag and the password survive.
    expect(r.mustChangePassword).toBe(true);
    expect(r.passwordHash).toBe(PASSWORD_HASH);
    expect(await checkSessionVersion({ userId, tokenVersion: 4 })).toBe("revoked");
  });

  it("the same recovery code cannot be used twice", async () => {
    const { POST } = await import("@/app/api/auth/totp/recover/route");
    const res = await POST(json({ email: EMAIL, tenantSlug: SLUG, recoveryCode: codes[0].display }));
    expect(res.status).toBe(200); // opaque by design
    const r = (await row())!;
    expect((r.totpRecoveryCodes as string[]).length).toBe(7);
    expect(r.sessionVersion).toBe(5);
  });

  it("the operator 2FA reset clears the remaining codes, bumps the version, and leaves password + flag", async () => {
    // Re-arm the factor so the reset has something to clear.
    await withRlsBypass((tx) => tx.user.update({ where: { id: userId }, data: { totpEnabled: true, totpSecret: "JBSWY3DPEHPK3PXP" } }));
    const { POST } = await import("@/app/api/admin/customers/[id]/totp-reset/route");
    const res = await POST(json({ reason: "verification test", confirmName: NAME }), { params: Promise.resolve({ id: tenantId }) });
    expect(res.status).toBe(200);
    const r = (await row())!;
    expect(r.totpEnabled).toBe(false);
    expect(r.totpSecret).toBeNull();
    expect(r.totpRecoveryCodes).toBeNull();
    expect(r.sessionVersion).toBe(6);
    expect(r.mustChangePassword).toBe(true);
    expect(r.passwordHash).toBe(PASSWORD_HASH);
    expect(await checkSessionVersion({ userId, tokenVersion: 5 })).toBe("revoked");
    expect(await checkSessionVersion({ userId, tokenVersion: 6 })).toBe("ok");
  });

  it("a deleted row is a revoked session", async () => {
    expect(await checkSessionVersion({ userId: `missing-${STAMP}`, tokenVersion: 0 })).toBe("revoked");
  });
});
