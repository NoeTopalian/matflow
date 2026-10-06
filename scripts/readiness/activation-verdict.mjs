// The owner-activation verdict, shared by owner-account-state.mjs and
// tenant-state.mjs (6 Oct 2026, operator audit Q4 / remediation lane B).
//
// "ALREADY ACTIVATED" used to be read from two row flags alone
// (totpEnabled && !mustChangePassword) — flags a support (impersonation)
// session could set. Support sessions are now read-only, but the verdict must
// not depend on that alone: it also demands evidence that the OWNER signed in
// (at least one LoginEvent — written only by a real sign-in, never by a
// support session) and that no password / authenticator audit row for the
// owner was written by someone acting as them (metadata.actingAs).
//
// Sign-in records (E2E flow 9, 6 Oct 2026): LoginEvent rows used to be written
// only with NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS === "true", which production
// does not set, so no genuine activation could read ACTIVATED. lib/login-event.ts
// now always writes the row; for an owner who activated before that deploy, the
// owner's OWN credential audit rows (user.password.set_own, auth.totp.enrolled —
// never one carrying metadata.actingAs, and only when no operator reset precedes
// them, D7) stand in for the LoginEvent, and the verdict says so.
//
// Pure, no imports: unit-tested in tests/unit/impersonation-cannot-activate.test.ts.

/** Audit actions that change the owner's own credentials or second factor. */
export const CREDENTIAL_ACTION_RE = /(password|totp|recovery)/i;

/**
 * @param {object} owner
 * @param {boolean} owner.totpEnabled
 * @param {boolean} owner.mustChangePassword
 * @param {number} owner.loginEvents          LoginEvent rows for the owner
 * @param {number} owner.supportCredentialRows credential audit rows for the owner carrying metadata.actingAs
 * @param {{ action: string, createdAt: Date | string } | null} [owner.ownActivationEvidence]
 *                                            the owner's latest own activation row
 *                                            (selectOwnActivationEvidence) - used when
 *                                            there is no LoginEvent
 * @param {number} [owner.operatorResetRows]  operator force-password-reset / owner totp-reset rows for the
 *                                            owner that precede the activation evidence
 *                                            (countOperatorResetsBeforeActivation; includes admin.tenant.create)
 * @param {boolean} [owner.operatorCreatedAccount] an admin.tenant.create row applies to this owner
 *                                            (operatorCreateRowsFor) - the operator chose the first password
 * @param {Date | string | null} [owner.lastSignInAt] the owner's latest LoginEvent time, for the wording
 * @returns {{ activated: boolean, state: string, detail: string }}
 */
