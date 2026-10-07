/**
 * Operator step-up re-authentication (6 Oct 2026).
 *
 * The highest-impact operator actions — resetting an owner's password or second
 * factor, clearing a member's second factor, transferring ownership, deleting a
 * club — need FRESH proof that the named operator is at the keyboard, not just
 * an 8-hour session cookie that might have been copied.
 *
 *   1. The operator (MFA-verified session) POSTs a current authenticator code
 *      with { action, targetId } to /api/admin/auth/step-up.
 *   2. The code is spent through `consumeOperatorTotp` (single use, every
 *      instance), and the operator receives a GRANT: a signed token bound to
 *      operatorId + action + targetId + expiry (5 minutes) + a random nonce.
 *   3. The action route calls `requireStepUp(req, ...)` with the action and the
 *      target it is about to touch. The grant must verify, match all four
 *      bindings, and its nonce must still be the operator's outstanding one.
 *
 * SINGLE USE ACROSS INSTANCES. The Operator row holds the SHA-256 of the one
 * outstanding nonce and its expiry. Consumption is ONE conditional update
 *   UPDATE "Operator" SET stepUpNonceHash = NULL, stepUpExpiresAt = NULL
 *   WHERE id = $op AND stepUpNonceHash = $hash AND stepUpExpiresAt > now()
 * and succeeds for exactly one caller. Chosen over a consumed-nonce table
 * because it needs no new table, no clean-up job, and an operator only ever
 * needs one step-up at a time; issuing a new grant supersedes the old one.
 *
 * The grant travels in the `x-matflow-step-up` request header, so a route can
 * check it without its body schema knowing about it.
 *
 * For lane D (soft-delete): `requireStepUp(req, ctx, "tenant.soft_delete", stepUpTarget(tenantId))`
 * after the operator gate (and body parse); the Danger Zone already asks for the
 * code and sends the grant on the delete POST. For lane B (impersonation start):
 * the same with "support.impersonate"; its button must call /api/admin/auth/step-up
 * first and send the grant in the `x-matflow-step-up` header.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { sha256Hex } from "@/lib/operator-auth";

export const STEP_UP_HEADER = "x-matflow-step-up";
export const STEP_UP_TTL_MS = 5 * 60 * 1000;
const STEP_UP_HMAC_DOMAIN = "operator-step-up.v1.";

export const STEP_UP_ACTIONS = [
  "owner.force_password_reset",
  "owner.totp_reset",
  "member.totp_reset",
  "tenant.transfer_ownership",
  "tenant.soft_delete",
  // Suspending a club signs every user and member of it out (review of lanes
  // A/B/D, 6 Oct 2026). POST only: un-suspending is the recovery direction.
  "tenant.suspend",
  // Reserved for lane B (support sessions need fresh operator MFA); target =
  // the tenant id. Not yet demanded by any route in this lane.
  "support.impersonate",
  // Owner login email (7 Oct 2026): mark provisional, clear provisional,
  // change. Target = stepUpTarget(tenantId, ownerUserId, subAction), so a grant
  // for one club's owner cannot be spent on another account, nor a grant for
  // one sub-action on another.
  "owner.login_email",
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

type GrantPayload = { v: 1; op: string; act: StepUpAction; tgt: string; exp: number; n: string };

function sign(body: string): string {
  return createHmac("sha256", AUTH_SECRET_VALUE).update(`${STEP_UP_HMAC_DOMAIN}${body}`).digest("hex");
}

/** Mint a grant and make it the operator's one outstanding grant. */
export async function issueStepUpGrant(args: {
  operatorId: string;
  action: StepUpAction;
  targetId: string;
}): Promise<{ grant: string; expiresAt: Date }> {
  const nonce = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + STEP_UP_TTL_MS);
  const payload: GrantPayload = {
    v: 1,
    op: args.operatorId,
    act: args.action,
    tgt: args.targetId,
    exp: expiresAt.getTime(),
    n: nonce,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  await prisma.operator.update({
    where: { id: args.operatorId },
    data: { stepUpNonceHash: sha256Hex(nonce), stepUpExpiresAt: expiresAt },
  });
  return { grant: `${body}.${sign(body)}`, expiresAt };
}

/** Signature + shape + expiry only. Pure; does not spend anything. */
export function verifyStepUpGrantToken(token: string): GrantPayload | null {
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
    payload?.v !== 1 ||
    typeof payload.op !== "string" ||
    !isStepUpAction(payload.act) ||
    typeof payload.tgt !== "string" ||
    typeof payload.n !== "string" ||
    !Number.isSafeInteger(payload.exp)
  ) {
    return null;
  }
  if (payload.exp <= Date.now()) return null;
  return payload;
}

export type StepUpRefusal = "missing" | "invalid" | "wrong_operator" | "wrong_action" | "wrong_target" | "spent";

/**
 * Verify the grant against the expected operator, action and target, then
 * spend it. A grant that fails any binding is NOT spent (so a mistaken call
 * cannot burn the operator's real grant) — and is useless anyway.
 */
export async function consumeStepUpGrant(args: {
  token: string | null | undefined;
  operatorId: string;
  action: StepUpAction;
  targetId: string;
}): Promise<{ ok: true } | { ok: false; reason: StepUpRefusal }> {
  if (!args.token) return { ok: false, reason: "missing" };
  const payload = verifyStepUpGrantToken(args.token);
  if (!payload) return { ok: false, reason: "invalid" };
  if (payload.op !== args.operatorId) return { ok: false, reason: "wrong_operator" };
  if (payload.act !== args.action) return { ok: false, reason: "wrong_action" };
  if (payload.tgt !== args.targetId) return { ok: false, reason: "wrong_target" };
  const spent = await prisma.operator.updateMany({
    where: {
      id: args.operatorId,
      stepUpNonceHash: sha256Hex(payload.n),
      stepUpExpiresAt: { gt: new Date() },
    },
    data: { stepUpNonceHash: null, stepUpExpiresAt: null },
  });
  if (spent.count !== 1) return { ok: false, reason: "spent" };
  return { ok: true };
}

/**
 * Route helper. Returns a 403 response to send, or null to carry on.
 * `operator` is the route's getOperatorContext() result: the shared-secret
 * sentinel (development only) has no authenticator and is always refused.
 */
export async function requireStepUp(
  req: Request,
  operator: { operatorId: string; named?: boolean },
  action: StepUpAction,
  targetId: string,
): Promise<NextResponse | null> {
  if (operator.named === false) {
    return NextResponse.json(
      { error: "This action needs a named operator account with an authenticator.", stepUpRequired: true },
      { status: 403 },
    );
  }
  const result = await consumeStepUpGrant({
    token: req.headers.get(STEP_UP_HEADER),
    operatorId: operator.operatorId,
    action,
    targetId,
  });
  if (result.ok) return null;
  return NextResponse.json(
    {
      error:
        result.reason === "missing"
          ? "Confirm this action with a code from your authenticator."
          : "That confirmation has expired or was already used. Enter a new authenticator code.",
      stepUpRequired: true,
    },
    { status: 403 },
  );
}
