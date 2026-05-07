/**
 * Resend webhook — receives delivery / bounce / complaint events.
 * Signature verification via RESEND_WEBHOOK_SECRET (svix).
 *
 * Set up: see docs/EMAIL-SETUP-RUNBOOK.md Step 11. Endpoint URL on the
 * Resend dashboard side is `https://matflow.studio/api/webhooks/resend`.
 */
import { Webhook } from "svix";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ResendEvent = {
  type: string;
  created_at?: string;
  data?: {
    email_id?: string;
    to?: string[];
    subject?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    complaint?: { type?: string; userAgent?: string };
  };
};

// Status precedence — out-of-order Resend events must never let a transient
// status (delivery_delayed) overwrite a terminal one (bounced/complained), and
// `failed` and `bounced` must not be interchangeable. Each status has a
// distinct rank; a webhook event whose mapped rank is < the current rank is
// rejected. (Security audit iteration 2 / H3, 2026-05-07.)
const STATUS_RANK: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  delivery_delayed: 2, // transient — same plane as delivered, won't overwrite terminals
  failed: 3,
  bounced: 4,          // terminal
  complained: 5,       // strongest — never overwritten by anything
};

export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const rawBody = await req.text();

  if (!secret) {
    // Dev-only fallback: no secret configured, accept events but warn.
    console.warn("[resend-webhook] RESEND_WEBHOOK_SECRET not set — accepting unsigned event in dev mode");
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Webhook secret not configured" }, { status: 503 });
    }
  } else {
    try {
      const wh = new Webhook(secret);
      const headers = {
        "svix-id": req.headers.get("svix-id") ?? "",
        "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
        "svix-signature": req.headers.get("svix-signature") ?? "",
      };
      wh.verify(rawBody, headers);
    } catch (err) {
      console.warn("[resend-webhook] signature verification failed", err);
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let event: ResendEvent;
  try {
    event = JSON.parse(rawBody) as ResendEvent;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const resendId = event.data?.email_id;
  if (!resendId) return NextResponse.json({ ok: true, ignored: "no email_id" });

  // Map event type to the status enum + capture diagnostic message for
  // bounces/complaints so the operator can see WHY in the EmailLog table.
  let nextStatus: string | null = null;
  let errorMessage: string | null = null;
  switch (event.type) {
    case "email.sent":
      nextStatus = "sent";
      break;
    case "email.delivered":
      nextStatus = "delivered";
      break;
    case "email.bounced": {
      nextStatus = "bounced";
      const b = event.data?.bounce;
      if (b) {
        const parts = [b.type, b.subType, b.message].filter(Boolean).join(" — ");
        errorMessage = parts.slice(0, 500) || "bounced";
      } else {
        errorMessage = "bounced";
      }
      break;
    }
    case "email.complained":
      nextStatus = "complained";
      errorMessage = "Recipient marked as spam";
      break;
    case "email.delivery_delayed":
      // Transient — must NOT clobber a later terminal `bounced`. Status rank
      // 2 (same as delivered), so a subsequent bounce rank 4 will overwrite.
      nextStatus = "delivery_delayed";
      errorMessage = "Resend reported delivery delayed";
      break;
    case "email.failed":
      nextStatus = "failed";
      errorMessage = "Resend reported failed";
      break;
    case "email.opened":
    case "email.clicked":
      // Visibility-only events — ack but don't write (keeps EmailLog small)
      return NextResponse.json({ ok: true, ignored: event.type });
    default:
      return NextResponse.json({ ok: true, ignored: event.type });
  }

  try {
    // Webhook is cross-tenant by nature: Resend doesn't know which tenant
    // an email_id belongs to, we look it up via the unique resendId. RLS
    // bypass is intentional + correct.
    const existing = await withRlsBypass((tx) =>
      tx.emailLog.findUnique({ where: { resendId }, select: { id: true, status: true } }),
    );
    if (!existing) {
      // Email was sent before the webhook was wired, or from a different
      // environment. Ack so Resend doesn't retry.
      return NextResponse.json({ ok: true, ignored: "email not found" });
    }

    // Don't downgrade — once a message is complained/bounced, a later
    // `delivered` event (out-of-order delivery) shouldn't overwrite.
    const currentRank = STATUS_RANK[existing.status] ?? 0;
    const nextRank = STATUS_RANK[nextStatus] ?? 0;
    if (nextRank < currentRank) {
      return NextResponse.json({ ok: true, ignored: "would downgrade status" });
    }

    await withRlsBypass((tx) =>
      tx.emailLog.update({
        where: { id: existing.id },
        data: {
          status: nextStatus,
          ...(errorMessage ? { errorMessage } : {}),
        },
      }),
    );
  } catch (err) {
    console.warn("[resend-webhook] DB update failed", err);
    // Still 200 so Resend doesn't retry forever; failure is logged
  }

  return NextResponse.json({ ok: true });
}
