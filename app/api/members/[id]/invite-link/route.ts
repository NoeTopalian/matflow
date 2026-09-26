/**
 * POST /api/members/[id]/invite-link
 *
 * Mints a fresh first-time-login link for one adult member and returns it ONCE
 * to the owner or manager who asked, so it can be handed to the person at the
 * desk when email is not delivering (customer simulation, 26 Sep 2026, F-5:
 * every member credential travelled by email and nothing on screen offered a
 * fallback).
 *
 * This is the same token the emailed invite carries (`first_time_signup`,
 * 7 days, single use, hash-only at rest — lib/token-hash.ts). Asking for a
 * link invalidates any earlier unused invite for the same address, so a link
 * that was shown and then lost can be replaced rather than left live. The
 * action is audited. Kids never get a link (passwordless by design) and a
 * synthesised address is refused for the same reason the email path refuses it.
 *
 * Restricted to owner and manager: the desk roles can send the emailed invite
 * but should not be handed a working login credential to copy.
 */
import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { assertSameOrigin } from "@/lib/csrf";
import { getBaseUrl } from "@/lib/env-url";
import { logAudit } from "@/lib/audit-log";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

export const runtime = "nodejs";

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager"].includes(session.user.role)) {
    return NextResponse.json({ error: "Only the owner or a manager can show an invite link." }, { status: 403 });
  }

  const tenantId: string = session.user.tenantId;
  const { id: memberId } = await params;

  const member = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({ where: { id: memberId, tenantId }, select: { id: true, email: true, accountType: true, name: true } }),
  );
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  if (member.accountType === "kids") {
    return NextResponse.json({ error: "Children don't have their own login — their parent signs in for them." }, { status: 400 });
  }
  const email = member.email;
  if (!email || isSynthesisedEmail(email)) {
    return NextResponse.json({ error: "This member has no email address — add one before creating an invite link." }, { status: 400 });
  }

  // Someone who already has a password uses "Forgot password?" — a fresh
  // invite link would let whoever holds it take over an existing login.
  // Members keep their password on the Member row (accept-invite writes it there).
  const existing = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({ where: { id: memberId, tenantId }, select: { passwordHash: true } }),
  );
  if (existing?.passwordHash) {
    return NextResponse.json({ error: `${member.name} already has a login. They can use "Forgot password?" on the sign-in screen.` }, { status: 409 });
  }

  const rawToken = randomBytes(24).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TOKEN_TTL_MS);

  try {
    await withTenantContext(tenantId, async (tx) => {
      await tx.magicLinkToken.updateMany({
        where: { email, tenantId, purpose: "first_time_signup", used: false },
        data: { used: true, usedAt: new Date() },
      });
      await tx.magicLinkToken.create({
        data: { tenantId, email, tokenHash, purpose: "first_time_signup", expiresAt },
      });
    });
  } catch (e) {
    console.error("[members/[id]/invite-link]", e);
    return NextResponse.json({ error: "Could not create the invite link. Try again." }, { status: 500 });
  }

  await logAudit({
    tenantId,
    userId: session.user.id,
    action: "member.invite_link.generated",
    entityType: "Member",
    entityId: memberId,
    metadata: { expiresAt: expiresAt.toISOString() },
    req,
  });

  const url = `${getBaseUrl(req)}/login/accept-invite?token=${encodeURIComponent(rawToken)}`;
  return NextResponse.json({ url, expiresAt: expiresAt.toISOString() });
}
