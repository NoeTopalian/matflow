import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/authz";
import { sendEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";

const schema = z.object({
  to: z.string().email(),
  message: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  const { tenantId, userId } = await requireOwner();

  const rl = await checkRateLimit(`email:test:${userId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many test emails. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });

  const result = await sendEmail({
    tenantId,
    templateId: "test",
    to: parsed.data.to,
    vars: { message: parsed.data.message ?? "If you can read this, transactional email is working." },
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
