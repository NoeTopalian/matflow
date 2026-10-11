// The one gate in front of every Stripe call MatFlow makes for a club.
//
// Payments lane PA (11 Oct 2026), audit docs/payments/STRIPE-CONNECT-AUDIT-
// 2026-10-11.md §4 / F2. Each club takes its members' money through its OWN
// connected Stripe account (direct charges, `Stripe-Account` header). Before
// this module every route made its own decision from its own subset of
// `stripeAccountId`, `stripeConnected` and the cached status, and the member
// shop passed `{ stripeAccount }` only when the flag was set. A club that had
// revoked MatFlow kept its id with the flag cleared, the status refresh failed
// OPEN on the resulting permission error, and the Checkout Session was created
// on MatFlow's platform account.
//
// The rule now (Noe, 11 Oct): missing, stale, disconnected or unverifiable club
// authorisation refuses. There is no fallback to the platform account: callers
// receive an account id or an exception, never `undefined`.
//
// Race with disconnection: the id returned is the one read in the SAME query
// as the flag and the status. Callers pass that id to Stripe and never re-read
// the tenant, so a disconnect or deauthorisation landing after the guard
// either refuses the request (if it committed first) or the call goes to the
// captured club account — which Stripe itself refuses once access is revoked.
// It cannot become a platform-account call.

import { NextResponse } from "next/server";
import { withTenantContext } from "@/lib/prisma-tenant";
import { refreshStripeAccountStatus, type StripeAccountStatus } from "@/lib/stripe-account-status";

/** A cached status older than this is refreshed from Stripe before use. */
export const CLUB_ACCOUNT_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Clock skew tolerated on a stored refreshedAt; anything further in the future is treated as stale. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Why the club account is being used. Money-in purposes start or restart a
 * collection and also need `chargesEnabled`. Money-out and management purposes
 * (refund, cancel, pause, the billing portal, minting catalogue prices) still
 * need a connected, verifiable account but must keep working while Stripe has
 * charges disabled — refusing them would trap a refund or a cancellation
 * behind the very restriction that stopped new charges.
 */
export type ClubAccountPurpose =
  | "shop_checkout"
  | "class_pack_checkout"
  | "adhoc_charge"
  | "subscription_start"
  | "collection_resume"
  | "refund"
  | "subscription_cancel"
  | "collection_pause"
  | "billing_portal"
  | "catalogue";

const MONEY_IN: ReadonlySet<ClubAccountPurpose> = new Set([
  "shop_checkout",
  "class_pack_checkout",
  "adhoc_charge",
  "subscription_start",
  "collection_resume",
]);

export type ClubAccountRefusalReason =
  | "no_account"
  | "not_connected"
  | "deauthorized"
  | "status_unreadable"
  | "charges_disabled"
  | "stripe_not_configured"
  | "tenant_unreadable";

export class ClubAccountNotChargeable extends Error {
  readonly reason: ClubAccountRefusalReason;
  readonly tenantId: string;
  readonly purpose: ClubAccountPurpose;

  constructor(
    reason: ClubAccountRefusalReason,
    ctx: { tenantId: string; purpose: ClubAccountPurpose; cause?: unknown },
  ) {
    super(`Club Stripe account not usable for ${ctx.purpose}: ${reason}`);
    this.name = "ClubAccountNotChargeable";
    this.reason = reason;
    this.tenantId = ctx.tenantId;
    this.purpose = ctx.purpose;
    if (ctx.cause !== undefined) (this as { cause?: unknown }).cause = ctx.cause;
  }
}

export type ChargeableClubAccount = {
  /** The connected account id, read in the same query as the flag and the status. */
  stripeAccountId: string;
  status: StripeAccountStatus;
};

/** Reasons a stored status cannot be trusted and must be re-read from Stripe. */
// "status_unreadable" is what refreshStripeAccountStatus writes on any failure
// (STATUS_UNREADABLE there); "refresh_error" is the pre-lane-PA spelling still
// sitting in some rows.
const UNREADABLE_REASONS = new Set(["status_unreadable", "refresh_error", "stripe_not_configured"]);

function parseStatus(raw: unknown): StripeAccountStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Partial<StripeAccountStatus>;
  if (typeof s.chargesEnabled !== "boolean" || typeof s.refreshedAt !== "string") return null;
  return {
    chargesEnabled: s.chargesEnabled,
    payoutsEnabled: s.payoutsEnabled === true,
    requirementsPastDue: Array.isArray(s.requirementsPastDue) ? s.requirementsPastDue : [],
    disabledReason: typeof s.disabledReason === "string" ? s.disabledReason : null,
    refreshedAt: s.refreshedAt,
  };
}

function isFresh(s: StripeAccountStatus, now: number): boolean {
  const at = new Date(s.refreshedAt).getTime();
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age <= CLUB_ACCOUNT_STATUS_MAX_AGE_MS && age >= -FUTURE_SKEW_MS;
}

/**
 * Returns the club's connected account id, or throws ClubAccountNotChargeable.
 * Call it after authentication, the review lock and the TeamUp bridge check,
 * and before ANY Stripe call made on the club's behalf. Pass the returned
 * `stripeAccountId` — and only that — as `stripeAccount` on every call.
 */
