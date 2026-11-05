/**
 * New activity events (5 Nov 2026) — things that happen in a club that the
 * audit log did not record before the Activity timeline needed them: a
 * membership started, a class pack bought, a shop order paid, a class booked
 * or the booking cancelled.
 *
 * Every one of them goes through `logActivityEvent`, which checks the row's
 * metadata against a closed shape before it is written. The shapes hold ids,
 * counts and amounts only: no name, no title, no message, no address. A row
 * that would carry anything else is a programming error — it throws in tests
 * and development, and in production the extra keys are dropped and the event
 * is still recorded, because losing "Faisal bought a class pack" is worse than
 * failing his purchase over a log line.
 *
 * Rows about a member use that member as the entity (`entityType: "Member"`),
 * so the member's own History and their subject-access export both find them.
 */
import { z } from "zod";

import { logAudit } from "@/lib/audit-log";
import { ERASED_EMAIL } from "@/lib/login-email";
import { withTenantContext } from "@/lib/prisma-tenant";

/** A record id as the app writes them: a cuid, or a seeded club's readable id. */
const id = z.string().regex(/^[A-Za-z0-9_:-]{1,100}$/);
const pence = z.number().int().nonnegative();
const currency = z.string().regex(/^[A-Za-z]{3}$/);

const SHAPES = {
  /**
   * A membership was started through Stripe. Written when the subscription is
   * created, which is BEFORE any money moves (`payment_behavior:
   * "default_incomplete"`): the row says "awaiting first payment", and the
   * payment, when it comes, is its own `member.payment.succeeded` row.
   */
  "member.subscription.purchased": { memberId: id, tierId: id.nullable(), stripeSubscriptionId: z.string().regex(/^sub_[A-Za-z0-9]{1,90}$/) },
  /** A paid class pack was added to a member. */
  "class_pack.purchased": { memberId: id, classPackId: id, memberClassPackId: id, credits: z.number().int().positive(), amountPence: pence, currency },
  /** A shop order was paid through Stripe. */
  "order.paid": { memberId: id.nullable(), orderId: id, orderRef: z.string().min(1).max(60), amountPence: pence, currency },
  /** A member booked a standing place in a class, or gave it up. */
  "class.booking.created": { memberId: id, classId: id },
  "class.booking.cancelled": { memberId: id, classId: id },
} as const;

export type ActivityEventAction = keyof typeof SHAPES;
export const ACTIVITY_EVENT_ACTIONS = Object.keys(SHAPES) as ActivityEventAction[];

/** The closed shape of each event's metadata. Exported for the tests that prove nothing else gets in. */
export const ACTIVITY_EVENT_SCHEMAS = {
  "member.subscription.purchased": z.strictObject(SHAPES["member.subscription.purchased"]),
  "class_pack.purchased": z.strictObject(SHAPES["class_pack.purchased"]),
  "order.paid": z.strictObject(SHAPES["order.paid"]),
  "class.booking.created": z.strictObject(SHAPES["class.booking.created"]),
  "class.booking.cancelled": z.strictObject(SHAPES["class.booking.cancelled"]),
} satisfies Record<ActivityEventAction, z.ZodType>;
/** The same shapes with unknown keys dropped instead of refused: what production falls back to. */
const LENIENT: Record<ActivityEventAction, z.ZodType> = {
  "member.subscription.purchased": z.object(SHAPES["member.subscription.purchased"]),
  "class_pack.purchased": z.object(SHAPES["class_pack.purchased"]),
  "order.paid": z.object(SHAPES["order.paid"]),
  "class.booking.created": z.object(SHAPES["class.booking.created"]),
  "class.booking.cancelled": z.object(SHAPES["class.booking.cancelled"]),
};

export type ActivityEventMetadata<A extends ActivityEventAction> = z.infer<(typeof ACTIVITY_EVENT_SCHEMAS)[A]>;

