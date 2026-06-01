import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { memberUpdateSchema as updateSchema } from "@/lib/schemas/member";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { stripTotpFields } from "@/lib/totp-immutable";
import {
  deleteParentMemberWithKidsResolution,
  type ParentDeletionStrategy,
} from "@/lib/member-delete";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Staff-only — without this, a member could enumerate other members in the
  // same tenant. Members read their own profile via /api/member/me.
  // (Security audit 2026-05-07, severity LOW.)
  const canRead = ["owner", "manager", "coach", "admin"].includes(session.user.role);
  if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  try {
    const { member, promoters } = await withTenantContext(session.user.tenantId, async (tx) => {
      // Audit iter-1-database A8I1-S-2 [Critical]: explicit select drops
      // passwordHash, totpSecret, totpRecoveryCodes, sessionVersion,
      // failedLoginCount, lockedUntil, waiverIpAddress from the wire.
      // Was: `include:` with no top-level select returns ALL Member scalar
      // fields. Any coach in the tenant could harvest the entire roster's
      // 2FA seeds + offline-crackable bcrypt hashes by hitting this route
      // for each member ID. GDPR Article 32 violation + 2FA bypass surface.
      const m = await tx.member.findFirst({
        where: { id, tenantId: session.user.tenantId },
        select: {
          id: true,
          tenantId: true,
          email: true,
          name: true,
          phone: true,
          membershipType: true,
          status: true,
          paymentStatus: true,
          notes: true,
          onboardingCompleted: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
          medicalConditions: true,
          dateOfBirth: true,
          accountType: true,
          waiverAccepted: true,
          waiverAcceptedAt: true,
          // NOTE: waiverIpAddress deliberately omitted — staff don't need it.
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          preferredPaymentMethod: true,
          lastAnnouncementSeenAt: true,
          parentMemberId: true,
          hasKidsHint: true,
          // totpEnabled (boolean) is fine; totpSecret + totpRecoveryCodes
          // (the actual 2FA seed material) are NOT.
          totpEnabled: true,
          classReminders: true,
          beltPromotions: true,
          gymAnnouncements: true,
          notifyOnNewLogin: true,
          joinedAt: true,
          updatedAt: true,
          memberRanks: {
            select: {
              id: true,
              memberId: true,
              rankSystemId: true,
              stripes: true,
              achievedAt: true,
              promotedById: true,
              rankSystem: true,
              rankHistory: {
                select: {
                  id: true,
                  memberRankId: true,
                  fromRankId: true,
                  toRankId: true,
                  promotedAt: true,
                  promotedById: true,
                  notes: true,
                },
                orderBy: { promotedAt: "desc" },
                take: 10,
              },
            },
            orderBy: { achievedAt: "desc" },
          },
          attendances: {
            select: {
              id: true,
              memberId: true,
              classInstanceId: true,
              checkInTime: true,
              checkInMethod: true,
              checkedInById: true,
              classInstance: {
                select: {
                  id: true,
                  classId: true,
                  date: true,
                  startTime: true,
                  endTime: true,
                  isCancelled: true,
                  class: {
                    select: {
                      id: true,
                      name: true,
                      coachName: true,
                      location: true,
                    },
                  },
                },
              },
            },
            orderBy: { checkInTime: "desc" },
            take: 20,
          },
        },
      });
      if (!m) return { member: null, promoters: new Map<string, { id: string; name: string }>() };

      // LB-007 (audit H4): enrich each MemberRank + RankHistory entry with the
      // promoter's name. Previously the UI only had promotedById and showed it
      // as blank.
      const promoterIds = new Set<string>();
      for (const rank of m.memberRanks) {
        if (rank.promotedById) promoterIds.add(rank.promotedById);
        for (const h of rank.rankHistory) {
          if (h.promotedById) promoterIds.add(h.promotedById);
        }
      }
      let pmap: Map<string, { id: string; name: string }> = new Map();
      if (promoterIds.size > 0) {
        const users = await tx.user.findMany({
          where: { id: { in: Array.from(promoterIds) } },
          select: { id: true, name: true },
        });
        pmap = new Map(users.map((u) => [u.id, u]));
      }
      return { member: m, promoters: pmap };
    });

    if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const enriched = {
      ...member,
      memberRanks: member.memberRanks.map((rank) => ({
        ...rank,
        promotedBy: rank.promotedById ? (promoters.get(rank.promotedById) ?? null) : null,
        rankHistory: rank.rankHistory.map((h) => ({
          ...h,
          promotedBy: h.promotedById ? (promoters.get(h.promotedById) ?? null) : null,
        })),
      })),
    };
    return NextResponse.json(enriched);
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canEdit = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    // Defence in depth: strip TOTP fields so an attacker cannot disable
    // a member's TOTP through this PATCH route. Only the dedicated reset
    // endpoints (/api/admin/customers/[id]/member-totp-reset for operator
    // and /api/members/[id]/totp-reset for staff) may clear it.
    body = stripTotpFields(await req.json() as Record<string, unknown>);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const { dateOfBirth, updatedAt: clientUpdatedAt, ...rest } = parsed.data;
    // Optimistic-concurrency precondition: only update if the row's updatedAt
    // matches what the client thinks it is. Skipped when no precondition is
    // sent so existing callers stay backward-compatible.
    const concurrencyGuard = clientUpdatedAt ? { updatedAt: new Date(clientUpdatedAt) } : {};
    // Audit iter-1-member-lifecycle A3C-2 + A3H-6: pre-flight checks before
    // any mutation. Two cases require a DB lookup of the existing member:
    //   1. Refuse status transitions away from "cancelled" when the member
    //      has been GDPR-erased (sentinel email pattern). Resurrecting an
    //      Article-17-erased record would void the fulfilment evidence.
    //   2. When staff PATCH transitions status TO "cancelled" and the member
    //      has an active Stripe subscription, cancel the Stripe subscription
    //      via cancel_at_period_end so the gym doesn't keep charging the
    //      card on file. If the Stripe cancel fails, refuse the PATCH so the
    //      DB and Stripe never diverge.
    let stripeCancelMetadata: { stripeCancelled: boolean; cancelAt: number | null } | null = null;
    if (rest.status) {
      const existing = await withTenantContext(session.user.tenantId, (tx) =>
        tx.member.findFirst({
          where: { id, tenantId: session.user.tenantId },
          select: { email: true, status: true, stripeSubscriptionId: true },
        }),
      );
      if (existing && /^deleted-.*@deleted\.invalid$/.test(existing.email) && rest.status !== "cancelled") {
        return NextResponse.json(
          { error: "This member has been erased under GDPR Article 17 and cannot be reactivated." },
          { status: 422 },
        );
      }
      // A3H-6: status transitioning to "cancelled" while a live Stripe sub
      // exists — cancel Stripe-side first.
      if (
        rest.status === "cancelled" &&
        existing?.status !== "cancelled" &&
        existing?.stripeSubscriptionId
      ) {
        const tenantStripe = await withTenantContext(session.user.tenantId, (tx) =>
          tx.tenant.findUnique({
            where: { id: session.user.tenantId },
            select: { stripeAccountId: true },
          }),
        );
        if (tenantStripe?.stripeAccountId) {
          const cancelResult = await cancelSubscriptionAtPeriodEnd({
            tenant: { stripeAccountId: tenantStripe.stripeAccountId },
            stripeSubscriptionId: existing.stripeSubscriptionId,
          });
          if (!cancelResult.ok) {
            return NextResponse.json(
              {
                error:
                  "Cannot cancel this member: Stripe subscription cancellation failed (" +
                  cancelResult.error +
                  "). Cancel manually in Stripe, then retry.",
              },
              { status: cancelResult.status },
            );
          }
          stripeCancelMetadata = {
            stripeCancelled: true,
            cancelAt: cancelResult.cancelAt,
          };
        }
        // No tenantStripe.stripeAccountId means staff is cancelling a member
        // whose subscription predates the Stripe disconnect — proceed
        // without a Stripe call (orphaned subscription is the operator's
        // problem in Stripe directly).
      }
    }
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const m = await tx.member.updateMany({
        where: { id, tenantId: session.user.tenantId, ...concurrencyGuard },
        data: {
          ...rest,
          ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null } : {}),
        },
      });
      if (m.count === 0) {
        const existing = await tx.member.findFirst({
          where: { id, tenantId: session.user.tenantId },
          select: { updatedAt: true },
        });
        return { updated: null, existing };
      }
      // Audit iter-2-database A8I2-S-1 [Critical]: explicit select on the
      // post-update re-fetch. Same vulnerability class as the GET fix —
      // every successful PATCH was returning passwordHash + totpSecret +
      // totpRecoveryCodes + sessionVersion + failedLoginCount + lockedUntil
      // + waiverIpAddress in the response body. Now matches the GET shape
      // (excluding the heavy relations which the PATCH response never
      // exposed anyway).
      const fresh = await tx.member.findFirst({
        where: { id, tenantId: session.user.tenantId },
        select: {
          id: true,
          tenantId: true,
          email: true,
          name: true,
          phone: true,
          membershipType: true,
          status: true,
          paymentStatus: true,
          notes: true,
          onboardingCompleted: true,
          emergencyContactName: true,
          emergencyContactPhone: true,
          emergencyContactRelation: true,
          medicalConditions: true,
          dateOfBirth: true,
          accountType: true,
          waiverAccepted: true,
          waiverAcceptedAt: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          preferredPaymentMethod: true,
          lastAnnouncementSeenAt: true,
          parentMemberId: true,
          hasKidsHint: true,
          totpEnabled: true,
          classReminders: true,
          beltPromotions: true,
          gymAnnouncements: true,
          notifyOnNewLogin: true,
          joinedAt: true,
          updatedAt: true,
        },
      });
      return { updated: fresh, existing: null };
    });

    if (!result.updated) {
      if (!result.existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (clientUpdatedAt) {
        return NextResponse.json(
          { error: "This member was updated by someone else. Reload and try again.", currentUpdatedAt: result.existing.updatedAt.toISOString() },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updated = result.updated;
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.update",
      entityType: "Member",
      entityId: id,
      metadata: {
        fields: Object.keys(parsed.data),
        // A3H-6: surface the Stripe outcome in the audit row so the gym
        // owner can trace any billing-state side-effects of this PATCH.
        ...(stripeCancelMetadata ? { stripe: stripeCancelMetadata } : {}),
      },
      req,
    });
    return NextResponse.json(updated);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update member" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  // F5 deletion gateway: when a Member has linked kids, the caller MUST pick
  // a strategy (reassign / cascade / orphan). The first call without a
  // strategy is the probe — it returns 409 with the kids list so the UI can
  // surface the three-option picker; the second call passes ?strategy=... in
  // the query string.
  const url = new URL(req.url);
  const strategyKind = url.searchParams.get("strategy");
  let strategy: ParentDeletionStrategy = undefined;
  if (strategyKind) {
    if (strategyKind === "reassign") {
      const to = url.searchParams.get("toParentMemberId");
      if (!to) return NextResponse.json({ error: "reassign requires toParentMemberId" }, { status: 400 });
      strategy = { kind: "reassign", toParentMemberId: to };
    } else if (strategyKind === "cascade") {
      strategy = { kind: "cascade" };
    } else if (strategyKind === "orphan") {
      strategy = { kind: "orphan" };
    } else {
      return NextResponse.json({ error: "Invalid strategy" }, { status: 400 });
    }
  }

  try {
    const outcome = await withTenantContext(session.user.tenantId, (tx) =>
      deleteParentMemberWithKidsResolution(
        tx,
        { id, tenantId: session.user.tenantId },
        strategy,
      ),
    );
    if (outcome.kind === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (outcome.kind === "race") {
      return NextResponse.json({ error: "Conflict — member already removed" }, { status: 409 });
    }
    if (outcome.kind === "kids-present") {
      // Probe response. UI shows the picker, then re-issues DELETE with
      // ?strategy=cascade / reassign&toParentMemberId=X / orphan.
      return NextResponse.json(
        {
          error: "This member has linked kids — choose how to resolve them",
          kids: outcome.kids,
        },
        { status: 409 },
      );
    }
    if (outcome.kind === "invalid-reassign") {
      return NextResponse.json({ error: outcome.reason }, { status: 400 });
    }

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.delete",
      entityType: "Member",
      entityId: id,
      metadata: strategy
        ? { kidsAffected: outcome.kidsAffected, strategy: strategy.kind }
        : { kidsAffected: 0 },
      req,
    });
    return NextResponse.json({ success: true, kidsAffected: outcome.kidsAffected });
  } catch {
    return NextResponse.json({ error: "Failed to delete member" }, { status: 500 });
  }
}
