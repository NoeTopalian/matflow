import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { randomInt } from "crypto";

export async function POST(req: Request) {
  const { email, tenantSlug } = await req.json();

  if (!email || !tenantSlug) {
    return NextResponse.json({ error: "Missing fields." }, { status: 400 });
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
  // For now, log to console during development
  console.log(`[MatFlow] Password reset OTP for ${email}: ${token}`);

  return NextResponse.json({ ok: true });
}
