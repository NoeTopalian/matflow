/**
 * Stripe → MatFlow reconciliation, on its own schedule (payments lane PD, 11 Oct 2026).
 *
 * vercel.json schedules this route daily at 04:15 UTC (off-peak, after the
 * retention sweep). Two gates, both default OFF, so adding the schedule
 * changes nothing until Noe switches it on:
 *  1. CRON_SECRET must be set and the bearer must match it (as every cron);
 *  2. STRIPE_RECONCILE_ENABLED must be exactly "true" — its own switch, not
 *     the retention kill-switch (RETENTION_CRON_ENABLED) it used to sit behind.
 * Disabled → 503, the same answer retention gives, after the bearer so an
 * unauthenticated caller learns nothing about the configuration.
 *
 * The work is lib/stripe/reconcile.ts: it records events Stripe emitted that
 * the store never saw (as `received`, for operator replay — never processed
 * here), reports state drift without writing member or payment state, and
 * writes one StripeReconcileRun row that /admin/stripe shows. One club that
 * cannot be checked (an invalid account id, a permission error, a timeout) is
 * recorded with an error CODE and the run carries on (200, run status
 * "errors"); only a run that could not complete answers 500. Stripe's error
 * text is never in the response or the row: it can quote the key. ?dryRun=1
 * reports without recording anything.
 *
 * The retention cron still calls the same function as its first step; that
 * caller is unchanged (lane PD does not own it).
 */
import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/constant-time";
import { checkCronAuthAttempt } from "@/lib/rate-limit";
import { maskStripeSecrets, reconcileErrorCode, runStripeReconciliation } from "@/lib/stripe/reconcile";
import { sanitiseEventError } from "@/lib/stripe/event-store";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Exactly "true" turns the scheduled run on. Anything else, including unset, is off. */
function stripeReconcileEnabled(): boolean {
  return process.env.STRIPE_RECONCILE_ENABLED === "true";
}

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  // Constant time, and only a FAILED attempt spends the throttle, so the
  // scheduler's valid bearer is never throttled (lib/rate-limit.ts,
  // checkCronAuthAttempt).
  if (!bearerMatches(authHeader, expected)) {
    const throttle = await checkCronAuthAttempt(req);
    if (!throttle.allowed) {
      return NextResponse.json(
        { error: "Too many attempts. Try again shortly." },
        { status: 429, headers: { "Retry-After": String(throttle.retryAfterSeconds) } },
      );
    }
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }
  // ?dryRun=1 reports what is missing or drifting and records NOTHING (no
  // StripeEvent row, no run row); like retention's dry run it is allowed while
  // the switch is off, behind the same bearer.
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  if (!stripeReconcileEnabled() && !dryRun) {
    return NextResponse.json({ error: "stripe reconcile cron disabled" }, { status: 503 });
  }

  try {
    const result = await runStripeReconciliation({ trigger: "cron", dryRun });
    // A club that could not be checked is a finding with a code on the run
    // row, not a failed run: the other clubs were reconciled.
    return NextResponse.json({ ...result, ok: true });
  } catch (e) {
    // The run itself failed (database unreachable, …). Code only in the
    // response; the masked message goes to the server log.
    console.error("[cron/stripe-reconcile] run failed", { code: reconcileErrorCode(e), message: maskStripeSecrets(sanitiseEventError(e)) });
    return NextResponse.json({ ok: false, error: "reconcile_failed", code: reconcileErrorCode(e) }, { status: 500 });
  }
}
