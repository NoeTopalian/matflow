import { prisma } from "@/lib/prisma";

/**
 * Cached snapshot of a tenant's Stripe Connect account capabilities (Fix 3).
 *
 * Stripe accounts can lose `charges_enabled` or `payouts_enabled` between
 * checkouts (KYC failure, requirements past due, fraud flag). Without this
 * cache + per-checkout gate, MatFlow would happily take payments that never
 * settle to the gym's bank.
 *
 * Refresh strategy:
 *   - On `account.updated` webhook (real-time)
 *   - Lazy refresh-on-first-checkout when status is null/stale (defensive)
 *   - Optional nightly cron (not implemented at launch — webhook is enough)
 */
export type StripeAccountStatus = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsPastDue: string[];
  disabledReason: string | null;
  refreshedAt: string; // ISO timestamp
};

/**
 * Fetch fresh account status from Stripe and persist on Tenant.stripeAccountStatus.
 * Returns the new status. Does NOT throw on Stripe errors — returns a safe-deny
 * status (chargesEnabled=false) so the calling gate fails closed.
 */
export async function refreshStripeAccountStatus(
  tenantId: string,
  stripeAccountId: string,
): Promise<StripeAccountStatus> {
  let status: StripeAccountStatus;
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      // Stripe not configured at all — treat as safe-deny.
      status = {
        chargesEnabled: false,
        payoutsEnabled: false,
        requirementsPastDue: [],
        disabledReason: "stripe_not_configured",
        refreshedAt: new Date().toISOString(),
      };
    } else {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
      const account = await stripe.accounts.retrieve(stripeAccountId);
      status = {
        chargesEnabled: account.charges_enabled === true,
        payoutsEnabled: account.payouts_enabled === true,
        requirementsPastDue: account.requirements?.past_due ?? [],
        disabledReason: account.requirements?.disabled_reason ?? null,
        refreshedAt: new Date().toISOString(),
      };
    }
  } catch (e) {
    console.error("[stripe-account-status] refresh failed", { tenantId, stripeAccountId, error: e });
    status = {
      chargesEnabled: false,
      payoutsEnabled: false,
      requirementsPastDue: [],
      disabledReason: "refresh_error",
      refreshedAt: new Date().toISOString(),
    };
  }

  try {
    await prisma.tenant.update({
      where: { id: tenantId },
      data: { stripeAccountStatus: status },
    });
  } catch (e) {
    console.error("[stripe-account-status] persist failed", { tenantId, error: e });
  }

  return status;
}

/**
 * Pure check — does the cached status allow new charges?
 *
 * Fail-closed: null / undefined / missing chargesEnabled all return false.
 * The calling route should refresh and re-check before returning a 503 to
 * the user, so a fresh tenant whose status hasn't been hydrated gets a
 * chance to recover via lazy-refresh.
 */
export function canAcceptCharges(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const s = status as Partial<StripeAccountStatus>;
  return s.chargesEnabled === true;
}

/**
 * Combined helper for checkout-style routes: returns true if the tenant can
 * accept charges right now, refreshing the cache if it's missing or older
 * than the staleness window. Fails closed on errors.
 *
 * Default staleness window: 24 hours. Webhook keeps it fresh in normal ops.
 */
export async function ensureCanAcceptCharges(
  tenantId: string,
  stripeAccountId: string,
  cachedStatus: unknown,
  stalenessMs: number = 24 * 60 * 60 * 1000,
): Promise<{ ok: boolean; status: StripeAccountStatus | null }> {
  let s: StripeAccountStatus | null = null;
  if (cachedStatus && typeof cachedStatus === "object") {
    s = cachedStatus as StripeAccountStatus;
  }

  const stale = !s || (Date.now() - new Date(s.refreshedAt ?? 0).getTime() > stalenessMs);
  if (stale) {
    s = await refreshStripeAccountStatus(tenantId, stripeAccountId);
  }

  return { ok: canAcceptCharges(s), status: s };
}
