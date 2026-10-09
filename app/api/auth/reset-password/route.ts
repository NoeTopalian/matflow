import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { hashToken } from "@/lib/token-hash";
import { hashSubjectBoundResetCode, type TokenSubject } from "@/lib/auth-token-binding";
import { checkRateLimit } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { isLoginEmailProvisional } from "@/lib/login-email";
import {
  PASSWORD_HISTORY_LIMIT,
  passwordReused,
  recentPasswordHashes,
  recordPasswordHistory,
  staffPasswordSchema,
} from "@/lib/password-policy";

// UK NCSC / OWASP compliant password policy: the shared staff rule and history
// in lib/password-policy.ts (8 Oct 2026, the same module set-password and the
// self-service change use). Staff accounts may not reuse the current password
// or any of the last PASSWORD_HISTORY_LIMIT (8); members keep no history.

/**
 * How many codes may be TRIED, as opposed to sent.
 *
 * `forgot-password` limits sends to three per fifteen minutes so nobody can
 * flood a mailbox. This side had no limit at all — and this is the side that
 * accepts a six-digit code, which is a million values wide and lives for two
 * minutes. Unthrottled, an attacker who knows an address can spend that window
 * guessing, and a hit is a full takeover: it sets the password and clears the
 * lockout with it.
 *
 * Ten attempts per fifteen minutes matches the ten-guess account lockout the
 * password door already applies, so the two brakes tell the same story.
 */
const RESET_ATTEMPT_MAX = 10;
const RESET_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

// Audit iter-1-auth-boundary AH-8: validate body shape + bounds before any work.
const bodySchema = z.object({
  token: z.string().min(1).max(20),
  email: z.string().email().max(120),
  tenantSlug: z.string().min(1).max(60),
  password: z.string().min(10).max(128),
});

