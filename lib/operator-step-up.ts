/**
 * Operator step-up re-authentication (6 Oct 2026; bindings, atomic spend and
 * idempotent replay 9 Oct 2026, admin hub lane C, ledger AH-03).
 *
 * The highest-impact operator actions — resetting an owner's password or second
 * factor, clearing a member's second factor, transferring ownership, deleting or
 * suspending a club, changing an owner's login email or name, starting a support
 * session — need FRESH proof that the named operator is at the keyboard, not
 * just an 8-hour session cookie that might have been copied.
 *
 *   1. The operator (MFA-verified session), having entered the data, POSTs a
 *      current authenticator code with { action, targetId, change } to
 *      /api/admin/auth/step-up. `change` is the canonical intended change
 *      (e.g. { newEmail } or { name }; {} for actions whose change is the
 *      subject's state only, such as a reset or a suspension).
 *   2. The code is spent through `consumeOperatorTotp` (single use, every
 *      instance), and the operator receives a GRANT: an HMAC-signed payload
 *      bound to
 *        op  — the operator id,
 *        sv  — the operator's sessionVersion when it was issued (a sign-out
 *              everywhere / revocation kills every outstanding grant),
 *        act — the action, tgt — stepUpTarget(tenant, subject, subAction),
 *        chg — a KEYED digest of the canonical change (HMAC with the server
 *              secret, so the payload the browser holds is not a plain hash of
 *              a predictable address),
 *        ver — a keyed digest of the subject's record version, resolved on the
 *              server when the grant is issued (stepUpVersion below),
 *        exp — 5 minutes, n — a random nonce.
 *   3. The action route calls `requireStepUp(req, ctx, action, target, { change })`
 *      AFTER its harmless preflight (parse, 404, 409, "unchanged"). That checks
 *      signature, expiry, operator, session, action, target and change — and
 *      spends NOTHING. It returns the verified grant.
 *   4. Inside the route's mutation transaction, `consumeStepUpGrant(tx, grant)`
 *      runs the single-use conditional UPDATE on the Operator row, then
 *      re-reads the subject's version. The route then re-validates, mutates and
 *      writes its audit row (logAudit({ tx, requestId: grant.requestId })) in
 *      the SAME transaction. An audit failure therefore rolls back the spend and
 *      the mutation together: the grant stays usable and nothing changed.
 *
 * SINGLE USE ACROSS INSTANCES. The Operator row holds the SHA-256 of the one
 * outstanding nonce and its expiry. Consumption is ONE conditional update
 *   UPDATE "Operator" SET stepUpNonceHash = NULL, stepUpExpiresAt = NULL
 *   WHERE id = $op AND stepUpNonceHash = $hash AND stepUpExpiresAt > now()
 *     AND sessionVersion = $sv
 * and succeeds for exactly one caller; a concurrent second caller blocks on the
 * row lock and then matches nothing. Issuing a new grant supersedes the old one.
 *
 * IDEMPOTENT REPLAY. The SHA-256 of the nonce is the request id written to the
 * outcome audit row's `requestId` column. When the nonce is already gone, the
 * route asks for the outcome row by (tenant, outcome action, requestId): if the
 * mutation committed, the route answers 200 with the recorded minimal result
 * and `alreadyApplied: true`, and changes nothing; if not, 403 `used`. A
 * double-click therefore never mutates twice and never bumps a sessionVersion
 * twice: the second request either finds the nonce spent (replay path) or, if
 * it is somehow still outstanding, the subject's version moved (409 stale).
 *
 * The grant travels in the `x-matflow-step-up` request header.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { OP_SESSION_COOKIE, resolveOperatorFromCookie, sha256Hex } from "@/lib/operator-auth";
import { emailField } from "@/lib/email-normalise";
import { displayNameSchema } from "@/lib/account-profile";
import { logAudit } from "@/lib/audit-log";

export const STEP_UP_HEADER = "x-matflow-step-up";
export const STEP_UP_TTL_MS = 5 * 60 * 1000;
const STEP_UP_HMAC_DOMAIN = "operator-step-up.v2.";
const CHANGE_HMAC_DOMAIN = "operator-step-up.change.v1.";
const VERSION_HMAC_DOMAIN = "operator-step-up.version.v1.";

export const STEP_UP_ACTIONS = [
  "owner.force_password_reset",
  "owner.totp_reset",
  "member.totp_reset",
  "tenant.transfer_ownership",
  "tenant.soft_delete",
  // Suspending a club signs every user and member of it out (review of lanes
  // A/B/D, 6 Oct 2026). POST only: un-suspending is the recovery direction.
  "tenant.suspend",
  // Support session start; target = stepUpTarget(tenantId, userId).
  "support.impersonate",
  // EDIT support session start (hub club edit access, 13 Oct 2026); target =
  // stepUpTarget(tenantId, userId, "edit"), so a grant bought for viewing can
  // never start an edit session.
  "support.edit",
  // Owner login email (7 Oct 2026): mark provisional, clear provisional,
  // change. Target = stepUpTarget(tenantId, ownerUserId, subAction), so a grant
  // for one club's owner cannot be spent on another account, nor a grant for
  // one sub-action on another.
  "owner.login_email",
  // Owner display-name correction (8 Oct 2026, account-editing lane R).
  // Target = stepUpTarget(tenantId, ownerUserId, "name").
  "owner.profile",
  // A member's contact address, moved by the operator to free a login address
  // for the owner (admin hub lane F, 9 Oct 2026). Target =
  // stepUpTarget(tenantId, memberId, "change"); change = { newEmail }.
  "member.contact_email",
  // Incident revoke-all (security campaign lane A, 9 Oct 2026, AH-R7 /
  // SEC-013): end every session and retire every sign-in token of one staff
  // user, one member, or a whole club. Target = stepUpTarget(tenantId,
  // subjectId, scope) with scope "user" | "member", or
  // stepUpTarget(tenantId, CLUB_REVOKE_SUBJECT, "club") for the whole club.
  "access.revoke_all",
] as const;
export type StepUpAction = (typeof STEP_UP_ACTIONS)[number];

export function isStepUpAction(value: unknown): value is StepUpAction {
  return typeof value === "string" && (STEP_UP_ACTIONS as readonly string[]).includes(value);
}

/**
 * The target string a grant is bound to. Routes and the Danger Zone build it
 * the same way: the tenant, then (where the action picks a person) that
 * person's id — so a grant for member A cannot be spent on member B — then
 * (where one action covers several operations) the sub-action, so a grant
 * bought for "mark provisional" cannot be spent on "change" (review defect 7,
 * 7 Oct 2026).
 */
