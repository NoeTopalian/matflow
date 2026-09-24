// GET  /api/stripe/migrate-memberships → preview: what would happen to each
//      member if their existing Stripe customer/subscription were linked.
// POST /api/stripe/migrate-memberships { memberIds, dryRun? } → apply.
//
// The "no re-sign" migration off a previous platform. Owner-only: it links
// members to money and, for members with no live subscription, creates one on
// their saved payment method anchored to their next due date. The engine
// (lib/stripe/migrate-memberships.ts) recomputes the plan on apply and refuses
// anything that is not actionable, so the request body can only choose WHO.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiOwner } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { apiError } from "@/lib/api-error";
import { checkRateLimit } from "@/lib/rate-limit";
import { previewMigration, applyMigration, MigrationError } from "@/lib/stripe/migrate-memberships";

export const runtime = "nodejs";
// Sequential Stripe calls for a whole roster — mirror the import commit route.
export const maxDuration = 300;

const MAX_BATCH = 500;

const applySchema = z.object({
  memberIds: z.array(z.string().min(1)).min(1).max(MAX_BATCH),
  dryRun: z.boolean().optional(),
  // Only when the previous platform has confirmed it hands subscriptions
  // over without cancelling them; otherwise existing subscriptions are
  // replaced at their period end (lib/stripe/migrate-memberships.ts).
  allowAdopt: z.boolean().optional(),
});

async function stripeClient() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = (await import("stripe")).default;
  return new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" });
}

function migrationErrorResponse(e: unknown) {
  if (e instanceof MigrationError && e.code === "not_connected") {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
  // Stripe refused the connected account (deauthorised, wrong mode, never
  // existed). That is a state of the club's Stripe link, not a fault in
  // MatFlow — say so, and say what fixes it, rather than a 500 reference.
  const s = e as { type?: string; statusCode?: number } | null;
  if (s && typeof s.type === "string" && s.type.startsWith("Stripe") && s.statusCode && s.statusCode < 500) {
    return NextResponse.json(
      { ok: false, error: "Stripe would not let MatFlow read this club's account. Reconnect Stripe under Settings → Revenue and try again." },
      { status: 400 },
    );
  }
  return null;
}

export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const allowAdopt = new URL(req.url).searchParams.get("allowAdopt") === "1";

  const limit = await checkRateLimit(`stripe-migrate-preview:${tenantId}`, 30, 10 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "Too many previews — try again shortly." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  }

  const stripe = await stripeClient();
  if (!stripe) return apiError("Stripe is not configured", 503);

  try {
    const preview = await previewMigration(stripe, tenantId, new Date(), { allowAdopt });
    return NextResponse.json({ ok: true, ...preview });
  } catch (e) {
    return migrationErrorResponse(e) ?? apiError("Could not read your Stripe customers", 500, e, "[stripe/migrate-memberships GET]");
  }
}

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;

  let body: unknown = {};
  try { body = await req.json(); } catch {}
  const parsed = applySchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Invalid data" }, { status: 400 });

  const limit = await checkRateLimit(`stripe-migrate-apply:${tenantId}`, 10, 60 * 60 * 1000);
  if (!limit.allowed) {
    return NextResponse.json({ ok: false, error: "Too many migration runs — try again later." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });
  }

  const stripe = await stripeClient();
  if (!stripe) return apiError("Stripe is not configured", 503);

  try {
    const outcomes = await applyMigration(stripe, tenantId, parsed.data.memberIds, {
      dryRun: parsed.data.dryRun ?? false,
      allowAdopt: parsed.data.allowAdopt ?? false,
      userId,
    });
    return NextResponse.json({ ok: true, outcomes });
  } catch (e) {
    return migrationErrorResponse(e) ?? apiError("Migration failed before any member was changed", 500, e, "[stripe/migrate-memberships POST]");
  }
}
