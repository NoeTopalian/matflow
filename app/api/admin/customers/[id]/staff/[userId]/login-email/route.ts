// POST /api/admin/customers/[id]/staff/[userId]/login-email
//
// Operator moves ONE non-owner staff account's login address (hub conflicts,
// 12 Oct 2026). The staff counterpart of …/members/[memberId]/contact-email:
// a manager, coach or admin account holds the address the club owner should
// sign in with, the club has confirmed (by phone, independently) which
// address is really whose, and the staff account must move first so the
// owner's change can claim it.
//
// Body (strict): { newEmail, reason (trimmed, 10–500), version }
//   - newEmail: normalised (trim + lower-case), at most 120 characters;
//   - version: the opaque staff version the operator's address check returned
//     (POST …/login-email/check). Compared again inside the transaction, so an
//     account that changed since the operator looked is not changed (409).
// The step-up grant travels in the x-matflow-step-up header and is bound to
// action "staff.login_email", target stepUpTarget(tenant, user, "change"),
// change { newEmail }, this operator session and the account's version at
// issue (role, session version, address, password present).
//
// Preflight (nothing written, grant unspent): operator, support, rate limit,
// body, club, user IN this club (404 otherwise — never another club's), not
// the owner (409 "owner": the owner's Login email card is the only door to
// the owner's address), not a system placeholder address, address different
// from the current one, address free in this club (409 with the holder —
// operators may see it), version unchanged.
//
// Then ONE transaction: spend the grant (replay → the recorded result) →
// re-read the account and compare the version (still not the owner) → claim
// the address (advisory lock, both tables) → conditional write of `email`,
// a sessionVersion bump (every session of the account ends) and
// `loginEmailProvisionalSince` (the new address is unverified until it is
// confirmed, as on the owner route) → retire this club's sign-in tokens for
// the old AND new address (reset, login, first_time_signup; a waiver link is
// not a credential) → the audit row. Any failure rolls back all of it, the
// spend included.
//
// NEVER written here: passwordHash, TOTP (secret, enabled flag, last step),
// recovery codes, role, tenantId — and never the owner's account. No merge.

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdminAuthed } from "@/lib/admin-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { emailField, normaliseEmail } from "@/lib/email-normalise";
import { hasImpersonationCookie } from "@/lib/impersonation";
import { SUPPORT_OPERATOR_PLANE_MESSAGE } from "@/lib/support-session";
import {
  LOGIN_EMAIL_REASON_MIN,
  LoginIdentityTaken,
  claimLoginIdentity,
  emailDigest,
  retireEmailBoundTokens,
  type LoginIdentityClaim,
} from "@/lib/login-email";
import {
  STEP_UP_HEADER,
  StepUpRefusedError,
  consumeStepUpGrant,
  findAppliedGrant,
  refuseStepUp,
  requireStepUp,
  stepUpTarget,
  stepUpVersionDigestIn,
  verifyStepUpGrantToken,
} from "@/lib/operator-step-up";
import { sha256Hex } from "@/lib/operator-auth";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

export const runtime = "nodejs";

// System-managed address shapes (a no-login placeholder or a GDPR erasure
// sentinel) are never given to a sign-in account: refused as a target, as on
// the member route.
const ERASED_SENTINEL = /^deleted-.*@deleted\.invalid$/i;
const managedAddress = (email: string) => isSynthesisedEmail(email) || ERASED_SENTINEL.test(email);

