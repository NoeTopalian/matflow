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
  const user = await withTenantContext(tenant.id, (tx) =>
    tx.user.findFirst({ where: { email: normEmail, tenantId: tenant.id } }),
  );

  // Always return 200 to prevent email enumeration
  if (!user) return NextResponse.json({ ok: true });

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

  // Sprint 5 US-502: production fail-closed with informative error when RESEND_API_KEY
  // is missing — same pattern as /api/magic-link/request. Dev mode logs the OTP and
  // returns 200 so local development isn't blocked on env config.
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === "production") {
      console.error("[forgot-password] RESEND_API_KEY unset in production");
      return NextResponse.json(
        { error: "Email service not configured. Set RESEND_API_KEY." },
        { status: 503 },
      );
    }
    console.log(`[MatFlow DEV] Password reset code: ${token} for ${tenantSlug}/${email}`);
    return NextResponse.json({ ok: true });
  }

  const sendResult = await sendEmail({
    tenantId: tenant.id,
    templateId: "password_reset",
    to: email.toLowerCase().trim(),
    vars: { code: token, gymName: tenant.name },
  });
  if (!sendResult.ok) {
    console.error("[forgot-password] email send failed", sendResult);
    return NextResponse.json(
      { error: "Could not send the reset email. Please try again." },
      { status: 503 },
    );
  }

  return NextResponse.json({ ok: true });
}
