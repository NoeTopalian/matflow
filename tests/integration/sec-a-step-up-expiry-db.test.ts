// AH-G5 / SEC-014 / SEC-015 against a REAL database (security campaign lane A,
// 9 Oct 2026). Neon TEST branch only, through the guarded runners (both roles).
//
// Grant expiry semantics. A grant carries two expiries that are written from
// the same instant: `exp` inside the signed payload (checked by requireStepUp,
// before any write) and `stepUpExpiresAt` on the Operator row (checked by the
// conditional spend inside the mutation transaction, against the APP clock —
// `new Date()` is a bound parameter, so database/app clock skew cannot widen
// it). Either one lapsing refuses the grant. Until 9 Oct a grant whose stored
// expiry lapsed (naturally between check and spend, or moved by hand) was
// refused with the label `used`, which tells an operator investigating an
// incident that the grant was SPENT when it never was. Also pinned: a spent
// grant is `used`, a superseded one is `used`, a revoked operator session is
// `wrong_session`, and nothing is spent by a refusal.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { sha256Hex } from "@/lib/operator-auth";
import {
  StepUpRefusedError,
  consumeStepUpGrant,
  issueStepUpGrant,
  verifyStepUpGrantToken,
  type VerifiedStepUp,
} from "@/lib/operator-step-up";

process.env.AUTH_SECRET ??= "sec-a-step-up-expiry-db-test-secret-0123456789abcdef";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secA-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OP_ID = `${STAMP}-op`;

describe.skipIf(!HAS_DB)("step-up grant expiry and spend labels on Postgres (AH-G5)", () => {
  const ids = { tenant: "", owner: "" };
  const target = () => `${ids.tenant}`;

  async function grant(): Promise<{ token: string; verified: VerifiedStepUp }> {
    const { grant: token } = await issueStepUpGrant({ operatorId: OP_ID, action: "tenant.suspend", targetId: target() });
    const p = verifyStepUpGrantToken(token)!;
    return {
      token,
      verified: {
        operatorId: p.op,
        sessionVersion: p.sv,
        action: p.act,
        targetId: p.tgt,
        tenantId: p.tgt.split("/")[0],
        versionDigest: p.ver,
        requestId: sha256Hex(p.n),
      },
    };
  }
  async function spend(v: VerifiedStepUp): Promise<string> {
    try {
      const r = await withRlsBypass((tx) => consumeStepUpGrant(tx, v));
      return r.kind;
    } catch (e) {
      if (e instanceof StepUpRefusedError) return e.reason;
      throw e;
    }
  }
  const opRow = () => prisma.operator.findUniqueOrThrow({ where: { id: OP_ID }, select: { stepUpNonceHash: true, stepUpExpiresAt: true, sessionVersion: true } });

  beforeAll(async () => {
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `${STAMP}@operator.test`,
        name: "secA synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: "SYNTHETICSECRETNOTUSED",
      },
    });
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`.toLowerCase(), onboardingCompleted: true } });
      ids.tenant = t.id;
      ids.owner = (await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-owner@example.test`.toLowerCase(), name: "secA Owner", role: "owner", passwordHash: "synthetic-not-a-hash" } })).id;
    });
  }, 120_000);

  afterAll(async () => {
    if (ids.tenant) {
      await withRlsBypass(async (tx) => {
        await tx.user.deleteMany({ where: { tenantId: ids.tenant } });
        await tx.tenant.delete({ where: { id: ids.tenant } });
      }, { timeout: 60_000 });
    }
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
    const left = {
      operators: await prisma.operator.count({ where: { id: OP_ID } }),
      tenants: await withRlsBypass((tx) => tx.tenant.count({ where: { id: ids.tenant } })),
    };
    expect(left).toEqual({ operators: 0, tenants: 0 });
  }, 120_000);

  it("positive control: a live grant is spent exactly once", async () => {
    const g = await grant();
    expect(await spend(g.verified)).toBe("spent");
    expect((await opRow()).stepUpNonceHash).toBeNull();
    expect(await spend(g.verified), "a spent grant is `used`").toBe("used");
  });

  it("a grant whose STORED expiry lapsed is refused as `expired`, not `used` — and nothing is spent", async () => {
    const g = await grant();
    await prisma.operator.update({ where: { id: OP_ID }, data: { stepUpExpiresAt: new Date(Date.now() - 1000) } });
    expect(await spend(g.verified)).toBe("expired");
    const row = await opRow();
    expect(row.stepUpNonceHash, "a refusal spends nothing").toBe(g.verified.requestId);
  });

  it("the signed payload's own expiry is reported by verifyStepUpGrantToken (checked before any write)", async () => {
    const g = await grant();
    const p = verifyStepUpGrantToken(g.token)!;
    expect(p.expired).toBe(false);
    expect(p.exp - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it("a superseded grant (a newer one was issued) is refused as `used`; the newer one is spendable", async () => {
    const older = await grant();
    const newer = await grant();
    expect(await spend(older.verified)).toBe("used");
    expect(await spend(newer.verified)).toBe("spent");
  });

  it("a grant from a revoked operator session is `wrong_session`", async () => {
    const g = await grant();
    await prisma.operator.update({ where: { id: OP_ID }, data: { sessionVersion: { increment: 1 } } });
    expect(await spend(g.verified)).toBe("wrong_session");
  });

  it("five concurrent spends of one grant on separate pooled connections: exactly one `spent`", async () => {
    const g = await grant();
    const results = await Promise.all(Array.from({ length: 5 }, () => spend(g.verified)));
    expect(results.filter((r) => r === "spent")).toHaveLength(1);
    expect(results.filter((r) => r !== "spent").every((r) => r === "used")).toBe(true);
  });
});
