// POST /api/members/[id]/card/revoke
//
// Kills every printed ID card a member currently holds, by bumping the
// `cardVersion` that lib/card-token.ts bakes into the QR. The scanner
// (app/api/checkin/card) compares the decoded version against this column and
// refuses anything behind it, so the old laminated card stops working the
// moment this returns — and a replacement printed afterwards carries the new
// version.
//
// Until this route existed the column was a handle nothing could turn:
// lib/card-token.ts said so in terms ("REVOCATION IS NOT YET OPERABLE"), which
// meant a lost card stayed valid for its full five-year expiry. That is the
// reason no member was allowed a printed card before the scanner and this
// route both shipped.
//
// Gated at requireApiStaff to MATCH THE PRINT PAGE (app/print/member-cards,
// which calls requireStaff). Anyone who can issue a card can cancel one;
// splitting the two would leave a coach able to print a replacement while
// unable to kill the card it replaces, which is the same
// adjacent-screens-disagree failure the scanner's permission rule avoids.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiStaff } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

export const runtime = "nodejs";

const bodySchema = z.object({
  // Required, as on the sibling credential reset (members/[id]/totp-reset). A
  // physical credential being cancelled is a real-world event — "lost at
  // training", "left the club" — and an audit row that cannot say which is
  // worth much less when someone asks months later why a card stopped working.
  reason: z.string().min(5).max(500),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id: memberId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Reason (min 5 characters) required" }, { status: 400 });
  }

  // Tenant scope is enforced by withTenantContext AND the where clause, so a
  // forged memberId from another club cannot be reached.
  const outcome = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({
      where: { id: memberId, tenantId },
      select: { id: true, name: true, cardVersion: true },
    });
    if (!member) return null;

    // Increment rather than write a computed value: two staff revoking the same
    // lost card at once must not land on the same version and leave one of the
    // old cards alive.
    const updated = await tx.member.update({
      where: { id: member.id },
      data: { cardVersion: { increment: 1 } },
      select: { cardVersion: true },
    });
    return { member, newVersion: updated.cardVersion };
  });

  if (!outcome) {
    return NextResponse.json({ error: "Member not found" }, { status: 404 });
  }

  await logAudit({
    tenantId,
    userId,
    action: "member.card_revoked",
    entityType: "Member",
    entityId: outcome.member.id,
    metadata: {
      reason: parsed.data.reason,
      previousCardVersion: outcome.member.cardVersion,
      cardVersion: outcome.newVersion,
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    cardVersion: outcome.newVersion,
    memberName: outcome.member.name,
  });
}