type LogArgs = Parameters<typeof logAudit>[0];
export type ActivityEventBase = Omit<LogArgs, "action" | "metadata" | "entityType" | "entityId"> & {
  /**
   * The member's address when the caller already has it. An erased member
   * (`deleted-…@deleted.invalid`) gets no new activity: their record is gone
   * on purpose, and a row naming their id would outlive the erasure.
   */
  memberEmail?: string | null;
  /** The record the row is about, when it is not the member (a shop order with no member on it). */
  entity?: { type: string; id: string };
};

const strict = () => process.env.NODE_ENV !== "production";

/**
 * Record one of the events above. Returns true when a row was written.
 *
 * Pass `tx` to write inside the caller's transaction (the row then commits or
 * rolls back with the change it records — a retried Stripe event cannot leave
 * two rows), or `durable: true` for an awaited write of its own.
 */
export async function logActivityEvent<A extends ActivityEventAction>(action: A, metadata: ActivityEventMetadata<A>, base: ActivityEventBase): Promise<boolean> {
  const { memberEmail, entity, ...log } = base;
  if (typeof memberEmail === "string" && ERASED_EMAIL.test(memberEmail)) return false;

  let checked = (ACTIVITY_EVENT_SCHEMAS[action] as z.ZodType).safeParse(metadata);
  if (!checked.success) {
    // Key names and what was wrong with them — never a value.
    const problem = checked.error.issues
      .map((issue) => `${issue.path.join(".") || "(row)"}: ${issue.code}${issue.code === "unrecognized_keys" ? ` ${issue.keys.join(", ")}` : ""}`)
      .join("; ");
    if (strict()) throw new Error(`[activity-events] ${action} was given metadata it does not allow — ${problem}`);
    // Production: say which keys were wrong (never their values), drop what is not in the shape, and carry on.
    console.error(`[activity-events] ${action}: ${problem}`);
    checked = LENIENT[action].safeParse(metadata);
    if (!checked.success) return false;
  }

  const memberId = (checked.data as { memberId?: string | null }).memberId ?? null;
  const about = entity ?? (memberId ? { type: "Member", id: memberId } : null);
  if (!about) {
    if (strict()) throw new Error(`[activity-events] ${action} names no member and no other record to file it under`);
    return false;
  }
  await logAudit({ ...log, action, entityType: about.type, entityId: about.id, metadata: checked.data as Record<string, unknown> });
  return true;
}

/**
 * "Started a membership — awaiting first payment": written once the Stripe
 * subscription exists. The request that creates it is retried by design (the
 * client holds one idempotency key across retries and Stripe answers with the
 * same subscription), so the row is keyed by the subscription and written
 * once. Never throws: the member is owed their payment form whether or not
 * this line was recorded.
 */
export async function logMembershipStarted(args: {
  tenantId: string;
  memberId: string;
  /** The Stripe price the plan was sold at; the plan is looked up from it. */
  stripePriceId: string;
  stripeSubscriptionId: string;
  /** The staff member who started it, or the member themselves. */
  userId?: string | null;
  memberEmail?: string | null;
  req?: Request;
}): Promise<boolean> {
  try {
    const requestId = `sub-purchased:${args.stripeSubscriptionId}`;
    const found = await withTenantContext(args.tenantId, async (tx) => {
      const already = await tx.auditLog.findFirst({ where: { tenantId: args.tenantId, requestId }, select: { id: true } });
      if (already) return null;
      const tier = await tx.membershipTier.findFirst({ where: { tenantId: args.tenantId, stripePriceId: args.stripePriceId }, select: { id: true } });
      return { tierId: tier?.id ?? null };
    });
    if (!found) return false;
    return await logActivityEvent(
      "member.subscription.purchased",
      { memberId: args.memberId, tierId: found.tierId, stripeSubscriptionId: args.stripeSubscriptionId },
      { tenantId: args.tenantId, userId: args.userId ?? null, durable: true, requestId, memberEmail: args.memberEmail, req: args.req },
    );
  } catch (e) {
    console.error("[activity-events] member.subscription.purchased was not recorded", (e as Error)?.message);
    return false;
  }
}
