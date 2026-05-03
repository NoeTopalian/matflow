import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { NextRequest, NextResponse } from "next/server";
import { encode } from "next-auth/jwt";
import { logAudit } from "@/lib/audit-log";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { hashToken } from "@/lib/token-hash";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");

  if (!token) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

  // Fix 1: tokens are stored hashed at rest. Re-hash the incoming raw token
  // and look up by tokenHash (the @unique index makes this constant-time).
  const tokenHash = hashToken(token);

  // Token consume + tenant lookup happens before we know which tenant the
  // token belongs to, so we bypass RLS for that step. Once tenantId is
  // resolved we switch to tenant-scoped context for the User/Member lookup.
  const consumeResult = await withRlsBypass(async (tx) => {
    const consumed = await tx.magicLinkToken.updateMany({
      where: { tokenHash, used: false, expiresAt: { gt: new Date() } },
      data: { used: true, usedAt: new Date() },
    });
    if (consumed.count !== 1) return null;
    return tx.magicLinkToken.findUnique({
      where: { tokenHash },
      select: { tenantId: true, email: true, purpose: true },
    });
  });

  if (!consumeResult) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }
  const tokenRow = consumeResult;

  // Resolve user OR member — tenantId MUST match token row (defense in depth)
  const lookups = await withTenantContext(tokenRow.tenantId, async (tx) => {
    const u = await tx.user.findFirst({
      where: { tenantId: tokenRow.tenantId, email: tokenRow.email },
      select: { id: true, tenantId: true, email: true, name: true, role: true, sessionVersion: true },
    });
    const m = !u
      ? await tx.member.findFirst({
          // Sprint 3 K: defence-in-depth — kid sub-accounts (passwordHash null) cannot mint a session
          // even if a token row exists for the synthesised email.
          where: { tenantId: tokenRow.tenantId, email: tokenRow.email, passwordHash: { not: null } },
          select: { id: true, tenantId: true, email: true, name: true, sessionVersion: true },
        })
      : null;
    const t = await tx.tenant.findUnique({
      where: { id: tokenRow.tenantId },
      select: { slug: true },
    });
    return { user: u, member: m, tenant: t };
  });
  const { user, member, tenant } = lookups;

  if (!user && !member) {
    return NextResponse.redirect(new URL("/login?error=invalid_link", req.url));
  }

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
