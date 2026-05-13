import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { z } from "zod";

const schema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const tenantId: string = session.user.tenantId;
  const memberId = (session.user.memberId as string | undefined) ?? null;
  const userId = memberId ? null : ((session.user.id as string | undefined) ?? null);
  if (!memberId && !userId) return apiError("No subject on session", 403);

  let body: unknown;
  try { body = await req.json(); } catch { return apiError("Invalid JSON", 400); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return apiError("Invalid data", 400);

  const ua = req.headers.get("user-agent")?.slice(0, 500) ?? null;

  try {
    const sub = await withTenantContext(tenantId, (tx) =>
      tx.pushSubscription.upsert({
        where: { endpoint: parsed.data.endpoint },
        create: {
          tenantId,
          memberId,
          userId,
          endpoint: parsed.data.endpoint,
          p256dh: parsed.data.keys.p256dh,
          auth: parsed.data.keys.auth,
          userAgent: ua,
        },
        update: { p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth, userAgent: ua },
      }),
    );
    return NextResponse.json({ ok: true, id: sub.id }, { status: 201 });
  } catch (e) {
    return apiError("Failed to subscribe", 500, e, "[push/subscribe]");
  }
}
