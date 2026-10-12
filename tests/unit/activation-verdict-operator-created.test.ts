// Review of lane I, finding D-I2 (6 Oct 2026, Medium): an owner created by
// POST /api/admin/create-tenant got a password the OPERATOR chose. Signing in
// with it writes a LoginEvent, and lets the holder choose a new password and
// enrol an authenticator — so the verdict read ALREADY ACTIVATED for an
// account the operator could have activated. `admin.tenant.create` now counts
// as an operator-issued credential that precedes ALL activation evidence
// (whatever the timestamps say), for the owner that row created.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ownerActivationVerdict,
  countOperatorResetsBeforeActivation,
  operatorCreateRowsFor,
  selectOwnActivationEvidence,
  OPERATOR_CREATE_ACTIONS,
} from "../../scripts/readiness/activation-verdict.mjs";

const t = (iso: string) => new Date(iso);
const OWNER = { id: "u-owner", role: "owner" };
const create = (over: Record<string, unknown> = {}) => ({
  action: "admin.tenant.create",
  createdAt: t("2026-10-07T09:00:00Z"),
  metadata: { slug: "example", ownerUserId: "u-owner" },
  ...over,
});
const ownSet = { userId: "u-owner", action: "user.password.set_own", createdAt: t("2026-10-07T10:00:00Z"), metadata: {} };
const ownTotp = { userId: "u-owner", action: "auth.totp.enrolled", createdAt: t("2026-10-07T10:05:00Z"), metadata: {} };

describe("operatorCreateRowsFor", () => {
  it("applies a create row to the owner it names", () => {
    expect(operatorCreateRowsFor([create()], OWNER)).toHaveLength(1);
  });
  it("not to a different owner (e.g. after an ownership transfer)", () => {
    expect(operatorCreateRowsFor([create()], { id: "u-other", role: "owner" })).toHaveLength(0);
  });
  it("a legacy row that names no owner applies to every owner of the club (cannot tell which)", () => {
    expect(operatorCreateRowsFor([create({ metadata: { slug: "example" } })], { id: "u-any", role: "owner" })).toHaveLength(1);
  });
  it("never to staff", () => {
    expect(operatorCreateRowsFor([create()], { id: "u-owner", role: "manager" })).toHaveLength(0);
  });
  it("ignores other actions", () => {
    expect(operatorCreateRowsFor([{ ...create(), action: "admin.application.approve" }], OWNER)).toHaveLength(0);
    expect(OPERATOR_CREATE_ACTIONS).toEqual(["admin.tenant.create"]);
  });
});

describe("admin.tenant.create precedes all activation evidence", () => {
  it("counts before own rows and a LoginEvent", () => {
    expect(countOperatorResetsBeforeActivation([create(), ownSet, ownTotp], t("2026-10-07T10:06:00Z"))).toBe(1);
  });
  it("counts even if its timestamp is not earlier (it created the account, so nothing can precede it)", () => {
    expect(countOperatorResetsBeforeActivation([create({ createdAt: t("2026-10-09T00:00:00Z") }), ownSet], t("2026-10-08T00:00:00Z"))).toBe(1);
  });
});

describe("create-tenant -> LoginEvent + own enrolment is NOT 'ALREADY ACTIVATED'", () => {
  it("reads ACTIVATED AFTER OPERATOR RESET and says the operator chose the first password", () => {
    const rows = [create(), ownSet, ownTotp];
    const own = operatorCreateRowsFor(rows, OWNER);
    const v = ownerActivationVerdict({
      totpEnabled: true,
      mustChangePassword: false,
      loginEvents: 1,
      lastSignInAt: t("2026-10-07T10:06:00Z"),
      supportCredentialRows: 0,
      operatorResetRows: countOperatorResetsBeforeActivation(rows, t("2026-10-07T10:06:00Z")),
      operatorCreatedAccount: own.length > 0,
      ownActivationEvidence: selectOwnActivationEvidence(rows, OWNER.id),
    });
    expect(v.activated).toBe(false);
    expect(v.state).toBe("ACTIVATED AFTER OPERATOR RESET");
    expect(v.detail).toMatch(/created by an operator/);
    expect(v.detail).toMatch(/confirm with the owner/);
  });

  it("Total BJJ-shaped: created by an operator, later operator reset, owner activates himself -> confirm with the owner, with the dates to ask about", () => {
    const reset = { action: "admin.owner.force_password_reset", createdAt: t("2026-10-08T09:00:00Z"), metadata: {} };
    const set = { ...ownSet, createdAt: t("2026-10-08T12:00:00Z") };
    const totp = { ...ownTotp, createdAt: t("2026-10-08T12:03:00Z") };
    const rows = [create({ createdAt: t("2026-10-03T09:00:00Z") }), reset, set, totp];
    const lastLogin = t("2026-10-08T12:04:00Z");
    const v = ownerActivationVerdict({
      totpEnabled: true,
      mustChangePassword: false,
      loginEvents: 1,
      lastSignInAt: lastLogin,
      supportCredentialRows: 0,
      operatorResetRows: countOperatorResetsBeforeActivation(rows, lastLogin),
      operatorCreatedAccount: operatorCreateRowsFor(rows, OWNER).length > 0,
      ownActivationEvidence: selectOwnActivationEvidence(rows, OWNER.id),
    });
    expect(v.state).toBe("ACTIVATED AFTER OPERATOR RESET");
    expect(v.detail).toMatch(/2 operator-issued/);
    expect(v.detail).toMatch(/2026-10-08/); // the date the owner is asked about
    expect(v.detail).toMatch(/own phone/);
    expect(v.detail).not.toMatch(/do not reset again/);
  });

  it("an owner with no operator-issued credential still reads ALREADY ACTIVATED", () => {
    const v = ownerActivationVerdict({ totpEnabled: true, mustChangePassword: false, loginEvents: 1, supportCredentialRows: 0, operatorResetRows: 0 });
    expect(v.state).toBe("ALREADY ACTIVATED");
  });
});

describe("both readiness scripts fetch the club's admin.tenant.create row", () => {
  it.each(["owner-account-state.mjs", "tenant-state.mjs"])("%s", (file) => {
    const src = readFileSync(path.join(process.cwd(), "scripts/readiness", file), "utf8");
    expect(src).toMatch(/OPERATOR_CREATE_ACTIONS/);
    expect(src).toContain("operatorCreateRowsFor(");
    expect(src).toMatch(/operatorCreatedAccount/);
  });
});
