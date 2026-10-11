import { withTenantContext } from "@/lib/prisma-tenant";

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
 *   - Lazy refresh by the club-account guard (lib/stripe/club-account.ts) when
 *     the status is missing, stale or unreadable
 *   - Optional nightly cron (not implemented at launch — webhook is enough)
 *
 * Every route that calls Stripe for a club goes through
 * `requireChargeableClubAccount` in lib/stripe/club-account.ts, which owns the
 * decision. This module only fetches and stores the snapshot.
 */
export type StripeAccountStatus = {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  requirementsPastDue: string[];
  disabledReason: string | null;
  refreshedAt: string; // ISO timestamp
};

/**
 * How long a single `accounts.retrieve` may take before the refresh gives up
 * and fails closed. It runs inline on a member's checkout, so it is short; the
 * SDK's own default is 80 s.
 */
export const ACCOUNT_STATUS_REFRESH_TIMEOUT_MS = 5_000;

/** The disabledReason written whenever Stripe could not be read. */
export const STATUS_UNREADABLE = "status_unreadable";

class AccountStatusTimeout extends Error {
  constructor(ms: number) {
    super(`accounts.retrieve did not answer within ${ms}ms`);
    this.name = "AccountStatusTimeout";
  }
}

function unreadable(): StripeAccountStatus {
  return {
    chargesEnabled: false,
    payoutsEnabled: false,
    requirementsPastDue: [],
    disabledReason: STATUS_UNREADABLE,
    refreshedAt: new Date().toISOString(),
  };
}

/**
 * Fetch fresh account status from Stripe and persist on Tenant.stripeAccountStatus.
 * Returns the new status. Never throws on Stripe errors: ANY failure — a
 * permission error, a timeout, a network or API error — returns a fail-closed
 * status (chargesEnabled=false, disabledReason="status_unreadable").
 *
 * Payments lane PA (11 Oct 2026): a permission error used to FAIL OPEN with
 * chargesEnabled=true, on the reasoning that a platform key missing the
 * accounts read scope would otherwise block every club. But a revoked
 * connection is answered the same way, and the shop then created the Checkout
 * Session on MatFlow's own platform account (audit §4, F2). An unreadable
 * account is an unverifiable authorisation, and that now refuses. The operator
 * signal is kept: the log line below names the missing scope, and the stored
 * `status_unreadable` is what /api/stripe/connect/health reports.
 */
export async function refreshStripeAccountStatus(
  tenantId: string,
  stripeAccountId: string,
  opts: { timeoutMs?: number } = {},
): Promise<StripeAccountStatus> {
  const timeoutMs = opts.timeoutMs ?? ACCOUNT_STATUS_REFRESH_TIMEOUT_MS;
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
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: "2026-03-25.dahlia",
        timeout: timeoutMs,
        maxNetworkRetries: 0,
      });
      // The SDK timeout covers the socket; the race covers everything else
      // (DNS, a wedged agent, a mocked client) so the member is never held.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const account = await Promise.race([
        stripe.accounts.retrieve(stripeAccountId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AccountStatusTimeout(timeoutMs)), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      status = {
        chargesEnabled: account.charges_enabled === true,
        payoutsEnabled: account.payouts_enabled === true,
        requirementsPastDue: account.requirements?.past_due ?? [],
        disabledReason: account.requirements?.disabled_reason ?? null,
        refreshedAt: new Date().toISOString(),
      };
    }
  } catch (e) {
    const type = (e as { type?: string })?.type;
    const message = (e as { message?: string })?.message ?? "";
    const isPermissionError =
      type === "StripePermissionError" || /does not have the required permissions/i.test(message);
    if (isPermissionError) {
      console.error(
        "[stripe-account-status] CONFIG: accounts.retrieve was refused for permissions — either the club " +
          "revoked MatFlow's access, or STRIPE_SECRET_KEY lacks the accounts read scope " +
          "(accounts_kyc_basic_read). If every club shows this, grant that scope on the key in the Stripe " +
          "Dashboard. Payments for this club are REFUSED until the status can be read.",
        { tenantId, stripeAccountId },
      );
    } else {
      console.error(
        "[stripe-account-status] refresh failed — payments for this club are REFUSED until the status can be read",
        {
          tenantId,
          stripeAccountId,
          // The message only: a Stripe error object carries raw headers.
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        },
      );
    }
    status = unreadable();
  }

  try {
    // Written only onto the SAME account while it is still connected. A
    // disconnect (id nulled) or a deauthorisation webhook (flag cleared, status
    // stamped "deauthorized") that lands while this refresh was in flight must
    // not be overwritten by an answer about the old connection.
    await withTenantContext(tenantId, (tx) =>
      tx.tenant.updateMany({
        where: { id: tenantId, stripeAccountId, stripeConnected: true },
        data: { stripeAccountStatus: status },
      }),
    );
  } catch (e) {
    console.error("[stripe-account-status] persist failed", { tenantId, error: e });
  }

  return status;
}

/**
 * Pure check — does the cached status allow new charges?
 *
 * Fail-closed: null / undefined / missing chargesEnabled all return false.
 */
export function canAcceptCharges(status: unknown): boolean {
  if (!status || typeof status !== "object") return false;
  const s = status as Partial<StripeAccountStatus>;
  return s.chargesEnabled === true;
}

/**
 * @deprecated Routes use `requireChargeableClubAccount` (lib/stripe/club-account.ts),
 * which also checks the account id, the connected flag, the deauthorised stamp
 * and the freshness of the snapshot in one read. Kept for its existing tests;
 * do not call it from a route — it does not know whether the club is connected.
 *
 * Returns true if the cached status allows charges, refreshing when it is
 * missing or older than the staleness window. Fails closed on errors.
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