export function stepUpTarget(tenantId: string, subjectId?: string, subAction?: string): string {
  return [tenantId, subjectId, subAction].filter((p): p is string => typeof p === "string" && p.length > 0).join("/");
}

// ─── The canonical intended change ──────────────────────────────────────────

/** A flat object of primitives — the only shape a change may take. */
export type StepUpChange = Record<string, string | number | boolean | null>;

const EMPTY_CHANGE = z.object({}).strict();
/**
 * Per action, the change the operator declares and the route re-derives from
 * its own body. Parsed with the SAME normalisation on both sides (the address
 * is trimmed and lower-cased by emailField; the name trimmed), so the operator
 * typing "  Ann@X.test" and the route reading "ann@x.test" agree, while a
 * different address or name never does.
 */
const CHANGE_SCHEMAS: Record<StepUpAction, z.ZodType<StepUpChange>> = {
  "owner.force_password_reset": EMPTY_CHANGE,
  "owner.totp_reset": EMPTY_CHANGE,
  "member.totp_reset": EMPTY_CHANGE,
  "tenant.transfer_ownership": EMPTY_CHANGE,
  "tenant.soft_delete": EMPTY_CHANGE,
  "tenant.suspend": EMPTY_CHANGE,
  "support.impersonate": EMPTY_CHANGE,
  "support.edit": EMPTY_CHANGE,
  "owner.login_email": z.union([z.object({ newEmail: emailField(120) }).strict(), EMPTY_CHANGE]),
  "owner.profile": z.object({ name: displayNameSchema }).strict(),
  "member.contact_email": z.object({ newEmail: emailField(120) }).strict(),
  "access.revoke_all": EMPTY_CHANGE,
};

