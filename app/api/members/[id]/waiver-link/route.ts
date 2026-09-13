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
import { STAFF_ROLES } from "@/lib/authz";

export const runtime = "nodejs";

// Was a LOCAL two-element `STAFF_ROLES` shadowing the four-element shared
// constant under the identical name — which is how this ended up stricter than
// its own dangerous sibling.
//
// /api/members/[id]/waiver/sign EXECUTES the waiver in the member’s name and
// admits all four staff roles; this route merely emails the member a link so
// they can sign it themselves, and admitted two. The strictly less powerful
// verb was the restricted one.
//
// Resolved by widening this rather than narrowing sign, because the supervised
// signing PAGE (app/dashboard/members/[id]/waiver) is requireStaff() on
// purpose: a waiver gets signed on a club tablet supervised by whoever is on
// duty, usually a coach. Narrowing sign would have broken a deliberate flow and
// manufactured a fresh page-renders-but-API-403s defect.
//
// Making both owner+manager is a coherent alternative — but that is a product
// decision about whether waivers are a senior-only action, not a correctness
// one, and it belongs to the club owner rather than to this file.

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
