import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { randomInt } from "crypto";

// In-memory rate limiter: 3 requests per email per 15 minutes
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now >= entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count++;
  return { allowed: true, retryAfterSeconds: 0 };
}

export async function POST(req: Request) {
  const { email, tenantSlug } = await req.json();

  if (!email || !tenantSlug) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
  }

  // Rate limit by email+tenant
  const rateLimitKey = `${tenantSlug}:${email.toLowerCase().trim()}`;
  const { allowed, retryAfterSeconds } = checkRateLimit(rateLimitKey);
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

  await prisma.passwordResetToken.create({
    data: {
      email: email.toLowerCase().trim(),
      tenantId: tenant.id,
      token,
      expiresAt,
    },
  });

  // TODO: Send email via your email provider (Resend, SendGrid, etc.)
  // OTP is NOT logged here — configure an email provider to deliver it
  if (process.env.NODE_ENV !== "production") {
    console.log(`[MatFlow DEV] Password reset token created for ${tenantSlug} (check DB)`);
  }

  return NextResponse.json({ ok: true });
}
