import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail } from "@/lib/email";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { z } from "zod";

const schema = z.object({
  email: z.string().email().max(120),
  tenantSlug: z.string().min(1).max(60),
});

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch (e) { console.error("[magic-link/request] malformed JSON body", e); return NextResponse.json({ ok: true }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: true });
  const { email, tenantSlug } = parsed.data;
  const normEmail = email.toLowerCase().trim();

  const rl = await checkRateLimit(`magic-link:${tenantSlug}:${normEmail}`, 3, 15 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json({ ok: true }); // silent rate-limit (no enumeration)
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } });
  if (!tenant) return NextResponse.json({ ok: true });

  // Check user OR member exists in this tenant
  const user = await prisma.user.findFirst({
    where: { tenantId: tenant.id, email: normEmail },
    select: { id: true },
  });
  const member = !user
    ? await prisma.member.findFirst({
        // Sprint 3 K: passwordHash IS NOT NULL excludes kid sub-accounts
        // (which have synthesised emails and are intentionally non-loginable).
        where: { tenantId: tenant.id, email: normEmail, passwordHash: { not: null } },
        select: { id: true },
      })
    : null;
  if (!user && !member) return NextResponse.json({ ok: true });

  // Anti-stockpile: invalidate prior unused tokens for this email+tenant
  await prisma.magicLinkToken.updateMany({
    where: { email: normEmail, tenantId: tenant.id, used: false },
    data: { used: true, usedAt: new Date() },
  });

  // Issue new token (B-3: 32 random bytes as hex = 64-char string)
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes
  await prisma.magicLinkToken.create({
    data: {
      tenantId: tenant.id,
      email: normEmail,
      token,
      purpose: "login",
      expiresAt,
      ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent")?.slice(0, 500) ?? null,
    },
  });

  // Build the link
  const baseUrl = process.env.NEXTAUTH_URL ?? new URL(req.url).origin;
  const link = `${baseUrl}/api/magic-link/verify?token=${encodeURIComponent(token)}`;

  // Send email — production fails closed if RESEND_API_KEY unset
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === "production") {
      console.error("[magic-link/request] RESEND_API_KEY unset in production");
      return apiError("Email service not configured", 503, undefined, "[magic-link/request]");
    }
    console.log(`[MatFlow DEV] Magic-link: ${link}`);
  } else {
    const result = await sendEmail({
      tenantId: tenant.id,
      templateId: "magic_link",
      to: normEmail,
      vars: { gymName: tenant.name, link, expiresIn: "30 minutes" },
    });
    if (!result?.ok) {
      console.error("[magic-link/request] sendEmail failed", result);
      return apiError("Could not send sign-in link", 503, undefined, "[magic-link/request]");
    }
  }

  await logAudit({
    tenantId: tenant.id,
    userId: null,
    action: "auth.magic_link.request",
    entityType: user ? "User" : "Member",
    entityId: user?.id ?? member!.id,
    metadata: { email: normEmail },
    req,
  });

  return NextResponse.json({ ok: true });
}
