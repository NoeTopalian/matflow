import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { z } from "zod";
import { MAX_PUSH_ENDPOINT_LENGTH, isAllowedPushEndpoint } from "../endpoint-url";

const schema = z.object({
  // `.url()` alone is the WHATWG parser and accepts `javascript:`, `data:` and
  // any internal host — see ../endpoint-url.ts. https only, with a length cap.
  endpoint: z
    .string()
    .max(MAX_PUSH_ENDPOINT_LENGTH)
    .refine(isAllowedPushEndpoint, { message: "endpoint must be an https:// URL" }),
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
    // Round 5 (11 Nov 2026): the endpoint is unique across every club, and the
    // upsert used to update whichever row held it, so a session that presented
    // someone else's endpoint (in this club or another) replaced that row's
    // keys. Only the subject who registered an endpoint may update it; anyone
    // else is refused and the row is left as it was.
    const sub = await withTenantContext(tenantId, async (tx) => {
      const existing = await tx.pushSubscription.findUnique({
        where: { endpoint: parsed.data.endpoint },
        select: { id: true, tenantId: true, memberId: true, userId: true },
      });
      if (existing && (existing.tenantId !== tenantId || existing.memberId !== memberId || existing.userId !== userId)) return null;
      const keys = { p256dh: parsed.data.keys.p256dh, auth: parsed.data.keys.auth, userAgent: ua };
      if (existing) {
        // A subscription marked gone (lib/push.ts, disabledAt) that the browser registers again is active again.
        return tx.pushSubscription.update({ where: { id: existing.id }, data: { ...keys, disabledAt: null }, select: { id: true } });
      }
      return tx.pushSubscription.create({ data: { tenantId, memberId, userId, endpoint: parsed.data.endpoint, ...keys }, select: { id: true } });
    });
    if (!sub) return apiError("This device is registered to someone else", 409);
    return NextResponse.json({ ok: true, id: sub.id }, { status: 201 });
  } catch (e) {
    if ((e as { code?: unknown })?.code === "P2002") {
      // Two first registrations by the same subject at once: the loser finds the winner's row, which is theirs.
      // Another club's row is invisible here under row-level security, so a collision with it stays a 409.
      const mine = await withTenantContext(tenantId, (tx) =>
        tx.pushSubscription.findFirst({ where: { endpoint: parsed.data.endpoint, tenantId, memberId, userId }, select: { id: true } }),
      ).catch(() => null);
      if (mine) return NextResponse.json({ ok: true, id: mine.id }, { status: 201 });
      return apiError("This device is registered to someone else", 409);
    }
    return apiError("Failed to subscribe", 500, e, "[push/subscribe]");
  }
}