/** The subject segment of a whole-club revoke-all target (never a cuid). */
export const CLUB_REVOKE_SUBJECT = "all";

/** Normalise a declared change for `action`; null when it is not a valid change for it. */
export function canonicalStepUpChange(action: StepUpAction, raw: unknown): StepUpChange | null {
  const parsed = CHANGE_SCHEMAS[action].safeParse(raw ?? {});
  return parsed.success ? parsed.data : null;
}

/** Sorted-key JSON of a flat change object: one byte sequence per change. */
function canonicalJson(change: StepUpChange): string {
  return JSON.stringify(Object.keys(change).sort().map((k) => [k, change[k]]));
}

function keyed(domain: string, value: string): string {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(`${domain}${value}`).digest("hex");
}

/** Keyed digest of the canonical change (never a plain hash of an address). */
export function stepUpChangeDigest(action: StepUpAction, change: StepUpChange): string {
  return keyed(CHANGE_HMAC_DOMAIN, `${action}\n${canonicalJson(change)}`);
}

// ─── The subject's record version ───────────────────────────────────────────

/**
 * The version of the record the action will change, as a string, or null when
 * the subject does not exist. Field-specific on purpose: a User's `updatedAt`
 * moves on every failed sign-in (failedLoginCount), so binding a recovery
 * action to it would let anyone hammering the owner's login keep the operator
 * from ever resetting it. Each version is the state the operator decided on.
 * Hashed (keyed) before it enters a grant, so the payload carries no address.
 */
