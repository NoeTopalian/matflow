import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { logAudit } from "@/lib/audit-log";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

  // B-1 + B-2: Atomic consume — rejects if already used, expired, or not found
  const consumed = await prisma.magicLinkToken.updateMany({
    where: { token, used: false, expiresAt: { gt: new Date() } },
    data: { used: true, usedAt: new Date() },
  });

  if (consumed.count !== 1) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

  // Safe to read the row now — we have confirmed it existed and atomically consumed it
  const tokenRow = await prisma.magicLinkToken.findUnique({
    where: { token },
    select: { tenantId: true, email: true, purpose: true },
  });

  if (!tokenRow) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

  // Resolve user OR member — tenantId MUST match token row (defense in depth)
  const user = await prisma.user.findFirst({
    where: { tenantId: tokenRow.tenantId, email: tokenRow.email },
    select: { id: true, tenantId: true, email: true, name: true, role: true, sessionVersion: true },
  });

  const member = !user
    ? await prisma.member.findFirst({
        where: { tenantId: tokenRow.tenantId, email: tokenRow.email },
        select: { id: true, tenantId: true, email: true, name: true, sessionVersion: true },
      })
    : null;

  if (!user && !member) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

  // Fetch tenant slug for cookie payload
  const tenant = await prisma.tenant.findUnique({
    where: { id: tokenRow.tenantId },
    select: { slug: true },
  });

  if (!tenant) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

  const secure = process.env.NODE_ENV === "production";
  const cookieName = secure
    ? "__Secure-next-auth.session-token"
    : "next-auth.session-token";

  // Mint NextAuth JWT — mirrors the structure from totp/verify/route.ts
  const jwtPayload = user
    ? {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        tenantId: user.tenantId,
        tenantSlug: tenant.slug,
        sessionVersion: user.sessionVersion,
        totpPending: false,
      }
    : {
        id: member!.id,
        email: member!.email,
        name: member!.name,
        role: "member",
        tenantId: member!.tenantId,
        tenantSlug: tenant.slug,
        sessionVersion: member!.sessionVersion,
        totpPending: false,
      };

  const encoded = await encode({
    token: jwtPayload,
    secret: AUTH_SECRET_VALUE!,
    maxAge: 30 * 24 * 60 * 60,
    salt: cookieName,
  });

  await logAudit({
    tenantId: tokenRow.tenantId,
    userId: user?.id ?? null,
    action: "auth.magic_link.consume",
    entityType: user ? "User" : "Member",
    entityId: user?.id ?? member!.id,
    metadata: { email: tokenRow.email },
    req,
  });

  const destination = user ? "/dashboard" : "/member/home";
  const res = NextResponse.redirect(new URL(destination, req.url));
  res.cookies.set(cookieName, encoded, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });
  return res;
}