export function ownerActivationVerdict(owner) {
  const flagsSay = owner.totpEnabled === true && owner.mustChangePassword === false;
  const loginEvents = Number(owner.loginEvents ?? 0);
  const supportRows = Number(owner.supportCredentialRows ?? 0);
  const operatorResets = Number(owner.operatorResetRows ?? 0);
  if (!flagsSay) {
    return { activated: false, state: "NOT ACTIVATED", detail: "authenticator and/or own password not yet in place" };
  }
  if (supportRows > 0) {
    return {
      activated: false,
      state: "FLAGS SET UNDER SUPPORT ACCESS",
      detail: `${supportRows} password/authenticator audit row(s) for the owner were written by an operator acting as them (metadata.actingAs) - not the owner's own activation; investigate before handover`,
    };
  }
  const own = owner.ownActivationEvidence ?? null;
  if (loginEvents < 1 && !own) {
    return {
      activated: false,
      state: "FLAGS SET, NO OWNER SIGN-IN",
      detail: "authenticator enrolled and password changed, but no LoginEvent exists for the owner - not evidence the owner did it; confirm with the owner",
    };
  }
  // Review finding D7 (6 Oct 2026): an operator reset hands the operator the
  // temporary password, and signing in with it produces every piece of
  // evidence above (a LoginEvent, an own password, an enrolled authenticator).
  // So after an operator reset the verdict cannot tell the owner from the
  // operator: say so instead of ALREADY ACTIVATED.
  // Review of lane I, D-I2: an owner created by POST /api/admin/create-tenant
  // signed in first with a password the OPERATOR chose (admin.tenant.create,
  // counted in operatorResetRows) - the same ambiguity.
  if (operatorResets > 0) {
    const created = owner.operatorCreatedAccount === true
      ? " (including the account's first password: the account was created by an operator through create-tenant, and the operator chose that password)"
      : "";
    const evidence = describeEvidenceForConfirmation(own, loginEvents, owner.lastSignInAt ?? null);
    return {
      activated: false,
      state: "ACTIVATED AFTER OPERATOR RESET",
      detail:
        `${operatorResets} operator-issued password/authenticator credential(s) for the owner precede the activation evidence${created} - ` +
        `whoever held that temporary password could have activated. Evidence on record: ${evidence.text}. ` +
        `To close this, confirm with the owner on a channel you verified yourself (a phone call or in person - not a reply to the account's own email): ` +
        `"Did you choose your own MatFlow password and scan the authenticator QR code yourself, on your own phone${evidence.dated ? ", on the date(s) above" : ""}?" ` +
        `Yes: record who confirmed, how and when, and treat the owner as activated. No or unsure: issue a new operator reset and have the owner activate while you watch`,
    };
  }
  if (loginEvents < 1) {
    return {
      activated: true,
      state: "ALREADY ACTIVATED",
      detail: `ACTIVATED - ${describeOwnEvidence(own)}; sign-in records not kept before ${SIGN_IN_RECORDS_SINCE}. Authenticator enrolled, own password chosen, no support-attributed credential change; do not reset again unless compromise is suspected`,
    };
  }
  return {
    activated: true,
    state: "ALREADY ACTIVATED",
    detail: `authenticator enrolled, own password chosen, ${loginEvents} owner sign-in(s) recorded, no support-attributed credential change; do not reset again unless compromise is suspected`,
  };
}

/** Where the record gap ends. No date: the fix's deploy date is not known here. */
export const SIGN_IN_RECORDS_SINCE = "the deploy that made sign-in records unconditional (lib/login-event.ts, 6 Oct 2026 fix)";

/** The owner's own activation actions, accepted as evidence when no LoginEvent exists. */
export const OWN_ACTIVATION_ACTIONS = ["user.password.set_own", "auth.totp.enrolled"];

function describeOwnEvidence(row) {
  const d = new Date(row.createdAt);
  const day = Number.isNaN(d.getTime()) ? "(date unknown)" : d.toISOString().slice(0, 10);
  return row.action === "auth.totp.enrolled"
    ? `owner enrolled own authenticator ${day}`
    : `owner set own password ${day}`;
}

/** The owner's evidence, with dates, for the person confirming with the owner (D-I2). */
function describeEvidenceForConfirmation(own, loginEvents, lastSignInAt) {
  const parts = [];
  let dated = false;
  if (own) {
    parts.push(describeOwnEvidence(own));
    dated = !Number.isNaN(new Date(own.createdAt).getTime());
  }
  if (loginEvents > 0) {
    const d = lastSignInAt ? new Date(lastSignInAt) : null;
    const day = d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
    parts.push(`${loginEvents} owner sign-in record(s)${day ? `, latest ${day}` : ""}`);
    if (day) dated = true;
  }
  return { text: parts.length ? parts.join("; ") : "none dated", dated };
}

function hasActingAs(m) {
  return !!m && typeof m === "object" && typeof m.actingAs === "string" && m.actingAs.length > 0;
}

/**
 * The owner's latest OWN activation row: user.password.set_own or
 * auth.totp.enrolled, written by the owner themselves (userId === ownerId) and
 * carrying no metadata.actingAs. A row written under support access never counts.
 * @param {Array<{ userId?: string | null, action: string, metadata: unknown, createdAt: Date | string }>} rows
 * @param {string} ownerId
 * @returns {{ action: string, createdAt: Date | string } | null}
 */
