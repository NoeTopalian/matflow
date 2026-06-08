import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/authz";
import { sendEmail } from "@/lib/email";
import { checkRateLimit } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

const schema = z.object({
  to: z.string().email(),
  message: z.string().max(500).optional(),
});

export async function POST(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
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

  if (result.ok) {
    await logAudit({
      tenantId,
      userId,
      action: "email.test_sent",
      entityType: "Tenant",
      entityId: tenantId,
      metadata: {
        to: parsed.data.to,
        messageLength: parsed.data.message?.length ?? 0,
      },
      req,
    });
  }

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
