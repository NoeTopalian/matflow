// SEC-007 — a consumed recovery factor cannot authorise another operation
// (security campaign lane A, 9 Oct 2026). REAL database, Neon TEST branch
// only, both roles through the guarded runners.
//
// POST /api/auth/totp/recover (public: email + club + one recovery code) turns
// the second factor off and removes the code from the stored list. Until 9 Oct
// it read the list, computed the remainder and wrote it back unconditionally,
// so two concurrent recoveries both "succeeded": sessionVersion moved twice,
// two `auth.totp.recovery.used` rows were written, and the later write put the
// code the earlier request had consumed BACK into the list (still usable). The
// route answers {ok:true} for every outcome (anti-enumeration), so every
// assertion here is on the database.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.12",
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { generateRecoveryCodes, recoveryCodeArrayFromJson } from "@/lib/recovery-codes";
import { POST as recover } from "@/app/api/auth/totp/recover/route";

process.env.AUTH_SECRET ??= "sec-a-recovery-race-db-test-secret-0123456789abcdef";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`.toLowerCase();
const ORIGIN = "http://localhost:3847";
const post = (body: unknown) =>
  new Request(`${ORIGIN}/api/auth/totp/recover`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe.skipIf(!HAS_DB)("recovery codes are single-use under concurrency (SEC-007)", () => {
  const ids = { tenant: "", slug: "" };

  async function mkUser(who: string, totpEnabled = true) {
    const codes = generateRecoveryCodes();
    const id = await withRlsBypass(async (tx) =>
      (
        await tx.user.create({
          data: {
            tenantId: ids.tenant, email: E(who), name: `secA ${who}`, role: "coach", passwordHash: "synthetic-not-a-hash",
            totpEnabled, totpSecret: totpEnabled ? "SYNTHETICSECRETNOTUSED" : null, totpRecoveryCodes: codes.map((c) => c.hash),
          },
        })
      ).id,
    );
    return { id, email: E(who), codes };
  }
  const state = (id: string) =>
    withRlsBypass(async (tx) => {
      const u = await tx.user.findUniqueOrThrow({ where: { id }, select: { totpEnabled: true, sessionVersion: true, totpRecoveryCodes: true } });
      return { totpEnabled: u.totpEnabled, sessionVersion: u.sessionVersion, codes: recoveryCodeArrayFromJson(u.totpRecoveryCodes) };
    });
  async function usedRows(id: string) {
    // logAudit is best-effort here (after the response): poll briefly.
    let n = 0;
    for (let i = 0; i < 12; i++) {
      n = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: ids.tenant, entityId: id, action: "auth.totp.recovery.used" } }));
      await new Promise((r) => setTimeout(r, 250));
    }
    return n;
  }

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.slug = t.slug;
    });
  }, 120_000);

  afterAll(async () => {
    if (!ids.tenant) return;
    await new Promise((r) => setTimeout(r, 750));
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.user.deleteMany({ where: { tenantId: ids.tenant } });
      await tx.tenant.delete({ where: { id: ids.tenant } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: ids.tenant } }),
      users: await tx.user.count({ where: { tenantId: ids.tenant } }),
    }));
    expect(left).toEqual({ tenants: 0, users: 0 });
  }, 120_000);

  it("positive control: one recovery switches the factor off, removes that code, bumps the version once", async () => {
    const u = await mkUser("single");
    await recover(post({ email: u.email, tenantSlug: ids.slug, recoveryCode: u.codes[0].display }));
    const s = await state(u.id);
    expect(s).toMatchObject({ totpEnabled: false, sessionVersion: 1 });
    expect(s.codes).toHaveLength(7);
    expect(s.codes).not.toContain(u.codes[0].hash);
  }, 60_000);

  it("two DIFFERENT codes at once: exactly one recovery, and no consumed code comes back", async () => {
    const u = await mkUser("two-codes");
    await Promise.all([
      recover(post({ email: u.email, tenantSlug: ids.slug, recoveryCode: u.codes[0].display })),
      recover(post({ email: u.email, tenantSlug: ids.slug, recoveryCode: u.codes[1].display })),
    ]);
    const s = await state(u.id);
    expect(s.totpEnabled).toBe(false);
    expect(s.sessionVersion, "the recovery happened once").toBe(1);
    expect(s.codes).toHaveLength(7);
    const consumed = [u.codes[0].hash, u.codes[1].hash].filter((h) => !s.codes.includes(h));
    expect(consumed, "exactly one of the two codes was spent, and it stays spent").toHaveLength(1);
    expect(await usedRows(u.id)).toBe(1);
  }, 60_000);

  it("the SAME code twice at once: one recovery", async () => {
    const u = await mkUser("same-code");
    await Promise.all([
      recover(post({ email: u.email, tenantSlug: ids.slug, recoveryCode: u.codes[2].display })),
      recover(post({ email: u.email, tenantSlug: ids.slug, recoveryCode: u.codes[2].display })),
    ]);
    const s = await state(u.id);
    expect(s.sessionVersion).toBe(1);
    expect(s.codes).not.toContain(u.codes[2].hash);
    expect(await usedRows(u.id)).toBe(1);
  }, 60_000);

  it("no second factor to recover: nothing is spent and nothing changes", async () => {
    const u = await mkUser("no-totp", false);
    await recover(post({ email: u.email, tenantSlug: ids.slug, recoveryCode: u.codes[0].display }));
    const s = await state(u.id);
    expect(s).toMatchObject({ totpEnabled: false, sessionVersion: 0 });
    expect(s.codes).toHaveLength(8);
  }, 60_000);
});
