/**
 * POST /api/admin/auth/step-up
 * Body: { action: StepUpAction, targetId: string, change?: {…}, code: "123456" }
 *
 * Fresh re-authentication for one high-impact operator action. Requires a
 * full, MFA-verified operator session (never the shared secret, never an
 * enrolment or challenge cookie) AND a current authenticator code, which is
 * spent. Returns a grant bound to this operator, this session (its
 * sessionVersion), this action, this target, the canonical intended change the
 * operator entered (`change`, e.g. { newEmail } or { name }; {} for a reset or
 * a suspension) and the subject's record version as it stands now — valid for
 * 5 minutes and usable once. See lib/operator-step-up.ts.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertSameOrigin } from "@/lib/csrf";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { OP_SESSION_COOKIE, consumeOperatorTotp, resolveOperatorFromCookie } from "@/lib/operator-auth";
import {
  STEP_UP_ACTIONS,
  canonicalStepUpChange,
  issueStepUpGrant,
  resolveStepUpVersionDigest,
} from "@/lib/operator-step-up";

export const runtime = "nodejs";

// The change is a small flat object of primitives; its per-action shape is
// enforced by canonicalStepUpChange (strict: unknown keys are refused).
const changeValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const schema = z
  .object({
    action: z.enum(STEP_UP_ACTIONS),
    targetId: z.string().min(1).max(200),
    change: z
      .record(z.string().max(40), changeValue)
      .refine((c) => Object.keys(c).length <= 8)
      .optional(),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();

export async function POST(req: Request) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const store = await cookies();
  // `req`: an allowlist refusal row records the IP and user agent (lane B).
  const session = await resolveOperatorFromCookie(store.get(OP_SESSION_COOKIE)?.value, { req });
  if (!session) {
    return NextResponse.json({ error: "Sign in with your operator account first." }, { status: 401 });
  }

  const rl = await checkRateLimit(`admin:operator-step-up:${session.id}`, 5, 10 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Action, target and a 6-digit code are required." }, { status: 400 });
  }
  // The change must be a valid change for THIS action before a code is spent.
  const change = canonicalStepUpChange(parsed.data.action, parsed.data.change ?? {});
  if (!change) {
    return NextResponse.json({ error: "The change you entered is not valid for this action." }, { status: 400 });
  }

  const operator = await prisma.operator.findUnique({
    where: { id: session.id },
    select: { id: true, totpEnabled: true, totpSecret: true, totpLastUsedStep: true },
  });
  if (!operator?.totpEnabled || !operator.totpSecret) {
    return NextResponse.json({ error: "Sign in with your operator account first." }, { status: 401 });
  }

  const accepted = await consumeOperatorTotp(
    { id: operator.id, totpSecret: operator.totpSecret, totpLastUsedStep: operator.totpLastUsedStep },
    parsed.data.code,
  );
  if (!accepted) {
    return NextResponse.json(
      { error: "That code was not accepted. Wait for the next code and try again." },
      { status: 401 },
    );
  }

  // The record version the grant is bound to: the subject as it stands now,
  // after the operator has entered the change. A grant for a club or person
  // that does not exist is not issued.
  const versionDigest = await resolveStepUpVersionDigest(parsed.data.action, parsed.data.targetId);
  if (!versionDigest) {
    return NextResponse.json({ error: "That club or person was not found. Reload the page." }, { status: 404 });
  }

  // The issuance row is DURABLE and written BEFORE the grant exists (review
  // finding D5, 6 Oct 2026): it used to be best-effort and after, so a grant
  // could be issued with no record of who asked for it. If the row cannot be
  // written, no grant is issued. The change itself is not recorded here (it
  // may be an address); the outcome row of the action records it safely.
  try {
    await logAudit({
      tenantId: null,
      action: "admin.operator.step_up",
      entityType: "Operator",
      entityId: operator.id,
      metadata: {
        stepUpAction: parsed.data.action,
        targetId: parsed.data.targetId,
        changeFields: Object.keys(change).sort(),
      },
      actAsUserId: operator.id,
      operatorId: operator.id,
      req,
      durable: true,
      outcome: "authorised",
    });
  } catch (err) {
    console.error("[step-up] audit write failed; no grant issued", err);
    return NextResponse.json(
      { error: "The confirmation could not be recorded, so it was not issued. Try again with a new code." },
      { status: 500 },
    );
  }

  let issued: { grant: string; expiresAt: Date };
  try {
    issued = await issueStepUpGrant({
      operatorId: operator.id,
      action: parsed.data.action,
      targetId: parsed.data.targetId,
      change,
      sessionVersion: session.sessionVersion,
      versionDigest,
    });
  } catch (err) {
    console.error("[step-up] grant not issued", err);
    return NextResponse.json(
      { error: "Your operator session changed. Sign in again, then confirm with a new code." },
      { status: 401 },
    );
  }

  return NextResponse.json(
    { ok: true, grant: issued.grant, expiresAt: issued.expiresAt.toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
