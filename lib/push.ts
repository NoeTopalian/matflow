import webpush from "web-push";
import { prisma } from "@/lib/prisma";

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
if (PUBLIC && PRIVATE) {
  webpush.setVapidDetails("mailto:hello@matflow.io", PUBLIC, PRIVATE);
}

export async function sendPushToMember(memberId: string, payload: { title: string; body: string; url?: string }) {
  if (!PUBLIC || !PRIVATE) return;
  const subs = await prisma.pushSubscription.findMany({ where: { memberId } });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
      );
    } catch (e: unknown) {
      if ((e as { statusCode?: number }).statusCode === 410) {
        await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
      }
    }
  }
}
