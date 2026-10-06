// Review finding D7 (lane H, 6 Oct 2026): the readiness "ALREADY ACTIVATED"
// verdict could be satisfied by an operator. A force-password-reset or owner
// totp-reset hands the operator the temporary password; signing in with it
// writes a LoginEvent and lets them choose the password and enrol an
// authenticator — every piece of evidence the verdict asks for. When such an
// operator reset precedes the activation evidence, the verdict is now
// "ACTIVATED AFTER OPERATOR RESET — confirm with the owner", never
// "ALREADY ACTIVATED".

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ownerActivationVerdict,
  countOperatorResetsBeforeActivation,
} from "../../scripts/readiness/activation-verdict.mjs";

const FLAGS = { totpEnabled: true, mustChangePassword: false, loginEvents: 2, supportCredentialRows: 0 };
const t = (iso: string) => new Date(iso);

describe("countOperatorResetsBeforeActivation", () => {
  const ownSet = { action: "user.password.set_own", createdAt: t("2026-10-08T10:00:00Z"), metadata: {} };
  const ownTotp = { action: "auth.totp.enrolled", createdAt: t("2026-10-08T10:05:00Z"), metadata: {} };

  it("an operator force-password-reset BEFORE the owner's own activation rows counts", () => {
    const reset = { action: "admin.owner.force_password_reset", createdAt: t("2026-10-07T09:00:00Z"), metadata: {} };
    expect(countOperatorResetsBeforeActivation([reset, ownSet, ownTotp])).toBe(1);
  });

  it("an owner totp-reset before the activation counts", () => {
    const reset = { action: "admin.owner.totp_reset", createdAt: t("2026-10-08T09:59:00Z"), metadata: {} };
    expect(countOperatorResetsBeforeActivation([ownSet, reset, ownTotp])).toBe(1);
  });

  it("a reset AFTER the latest activation evidence does not count (it would have un-set the flags)", () => {
    const reset = { action: "admin.owner.force_password_reset", createdAt: t("2026-10-09T09:00:00Z"), metadata: {} };
    expect(countOperatorResetsBeforeActivation([ownSet, ownTotp, reset])).toBe(0);
  });

  it("with no own activation rows recorded, any operator reset counts", () => {
    const reset = { action: "admin.owner.totp_reset", createdAt: t("2026-10-07T09:00:00Z"), metadata: {} };
    expect(countOperatorResetsBeforeActivation([reset])).toBe(1);
  });

  it("a LoginEvent time is activation evidence too", () => {
    const reset = { action: "admin.owner.force_password_reset", createdAt: t("2026-10-07T09:00:00Z"), metadata: {} };
    expect(countOperatorResetsBeforeActivation([reset], t("2026-10-07T10:00:00Z"))).toBe(1);
    // The only evidence predates the reset: the reset came after (and would have un-set the flags).
    expect(countOperatorResetsBeforeActivation([reset], t("2026-10-07T08:00:00Z"))).toBe(0);
  });

  it("no operator reset → 0", () => {
    expect(countOperatorResetsBeforeActivation([ownSet, ownTotp])).toBe(0);
  });
});

describe("ownerActivationVerdict with an operator reset before activation", () => {
  it("is NOT 'ALREADY ACTIVATED': ACTIVATED AFTER OPERATOR RESET — confirm with the owner", () => {
    const v = ownerActivationVerdict({ ...FLAGS, operatorResetRows: 1 });
    expect(v.activated).toBe(false);
    expect(v.state).toBe("ACTIVATED AFTER OPERATOR RESET");
    expect(v.detail).toMatch(/confirm with the owner/);
  });

  it("without one, the evidence-backed verdict is unchanged", () => {
    expect(ownerActivationVerdict({ ...FLAGS, operatorResetRows: 0 }).state).toBe("ALREADY ACTIVATED");
    expect(ownerActivationVerdict({ ...FLAGS }).state).toBe("ALREADY ACTIVATED");
  });

  it("support-attributed changes still win (stronger signal)", () => {
    expect(ownerActivationVerdict({ ...FLAGS, supportCredentialRows: 1, operatorResetRows: 1 }).state).toBe("FLAGS SET UNDER SUPPORT ACCESS");
  });

  it("both readiness scripts feed operatorResetRows into the verdict", () => {
    for (const file of ["owner-account-state.mjs", "tenant-state.mjs"]) {
      const src = readFileSync(path.join(process.cwd(), "scripts/readiness", file), "utf8");
      expect(src, file).toContain("countOperatorResetsBeforeActivation(");
      expect(src, file).toMatch(/operatorResetRows/);
    }
  });
});
