// POST /api/member/subscriptions/cancel-for-kid
//
// F3 — parent cancels a kid's subscription.
//
// Mirror of /cancel scoped via the same composite predicate as
// /start-for-kid. End-of-cycle cancellation; webhook flips kid.status to
// "cancelled" when the period closes.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { cancelSubscriptionAtPeriodEnd } from "@/lib/stripe/subscriptions";
import { z } from "zod";

const bodySchema = z.object({
  kidMemberId: z.string().min(1).max(50),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = (session.user as { memberId?: string }).memberId;
  if (!parentMemberId) return apiError("Not a member account", 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return apiError("Invalid data", 400);
  }
  const { kidMemberId } = parsed.data;

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

  const kid = await withTenantContext(session.user.tenantId, (tx) =>
    tx.member.findFirst({
      where: {
        id: kidMemberId,
        tenantId: session.user.tenantId,
        parentMemberId,
      },
      select: { id: true, stripeSubscriptionId: true },
    }),
  );
  if (!kid) return apiError("Kid not found in your family", 404);
  if (!kid.stripeSubscriptionId) {
    return apiError("No active subscription to cancel", 404);
  }

  const outcome = await cancelSubscriptionAtPeriodEnd({
    tenant: { stripeAccountId: tenant.stripeAccountId },
    stripeSubscriptionId: kid.stripeSubscriptionId,
  });
  if (!outcome.ok) {
    return apiError(outcome.error, outcome.status, undefined, "[member/subscriptions/cancel-for-kid]");
  }

  await logAudit({
    tenantId: session.user.tenantId,
    userId: session.user.id ?? null,
    action: "member.subscription.cancel.kid",
    entityType: "Member",
    entityId: kid.id,
    metadata: { parentMemberId, cancelAt: outcome.cancelAt },
    req,
  });

  return NextResponse.json({
    ok: true,
    cancelAt: outcome.cancelAt,
    message: "The subscription will end at the close of the current cycle.",
  });
}
