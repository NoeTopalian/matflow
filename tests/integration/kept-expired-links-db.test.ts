// Expired sign-in and reset links are KEPT (product rule, Noe, 6 Nov 2026:
// "nothing should be automatically deleted"): the nightly job no longer
// deletes them. This file proves on the real database that keeping them is
// safe: a link that expired long ago, still marked unused, signs nobody in
// and resets nobody's password, and is left as it was.
//
// Synthetic clubs only (slug kel…), created here and removed in afterAll.
// Runs only against the Neon TEST branch; skips without a database.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";

vi.mock("next/server", () => ({
  after: (fn: () => unknown) => { void fn(); },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
    redirect: (url: URL | string) => ({ status: 302, headers: new Headers({ location: url instanceof URL ? url.toString() : url }), cookies: { set: vi.fn() } }),
  },
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { GET as verifyMagicLink } from "@/app/api/magic-link/verify/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `kel${Date.now().toString(36)}`;
const EMAIL = `${STAMP}-owner@example.test`;
/** A synthetic password that satisfies the reset policy; not a credential of anything real. */
const SYNTHETIC_PASSWORD = `Synthetic-${STAMP}-Aa1`;
const DAY_MS = 24 * 60 * 60 * 1000;
const longAgo = () => new Date(Date.now() - 400 * DAY_MS);

describe.skipIf(!HAS_DB)("a kept expired link is refused", () => {
  let tenantId = "";
  let userId = "";

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: STAMP, onboardingCompleted: true } });
      const u = await tx.user.create({ data: { tenantId: t.id, email: EMAIL, name: "Owner", role: "owner", passwordHash: "x" } });
      tenantId = t.id;
      userId = u.id;
    });
  });

  afterAll(async () => {
    // Synthetic fixture only: removed by this test, never by the product.
    await withRlsBypass(async (tx) => {
      await tx.magicLinkToken.deleteMany({ where: { tenantId } });
      await tx.passwordResetToken.deleteMany({ where: { tenantId } });
      await tx.loginEvent.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("a sign-in link that expired 400 days ago signs nobody in and stays unused", async () => {
    const raw = randomBytes(24).toString("hex");
    const row = await withRlsBypass((tx) =>
      tx.magicLinkToken.create({ data: { tenantId, email: EMAIL, tokenHash: hashToken(raw), purpose: "login", expiresAt: longAgo() }, select: { id: true } }),
    );
    const res = (await verifyMagicLink(new Request(`https://test.local/api/magic-link/verify?token=${raw}`) as never)) as unknown as { status: number; headers: Headers };
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login?error=invalid_link");
    const after = await withRlsBypass((tx) => tx.magicLinkToken.findUnique({ where: { id: row.id }, select: { used: true } }));
    expect(after).toEqual({ used: false });
  });

  it("a reset code that expired 400 days ago resets nothing and stays unused", async () => {
    const raw = randomBytes(4).toString("hex");
    const row = await withRlsBypass((tx) =>
      tx.passwordResetToken.create({ data: { tenantId, email: EMAIL, tokenHash: hashToken(raw), expiresAt: longAgo() }, select: { id: true } }),
    );
    const res = await resetPassword(
      new Request("https://test.local/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: raw, email: EMAIL, tenantSlug: STAMP, password: SYNTHETIC_PASSWORD }),
      }),
    );
    expect(res.status).toBe(400);
    const [token, user] = await withRlsBypass(async (tx) => [
      await tx.passwordResetToken.findUnique({ where: { id: row.id }, select: { used: true } }),
      await tx.user.findUnique({ where: { id: userId }, select: { passwordHash: true } }),
    ]);
    expect(token).toEqual({ used: false });
    expect(user).toEqual({ passwordHash: "x" });
  });
});
