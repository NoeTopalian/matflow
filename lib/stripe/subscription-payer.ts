// Payments lane PB (11 Oct 2026): who may see and pay a MatFlow subscription's
// outstanding first payment.
//
// Shared by GET /api/stripe/subscriptions/[id]/confirmation (hands out the
// PaymentIntent client secret) and GET /api/stripe/subscriptions/[id]/status
// (polled after confirmation). The subscription is found ONLY through lane
// PC's MemberSubscription mapping, scoped to the caller's club, so a
// subscription id from another club, or one MatFlow did not create, is
// indistinguishable from one that does not exist.
//
// Allowed: staff who may start a subscription (owner, manager — the same gate
// as POST /api/stripe/create-subscription), the member the subscription is
// for, or that member's CONFIRMED guardian (lib/guardianship.ts). Everyone
// else gets the same 404 as a missing subscription, so existence is never
// disclosed.

import { withTenantContext } from "@/lib/prisma-tenant";
import { CONFIRMED_GUARDIAN } from "@/lib/guardianship";

export const STAFF_PAYER_ROLES: ReadonlySet<string> = new Set(["owner", "manager"]);

/** Stripe subscription ids are `sub_` plus an opaque alphanumeric tail. */
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,200}$/;

export type SubscriptionPayerMapping = {
  id: string;
  tenantId: string;
  memberId: string;
  stripeAccountId: string;
  stripeSubscriptionId: string;
  status: string;
  endedAt: Date | null;
  requiresActionInvoiceId: string | null;
  createdAt: Date;
};

export type SubscriptionPayerAccess =
  | {
      ok: true;
      audience: "staff" | "member";
      tenantId: string;
      mapping: SubscriptionPayerMapping;
    }
  | { ok: false; status: 401 | 404; error: string };

type SessionLike = {
  user?: { tenantId?: string | null; role?: string | null; memberId?: string | null } | null;
} | null;

const NOT_FOUND = { ok: false as const, status: 404 as const, error: "Subscription not found" };

export async function resolveSubscriptionPayer(
  session: SessionLike,
  stripeSubscriptionId: string,
): Promise<SubscriptionPayerAccess> {
  const tenantId = session?.user?.tenantId ?? null;
  if (!session?.user || !tenantId) return { ok: false, status: 401, error: "Unauthorized" };
  if (!SUBSCRIPTION_ID.test(stripeSubscriptionId)) return NOT_FOUND;

  const role = session.user.role ?? "";
  const callerMemberId = session.user.memberId ?? null;

  return withTenantContext(tenantId, async (tx) => {
    const mapping = await tx.memberSubscription.findFirst({
      where: { tenantId, stripeSubscriptionId },
      select: {
        id: true,
        tenantId: true,
        memberId: true,
        stripeAccountId: true,
        stripeSubscriptionId: true,
        status: true,
        endedAt: true,
        requiresActionInvoiceId: true,
        createdAt: true,
      },
    });
    if (!mapping) return NOT_FOUND;

    if (STAFF_PAYER_ROLES.has(role)) return { ok: true, audience: "staff", tenantId, mapping };
    if (!callerMemberId) return NOT_FOUND;
    if (mapping.memberId === callerMemberId) return { ok: true, audience: "member", tenantId, mapping };

    // A guardian pays for their own confirmed child only.
    const child = await tx.member.findFirst({
      where: { id: mapping.memberId, tenantId, parentMemberId: callerMemberId, ...CONFIRMED_GUARDIAN },
      select: { id: true },
    });
    if (child) return { ok: true, audience: "member", tenantId, mapping };
    return NOT_FOUND;
  });
}
