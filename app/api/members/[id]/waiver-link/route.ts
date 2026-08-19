// POST /api/members/[id]/waiver-link
//
// Owner/manager mints a public, no-login waiver link for a member. Reuses the
// same MagicLinkToken (purpose="waiver_open") mechanism as the kiosk email
// flow, but returns the URL directly (for copy + QR) instead of emailing it.
// The public page at /waiver/open?token=… loads the waiver and saves a
// SignedWaiver — the token is the credential, so no login is required.

import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { assertSameOrigin } from "@/lib/csrf";
import { getBaseUrl } from "@/lib/env-url";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

const STAFF_ROLES = ["owner", "manager"];

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId: string = session.user.tenantId;
  const { id: memberId } = await params;

  const member = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({ where: { id: memberId, tenantId }, select: { id: true, email: true } }),
  );
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
  const email = member.email;
  if (!email) {
    return NextResponse.json(
      { error: "This member has no email — add one before generating a waiver link." },
      { status: 400 },
    );
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  try {
    await withTenantContext(tenantId, async (tx) => {
      // Invalidate the member's prior unused waiver links so only the newest works.
      await tx.magicLinkToken.updateMany({
        where: { email, tenantId, purpose: "waiver_open", used: false },
        data: { used: true, usedAt: new Date() },
      });
      await tx.magicLinkToken.create({
        data: { tenantId, email, tokenHash, purpose: "waiver_open", expiresAt },
      });
    });
  } catch (e) {
    console.error("[members/[id]/waiver-link]", e);
    return NextResponse.json({ error: "Could not generate waiver link" }, { status: 500 });
  }

  await logAudit({
    tenantId,
    userId: session.user.id,
    action: "member.waiver_link.generated",
    entityType: "Member",
    entityId: memberId,
    req,
  });

  const url = `${getBaseUrl(req)}/waiver/open?token=${rawToken}`;
  return NextResponse.json({ url, expiresAt: expiresAt.toISOString() });
}
