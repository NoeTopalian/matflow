import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { randomInt } from "crypto";
import { z } from "zod";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

// Audit iter-1-auth-boundary AH-8: validate body to bound input length + enforce
// email format. Matches the magic-link/request pattern.
const bodySchema = z.object({
  email: z.string().email().max(120),
  tenantSlug: z.string().min(1).max(60),
});

export async function POST(req: Request) {
  let raw: unknown;
  try { raw = await req.json(); } catch { return NextResponse.json({ ok: true }); }
  const parsed = bodySchema.safeParse(raw);
  // Audit iter-1-auth-boundary AH-9: opaque success on every failure path
  // (invalid body, missing tenant, missing user) so the endpoint cannot be
  // used to enumerate tenant slugs or email addresses.
  if (!parsed.success) return NextResponse.json({ ok: true });
  const { email, tenantSlug } = parsed.data;

  const rateLimitKey = `forgot:${tenantSlug}:${email.toLowerCase().trim()}`;
  const { allowed, retryAfterSeconds } = await checkRateLimit(rateLimitKey, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  // Look up tenant — pre-session bypass.
  const tenant = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { slug: tenantSlug } }),
  );
  // Audit iter-1-auth-boundary AH-9: opaque success when tenant not found
  // (was previously 404 "Gym not found." — enabled tenant-slug enumeration).
  if (!tenant) return NextResponse.json({ ok: true });

  // From here we know the tenant — switch to tenant-scoped context.
  const normEmail = email.toLowerCase().trim();
  // Audit iter-1-auth-boundary AH-3: members with passwordHash are first-
  // class login subjects (auth.ts:317). Look them up too so they can self-
  // service reset. Members without a password (magic-link-only) get no
  // reset email — they don't have a password to reset.
  //
  // Audit iter-2 A2H2-3 (deferred to backlog M-A2I2-1): when a User and
  // Member share the same email in the same tenant, User wins precedence at
  // reset-password consume time. The PasswordResetToken row carries only
  // email + tenantId (no subjectKind discriminator yet). This matches the
  // codebase-wide precedence at auth.ts:187 — staff identity dominates. A
  // proper fix requires adding `subjectKind` to PasswordResetToken (DB
  // migration, deferred). Until then, document explicitly here.
  const [user, member] = await withTenantContext(tenant.id, (tx) =>
    Promise.all([
      tx.user.findFirst({ where: { email: normEmail, tenantId: tenant.id }, select: { id: true } }),
      tx.member.findFirst({
        where: { email: normEmail, tenantId: tenant.id, passwordHash: { not: null } },
        select: { id: true },
      }),
    ]),
  );

  // Always return 200 to prevent email enumeration. Subject type is
  // discovered at consume time (the PasswordResetToken row only carries
  // email + tenantId; both subject lookups happen on reset-password).
  if (!user && !member) return NextResponse.json({ ok: true });

  // Generate 6-digit OTP
  const token = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

  await withTenantContext(tenant.id, async (tx) => {
    // Invalidate any existing unused tokens for this email + tenant
    await tx.passwordResetToken.updateMany({
      where: { email: normEmail, tenantId: tenant.id, used: false },
      data: { used: true },
    });
    // Fix 1: persist HMAC of the OTP, not the raw value — see lib/token-hash.ts.
    await tx.passwordResetToken.create({
      data: {
        email: normEmail,
        tenantId: tenant.id,
        tokenHash: hashToken(token),
        expiresAt,
      },
    });
  });

  // A FAILED SEND MUST NOT ANSWER DIFFERENTLY FROM AN UNKNOWN ADDRESS.
  //
  // This route is opaque on purpose: an address with no account, a club that
  // does not exist and a malformed body all answer `200 {"ok":true}` so that
  // nobody can use "I forgot my password" to enumerate a club's roster. Only
  // an address that DOES have an account ever reaches this point, so the two
  // 503s that used to live here were a clean oracle — 503 meant "this person
  // trains here", 200 meant "they do not" — and mail being down is a
  // club-wide, operator-visible condition that tells the caller nothing about
  // their own request.
  //
  // The operator keeps the real signal: a console error, and, when a send was
  // attempted at all, the `EmailLog` row `sendEmail` writes at status 'failed'.
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === "production") {
      console.error("[forgot-password] RESEND_API_KEY unset in production — no code was sent");
    } else {
      console.log(`[MatFlow DEV] Password reset code: ${token} for ${tenantSlug}/${email}`);
    }
    return NextResponse.json({ ok: true });
  }

  const sendResult = await sendEmail({
    tenantId: tenant.id,
    templateId: "password_reset",
    to: email.toLowerCase().trim(),
    vars: { code: token, gymName: tenant.name },
  });
  if (!sendResult.ok) {
    // Loud for the operator, silent for the caller — see the note above.
    console.error("[forgot-password] email send failed", sendResult);
  }

  return NextResponse.json({ ok: true });
}
