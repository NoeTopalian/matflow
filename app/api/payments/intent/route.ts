/**
 * Member-initiated payment intent for an off-Stripe method
 * (bank transfer, cash). Records a Payment row with status="pending"
 * so the gym owner can confirm it later via /api/payments/manual style flow.
 *
 * Card payments do NOT come through here — they go through Stripe Checkout
 * (existing /api/member/class-packs/buy etc.).
 */
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";

const schema = z.object({
  kind: z.enum(["class_pack"]),
  itemId: z.string().min(1),
  method: z.enum(["bank_transfer", "cash"]),
  notes: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "No member account linked" }, { status: 400 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const tenantId = session.user.tenantId;

  if (parsed.data.kind === "class_pack") {
    const pack = await prisma.classPack.findFirst({
      where: { id: parsed.data.itemId, tenantId, isActive: true },
    });
    if (!pack) return NextResponse.json({ error: "Pack unavailable" }, { status: 404 });

    const description = `${parsed.data.method === "bank_transfer" ? "Bank transfer" : "Cash"} intent: ${pack.name}${parsed.data.notes ? ` — ${parsed.data.notes}` : ""}`;

    const payment = await prisma.payment.create({
      data: {
        tenantId,
        memberId,
        amountPence: pack.pricePence,
        currency: pack.currency,
        status: "pending",
        description,
      },
    });

    await logAudit({
      tenantId,
      userId: null,
      action: "payment.intent",
      entityType: "Payment",
      entityId: payment.id,
      metadata: { kind: "class_pack", packId: pack.id, method: parsed.data.method, amountPence: pack.pricePence },
      req,
    });

    return NextResponse.json({
      ok: true,
      paymentId: payment.id,
      message:
        parsed.data.method === "bank_transfer"
          ? "Pay by bank transfer using the gym's reference. Your gym will confirm payment and activate the pack."
          : "Pay in cash at the gym. Your gym will confirm payment and activate the pack.",
    }, { status: 201 });
  }

  return NextResponse.json({ error: "Unsupported kind" }, { status: 400 });
}
