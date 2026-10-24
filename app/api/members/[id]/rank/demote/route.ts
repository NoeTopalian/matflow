import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { STAFF_ROLES } from "@/lib/authz";
import { refuseSupportSessionUnlessEdit, refuseSupportEditFields, SUPPORT_EDIT_FIELD_POLICY } from "@/lib/support-session";
import { recordSupportRefusal, refusedFieldsOf } from "@/lib/support-refusal-audit";
import { OPEN_RULES, accessRefusals, highestRankOrder } from "@/lib/booking-eligibility";
import { recordKeptBookings } from "@/lib/booking-eligibility-db";

const demoteSchema = z.object({
  toRankId: z.string().min(1),
  reason: z.string().min(5).max(500).optional(),
  notify: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  const support = refuseSupportSessionUnlessEdit(session); if (support) return support; // view refused; an EDIT session may correct a rank (SUPPORT_EDIT_MUTATION_ALLOWLIST)
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Symmetric with promote — see the note there.
  const canDemote = STAFF_ROLES.includes(session.user.role);
  if (!canDemote) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id: memberId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }


  // Edit-session field policy (security review I-2): notify/reason refused -
  // notify emails operator-written free text to the member in the club's name.
  const fieldRefusal = refuseSupportEditFields(session, body, SUPPORT_EDIT_FIELD_POLICY["member.rank.demote"]);
  if (fieldRefusal) {
    await recordSupportRefusal(session, { route: "POST /api/members/[id]/rank/demote", refusedFields: await refusedFieldsOf(fieldRefusal) }, req);
    return fieldRefusal;
  }
  const parsed = demoteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { toRankId, reason, notify } = parsed.data;
  const tenantId = session.user.tenantId;

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      // Audit iter-4-database A8I4-V-4 [High]: select only the fields used
      // downstream (id, email, name for the rank_demoted email template).
      // Was bare findFirst pulling all sensitive scalars.
      const member = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: { id: true, email: true, name: true },
      });
      if (!member) return { kind: "no-member" as const };

      const newRank = await tx.rankSystem.findFirst({
        where: { id: toRankId, tenantId, deletedAt: null },
      });
      if (!newRank) return { kind: "no-rank" as const };

      const existingRank = await tx.memberRank.findFirst({
        where: {
          memberId,
          rankSystem: { discipline: newRank.discipline, tenantId },
        },
        include: { rankSystem: true },
      });

      // D2: the member's highest rank order (any discipline, the door's read)
      // before this demotion, so the classes it NEWLY turns them away from
      // can be told apart from ones that already refused them.
      const orderBefore = highestRankOrder(
        (await tx.memberRank.findMany({ where: { memberId, member: { tenantId } }, select: { rankSystem: { select: { order: true } } } }))
          .map((r) => r.rankSystem),
      );

      const updated = existingRank
        ? await tx.memberRank.update({
            where: { id: existingRank.id },
            data: {
              rankSystemId: toRankId,
              stripes: 0,
              achievedAt: new Date(),
              promotedById: session.user.id,
              rankHistory: {
                create: {
                  fromRankId: existingRank.rankSystemId,
                  toRankId,
                  promotedById: session.user.id,
                  notes: reason ?? "demotion",
                },
              },
            },
            include: { rankSystem: true },
          })
        : await tx.memberRank.create({
            data: {
              memberId,
              rankSystemId: toRankId,
              stripes: 0,
              promotedById: session.user.id,
              rankHistory: {
                create: {
                  fromRankId: null,
                  toRankId,
                  promotedById: session.user.id,
                  notes: reason ?? "demotion",
                },
              },
            },
            include: { rankSystem: true },
          });

      // D2 (approved 21 Oct 2026): bookings are KEPT. This used to delete the
      // member's bookings on every class whose rank gate the new rank no
      // longer meets. Now the booked classes the demotion newly turns them
      // away from are recorded durably in this transaction, judged as the
      // door judges (lib/booking-eligibility.ts: the highest rank order of any
      // discipline, at the member app, parent and kiosk doors), and the
      // member sees each one marked "not eligible".
      const orderAfter = highestRankOrder(
        (await tx.memberRank.findMany({ where: { memberId, member: { tenantId } }, select: { rankSystem: { select: { order: true } } } }))
          .map((r) => r.rankSystem),
      );
      const booked = await tx.classSubscription.findMany({
        where: { memberId, member: { tenantId }, class: { tenantId } },
        select: {
          classId: true,
          class: { select: { requiredRank: { select: { order: true } }, maxRank: { select: { order: true } } } },
        },
      });
      const turnedAwayFrom = booked
        .filter((b) => {
          const rules = {
            ...OPEN_RULES,
            requiredRankOrder: b.class.requiredRank?.order ?? null,
            maxRankOrder: b.class.maxRank?.order ?? null,
          };
          const facts = (rankOrder: number | null) => ({ memberId, membershipTierId: null, tierName: null, rankOrder });
          const refusedNow = accessRefusals(rules, facts(orderAfter)).some((r) => r === "rank_below" || r === "rank_above");
          const refusedBefore = accessRefusals(rules, facts(orderBefore)).some((r) => r === "rank_below" || r === "rank_above");
          return refusedNow && !refusedBefore;
        })
        .map((b) => b.classId)
        .sort();
      for (const classId of turnedAwayFrom) {
        await recordKeptBookings(tx, {
          tenantId,
          userId: session.user.id,
          classId,
          cause: "member.rank.demote",
          byTrigger: { rank: [memberId] },
          req,
          extra: { toRankId },
        });
      }

      return {
        kind: "ok" as const,
        value: updated,
        fromRankId: existingRank?.rankSystemId ?? null,
        // The previous stripe count, so the owner's Undo restores it exactly.
        fromStripes: existingRank?.stripes ?? null,
        bookingsKeptIneligibleClassIds: turnedAwayFrom,
        memberEmail: member.email,
        memberName: member.name,
      };
    });

    if (result.kind === "no-member") return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (result.kind === "no-rank") return NextResponse.json({ error: "Rank not found" }, { status: 404 });

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "member.rank.demote",
      entityType: "Member",
      entityId: memberId,
      metadata: {
        fromRankId: result.fromRankId,
        fromStripes: result.fromStripes,
        // A demotion lands on the new belt with 0 stripes; recorded so the
        // owner's Undo refuses if stripes were added on that belt since.
        stripes: 0,
        toRankId,
        reason: reason ?? null,
        // D2: no booking is cancelled any more; the classes whose rank gate
        // now turns the member away (bookings kept) are listed, and each has a
        // durable class.bookings.kept_ineligible row from the transaction.
        bookingsKeptIneligibleClassIds: result.bookingsKeptIneligibleClassIds,
      },
      req,
    });

    if (notify && result.memberEmail) {
      try {
        const { sendEmail } = await import("@/lib/email");
        await sendEmail({
          tenantId,
          templateId: "rank_demoted",
          to: result.memberEmail,
          vars: {
            memberName: result.memberName ?? "Member",
            newRankName: result.value.rankSystem?.name ?? "(unknown)",
            reason: reason ?? "",
          },
        });
      } catch (e) {
        console.error("[rank.demote] notify email failed", e);
      }
    }

    return NextResponse.json({
      ok: true,
      memberRank: result.value,
      // Always 0 since D2 (bookings are kept); kept for older clients.
      cancelledSubscriptions: 0,
      bookingsKeptIneligibleClassIds: result.bookingsKeptIneligibleClassIds,
    });
  } catch {
    return NextResponse.json({ error: "Failed to demote" }, { status: 500 });
  }
}
