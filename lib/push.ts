import webpush from "web-push";
import { withTenantContext } from "@/lib/prisma-tenant";

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
if (PUBLIC && PRIVATE) {
  webpush.setVapidDetails("mailto:hello@matflow.studio", PUBLIC, PRIVATE);
}

/**
 * Deliver a web-push notification to every device a member has registered.
 *
 * Tenant-scoped (6 Oct 2026): both callers hold the tenant
 * (app/api/members/[id]/rank: session.user.tenantId; lib/notify-member-action:
 * args.tenantId), so the reads and the 410 clean-up run inside that club's
 * withTenantContext and filter on tenantId as well as memberId. This works
 * under a restricted runtime role (PushSubscription has RLS FORCEd), and a
 * member id from another club reads nothing. Each statement runs in its own
 * short transaction so none stays open across the network call.
 */
export async function sendPushToMember(
  tenantId: string,
  memberId: string,
  payload: { title: string; body: string; url?: string },
) {
  if (!PUBLIC || !PRIVATE) return;
  if (!tenantId || !memberId) return;
  const subs = await withTenantContext(tenantId, (tx) =>
    tx.pushSubscription.findMany({
      where: { memberId, tenantId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    }),
  );
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 410) {
        // Gone: the browser unsubscribed. Scoped to the member and club as
        // well as the id, so this can never remove anyone else's row.
        await withTenantContext(tenantId, (tx) =>
          tx.pushSubscription.deleteMany({ where: { id: sub.id, memberId, tenantId } }),
        ).catch(() => {});
      }
    }
  }
}
