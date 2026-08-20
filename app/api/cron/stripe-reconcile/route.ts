/**
 * Stripe → MatFlow reconciliation backstop (Tier 1.2).
 *
 * NOT on a schedule of its own. Vercel's Hobby plan allows 2 cron entries and
 * this project already uses both (monthly-reports, retention), so the nightly
 * run happens as the first step of /api/cron/retention. This route stays for
 * manual/ad-hoc runs and so the job can be given its own schedule again the
 * moment the plan allows a third entry.
 *
 * The logic lives in lib/stripe/reconcile.ts so both callers share it.
 */
import { NextResponse } from "next/server";
import { runStripeReconciliation } from "@/lib/stripe/reconcile";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization");
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 });
  }
  if (authHeader !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 });
  }

  return NextResponse.json(await runStripeReconciliation());
}
