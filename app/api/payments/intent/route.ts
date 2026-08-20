/**
 * Member-initiated payment intent for an off-Stripe method
 * (bank transfer, cash). Records a Payment row with status="pending"
 * so the gym owner can confirm it later via /api/payments/manual style flow.
 *
 * Card payments do NOT come through here — they go through Stripe Checkout
 * (existing /api/member/class-packs/buy etc.).
 */
import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";

const schema = z.object({
  kind: z.enum(["class_pack"]),
  itemId: z.string().min(1),
  method: z.enum(["bank_transfer", "cash"]),
  notes: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const memberId = session.user.memberId as string | undefined;
  if (!memberId) return NextResponse.json({ error: "No member account linked" }, { status: 400 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  // Off-Stripe class-pack purchases are disabled until an owner-side
  // fulfilment path exists: the pending Payment this route used to create
  // could never be converted into credits (the only MemberClassPack.create
  // site is the Stripe webhook), so members paid cash and received nothing.
  // Re-enable alongside a mark-paid → grant-credits flow.
  return NextResponse.json(
    { error: "Cash and bank-transfer purchases aren't available yet — pay by card, or ask the front desk to set up your pack." },
    { status: 501 },
  );
}
