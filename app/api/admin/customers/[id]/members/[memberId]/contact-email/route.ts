// POST /api/admin/customers/[id]/members/[memberId]/contact-email
//
// Operator moves ONE member's contact address (admin hub lane F, 9 Oct 2026;
// ledger AH-04, story I3). Step 1 of resolving a login-address conflict: an
// imported member holds the address the club owner should sign in with, the
// club has confirmed (by phone, independently) which address is really whose,
// and the member's record must move first so the owner's change can claim it.
//
// Body (strict): { newEmail, reason (trimmed, 10–500), version }
//   - newEmail: normalised (trim + lower-case), at most 120 characters;
//   - version: the opaque member version the operator's address check returned
//     (POST …/login-email/check). Compared again inside the transaction, so a
//     member that changed since the operator looked is not changed (409).
// The step-up grant travels in the x-matflow-step-up header and is bound to
// action "member.contact_email", target stepUpTarget(tenant, member, "change"),
// change { newEmail }, this operator session and the member's version at issue.
//
// Preflight (nothing written, grant unspent): operator, support, rate limit,
// body, club, member IN this club (404 otherwise — never another club's),
// address different from the current one, address free in this club (409
// with the holder — operators may see it), version unchanged.
//
// Then ONE transaction: spend the grant (replay → the recorded result) →
// re-read the member and compare the version → claim the address (advisory
// lock, both tables) → conditional write of `email` only → retire this club's
// sign-in tokens for the old AND new address (reset, login, first_time_signup;
// a waiver link is not a credential) → if the member can sign in (password in
// the database now, not as read earlier) bump sessionVersion so every session
// ends, and record the address as unverified (there is no Member provisional
// column; ACCOUNT-EDITING.md "What an email means") → the audit row. Any
// failure rolls back all of it, the spend included.
//
// NEVER written here: externalRef (the import identity — refresh and
// attendance matching rely on it), status, passwordHash, TOTP, recovery codes,
// memberships, family links, attendance, ledger rows. No merge.

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

export const runtime = "nodejs";

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
const OUTCOME = "admin.member.contact_email.changed";

const NO_STORE = { "Cache-Control": "private, no-store" } as const;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

class StaleMember extends Error {}

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
 * The recorded result of THIS operator's grant for THIS member, if its change
 * committed — read only (nothing is verified as spendable, nothing is spent).
 * The grant's signature binds the operator, action and target; its nonce hash
 * is the outcome row's request id.
 */
async function appliedOutcome(req: Request, operatorId: string, tenantId: string, target: string) {
  const token = req.headers.get(STEP_UP_HEADER);
  const payload = token ? verifyStepUpGrantToken(token) : null;
  if (!payload || payload.op !== operatorId || payload.act !== "member.contact_email" || payload.tgt !== target) return null;
  return withRlsBypass((tx) =>
    findAppliedGrant(tx, { tenantId, actions: [OUTCOME], requestId: sha256Hex(payload.n) }),
  );
}