export async function stepUpVersion(
  tx: Prisma.TransactionClient,
  action: StepUpAction,
  targetId: string,
): Promise<string | null> {
  const [tenantId, subjectId] = targetId.split("/");
  if (!tenantId) return null;

  const firstOwner = () =>
    tx.user.findFirst({
      where: { tenantId, role: "owner" },
      orderBy: { createdAt: "asc" },
      select: { id: true, email: true, name: true, sessionVersion: true, totpEnabled: true, loginEmailProvisionalSince: true },
    });

  switch (action) {
    case "owner.force_password_reset": {
      const o = await firstOwner();
      return o ? `owner:${o.id}:sv${o.sessionVersion}` : null;
    }
    case "owner.totp_reset": {
      const o = await firstOwner();
      return o ? `owner:${o.id}:sv${o.sessionVersion}:totp${o.totpEnabled}` : null;
    }
    case "owner.login_email": {
      const o = await firstOwner();
      if (!o || o.id !== subjectId) return null;
      const since = o.loginEmailProvisionalSince ? new Date(o.loginEmailProvisionalSince).toISOString() : "-";
      return `owner:${o.id}:sv${o.sessionVersion}:email=${o.email}:provisional=${since}`;
    }
    case "owner.profile": {
      const o = await firstOwner();
      if (!o || o.id !== subjectId) return null;
      return `owner:${o.id}:name=${o.name}`;
    }
    case "member.totp_reset": {
      if (!subjectId) return null;
      const m = await tx.member.findFirst({
        where: { id: subjectId, tenantId },
        select: { id: true, sessionVersion: true, totpEnabled: true },
      });
      return m ? `member:${m.id}:sv${m.sessionVersion}:totp${m.totpEnabled}` : null;
    }
    case "member.contact_email": {
      // What the operator decided on: this member, at this address, with this
      // import identity, able (or not) to sign in, at this session version.
      // Never updatedAt (it moves for reasons unrelated to the address).
      if (!subjectId) return null;
      const m = await tx.member.findFirst({
        where: { id: subjectId, tenantId },
        select: { id: true, sessionVersion: true, email: true, externalRef: true, passwordHash: true },
      });
      if (!m) return null;
      return `member:${m.id}:sv${m.sessionVersion}:email=${m.email.trim().toLowerCase()}:ext=${m.externalRef ?? "-"}:pw=${m.passwordHash != null}`;
    }
    case "tenant.transfer_ownership": {
      if (!subjectId) return null;
      const o = await firstOwner();
      const t = await tx.user.findFirst({
        where: { id: subjectId, tenantId },
        select: { id: true, role: true, sessionVersion: true },
      });
      return o && t ? `owner:${o.id}:sv${o.sessionVersion}|to:${t.id}:${t.role}:sv${t.sessionVersion}` : null;
    }
    case "tenant.suspend":
    case "tenant.soft_delete": {
      const t = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, subscriptionStatus: true, deletedAt: true },
      });
      if (!t) return null;
      const deleted = t.deletedAt ? new Date(t.deletedAt).toISOString() : "-";
      return `tenant:${t.id}:${t.subscriptionStatus}:deleted=${deleted}`;
    }
    case "access.revoke_all": {
      // Existence ONLY, never a session version: revoking is idempotent ("end
      // whatever exists now"), and a version that moves on every sign-out
      // would let the attacker being evicted keep the operator's grant stale
      // (log out everywhere, sign in, repeat) — an incident control that the
      // incident can block. A grant for one scope never fits another, and a
      // subject deleted or moved since issue yields null (refused).
      const scope = targetId.split("/")[2];
      if (!subjectId) return null;
      if (scope === "user") {
        const u = await tx.user.findFirst({ where: { id: subjectId, tenantId }, select: { id: true } });
        return u ? `revoke:user:${tenantId}:${u.id}` : null;
      }
      if (scope === "member") {
        const m = await tx.member.findFirst({ where: { id: subjectId, tenantId }, select: { id: true } });
        return m ? `revoke:member:${tenantId}:${m.id}` : null;
      }
      if (scope === "club" && subjectId === CLUB_REVOKE_SUBJECT) {
        const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
        return t ? `revoke:club:${t.id}` : null;
      }
      return null;
    }
    case "support.impersonate":
    case "support.edit": {
      // Same digest inputs for both scopes: the operator looked at the same
      // person either way; the action name (bound into the grant) is what
      // separates them.
      if (!subjectId) return null;
      const u = await tx.user.findUnique({
        where: { id: subjectId },
        select: { id: true, tenantId: true, role: true, sessionVersion: true },
      });
      return u && u.tenantId === tenantId ? `user:${u.id}:${u.role}:sv${u.sessionVersion}` : null;
    }
  }
}

function versionDigest(version: string): string {
  return keyed(VERSION_HMAC_DOMAIN, version);
}

/**
 * The keyed version digest read with the caller's transaction client, or null
 * when the subject does not exist. Lets a route hand the operator an OPAQUE
 * version of what they looked at (the hub's address check) and compare it
 * again inside the mutation — the digest carries no address.
 */
export async function stepUpVersionDigestIn(
  tx: Prisma.TransactionClient,
  action: StepUpAction,
  targetId: string,
): Promise<string | null> {
  const v = await stepUpVersion(tx, action, targetId);
  return v === null ? null : versionDigest(v);
}

/** The keyed version digest, read in its own transaction (for issuing). */
export async function resolveStepUpVersionDigest(action: StepUpAction, targetId: string): Promise<string | null> {
  const v = await withRlsBypass((tx) => stepUpVersion(tx, action, targetId));
  return v === null ? null : versionDigest(v);
}

// ─── The grant ──────────────────────────────────────────────────────────────

type GrantPayload = {
  v: 2;
  op: string;
  sv: number;
  act: StepUpAction;
  tgt: string;
  chg: string;
  ver: string;
  exp: number;
  n: string;
};

function sign(body: string): string {
  return keyed(STEP_UP_HMAC_DOMAIN, body);
}

export class StepUpIssueError extends Error {}

/**
 * Mint a grant and make it the operator's one outstanding grant. The change is
 * canonicalised here (throws StepUpIssueError when invalid). The session
 * version defaults to the operator's current one and the record version to the
 * subject's current one; the nonce is written only if the session version still
 * matches (a revocation in between issues nothing).
 */
