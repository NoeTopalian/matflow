// Single-use operator TOTP codes and step-up grants against REAL Postgres
// (lane A, 6 Oct 2026). The unit suites prove the logic with an in-memory
// table; this proves the conditional UPDATEs are atomic in the database, so
// two server instances racing the same code or grant cannot both win.
//
// Runs only against the Neon TEST branch (tests/setup-test-db.ts refuses the
// production endpoint). One synthetic Operator row with a unique id, deleted in
// afterAll. Skips without a database.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateSecret, generateSync } from "otplib";
import { prisma } from "@/lib/prisma";
import { consumeOperatorTotp } from "@/lib/operator-auth";
import { consumeStepUpGrant, issueStepUpGrant } from "@/lib/operator-step-up";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OP_ID = `lane-a-op-${STAMP}`;
const SECRET = generateSecret();

describe.skipIf(!HAS_DB)("operator single-use controls on the database", () => {
  beforeAll(async () => {
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `lane-a-${STAMP}@operator.test`,
        name: "Lane A synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: SECRET,
      },
    });
  });

  afterAll(async () => {
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
  });

  it("the new columns exist and default to null", async () => {
    const row = await prisma.operator.findUnique({
      where: { id: OP_ID },
      select: { totpLastUsedStep: true, stepUpNonceHash: true, stepUpExpiresAt: true },
    });
    expect(row).toEqual({ totpLastUsedStep: null, stepUpNonceHash: null, stepUpExpiresAt: null });
  });

  it("five concurrent uses of one TOTP code: exactly one is accepted", async () => {
    const code = generateSync({ secret: SECRET });
    const row = { id: OP_ID, totpSecret: SECRET, totpLastUsedStep: null };
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeOperatorTotp(row, code)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await prisma.operator.findUnique({ where: { id: OP_ID }, select: { totpLastUsedStep: true } });
    expect(typeof after?.totpLastUsedStep).toBe("number");
    // And later, with the stored step read back, the same code stays refused.
    expect(await consumeOperatorTotp({ ...row, totpLastUsedStep: after!.totpLastUsedStep }, code)).toBe(false);
  });

  it("five concurrent spends of one step-up grant: exactly one succeeds", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.totp_reset", targetId: "tenant-x" });
    const args = { token: grant, operatorId: OP_ID, action: "owner.totp_reset" as const, targetId: "tenant-x" };
    const results = await Promise.all(Array.from({ length: 5 }, () => consumeStepUpGrant(args)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "spent")).toBe(true);
    const row = await prisma.operator.findUnique({ where: { id: OP_ID }, select: { stepUpNonceHash: true, stepUpExpiresAt: true } });
    expect(row).toEqual({ stepUpNonceHash: null, stepUpExpiresAt: null });
  });

  it("a grant whose stored expiry has passed is refused even though its token is in date", async () => {
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.totp_reset", targetId: "tenant-x" });
    await prisma.operator.update({ where: { id: OP_ID }, data: { stepUpExpiresAt: new Date(Date.now() - 1000) } });
    const r = await consumeStepUpGrant({ token: grant, operatorId: OP_ID, action: "owner.totp_reset", targetId: "tenant-x" });
    expect(r).toEqual({ ok: false, reason: "spent" });
  });
});