const TAKEN_MESSAGE = "That address is already held by someone else in this club, so nothing was changed. Check it again.";
const STALE_MESSAGE = "This member's record changed since you checked it, so nothing was changed. Check the address again.";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; memberId: string }> }) {
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
  const { id: tenantId, memberId } = await params;
  const target = stepUpTarget(tenantId, memberId, "change");

  // ── Preflight: harmless reads; nothing written, the grant not spent. ──────
  const pre = await withRlsBypass(async (tx) => {
    const tenant = await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!tenant) return { kind: "no_tenant" as const };
    const member = await tx.member.findFirst({ where: { id: memberId, tenantId }, select: { id: true, email: true } });
    if (!member) return { kind: "no_member" as const };
    if (normaliseEmail(member.email) === newEmail) return { kind: "same" as const };
    const claim = await claimLoginIdentity(tx, { tenantId, email: newEmail, exclude: { memberId } });
    if (claim.kind !== "none") return { kind: "taken" as const, claim };
    const current = await stepUpVersionDigestIn(tx, "member.contact_email", target);
    if (current !== version) return { kind: "stale" as const };
    return { kind: "ok" as const };
  });
  if (pre.kind === "no_tenant") return json({ error: "Club not found." }, 404);
  if (pre.kind === "no_member") return json({ error: "Member not found in this club." }, 404);
  if (pre.kind !== "ok") {
    // A lost-response re-send of a grant whose change already committed lands
    // here (the address is now the new one): answer it from the record.
    const applied = await appliedOutcome(req, ctx.operatorId, tenantId, target);
    if (applied) return json({ ok: true, alreadyApplied: true, ...applied });
  }
  if (pre.kind === "same") return json({ error: "That is already this member's address." }, 400);
  if (pre.kind === "taken") return json({ error: TAKEN_MESSAGE, result: "taken", holder: holderOf(pre.claim) }, 409);
  if (pre.kind === "stale") return json({ error: STALE_MESSAGE, result: "stale" }, 409);

  // Fresh operator re-authentication bound to THIS member of THIS club, THIS
  // new address and the member as it stood when the grant was issued.
  // Verified here, spent inside the transaction below.
  const stepUp = await requireStepUp(req, ctx, "member.contact_email", target, { change: { newEmail } });
  if (stepUp instanceof Response) {
    stepUp.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
    return stepUp;
  }

  try {
    const result = await withRlsBypass(async (tx) => {
      // 1. Spend (single use; replay → recorded result; stale grant → throw).
      const spend = await consumeStepUpGrant(tx, stepUp, { replayActions: [OUTCOME] });
      if (spend.kind === "replay") return { alreadyApplied: true as const, ...spend.outcome };

      // 2. The member as it is now, and the version the operator checked.
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: { id: true, tenantId: true, email: true, passwordHash: true, externalRef: true, sessionVersion: true },
      });
      if (!member) throw new StaleMember();
      if ((await stepUpVersionDigestIn(tx, "member.contact_email", target)) !== version) throw new StaleMember();

      // 3. Claim the address (lock held to commit) — refuse if anyone holds it.
      const claim = await claimLoginIdentity(tx, { tenantId, email: newEmail, exclude: { memberId } });
      if (claim.kind !== "none") throw new LoginIdentityTaken(claim);

      // 4. The address, and nothing else; conditional on the one just read.
      const changed = await tx.member.updateMany({
        where: { id: memberId, tenantId, email: member.email },
        data: { email: newEmail },
      });
      if (changed.count !== 1) throw new StaleMember();

      // 5. Capability, decided in the database inside this transaction.
      const retired = await retireEmailBoundTokens(tx, { tenantId, emails: [member.email, newEmail] });
      const bumped = await tx.member.updateMany({
        where: { id: memberId, tenantId, passwordHash: { not: null } },
        data: { sessionVersion: { increment: 1 } },
      });
      const canSignIn = bumped.count === 1;
      const sessionVersionAfter = member.sessionVersion + (canSignIn ? 1 : 0);

      // 6. The outcome row, in the same transaction (its failure rolls back 1–5).
      await logAudit({
        tx,
        tenantId,
        userId: null,
        action: OUTCOME,
        entityType: "Member",
        entityId: memberId,
        metadata: {
          reason,
          oldEmailDigest: emailDigest(member.email),
          newEmailDigest: emailDigest(newEmail),
          canSignIn,
          // No verification step exists: a typed address proves nothing about
          // who reads it. A member who signs in has been signed out.
          unverified: canSignIn,
          sessionsRevoked: canSignIn,
          retired,
          sessionVersionAfter,
          version,
          result: { memberId, canSignIn, retired },
        },
        actAsUserId: ctx.operatorId,
        operatorId: stepUp.operatorId,
        requestId: stepUp.requestId,
        req,
      });
      return { memberId, canSignIn, retired };
    });
    return json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof StepUpRefusedError) {
      const res = refuseStepUp(err, req);
      res.headers.set("Cache-Control", NO_STORE["Cache-Control"]);
      return res;
    }
    if (err instanceof StaleMember) return json({ error: STALE_MESSAGE, result: "stale" }, 409);
    if (err instanceof LoginIdentityTaken) return json({ error: TAKEN_MESSAGE, result: "taken", holder: holderOf(err.claim) }, 409);
    if ((err as { code?: string })?.code === "P2002") return json({ error: TAKEN_MESSAGE, result: "taken" }, 409);
    console.error("[member contact-email] change or audit write failed; nothing changed", err);
    return json(
      { error: "The change could not be recorded, so nothing was changed. Try again with a new authenticator code." },
      500,
    );
  }
}