export async function issueStepUpGrant(args: {
  operatorId: string;
  action: StepUpAction;
  targetId: string;
  change?: unknown;
  sessionVersion?: number;
  versionDigest?: string;
}): Promise<{ grant: string; expiresAt: Date }> {
  const change = canonicalStepUpChange(args.action, args.change ?? {});
  if (!change) throw new StepUpIssueError("invalid change for this action");
  const sv =
    args.sessionVersion ??
    (await prisma.operator.findUnique({ where: { id: args.operatorId }, select: { sessionVersion: true } }))?.sessionVersion;
  if (typeof sv !== "number") throw new StepUpIssueError("operator not found");
  const ver = args.versionDigest ?? (await resolveStepUpVersionDigest(args.action, args.targetId));
  if (!ver) throw new StepUpIssueError("subject not found");

  const nonce = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + STEP_UP_TTL_MS);
  const payload: GrantPayload = {
    v: 2,
    op: args.operatorId,
    sv,
    act: args.action,
    tgt: args.targetId,
    chg: stepUpChangeDigest(args.action, change),
    ver,
    exp: expiresAt.getTime(),
    n: nonce,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const written = await prisma.operator.updateMany({
    where: { id: args.operatorId, sessionVersion: sv },
    data: { stepUpNonceHash: sha256Hex(nonce), stepUpExpiresAt: expiresAt },
  });
  if (written.count !== 1) throw new StepUpIssueError("operator session changed");
  return { grant: `${body}.${sign(body)}`, expiresAt };
}

/** Signature + shape only. Pure; does not spend anything. Expiry is reported, not refused. */
export function verifyStepUpGrantToken(token: string): (GrantPayload & { expired: boolean }) | null {
  if (typeof token !== "string" || token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig || !/^[a-f0-9]{64}$/i.test(sig)) return null;
  const expected = Buffer.from(sign(body), "hex");
  const actual = Buffer.from(sig, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let payload: GrantPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as GrantPayload;
  } catch {
    return null;
  }
  if (
    payload?.v !== 2 ||
    typeof payload.op !== "string" ||
    !Number.isSafeInteger(payload.sv) ||
    !isStepUpAction(payload.act) ||
    typeof payload.tgt !== "string" ||
    typeof payload.chg !== "string" ||
    typeof payload.ver !== "string" ||
    typeof payload.n !== "string" ||
    !Number.isSafeInteger(payload.exp)
  ) {
    return null;
  }
  return { ...payload, expired: payload.exp <= Date.now() };
}

export type StepUpRefusal =
  | "missing"
  | "invalid"
  | "expired"
  | "wrong_operator"
  | "wrong_session"
  | "wrong_action"
  | "wrong_target"
  | "wrong_change"
  | "used"
  | "stale";

/** A grant that passed every check that needs no write. Spent only by consumeStepUpGrant. */
export type VerifiedStepUp = {
  operatorId: string;
  sessionVersion: number;
  action: StepUpAction;
  targetId: string;
  tenantId: string;
  versionDigest: string;
  /** SHA-256 of the nonce: the Operator row's stepUpNonceHash and the audit row's requestId. */
  requestId: string;
};

/** Refusal raised inside the route's transaction, so the transaction rolls back. */
export class StepUpRefusedError extends Error {
  constructor(
    readonly reason: StepUpRefusal,
    readonly grant: Pick<VerifiedStepUp, "operatorId" | "action" | "targetId">,
  ) {
    super(`step-up refused: ${reason}`);
  }
}

