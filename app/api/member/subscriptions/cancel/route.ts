// POST /api/member/subscriptions/cancel
//
// F2 — member self-cancel.
//
// Sets Stripe cancel_at_period_end: true on the member's current
// subscription. They keep the access they already paid for until the cycle
// rolls over; the webhook flips Member.status to "cancelled" when the
// period actually closes. (Locked decision 2026-05-15: no immediate-cancel,
// no refunds on self-cancel.)
//
// Same three-gate as /start: logged-in member, tenant.memberSelfBilling
// true, tenant Stripe Connect healthy.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const memberId = (session.user as { memberId?: string }).memberId;
  if (!memberId) return apiError("Not a member account", 403);

  const tenant = await withTenantContext(session.user.tenantId, (tx) =>
    tx.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: {
        stripeAccountId: true,
        stripeConnected: true,
        memberSelfBilling: true,
      },
    }),
  );
  if (!tenant) return apiError("Tenant not found", 404);
  if (!tenant.memberSelfBilling) {
    return apiError("This gym manages payments centrally — please speak to staff", 403);
  }
  if (!tenant.stripeConnected || !tenant.stripeAccountId) {
    return apiError("This gym hasn't connected payments yet", 503);
  }

  const member = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: memberId, tenantId: session.user.tenantId },
      select: { id: true, parentMemberId: true, stripeSubscriptionId: true },
    }),
  );
  if (!member) return apiError("Member not found", 404);
  if (member.parentMemberId !== null) {
    return apiError("Sub-accounts can't self-cancel — your parent manages billing", 403);
  }
  if (!member.stripeSubscriptionId) {
    return apiError("No active subscription to cancel", 404);
  }

  const outcome = await cancelSubscriptionAtPeriodEnd({
    tenant: { stripeAccountId: tenant.stripeAccountId },
    stripeSubscriptionId: member.stripeSubscriptionId,
  });
  if (!outcome.ok) {
    return apiError(outcome.error, outcome.status, undefined, "[member/subscriptions/cancel]");
  }

  await logAudit({
    tenantId: session.user.tenantId,
    userId: session.user.id ?? null,
    action: "member.subscription.cancel",
    entityType: "Member",
    entityId: member.id,
    metadata: { initiator: "self", cancelAt: outcome.cancelAt },
    req,
  });

  return NextResponse.json({
    ok: true,
    cancelAt: outcome.cancelAt,
    message: "Your subscription will end at the close of the current cycle.",
  });
}
