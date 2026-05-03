/**
 * Resend webhook — receives delivery / bounce / complaint events.
 * Signature verification via RESEND_WEBHOOK_SECRET (svix).
 */
import { Webhook } from "svix";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ResendEvent = {
  type: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[]; subject?: string };
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

  const status = ((): string => {
    switch (event.type) {
      case "email.sent": return "sent";
      case "email.delivered": return "delivered";
      case "email.bounced": return "bounced";
      case "email.complained": return "complained";
      case "email.delivery_delayed": return "queued";
      case "email.failed": return "failed";
      default: return "queued";
    }
  })();

  try {
    // Webhook is cross-tenant by nature: Resend doesn't know which tenant
    // an email_id belongs to, we look it up via the unique resendId.
    // Bypass is intentional and correct.
    await withRlsBypass((tx) =>
      tx.emailLog.updateMany({
        where: { resendId },
        data: { status },
      }),
    );
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true });
}