const REFUSAL_MESSAGE: Record<StepUpRefusal, string> = {
  missing: "Confirm this action with a code from your authenticator.",
  invalid: "That confirmation is not valid. Enter a new authenticator code.",
  expired: "That confirmation has expired. Enter a new authenticator code.",
  wrong_operator: "That confirmation belongs to another operator. Enter a new authenticator code.",
  wrong_session: "Your operator session changed since you confirmed. Enter a new authenticator code.",
  wrong_action: "That confirmation was for a different action. Enter a new authenticator code.",
  wrong_target: "That confirmation was for a different club or person. Enter a new authenticator code.",
  wrong_change: "That confirmation was for a different change. Enter a new authenticator code.",
  used: "That confirmation was already used. Enter a new authenticator code.",
  stale: "This record changed after you confirmed, so nothing was changed. Reload the page, check it, and confirm again.",
};

/**
 * The refusal response, plus a best-effort security log row OUTSIDE any
 * mutation transaction (a refused attempt changes nothing, so its record must
 * not depend on one). Platform-scoped (tenantId null): it is not club activity.
 */
export function stepUpRefusalResponse(
  reason: StepUpRefusal,
  grant: { operatorId: string; action: StepUpAction; targetId: string },
  req?: Request,
): NextResponse {
  void Promise.resolve()
    .then(() =>
      logAudit({
        tenantId: null,
        action: "admin.operator.step_up_refused",
        entityType: "Operator",
        entityId: grant.operatorId,
        metadata: { stepUpAction: grant.action, targetId: grant.targetId, refusal: reason },
        actAsUserId: grant.operatorId,
        req,
      }),
    )
    .catch(() => {});
  return NextResponse.json(
    { error: REFUSAL_MESSAGE[reason], stepUpRequired: reason !== "stale", refusal: reason },
    { status: reason === "stale" ? 409 : 403 },
  );
}

/** Route catch helper: the response for a StepUpRefusedError thrown inside a transaction. */
export function refuseStepUp(err: StepUpRefusedError, req?: Request): NextResponse {
  return stepUpRefusalResponse(err.reason, err.grant, req);
}

async function currentOperatorSessionVersion(operatorId: string): Promise<number | null> {
  try {
    const store = await cookies();
    const op = await resolveOperatorFromCookie(store.get(OP_SESSION_COOKIE)?.value);
    return op && op.id === operatorId ? op.sessionVersion : null;
  } catch {
    return null;
  }
}

/**
 * Route helper, called AFTER harmless preflight. Verifies the grant in the
 * `x-matflow-step-up` header against the expected operator, session, action,
 * target and change. Spends NOTHING (that is consumeStepUpGrant, inside the
 * route's transaction). Returns the 403 to send, or the verified grant.
 *
 * `operator` is the route's getOperatorContext() result (or the impersonate
 * route's resolved session, which carries `sessionVersion`): the shared-secret
 * sentinel has no authenticator and is always refused.
 */
export async function requireStepUp(
  req: Request,
  operator: { operatorId: string; named?: boolean; sessionVersion?: number },
  action: StepUpAction,
  targetId: string,
  opts: { change?: unknown } = {},
): Promise<NextResponse | VerifiedStepUp> {
  if (operator.named === false) {
    return NextResponse.json(
      { error: "This action needs a named operator account with an authenticator.", stepUpRequired: true },
      { status: 403 },
    );
  }
  const who = { operatorId: operator.operatorId, action, targetId };
  const token = req.headers.get(STEP_UP_HEADER);
  if (!token) return stepUpRefusalResponse("missing", who, req);
  const payload = verifyStepUpGrantToken(token);
  if (!payload) return stepUpRefusalResponse("invalid", who, req);
  if (payload.op !== operator.operatorId) return stepUpRefusalResponse("wrong_operator", who, req);
  if (payload.expired) return stepUpRefusalResponse("expired", who, req);
  const sv = operator.sessionVersion ?? (await currentOperatorSessionVersion(operator.operatorId));
  if (sv === null || payload.sv !== sv) return stepUpRefusalResponse("wrong_session", who, req);
  if (payload.act !== action) return stepUpRefusalResponse("wrong_action", who, req);
  if (payload.tgt !== targetId) return stepUpRefusalResponse("wrong_target", who, req);
  const change = canonicalStepUpChange(action, opts.change ?? {});
  if (!change) return stepUpRefusalResponse("wrong_change", who, req);
  const expected = Buffer.from(stepUpChangeDigest(action, change), "hex");
  const actual = Buffer.from(/^[a-f0-9]{64}$/.test(payload.chg) ? payload.chg : "", "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return stepUpRefusalResponse("wrong_change", who, req);
  }
  return {
    operatorId: payload.op,
    sessionVersion: payload.sv,
    action: payload.act,
    targetId: payload.tgt,
    tenantId: payload.tgt.split("/")[0],
    versionDigest: payload.ver,
    requestId: sha256Hex(payload.n),
  };
}