export async function requireChargeableClubAccount(
  tenantId: string,
  { purpose }: { purpose: ClubAccountPurpose },
): Promise<ChargeableClubAccount> {
  const refuse = (reason: ClubAccountRefusalReason, cause?: unknown): never => {
    throw new ClubAccountNotChargeable(reason, { tenantId, purpose, cause });
  };

  let row: { stripeAccountId: string | null; stripeConnected: boolean; stripeAccountStatus: unknown } | null;
  try {
    // ONE read: id, flag and status come from the same row version.
    row = await withTenantContext(tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: tenantId },
        select: { stripeAccountId: true, stripeConnected: true, stripeAccountStatus: true },
      }),
    );
  } catch (e) {
    return refuse("tenant_unreadable", e);
  }

  const stripeAccountId = row?.stripeAccountId ?? null;
  if (!row || !stripeAccountId) return refuse("no_account");

  const cached = parseStatus(row.stripeAccountStatus);
  if (!row.stripeConnected) {
    return refuse(cached?.disabledReason === "deauthorized" ? "deauthorized" : "not_connected");
  }
  // The deauthorisation webhook stamps this; it is never cleared by age alone.
  if (cached?.disabledReason === "deauthorized") return refuse("deauthorized");

  if (!process.env.STRIPE_SECRET_KEY) return refuse("stripe_not_configured");

  let status = cached;
  const trustworthy =
    status !== null && isFresh(status, Date.now()) && !UNREADABLE_REASONS.has(status.disabledReason ?? "");
  if (!trustworthy) {
    // Fails closed: any error or timeout comes back as status_unreadable.
    status = await refreshStripeAccountStatus(tenantId, stripeAccountId);
  }
  if (!status) return refuse("status_unreadable");

  if (status.disabledReason === "deauthorized") return refuse("deauthorized");
  if (UNREADABLE_REASONS.has(status.disabledReason ?? "")) return refuse("status_unreadable");
  if (MONEY_IN.has(purpose) && status.chargesEnabled !== true) return refuse("charges_disabled");

  return { stripeAccountId, status };
}

const HTTP_STATUS: Record<ClubAccountRefusalReason, 409 | 503> = {
  no_account: 409,
  not_connected: 409,
  deauthorized: 409,
  status_unreadable: 503,
  charges_disabled: 503,
  stripe_not_configured: 503,
  tenant_unreadable: 503,
};

const MEMBER_MESSAGE: Record<ClubAccountRefusalReason, string> = {
  no_account: "Online payments aren't set up at this gym yet — please speak to the gym.",
  not_connected: "Online payments aren't available at this gym right now — please speak to the gym.",
  deauthorized: "Online payments aren't available at this gym right now — please speak to the gym.",
  status_unreadable: "We can't take payments for this gym just now — please try again later or speak to the gym.",
  charges_disabled: "This gym can't take online payments at the moment — please speak to the gym.",
  stripe_not_configured: "Online payments aren't available right now — please speak to the gym.",
  tenant_unreadable: "We can't take payments just now — please try again in a moment.",
};

const STAFF_MESSAGE: Record<ClubAccountRefusalReason, string> = {
  no_account: "Stripe isn't connected for this club. Connect it under Settings → Revenue first.",
  not_connected: "This club's Stripe account is disconnected. Reconnect it under Settings → Revenue first.",
  deauthorized:
    "This club's Stripe account revoked MatFlow's access. Reconnect it under Settings → Revenue before taking or managing payments.",
  status_unreadable:
    "MatFlow couldn't verify this club's Stripe account just now, so nothing was sent to Stripe. Try again shortly; if it persists, check the connection under Settings → Revenue.",
  charges_disabled:
    "Stripe has disabled charges on this club's account (check the Stripe dashboard for outstanding requirements). Nothing was charged.",
  stripe_not_configured: "Stripe isn't configured on this server. Nothing was sent to Stripe.",
  tenant_unreadable: "MatFlow couldn't read this club's payment settings just now. Nothing was sent to Stripe — try again.",
};

/**
 * Maps a refusal to the HTTP answer: 409 when the club has no usable
 * connection (the owner must act), 503 when it is temporarily unverifiable or
 * restricted. The body is `{ ok: false, error, reason }` like apiError's, with
 * a structured `reason` for staff screens; it never carries the account id.
 * Logged at error level so an operator sees refusals in aggregate.
 */
export function clubAccountRefusal(
  err: ClubAccountNotChargeable,
  opts: { audience: "member" | "staff"; extra?: Record<string, unknown> },
): NextResponse {
  console.error("[club-account] Stripe call refused", {
    tenantId: err.tenantId,
    purpose: err.purpose,
    reason: err.reason,
  });
  const error = opts.audience === "member" ? MEMBER_MESSAGE[err.reason] : STAFF_MESSAGE[err.reason];
  return NextResponse.json(
    { ...(opts.extra ?? {}), ok: false, error, reason: err.reason },
    { status: HTTP_STATUS[err.reason] },
  );
}

/**
 * Convenience for routes: run the guard and either get the account or a ready
 * refusal response. Anything other than a ClubAccountNotChargeable propagates.
 */
export async function clubAccountOrRefusal(
  tenantId: string,
  purpose: ClubAccountPurpose,
  opts: { audience: "member" | "staff"; extra?: Record<string, unknown> },
): Promise<{ ok: true; account: ChargeableClubAccount } | { ok: false; response: NextResponse }> {
  try {
    return { ok: true, account: await requireChargeableClubAccount(tenantId, { purpose }) };
  } catch (e) {
    if (e instanceof ClubAccountNotChargeable) return { ok: false, response: clubAccountRefusal(e, opts) };
    throw e;
  }
}
