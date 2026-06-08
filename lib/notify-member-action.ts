/**
 * feat/member-tickable-notes Phase 5 — fire-and-forget notification bundle
 * for a newly-created `member_note` Task.
 *
 * Sends:
 *   - Push (via lib/push.ts sendPushToMember) — unconditional if the member
 *     has any PushSubscription rows; web-push is the primary channel.
 *   - Email (via lib/email.ts member_action_assigned template) — only if the
 *     member's `taskAssignments` preference is true. Default true.
 *
 * Callers (app/api/tasks/route.ts) invoke this with `void notifyMemberAction(...)`
 * AFTER the task is persisted so a notification failure never blocks the
 * staff-side 201 response.
 *
 * Errors are swallowed individually (Promise.allSettled) so a failing push
 * endpoint or bounced email does not prevent the other channel from firing.
 */
import { withTenantContext, withRlsBypass } from "@/lib/prisma-tenant";
import { sendEmail } from "@/lib/email";
import { sendPushToMember } from "@/lib/push";
import { getBaseUrl } from "@/lib/env-url";

export type NotifyMemberActionArgs = {
  tenantId: string;
  memberId: string;
  title: string;
  body: string | null;
  fromName: string | null; // staff member's display name (or null if SET NULL fired)
  /**
   * Skip the push channel — used by tests and by the staff-side toggle
   * "Send without notifying" (Phase 5 UI). Default false.
   */
  skipPush?: boolean;
  /**
   * Original Request object — used to derive the absolute base URL for the
   * "Mark done" CTA when NEXTAUTH_URL isn't set in dev.
   */
  req?: Request;
};

export async function notifyMemberAction(args: NotifyMemberActionArgs): Promise<void> {
  // Look up the member's email + preference + name in one round-trip.
  // withRlsBypass because: this runs inside the route's same-tenant write
  // context but on a fresh transaction (fire-and-forget), and we already
  // KNOW the tenantId from args — the calling route validated it. Using
  // withTenantContext here also works; we use bypass because the next-up
  // sendEmail call also takes its own tenantId path and we keep the
  // failure modes uniform.
  const member = await withTenantContext(args.tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: args.memberId, tenantId: args.tenantId },
      select: { email: true, name: true, taskAssignments: true },
    }),
  ).catch(() => null);

  if (!member) return;

  // Marker for the few sentinel-email patterns elsewhere in the codebase
  // (GDPR-erased members carry an erased+ID sentinel email). Skip sending
  // to those — no point bouncing into the void.
  const looksLikeSentinel =
    member.email.startsWith("erased+") || member.email.endsWith("@deleted.matflow.local");
  if (looksLikeSentinel) return;

  const actionUrl = (() => {
    const base = args.req ? getBaseUrl(args.req) : (process.env.NEXTAUTH_URL ?? "");
    const trimmed = base.replace(/\/$/, "");
    return `${trimmed}/member/actions`;
  })();

  const gymName = await withRlsBypass((tx) =>
    tx.tenant.findUnique({ where: { id: args.tenantId }, select: { name: true } }),
  )
    .then((t) => t?.name ?? "your gym")
    .catch(() => "your gym");

  const tasks: Array<Promise<unknown>> = [];

  if (!args.skipPush) {
    tasks.push(
      sendPushToMember(args.memberId, {
        title: args.fromName ? `Action from ${args.fromName}` : `Action from ${gymName}`,
        body: args.title,
        url: "/member/actions",
      }).catch(() => undefined),
    );
  }

  if (member.taskAssignments) {
    tasks.push(
      sendEmail({
        tenantId: args.tenantId,
        templateId: "member_action_assigned",
        to: member.email,
        vars: {
          memberName: member.name,
          gymName,
          fromName: args.fromName ?? "",
          title: args.title,
          body: args.body ?? "",
          actionUrl,
        },
      }).catch(() => undefined),
    );
  }

  await Promise.allSettled(tasks);
}