/**
 * The outcome a route recorded for this grant, if its mutation committed:
 * the audit row with this tenant, one of the route's outcome actions and the
 * grant's request id. Its `metadata.result` is the minimal result to echo.
 */
export async function findAppliedGrant(
  tx: Prisma.TransactionClient,
  args: { tenantId: string; actions: readonly string[]; requestId: string },
): Promise<Record<string, unknown> | null> {
  const row = await tx.auditLog.findFirst({
    where: { tenantId: args.tenantId, requestId: args.requestId, action: { in: [...args.actions] } },
    orderBy: { createdAt: "desc" },
    select: { action: true, metadata: true },
  });
  if (!row) return null;
  const meta = (row.metadata ?? {}) as Record<string, unknown>;
  const result = meta.result && typeof meta.result === "object" ? (meta.result as Record<string, unknown>) : {};
  return { ...result, recordedAction: row.action };
}

/**
 * Spend the grant INSIDE the route's mutation transaction.
 *
 *  - the conditional UPDATE matches → the subject's version is re-read; if it
 *    moved since the grant was issued, StepUpRefusedError("stale") is thrown
 *    and the caller's transaction (spend included) rolls back → 409;
 *  - it matches nothing → the operator's session moved (wrong_session), or the
 *    grant was already spent: with `replayActions`, the recorded outcome is
 *    returned as { kind: "replay" } when the mutation committed; otherwise
 *    StepUpRefusedError("used").
 *
 * Throws only StepUpRefusedError (or a database error); either aborts the
 * caller's transaction.
 */
export async function consumeStepUpGrant(
  tx: Prisma.TransactionClient,
  grant: VerifiedStepUp,
  opts: { replayActions?: readonly string[] } = {},
): Promise<{ kind: "spent" } | { kind: "replay"; outcome: Record<string, unknown> }> {
  const spent = await tx.operator.updateMany({
    where: {
      id: grant.operatorId,
      stepUpNonceHash: grant.requestId,
      stepUpExpiresAt: { gt: new Date() },
      sessionVersion: grant.sessionVersion,
    },
    data: { stepUpNonceHash: null, stepUpExpiresAt: null },
  });
  if (spent.count === 1) {
    const version = await stepUpVersion(tx, grant.action, grant.targetId);
    if (version === null || versionDigest(version) !== grant.versionDigest) {
      throw new StepUpRefusedError("stale", grant);
    }
    return { kind: "spent" };
  }
  const op = await tx.operator.findUnique({
    where: { id: grant.operatorId },
    select: { sessionVersion: true, stepUpNonceHash: true, stepUpExpiresAt: true },
  });
  if (!op || op.sessionVersion !== grant.sessionVersion) throw new StepUpRefusedError("wrong_session", grant);
  if (opts.replayActions && opts.replayActions.length > 0) {
    const outcome = await findAppliedGrant(tx, {
      tenantId: grant.tenantId,
      actions: opts.replayActions,
      requestId: grant.requestId,
    });
    if (outcome) return { kind: "replay", outcome };
  }
  // AH-G5 / SEC-015 (security campaign lane A, 9 Oct 2026): the nonce is
  // still this grant's, so it was never spent — the conditional update missed
  // on the expiry alone (natural expiry between the check and the spend, or a
  // stored expiry moved by hand). Refused either way; the label now says why.
  if (op.stepUpNonceHash === grant.requestId) throw new StepUpRefusedError("expired", grant);
  throw new StepUpRefusedError("used", grant);
}
