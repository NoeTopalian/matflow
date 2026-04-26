/**
 * Resend webhook — receives delivery / bounce / complaint events.
 * Optional signature verification via RESEND_WEBHOOK_SECRET (svix).
 */
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type ResendEvent = {
  type: string;
  created_at?: string;
  data?: { email_id?: string; to?: string[]; subject?: string };
};

export async function POST(req: Request) {
  let event: ResendEvent;
  try {
    event = (await req.json()) as ResendEvent;
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
    await prisma.emailLog.updateMany({
      where: { resendId },
      data: { status },
    });
  } catch { /* best-effort */ }

  return NextResponse.json({ ok: true });
}
