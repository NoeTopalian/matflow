// Shared check-in business rules — single source of truth for both the staff
// route (`POST /api/checkin`) and the public kiosk route
// (`POST /api/kiosk/[token]/checkin`).
//
// Behaviour matrix (set by the caller):
//
//   method   enforceRankGate  enforceTimeWindow  requireCoverage
//   ------   ---------------  -----------------  ---------------
//   admin    false            false              false       (staff override)
//   self     true             true               true        (member self-serve)
//   auto     false            false              false       (cron / system)
//   kiosk    true             false              false       (iPad at the door — wider window, forgiving on subs)

import { withTenantContext } from "@/lib/prisma-tenant";
import { parseTime } from "@/lib/class-time";

const CHECKIN_WINDOW_BEFORE_MIN = 30;
const CHECKIN_WINDOW_AFTER_MIN = 30;

export type CheckinMethod = "admin" | "self" | "auto" | "kiosk";

export type PerformCheckinArgs = {
  tenantId: string;
  memberId: string;
  classInstanceId: string;
  method: CheckinMethod;
  enforceRankGate: boolean;
  enforceTimeWindow: boolean;
  requireCoverage: boolean;
  // Staff user id when method=admin (the person clicking "check in" in the
  // dashboard). Null/undefined for self / kiosk / auto / system.
  checkedInByUserId?: string | null;
};

export type PerformCheckinResult =
  | {
      kind: "success";
      record: { id: string; tenantId: string; memberId: string; classInstanceId: string; checkInMethod: string };
      coverage: { kind: "subscription" | "manual" | "pack" | "uncovered_kiosk"; creditsRemaining?: number };
    }
  | { kind: "class_not_found" }
  | { kind: "class_cancelled" }
  | { kind: "member_not_found" }
  | { kind: "rank_below" }
  | { kind: "rank_above" }
  | { kind: "outside_window" }
  | { kind: "no_coverage" }
  | { kind: "duplicate" }
  | { kind: "error"; error: unknown };

export async function performCheckin(args: PerformCheckinArgs): Promise<PerformCheckinResult> {
  const { tenantId, memberId, classInstanceId, method } = args;

  // Validate the class instance belongs to this tenant + load rank requirements.
  const instance = await withTenantContext(tenantId, (tx) =>
    tx.classInstance.findFirst({
      where: { id: classInstanceId, class: { tenantId } },
      include: {
        class: {
          include: {
            requiredRank: { select: { order: true } },
            maxRank: { select: { order: true } },
          },
        },
      },
    }),
  );
  if (!instance) return { kind: "class_not_found" };
  if (instance.isCancelled) return { kind: "class_cancelled" };

  // Rank gate.
  if (args.enforceRankGate && (instance.class.requiredRankId || instance.class.maxRankId)) {
    const memberRank = await withTenantContext(tenantId, (tx) =>
      tx.memberRank.findFirst({
        where: { memberId },
        orderBy: { rankSystem: { order: "desc" } },
        select: { rankSystem: { select: { order: true } } },
      }),
    );
    const memberOrder = memberRank?.rankSystem.order ?? null;
    if (instance.class.requiredRankId && instance.class.requiredRank) {
      // Unranked members fail-closed against requiredRank.
      if (memberOrder === null || memberOrder < instance.class.requiredRank.order) {
        return { kind: "rank_below" };
      }
    }
    if (instance.class.maxRankId && instance.class.maxRank && memberOrder !== null) {
      if (memberOrder > instance.class.maxRank.order) {
        return { kind: "rank_above" };
      }
    }
  }

  // Time window gate.
  if (args.enforceTimeWindow) {
    const now = new Date();
    const startsAt = parseTime(instance.startTime, instance.date);
    const endsAt = parseTime(instance.endTime, instance.date);
    const windowOpen = new Date(startsAt.getTime() - CHECKIN_WINDOW_BEFORE_MIN * 60_000);
    const windowClose = new Date(endsAt.getTime() + CHECKIN_WINDOW_AFTER_MIN * 60_000);
    if (now < windowOpen || now > windowClose) {
      return { kind: "outside_window" };
    }
  }

  // Coverage decision.
  const memberRecord = await withTenantContext(tenantId, (tx) =>
    tx.member.findUnique({
      where: { id: memberId },
      select: { paymentStatus: true, stripeSubscriptionId: true },
    }),
  );
  if (!memberRecord) return { kind: "member_not_found" };
  const hasActiveSubscription =
    !!memberRecord.stripeSubscriptionId && memberRecord.paymentStatus === "paid";

  try {
    if (args.requireCoverage && !hasActiveSubscription) {
      // Try to redeem a class pack atomically.
      const result = await withTenantContext(tenantId, async (tx) => {
        const activePack = await tx.memberClassPack.findFirst({
          where: {
            memberId,
            tenantId,
            status: "active",
            creditsRemaining: { gt: 0 },
            expiresAt: { gt: new Date() },
          },
          orderBy: { expiresAt: "asc" },
        });
        if (!activePack) return { kind: "no_coverage" as const };

        const updatedPack = await tx.memberClassPack.update({
          where: { id: activePack.id },
          data: { creditsRemaining: { decrement: 1 } },
        });
        const record = await tx.attendanceRecord.create({
          data: {
            tenantId,
            memberId,
            classInstanceId,
            checkInMethod: method,
            checkedInById: args.checkedInByUserId ?? null,
          },
        });
        await tx.classPackRedemption.create({
          data: { memberPackId: activePack.id, attendanceRecordId: record.id },
        });
        return { kind: "pack_redeemed" as const, record, creditsRemaining: updatedPack.creditsRemaining };
      });

      if (result.kind === "no_coverage") return { kind: "no_coverage" };
      return {
        kind: "success",
        record: result.record,
        coverage: { kind: "pack", creditsRemaining: result.creditsRemaining },
      };
    }

    // Coverage not required (admin / kiosk / auto) OR an active subscription
    // is on file — record straight.
    const record = await withTenantContext(tenantId, (tx) =>
      tx.attendanceRecord.create({
        data: {
          tenantId,
          memberId,
          classInstanceId,
          checkInMethod: method,
          checkedInById: args.checkedInByUserId ?? null,
        },
      }),
    );

    // Pack-redeem opportunistically for kiosk path so credits don't pile up
    // when a member already has a pack but no subscription.
    if (method === "kiosk" && !hasActiveSubscription) {
      const packResult = await withTenantContext(tenantId, async (tx) => {
        const pack = await tx.memberClassPack.findFirst({
          where: {
            memberId,
            tenantId,
            status: "active",
            creditsRemaining: { gt: 0 },
            expiresAt: { gt: new Date() },
          },
          orderBy: { expiresAt: "asc" },
        });
        if (!pack) return null;
        const updated = await tx.memberClassPack.update({
          where: { id: pack.id },
          data: { creditsRemaining: { decrement: 1 } },
        });
        await tx.classPackRedemption.create({
          data: { memberPackId: pack.id, attendanceRecordId: record.id },
        });
        return { creditsRemaining: updated.creditsRemaining };
      });
      if (packResult) {
        return { kind: "success", record, coverage: { kind: "pack", creditsRemaining: packResult.creditsRemaining } };
      }
      return { kind: "success", record, coverage: { kind: "uncovered_kiosk" } };
    }

    return {
      kind: "success",
      record,
      coverage: { kind: hasActiveSubscription ? "subscription" : "manual" },
    };
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") return { kind: "duplicate" };
    return { kind: "error", error: e };
  }
}
