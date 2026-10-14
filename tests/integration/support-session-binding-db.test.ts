// Support (impersonation) session binding against REAL Postgres (lane B, 6 Oct
// 2026). The unit suite (tests/unit/support-session-binding.test.ts) proves the
// logic with in-memory rows; this proves it on the database: the migration's
// columns, the nonce written at start and cleared by the stop (a captured
// cookie dies), revocation via the operator's sessionVersion, the target's
// sessionVersion and the club's status — read through withRlsBypass, so it also
// holds under the restricted role.
//
// Neon TEST branch only (tests/setup-test-db.ts refuses the production
// endpoint). Synthetic, uniquely-named rows; deleted in afterAll. Skips without
// a database.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => { jar.set(name, value); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";
import {
  startSupportSession,
  endSupportSession,
  resolveActiveImpersonation,
  readImpersonationCookieForStop,
  IMPERSONATION_COOKIE,
} from "@/lib/impersonation";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OP_ID = `lane-b-op-${STAMP}`;
const SLUG = `lane-b-${STAMP}`;

describe.skipIf(!HAS_DB)("support session binding on the database", () => {
  let tenantId = "";
  let userId = "";

  beforeAll(async () => {
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `lane-b-${STAMP}@operator.test`,
        name: "Lane B synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: "JBSWY3DPEHPK3PXP",
        sessionVersion: 2,
      },
    });
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: "Lane B Synthetic Club", slug: SLUG } });
      tenantId = t.id;
      const u = await tx.user.create({
        data: { tenantId, email: `owner-${STAMP}@example.test`, name: "Synthetic Owner", role: "owner", passwordHash: "x", sessionVersion: 5 },
      });
      userId = u.id;
    });
  });

  afterAll(async () => {
    if (userId) await withRlsBypass((tx) => tx.user.deleteMany({ where: { id: userId } }));
    if (tenantId) await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
  });

  async function start() {
    jar.clear();
    jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP_ID, 2));
    await startSupportSession({
      operatorId: OP_ID,
      operatorSessionVersion: 2,
      target: { id: userId, tenantId, sessionVersion: 5 },
      reason: "lane B integration probe",
      scope: "view",
    });
  }

  it("the new columns exist and start null", async () => {
    const row = await prisma.operator.findUnique({ where: { id: OP_ID }, select: { supportNonceHash: true, supportExpiresAt: true } });
    expect(row).toEqual({ supportNonceHash: null, supportExpiresAt: null });
  });

  it("start writes the nonce hash; the session resolves; the stop clears it and a captured cookie is dead", async () => {
    await start();
    const row = await prisma.operator.findUnique({ where: { id: OP_ID }, select: { supportNonceHash: true, supportExpiresAt: true } });
    expect(row?.supportNonceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(row!.supportExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect((await resolveActiveImpersonation())?.target.id).toBe(userId);

    const captured = jar.get(IMPERSONATION_COOKIE)!;
    const claim = await readImpersonationCookieForStop();
    await endSupportSession({ operatorId: OP_ID, nonce: claim!.n });
    jar.set(IMPERSONATION_COOKIE, captured);
    expect(await resolveActiveImpersonation()).toBeNull();
    const after = await prisma.operator.findUnique({ where: { id: OP_ID }, select: { supportNonceHash: true } });
    expect(after?.supportNonceHash).toBeNull();
  });

  it("operator revocation (sessionVersion bump) ends it", async () => {
    await start();
    expect(await resolveActiveImpersonation()).not.toBeNull();
    await prisma.operator.update({ where: { id: OP_ID }, data: { sessionVersion: { increment: 1 } } });
    expect(await resolveActiveImpersonation()).toBeNull();
    await prisma.operator.update({ where: { id: OP_ID }, data: { sessionVersion: 2 } });
  });

  it("a target sessionVersion bump ends it", async () => {
    await start();
    expect(await resolveActiveImpersonation()).not.toBeNull();
    await withRlsBypass((tx) => tx.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } }));
    expect(await resolveActiveImpersonation()).toBeNull();
    await withRlsBypass((tx) => tx.user.update({ where: { id: userId }, data: { sessionVersion: 5 } }));
  });

  it("suspending the club ends it", async () => {
    await start();
    expect(await resolveActiveImpersonation()).not.toBeNull();
    await withRlsBypass((tx) => tx.tenant.update({ where: { id: tenantId }, data: { subscriptionStatus: "suspended" } }));
    expect(await resolveActiveImpersonation()).toBeNull();
    await withRlsBypass((tx) => tx.tenant.update({ where: { id: tenantId }, data: { subscriptionStatus: "trial" } }));
  });
});
