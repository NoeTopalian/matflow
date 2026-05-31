-- Audit iter-1-member-lifecycle A3H-10 + backlog M3A-1 + M3A-2.
--
-- Member.stripeCustomerId: every Stripe webhook event resolves the member
-- via findMember(customerId) inside a tenant. Without an index, Postgres
-- seq-scans the Member table per event — ~50ms at 5,000 members, approaches
-- Stripe's 30s timeout on the 7-trip invoice.payment_failed path under
-- sustained load. Composite with tenantId so the index also covers the
-- tenantId-only fallback path when tenant resolution fails defensively.
--
-- Member.stripeSubscriptionId: not currently queried directly, but proactive
-- for the future direct-subscription lookup pattern.
--
-- Member(tenantId, paymentStatus): dashboard "Payments due" + any future
-- dunning batch query. Currently scales fine; index becomes load-bearing
-- at ~10x current member count.

CREATE INDEX IF NOT EXISTS "Member_tenantId_stripeCustomerId_idx"
  ON "Member"("tenantId", "stripeCustomerId");

CREATE INDEX IF NOT EXISTS "Member_stripeSubscriptionId_idx"
  ON "Member"("stripeSubscriptionId");

CREATE INDEX IF NOT EXISTS "Member_tenantId_paymentStatus_idx"
  ON "Member"("tenantId", "paymentStatus");