export function selectOwnActivationEvidence(rows, ownerId) {
  let best = null;
  for (const r of rows) {
    if (!OWN_ACTIVATION_ACTIONS.includes(String(r.action ?? ""))) continue;
    if (r.userId !== ownerId) continue;
    if (hasActingAs(r.metadata)) continue;
    const at = new Date(r.createdAt).getTime();
    if (Number.isNaN(at)) continue;
    if (!best || at > new Date(best.createdAt).getTime()) best = { action: r.action, createdAt: r.createdAt };
  }
  return best;
}

/** Operator resets that hand someone else the owner's way in (review finding D7). */
export const OPERATOR_RESET_ACTIONS = ["admin.owner.force_password_reset", "admin.owner.totp_reset"];

/**
 * Count the operator resets for the owner that precede the activation evidence:
 * the latest of the owner's own credential rows (any password / totp / recovery
 * action that is not admin.*) and the latest LoginEvent. With no own evidence at
 * all, every operator reset counts. A reset AFTER the evidence does not: it
 * un-sets the flags itself (mustChangePassword / totpEnabled).
 * @param {Array<{ action: string, createdAt: Date | string }>} rows the owner's credential audit rows
 * @param {Date | string | null} [lastLoginAt] the owner's latest LoginEvent time
 */
export function countOperatorResetsBeforeActivation(rows, lastLoginAt = null) {
  const time = (v) => (v ? new Date(v).getTime() : NaN);
  let evidence = time(lastLoginAt);
  for (const r of rows) {
    const action = String(r.action ?? "");
    if (action.startsWith("admin.") || !CREDENTIAL_ACTION_RE.test(action)) continue;
    const at = time(r.createdAt);
    if (!Number.isNaN(at) && (Number.isNaN(evidence) || at > evidence)) evidence = at;
  }
  return rows.filter((r) => {
    const action = String(r.action ?? "");
    // The account's creation by an operator precedes ALL evidence, whatever the
    // timestamps say (D-I2): nothing the owner did can come before it.
    if (OPERATOR_CREATE_ACTIONS.includes(action)) return true;
    if (!OPERATOR_RESET_ACTIONS.includes(action)) return false;
    return Number.isNaN(evidence) || time(r.createdAt) < evidence;
  }).length;
}

/**
 * Review of lane I, D-I2 (6 Oct 2026): POST /api/admin/create-tenant creates the
 * owner with a password the OPERATOR chose. Its audit row (tenant-level:
 * userId null, entityId = tenant id) is therefore an operator-issued credential
 * for that owner, counted by countOperatorResetsBeforeActivation as preceding
 * all evidence. (admin.application.approve is NOT one: its password is random
 * and never shown; the owner gets in through an emailed activation link.)
 */
export const OPERATOR_CREATE_ACTIONS = ["admin.tenant.create"];

/**
 * The club's admin.tenant.create rows that apply to this user: owners only; a
 * row naming the owner it created (metadata.ownerUserId, written since 6 Oct
 * 2026) applies to that owner alone, an older row that names none applies to
 * every owner of the club (it cannot tell which one it created).
 * @param {Array<{ action: string, metadata: unknown, createdAt: Date | string }>} tenantRows
 * @param {{ id: string, role: string }} user
 */
export function operatorCreateRowsFor(tenantRows, user) {
  if (user.role !== "owner") return [];
  return tenantRows.filter((r) => {
    if (!OPERATOR_CREATE_ACTIONS.includes(String(r.action ?? ""))) return false;
    const m = r.metadata;
    const named = m && typeof m === "object" && typeof m.ownerUserId === "string" ? m.ownerUserId : null;
    return named === null || named === user.id;
  });
}

/**
 * Count the owner's credential audit rows that carry metadata.actingAs.
 * @param {Array<{ action: string, metadata: unknown }>} rows
 */
export function countSupportCredentialRows(rows) {
  return rows.filter((r) => {
    if (!CREDENTIAL_ACTION_RE.test(String(r.action ?? ""))) return false;
    if (String(r.action).startsWith("admin.")) return false; // operator plane actions name the operator by design
    const m = r.metadata;
    return !!m && typeof m === "object" && typeof m.actingAs === "string" && m.actingAs.length > 0;
  }).length;
}