const bodySchema = z
  .object({
    newEmail: emailField(120),
    reason: z.string().trim().min(LOGIN_EMAIL_REASON_MIN).max(500),
    version: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

// Same budget as the other operator customer actions (A6I1-S-5).
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;
const OUTCOME = "admin.staff.login_email.changed";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

class StaleStaff extends Error {}

/** Operator-facing holder summary (never sent by club or self-service routes). */
function holderOf(claim: Exclude<LoginIdentityClaim, { kind: "none" }>) {
  if (claim.kind === "many") return { kind: "many" as const, count: claim.holders.length };
  return {
    kind: claim.kind,
    id: claim.id,
    name: claim.name,
    status: claim.kind === "user" ? claim.role : claim.status,
  };
}

/**
 * The recorded result of THIS operator's grant for THIS staff account, if its
 * change committed — read only (nothing is verified as spendable, nothing is
 * spent). The grant's signature binds the operator, action and target; its
 * nonce hash is the outcome row's request id.
 */
async function appliedOutcome(req: Request, operatorId: string, tenantId: string, target: string) {
  const token = req.headers.get(STEP_UP_HEADER);
  const payload = token ? verifyStepUpGrantToken(token) : null;
  if (!payload || payload.op !== operatorId || payload.act !== "staff.login_email" || payload.tgt !== target) return null;
  return withRlsBypass((tx) =>
    findAppliedGrant(tx, { tenantId, actions: [OUTCOME], requestId: sha256Hex(payload.n) }),
  );
}

const TAKEN_MESSAGE = "That address is already held by someone else in this club, so nothing was changed. Check it again.";
const STALE_MESSAGE = "This staff account changed since you checked it, so nothing was changed. Check the address again.";
const OWNER_MESSAGE = "This is the club owner's sign-in account. Use the owner's Login email card; nothing was changed.";
const MANAGED_TARGET_MESSAGE = "That address is a system placeholder and cannot be used as a login address.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  if (!(await isAdminAuthed(req))) return json({ error: "Forbidden" }, 403);
  // Session precedence: no operator powers from a browser in a support session.
  if (await hasImpersonationCookie()) return json({ error: SUPPORT_OPERATOR_PLANE_MESSAGE }, 403);

  const ctx = await getOperatorContext(req);
  const rl = await checkRateLimit(`admin:tenant-action:${ctx.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return json({ error: "Too many admin actions. Try again shortly." }, 429, { "Retry-After": String(rl.retryAfterSeconds) });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return json(
      { error: `Give the new address, a reason of at least ${LOGIN_EMAIL_REASON_MIN} characters, and check the address first.` },
      400,
    );
  }
  const { newEmail, reason, version } = parsed.data;
  const { id: tenantId, userId } = await params;
  const target = stepUpTarget(tenantId, userId, "change");

  // ── Preflight: harmless reads; nothing written, the grant not spent. ──────
  const pre = await withRlsBypass(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return { kind: "no_tenant" as const };
    const user = await tx.user.findFirst({ where: { id: userId, tenantId }, select: { id: true, email: true, role: true } });
    if (!user) return { kind: "no_user" as const };
    if (user.role === "owner") return { kind: "owner" as const };
    if (managedAddress(newEmail)) return { kind: "managed_target" as const };
    if (normaliseEmail(user.email) === newEmail) return { kind: "same" as const };
    const claim = await claimLoginIdentity(tx, { tenantId, email: newEmail, exclude: { userId } });
    if (claim.kind !== "none") return { kind: "taken" as const, claim };
    if ((await stepUpVersionDigestIn(tx, "staff.login_email", target)) !== version) return { kind: "stale" as const };
    return { kind: "ok" as const };
  });
  if (pre.kind === "no_tenant") return json({ error: "Club not found." }, 404);
  if (pre.kind === "no_user") return json({ error: "Staff account not found in this club." }, 404);
  if (pre.kind !== "ok") {
    // A lost-response re-send of a grant whose change already committed lands
    // here (the address is now the new one): answer it from the record.
    const applied = await appliedOutcome(req, ctx.operatorId, tenantId, target);
    if (applied) return json({ ok: true, alreadyApplied: true, ...applied });
  }
  if (pre.kind === "owner") return json({ error: OWNER_MESSAGE, result: "owner" }, 409);
  if (pre.kind === "managed_target") return json({ error: MANAGED_TARGET_MESSAGE, result: "managed" }, 400);
  if (pre.kind === "same") return json({ error: "That is already this staff account's address." }, 400);
  if (pre.kind === "taken") return json({ error: TAKEN_MESSAGE, result: "taken", holder: holderOf(pre.claim) }, 409);
  if (pre.kind === "stale") return json({ error: STALE_MESSAGE, result: "stale" }, 409);

  // Fresh operator re-authentication bound to THIS staff account of THIS club,
  // THIS new address and the account as it stood when the grant was issued.
  // Verified here, spent inside the transaction below.
  const stepUp = await requireStepUp(req, ctx, "staff.login_email", target, { change: { newEmail } });
  if (stepUp instanceof Response) {
    stepUp.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return stepUp;
  }

  try {
    const result = await withRlsBypass(async (tx) => {
      // 1. Spend (single use; replay → recorded result; stale grant → throw).
      const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: [OUTCOME] });
      if (spend.kind === "replay") return { alreadyApplied: true as const, ...spend.outcome };

      // 2. The account as it is now, and the version the operator checked.
      const user = await tx.user.findFirst({
        where: { id: userId, tenantId },
        select: { id: true, email: true, role: true, sessionVersion: true },
      });
      if (!user || user.role === "owner") throw new StaleStaff();
      if ((await stepUpVersionDigestIn(tx, "staff.login_email", target)) !== version) throw new StaleStaff();

      // 3. Claim the address (lock held to commit) — refuse if anyone holds it.
      const claim = await claimLoginIdentity(tx, { tenantId, email: newEmail, exclude: { userId } });
      if (claim.kind !== "none") throw new LoginIdentityTaken(claim);

      // 4. The address, the session bump and the unverified stamp; conditional
      //    on the address just read and on the account still not being the owner.
      const changed = await tx.user.updateMany({
        where: { id: userId, tenantId, email: user.email, role: { not: "owner" } },
        data: { email: newEmail, sessionVersion: { increment: 1 }, loginEmailProvisionalSince: new Date() },
      });
      if (changed.count !== 1) throw new StaleStaff();

      // 5. Sign-in tokens for the old AND new address in this club.
      const retired = await retireEmailBoundTokens(tx, { tenantId, emails: [user.email, newEmail] });

      // 6. The outcome row, in the same transaction (its failure rolls back 1–5).
      await logAudit({
        tx,
        tenantId,
        userId: null,
        action: OUTCOME,
        entityType: "User",
        entityId: userId,
        metadata: {
          reason,
          role: user.role,
          oldEmailDigest: emailDigest(user.email),
          newEmailDigest: emailDigest(newEmail),
          // A typed address proves nothing about who reads it: unverified
          // until confirmed, and every session of the account has ended.
          unverified: true,
          sessionsRevoked: true,
          retired,
          sessionVersionAfter: user.sessionVersion + 1,
          version,
          result: { userId, sessionsRevoked: true, retired },
        },
        actAsUserId: ctx.operatorId,
        operatorId: stepUp.operatorId,
        requestId: stepUp.requestId,
        req,
      });
      return { userId, sessionsRevoked: true as const, retired };
    });
    return json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof StepUpRefusedError) {
      const res = refuseStepUp(err, req);
      res.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
      return res;
    }
    if (err instanceof StaleStaff) return json({ error: STALE_MESSAGE, result: "stale" }, 409);
    if (err instanceof LoginIdentityTaken) return json({ error: TAKEN_MESSAGE, result: "taken", holder: holderOf(err.claim) }, 409);
    if ((err as { code?: string })?.code === "P2002") return json({ error: TAKEN_MESSAGE, result: "taken" }, 409);
    console.error("[staff login-email] change or audit write failed; nothing changed", err);
    return json(
      { error: "The change could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      500,
    );
  }
}