function validatePassword(password: string): string | null {
  const r = staffPasswordSchema.safeParse(password);
  return r.success ? null : (r.error.issues[0]?.message ?? "Choose a stronger password.");
}

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Missing or invalid fields." }, { status: 400 });
  const { token, email, tenantSlug, password } = parsed.data;

  const policyError = validatePassword(password);
  if (policyError) return NextResponse.json({ error: policyError }, { status: 400 });

  // Throttle the GUESS, before any lookup or bcrypt work. Keyed on club+email
  // exactly as `forgot-password` is, so one club cannot throttle another and a
  // sweep across a roster does not share one bucket. `failClosed`: if the
  // limiter store is unreachable the right answer is to stop accepting guesses
  // at a six-digit code, not to wave them through.
  const attemptKey = `reset-attempt:${tenantSlug}:${email.toLowerCase().trim()}`;
  const attempt = await checkRateLimit(attemptKey, RESET_ATTEMPT_MAX, RESET_ATTEMPT_WINDOW_MS, {
    failClosed: true,
  });
  if (!attempt.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please request a new code and try again shortly." },
      { status: 429, headers: { "Retry-After": String(attempt.retryAfterSeconds) } },
    );
  }

  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { slug: tenantSlug } }),
  );
  // Audit iter-1-auth-boundary AH-9: collapse tenant-not-found into the same
  // generic "code invalid or expired" error so attackers cannot enumerate
  // tenant slugs by probing reset endpoints.
  if (!tenant) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 },
    );
  }

  const normEmail = email.toLowerCase().trim();

  // From here we have a tenant — switch to tenant-scoped context.
  // Audit iter-1-auth-boundary AH-3: lookup subject as either User OR Member.
  // The token row carries only email + tenant; the subject type is
  // discovered here. User takes precedence (staff accounts) over Member
  // when both share an email — should be rare given staff and member share
  // an email tend to be edge cases (e.g. the owner has their own member row).
  // Set when the code was found by its subject-bound hash (below).
  let boundTo: TokenSubject | null = null;
  const lookups = await withTenantContext(tenant.id, async (tx) => {
    const live = { email: normEmail, tenantId: tenant.id, used: false, expiresAt: { gt: new Date() } };
    // A code minted before subject binding (hash of the code alone). None is
    // minted any more; one can only predate the deploy (codes live 2 minutes).
    let resetToken = await tx.passwordResetToken.findFirst({
      where: { tokenHash: hashToken(token), ...live },
    });
    // SUBJECT BINDING (AH-D2 / SEC-003, 9 Oct 2026; lib/auth-token-binding.ts):
    // a current code's stored hash covers the id of the person it was sent
    // for. Look for the hash computed for whoever holds this address NOW — a
    // different person (the first deleted, another created at the address)
    // computes a different hash and finds nothing. Same precedence as
    // forgot-password: a staff user, else a member who can sign in.
    if (!resetToken) {
      const holderUser = await tx.user.findFirst({ where: { email: normEmail, tenantId: tenant.id }, select: { id: true } });
      const holderMember = holderUser
        ? null
        : await tx.member.findFirst({
            where: { email: normEmail, tenantId: tenant.id, passwordHash: { not: null } },
            select: { id: true },
          });
      const holder: TokenSubject | null = holderUser
        ? { kind: "user", id: holderUser.id }
        : holderMember
          ? { kind: "member", id: holderMember.id }
          : null;
      if (holder) {
        resetToken = await tx.passwordResetToken.findFirst({
          where: { tokenHash: hashSubjectBoundResetCode(token, { tenantId: tenant.id, subject: holder }), ...live },
        });
        if (resetToken) boundTo = holder;
      }
    }
    if (!resetToken) return { resetToken: null, subject: null, history: [] as string[] };
    // Audit iter-4-database A8I4-V-2 [High]: only id + passwordHash are
    // consumed (bcrypt comparison below + history check). Bare findFirst
    // would otherwise load totpSecret + totpRecoveryCodes + sessionVersion
    // into server memory — no wire leak today but fragile if response
    // shape ever changes.
    const user = await tx.user.findFirst({
      where: { email: normEmail, tenantId: tenant.id },
      select: { id: true, passwordHash: true, mustChangePassword: true, loginEmailProvisionalSince: true },
    });
    // A provisional login email (7 Oct 2026, lib/login-email.ts) never
    // receives a reset code, so a code for it can only predate the marking (or
    // be a guess): refused as an expired code, and burned below so it cannot
    // be replayed once the mark is cleared.
    if (isLoginEmailProvisional(user)) {
      return { resetToken, subject: null, history: [] as string[], provisionalUserId: user!.id };
    }
    // A staff account on a temporary password cannot be reset by mailbox
    // (3 Oct 2026, see forgot-password). This catches a code requested before
    // the flag was set. Answered as an expired code: no new oracle, and no
    // fall-through to a member sharing the address (User precedence holds).
    if (user?.mustChangePassword === true) {
      return { resetToken, subject: null, history: [] as string[] };
    }
    if (user) {
      const history = await recentPasswordHashes(tx, user.id);
      return {
        resetToken,
        subject: { kind: "user" as const, id: user.id, passwordHash: user.passwordHash },
        history,
      };
    }
    // Fall back to Member. Members with passwordHash=null cannot reset
    // (they sign in via magic link). Members do not have password history
    // tracking today; the history check is staff-only.
    const member = await tx.member.findFirst({
      where: { email: normEmail, tenantId: tenant.id, passwordHash: { not: null } },
      select: { id: true, passwordHash: true },
    });
    if (!member || !member.passwordHash) {
      return { resetToken, subject: null, history: [] as string[] };
    }
    return {
      resetToken,
      subject: { kind: "member" as const, id: member.id, passwordHash: member.passwordHash },
      history: [] as string[],
    };
  });

  if (!lookups.resetToken) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 }
    );
  }
  if ("provisionalUserId" in lookups && lookups.provisionalUserId) {
    const refusedId = lookups.provisionalUserId;
    const tokenId = lookups.resetToken.id;
    await withTenantContext(tenant.id, (tx) =>
      tx.passwordResetToken.updateMany({ where: { id: tokenId, used: false }, data: { used: true } }),
    );
    await logAudit({
      tenantId: tenant.id,
      userId: null,
      action: "auth.password_reset.refused_provisional",
      entityType: "User",
      entityId: refusedId,
      metadata: { reason: "login_email_provisional", stage: "consume" },
      req,
    });
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 },
    );
  }
  // If a token is valid but the subject no longer exists (e.g. soft-deleted),
  // collapse to the same 400/message as an invalid token so an attacker who
  // somehow guesses a valid token can't learn that the user was deleted.
  // The subject the reset will write must be the one the code is bound to
  // (the two reads above are separate statements; a holder swapped between
  // them is refused, not reset).
  const bound = boundTo as TokenSubject | null;
  if (bound && lookups.subject && (bound.kind !== lookups.subject.kind || bound.id !== lookups.subject.id)) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 },
    );
  }
  if (!lookups.subject) {
    return NextResponse.json(
      { error: "Code is invalid or has expired (codes are valid for 2 minutes). Please request a new one." },
      { status: 400 },
    );
  }
  const { resetToken, subject, history } = lookups;

  // Audit iter-1-auth-boundary AH-10: parallelise the 8 bcrypt.compare calls.
  // Serial worst-case = 8 × ~100ms = ~800ms CPU before the new hash, which on
  // Vercel Hobby shared vCPU is a borderline-timeout DoS surface. bcrypt is
  // async and Node's libuv thread pool handles parallel CPU work cleanly.
  // Since 8 Oct 2026 the current password counts too (shared rule); members
  // keep no history and are checked as before (nothing to compare).
  if (subject.kind === "user" && (await passwordReused(password, subject.passwordHash, history))) {
    return NextResponse.json(
      { error: `You cannot reuse your current password or any of your last ${PASSWORD_HISTORY_LIMIT} passwords.` },
      { status: 400 }
    );
  }

  // Atomically consume the token — prevents two concurrent requests both succeeding.
  const consumed = await withTenantContext(tenant.id, (tx) =>
    tx.passwordResetToken.updateMany({
      where: { id: resetToken.id, used: false, expiresAt: { gt: new Date() } },
      data: { used: true },
    }),
  );
  if (consumed.count !== 1) {
    return NextResponse.json(
      { error: "Code is invalid or has already been used. Please request a new one." },
      { status: 400 },
    );
  }

  const newHash = await bcrypt.hash(password, 12);

  await withTenantContext(tenant.id, async (tx) => {
    if (subject.kind === "user") {
      // Update password AND bump sessionVersion so any pre-existing JWTs become
      // invalid on the next Node-runtime auth() check. Without this, an attacker
      // who stole credentials retains a valid session for ~30 days after the
      // legitimate user resets their password.
      await tx.user.update({
        where: { id: subject.id },
        data: {
          passwordHash: newHash,
          sessionVersion: { increment: 1 },
          // Clear the brute-force lockout too.
          //
          // `app/login/page.tsx:61` tells a locked person: "Try again in an
          // hour, or reset your password." Without this the second half of
          // that sentence was a lie — `auth.ts:294`/`:312` throws
          // AccountLockedError BEFORE comparing the password, so the new one
          // was never consulted, and the clear at `auth.ts:358-374` only runs
          // after a sign-in the lock had already prevented. Someone who holds
          // the reset code has proved control of the mailbox, which is a
          // stronger claim than the ten wrong guesses that set the lock.
          lockedUntil: null,
          failedLoginCount: 0,
        },
      });
      // Store current password in history before overwriting, pruned to the limit.
      await recordPasswordHistory(tx, subject.id, subject.passwordHash);
    } else {
      // Audit iter-1-auth-boundary AH-3: member password reset. Same
      // sessionVersion bump as User to invalidate stale JWTs. No password
      // history tracking for members today — keep this PR scoped to enabling
      // the reset flow; per-member history is a separate feature.
      await tx.member.update({
        where: { id: subject.id },
        data: {
          passwordHash: newHash,
          sessionVersion: { increment: 1 },
          // Same lockout clear as the User branch above. Members are the ones
          // who actually get locked out — at the kiosk and on the portal — and
          // `POST /api/members/[id]/unlock` needs a member of staff to be
          // standing there, which at 21:00 on a Tuesday is nobody.
          lockedUntil: null,
          failedLoginCount: 0,
        },
      });
    }
  });

  return NextResponse.json({ ok: true });
}
