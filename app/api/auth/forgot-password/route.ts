import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { randomInt } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";

const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export async function POST(req: Request) {
  const { email, tenantSlug } = await req.json();

  if (!email || !tenantSlug) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  const rateLimitKey = `forgot:${tenantSlug}:${email.toLowerCase().trim()}`;
  const { allowed, retryAfterSeconds } = await checkRateLimit(rateLimitKey, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } }
    );
  }

  // Look up tenant
  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) {
    return NextResponse.json({ error: "Gym not found." }, { status: 404 });
  }

  // Check the user exists in this tenant (don't reveal if they don't)
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase().trim(), tenantId: tenant.id },
  });

  // Always return 200 to prevent email enumeration
  if (!user) return NextResponse.json({ ok: true });

  // Invalidate any existing unused tokens for this email + tenant
  await prisma.passwordResetToken.updateMany({
    where: { email: email.toLowerCase().trim(), tenantId: tenant.id, used: false },
    data: { used: true },
  });

  // Generate 6-digit OTP
  const token = String(randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000); // 2 minutes

  // Fix 1: persist HMAC of the OTP, not the raw value — see lib/token-hash.ts.
  // The raw 6-digit code is sent via email and re-hashed at consume time.
  await prisma.passwordResetToken.create({
    data: {
      email: email.toLowerCase().trim(),
      tenantId: tenant.id,
      tokenHash: hashToken(token),
      expiresAt,
    },
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
