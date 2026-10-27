/**
 * The dashboard "Payments due" figure, per role (round-3 review L5, 23 Oct
 * 2026).
 *
 * Owners and managers open Payments → Outstanding from it, so it counts what
 * Outstanding lists: payers overdue plus "No payment yet". Coaches and admins
 * cannot open Outstanding; their link goes to the Members "Payers overdue"
 * chip, so their figure must be that chip's count — payers overdue only —
 * and say so. Otherwise a never-paid member past their first due date made
 * the tile read 1 and the chip it opened read 0.
 *
 * Pure: the client tile imports the copy, the server page imports the where.
 */
import type { Prisma } from "@prisma/client";
import { owesMoneyClause, overduePayerWhere } from "@/lib/overdue";
import { CHASEABLE_PAYER, PAYER_COPY } from "@/lib/member-population";

/** Payments → Outstanding is owner/manager only (requireApiOwnerOrManager). */
export function seesOutstanding(role: string | null | undefined): boolean {
  return role === "owner" || role === "manager";
}

export function paymentsDueWhere(tenantId: string, role: string | null | undefined, now: Date): Prisma.MemberWhereInput {
  return seesOutstanding(role)
    ? { tenantId, ...CHASEABLE_PAYER, OR: owesMoneyClause(now) }
    : { tenantId, ...overduePayerWhere(now) };
}

export function paymentsDueCopy(role: string | null | undefined): {
  label: string;
  detail: string;
  todoLabel: string;
  href: string;
} {
  return seesOutstanding(role)
    ? {
        label: "Payments Due",
        detail: "Overdue or no payment yet",
        todoLabel: "Payments due (overdue or no payment yet)",
        href: "/dashboard/payments",
      }
    : {
        label: PAYER_COPY.label,
        detail: "Parents and guardians who pay included",
        todoLabel: PAYER_COPY.label,
        href: "/dashboard/members?filter=overdue",
      };
}
