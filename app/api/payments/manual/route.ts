/**
 * Owner-side manual payment marking.
 * Use cases: cash collections, exempt members (employees, comps), external payments
 * (Direct Debit collected outside MatFlow's Stripe), one-off "I just took £40 in
 * person, mark Sean paid for the month".
 *
 * Creates a Payment row with no Stripe IDs and flips Member.paymentStatus = 'paid'.
 */
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwnerOrManager } from "@/lib/authz";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

const METHODS = ["cash", "exempt", "external", "comp", "other"] as const;

const schema = z.object({
  memberId: z.string().min(1),
  amountPence: z.number().int().min(0),
  method: z.enum(METHODS),
  notes: z.string().max(500).optional(),
  paidAt: z.string().optional(),
  currency: z.string().min(3).max(3).optional(),
});

const METHOD_LABEL: Record<typeof METHODS[number], string> = {
  cash: "Cash",
  exempt: "Exempt",
  external: "External",
  comp: "Comp",
  other: "Manual",
};

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwnerOrManager();

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { memberId, amountPence, method, notes, paidAt, currency } = parsed.data;

  const member = await prisma.member.findFirst({
    where: { id: memberId, tenantId },
    select: { id: true, name: true },
  });
  if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });

  const description = `${METHOD_LABEL[method]}${notes ? ` — ${notes}` : ""}`;
  const paidAtDate = paidAt ? new Date(paidAt) : new Date();

  try {
    const payment = await prisma.payment.create({
      data: {
        tenantId,
        memberId: member.id,
        amountPence,
        currency: (currency ?? "GBP").toUpperCase(),
        status: "succeeded",
        description,
        paidAt: paidAtDate,
      },
    });

    await prisma.member.update({
      where: { id: member.id },
      data: { paymentStatus: "paid" },
    });

    await logAudit({
      tenantId,
      userId,
      action: "payment.manual",
      entityType: "Payment",
      entityId: payment.id,
      metadata: { memberId: member.id, method, amountPence, notes: notes ?? null },
      req,
    });

    return NextResponse.json(payment, { status: 201 });
  } catch (e) {
    return apiError("Payment processing failed", 500, e, "[payments/manual]");
  }
}
