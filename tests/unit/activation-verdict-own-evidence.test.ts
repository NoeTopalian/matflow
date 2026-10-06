// E2E flow 9 (6 Oct 2026): a genuine activation could never read ACTIVATED.
//
// The verdict demanded at least one LoginEvent, and LoginEvent rows were only
// written with NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS === "true" — not set in
// production. lib/login-event.ts now always records the row, but an owner who
// activated before that deploy has none. So the owner's OWN credential audit
// rows — user.password.set_own and (post-deploy) auth.totp.enrolled, WITHOUT
// metadata.actingAs — are accepted as evidence when there is no LoginEvent,
// the D7 operator-reset ordering still applies, and the verdict text says
// which evidence it used.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ownerActivationVerdict,
  countOperatorResetsBeforeActivation,
  countSupportCredentialRows,
  selectOwnActivationEvidence,
} from "../../scripts/readiness/activation-verdict.mjs";

const OWNER = "u-owner";
const t = (iso: string) => new Date(iso);
const FLAGS = { totpEnabled: true, mustChangePassword: false, supportCredentialRows: 0, operatorResetRows: 0 };
const setOwn = { userId: OWNER, entityId: OWNER, action: "user.password.set_own", createdAt: t("2026-10-08T10:00:00Z"), metadata: {} };
const enrolled = { userId: OWNER, entityId: OWNER, action: "auth.totp.enrolled", createdAt: t("2026-10-08T10:05:00Z"), metadata: {} };
const supportSet = { ...setOwn, metadata: { actingAs: "op-noe" } };

describe("selectOwnActivationEvidence", () => {
  it("picks the owner's own set_own row", () => {
    expect(selectOwnActivationEvidence([setOwn], OWNER)).toMatchObject({ action: "user.password.set_own" });
  });

  it("picks the latest of set_own and auth.totp.enrolled", () => {
    expect(selectOwnActivationEvidence([setOwn, enrolled], OWNER)).toMatchObject({ action: "auth.totp.enrolled" });
  });

  it("a support-written row (metadata.actingAs) NEVER counts", () => {
    expect(selectOwnActivationEvidence([supportSet], OWNER)).toBeNull();
    expect(selectOwnActivationEvidence([{ ...enrolled, metadata: { actingAs: "op-noe" } }], OWNER)).toBeNull();
  });

  it("a row written by someone else about the owner does not count", () => {
    expect(selectOwnActivationEvidence([{ ...setOwn, userId: "u-manager" }], OWNER)).toBeNull();
  });

  it("other credential actions (operator resets, recovery codes) are not activation evidence", () => {
    const rows = [
      { ...setOwn, action: "admin.owner.force_password_reset" },
      { ...setOwn, action: "auth.totp.recovery_codes.generated" },
    ];
    expect(selectOwnActivationEvidence(rows, OWNER)).toBeNull();
  });
});

describe("ownerActivationVerdict without a LoginEvent", () => {
  it("own set_own row → ACTIVATED, and the text names the evidence and the record gap", () => {
    const v = ownerActivationVerdict({ ...FLAGS, loginEvents: 0, ownActivationEvidence: setOwn });
    expect(v.activated).toBe(true);
    expect(v.state).toBe("ALREADY ACTIVATED");
    expect(v.detail).toMatch(/owner set own password 2026-10-08/);
    expect(v.detail).toMatch(/sign-in records not kept before/);
  });

  it("own auth.totp.enrolled row → ACTIVATED, naming the authenticator", () => {
    const v = ownerActivationVerdict({ ...FLAGS, loginEvents: 0, ownActivationEvidence: enrolled });
    expect(v.activated).toBe(true);
    expect(v.detail).toMatch(/owner enrolled own authenticator 2026-10-08/);
  });

  it("no own evidence → unchanged: FLAGS SET, NO OWNER SIGN-IN", () => {
    const v = ownerActivationVerdict({ ...FLAGS, loginEvents: 0, ownActivationEvidence: null });
    expect(v.activated).toBe(false);
    expect(v.state).toBe("FLAGS SET, NO OWNER SIGN-IN");
  });

  it("a support-written row never counts, end to end through the callers' helpers", () => {
    const rows = [supportSet];
    const v = ownerActivationVerdict({
      ...FLAGS,
      loginEvents: 0,
      supportCredentialRows: countSupportCredentialRows(rows),
      ownActivationEvidence: selectOwnActivationEvidence(rows, OWNER),
    });
    expect(v.activated).toBe(false);
    expect(v.state).toBe("FLAGS SET UNDER SUPPORT ACCESS");
  });

  it("D7 still applies: an operator reset before the own row → ACTIVATED AFTER OPERATOR RESET", () => {
    const reset = { userId: "op-noe", entityId: OWNER, action: "admin.owner.force_password_reset", createdAt: t("2026-10-07T09:00:00Z"), metadata: {} };
    const rows = [reset, setOwn];
    const v = ownerActivationVerdict({
      ...FLAGS,
      loginEvents: 0,
      operatorResetRows: countOperatorResetsBeforeActivation(rows, null),
      ownActivationEvidence: selectOwnActivationEvidence(rows, OWNER),
    });
    expect(v.activated).toBe(false);
    expect(v.state).toBe("ACTIVATED AFTER OPERATOR RESET");
  });

  it("with a LoginEvent, the sign-in evidence is used and named", () => {
    const v = ownerActivationVerdict({ ...FLAGS, loginEvents: 2, ownActivationEvidence: setOwn });
    expect(v.activated).toBe(true);
    expect(v.detail).toMatch(/2 owner sign-in\(s\) recorded/);
  });
});

describe("callers pass the owner's own evidence", () => {
  it.each(["owner-account-state.mjs", "tenant-state.mjs"])("%s feeds ownActivationEvidence into the verdict", (file) => {
    const src = readFileSync(path.join(process.cwd(), "scripts/readiness", file), "utf8");
    expect(src).toMatch(/selectOwnActivationEvidence\(/);
    expect(src).toMatch(/ownActivationEvidence/);
  });
});
