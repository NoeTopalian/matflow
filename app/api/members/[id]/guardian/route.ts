// POST /api/members/[id]/guardian — confirm or reject a SUGGESTED guardian link
// (2 Oct 2026). `[id]` is the CHILD.
//
// An import may suggest a parent link from a shared email address or from the
// emergency contact on a child's TeamUp row. The link is written with
// guardianConfirmedAt NULL and grants the parent nothing — no portal access,
// no acting for the child — until a person who knows the family confirms it
// here. Rejecting an under-13's only link is refused (the database requires a
// guardian for a kid): link the right one first with "Link existing", which
// moves the child and is itself confirmed.
//
// `adoptUnverifiedEmail`: a guardian draft made from an emergency contact
// keeps the payer's real address as `unverifiedEmail` and signs in with none.
// Confirming can promote that address to the login address — only if no
// other member in the club has it — so the owner can later invite them.
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwnerOrManager } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { apiError } from "@/lib/api-error";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";

export const runtime = "nodejs";

const bodySchema = z.object({
  action: z.enum(["confirm", "reject"]),
  adoptUnverifiedEmail: z.boolean().optional().default(false),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiOwnerOrManager();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id: childId } = await params;

  const body = await req.json().catch(() => null);
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return apiError("action must be confirm or reject", 400);
  const { action, adoptUnverifiedEmail } = parsed.data;

  const outcome = await withTenantContext(tenantId, async (tx) => {
    const child = await tx.member.findFirst({
      where: { id: childId, tenantId },
      select: { id: true, name: true, accountType: true, parentMemberId: true, guardianConfirmedAt: true, guardianSuggestedBy: true },
    });
    if (!child) return { kind: "no-child" as const };
    if (!child.parentMemberId) return { kind: "no-link" as const };
    const parent = await tx.member.findFirst({
      where: { id: child.parentMemberId, tenantId },
      select: { id: true, name: true, email: true, unverifiedEmail: true, accountType: true },
    });
    if (!parent) return { kind: "no-link" as const };

    if (action === "reject") {
      if (child.accountType === "kids") return { kind: "kid-needs-guardian" as const, parent };
      const r = await tx.member.updateMany({
        where: { id: child.id, tenantId, parentMemberId: parent.id },
        data: { parentMemberId: null, guardianConfirmedAt: null, guardianSuggestedBy: null },
      });
      if (r.count !== 1) return { kind: "conflict" as const };
      return { kind: "rejected" as const, child, parent, wasConfirmed: !!child.guardianConfirmedAt };
    }

    // confirm
    let emailAdopted: string | null = null;
    if (adoptUnverifiedEmail && parent.unverifiedEmail && isSynthesisedEmail(parent.email)) {
      const taken = await tx.member.findFirst({ where: { tenantId, email: parent.unverifiedEmail }, select: { id: true } });
      if (taken) return { kind: "email-taken" as const, email: parent.unverifiedEmail };
      await tx.member.update({ where: { id: parent.id }, data: { email: parent.unverifiedEmail, unverifiedEmail: null } });
      emailAdopted = parent.unverifiedEmail;
    }
    const r = await tx.member.updateMany({
      where: { id: child.id, tenantId, parentMemberId: parent.id },
      data: { guardianConfirmedAt: new Date(), guardianSuggestedBy: child.guardianSuggestedBy ?? "staff" },
    });
    if (r.count !== 1) return { kind: "conflict" as const };
    return { kind: "confirmed" as const, child, parent, emailAdopted, wasConfirmed: !!child.guardianConfirmedAt };
  });

  if (outcome.kind === "no-child") return apiError("Member not found", 404);
  if (outcome.kind === "no-link") return apiError("This member has no guardian link to confirm or reject.", 404);
  if (outcome.kind === "conflict") return apiError("The guardian link changed while you were looking at it — reload.", 409);
  if (outcome.kind === "kid-needs-guardian") {
    return apiError(`A child under 13 must have a guardian. Open the right guardian's profile and use Link existing to move the child; that replaces this suggestion.`, 409);
  }
  if (outcome.kind === "email-taken") {
    return apiError(`${outcome.email} already belongs to another member in this club, so it was not adopted. Confirm without adopting, or sort out the other record first.`, 409);
  }

  await logAudit({
    tenantId,
    userId,
    action: outcome.kind === "confirmed" ? "member.guardian.confirmed" : "member.guardian.rejected",
    entityType: "Member",
    entityId: outcome.child.id,
    metadata: {
      parentMemberId: outcome.parent.id,
      suggestedBy: outcome.child.guardianSuggestedBy ?? null,
      wasConfirmed: outcome.wasConfirmed,
      ...(outcome.kind === "confirmed" && outcome.emailAdopted ? { emailAdopted: true } : {}),
    },
    req,
  });

  return NextResponse.json({
    ok: true,
    action,
    message:
      outcome.kind === "confirmed"
        ? `${outcome.parent.name} is confirmed as ${outcome.child.name}'s guardian.${outcome.emailAdopted ? " Their address is now their login — you can invite them." : ""}`
        : `${outcome.parent.name} is no longer linked to ${outcome.child.name}.`,
  });
}
