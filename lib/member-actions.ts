/**
 * feat/member-tickable-notes Phase 6 — compute "system" action items for a
 * member on the fly.
 *
 * System actions are things the app derives from the member's own profile
 * state — there's no row in the Task table for them. They appear on the
 * member's action list alongside DB-stored `member_note` tasks so the member
 * has ONE place to see "what does the gym expect from me right now".
 *
 * Why compute, not store?
 *   - The condition is the source of truth: once the member signs the waiver,
 *     the action disappears automatically. No cron, no double-write race.
 *   - Mirrors the staff dashboard's `getStats()` pattern in app/dashboard/page.tsx
 *     (waiverMissing / paymentsDue are computed there too).
 *
 * Visual treatment (Phase 6 UI): every system item carries `kind: "system"`
 * and renders with a ⚡ icon + "Suggested by MatFlow" footer, distinct from
 * member_note items which show the staff member's name. That's the answer to
 * "make it clear what is a note and what is a built-in to-do".
 */
// We accept any tx-like object with the `member.findFirst` shape we need —
// keeps this helper decoupled from the Prisma client output location and
// trivially mockable in tests.
type Tx = {
  member: {
    findFirst: (args: {
      where: { id: string; tenantId: string };
      select: {
        id: true;
        waiverAccepted: true;
        emergencyContactName: true;
        emergencyContactPhone: true;
        paymentStatus: true;
      };
    }) => Promise<{
      id: string;
      waiverAccepted: boolean;
      emergencyContactName: string | null;
      emergencyContactPhone: string | null;
      paymentStatus: string;
    } | null>;
  };
};

export type SystemAction = {
  id: string; // synthetic, stable for a given (memberId, code)
  code: SystemActionCode;
  kind: "system";
  title: string;
  body: string;
  /** Where the member goes to resolve the action. */
  href: string;
  /**
   * Sort weight — lower renders first. Tuned so safety/legal items (waiver)
   * come above billing nudges, which come above profile completeness.
   */
  weight: number;
};

export type SystemActionCode =
  | "waiver_missing"
  | "emergency_contact_missing"
  | "payment_overdue";

/**
 * Build the system-action list for one member.
 *
 * Caller is responsible for tenant scoping — pass a tx already bound via
 * `withTenantContext(tenantId, ...)`. We re-filter on memberId+tenantId
 * inside the query as defence in depth.
 */
export async function getMemberSystemActions(
  tx: Tx,
  args: { memberId: string; tenantId: string },
): Promise<SystemAction[]> {
  const m = await tx.member.findFirst({
    where: { id: args.memberId, tenantId: args.tenantId },
    select: {
      id: true,
      waiverAccepted: true,
      emergencyContactName: true,
      emergencyContactPhone: true,
      paymentStatus: true,
    },
  });
  if (!m) return [];

  const out: SystemAction[] = [];

  if (!m.waiverAccepted) {
    out.push({
      id: `sys:${m.id}:waiver_missing`,
      code: "waiver_missing",
      kind: "system",
      title: "Sign your waiver",
      body: "Every member signs once. Takes about a minute on the phone — the gym needs it on file before your next class.",
      href: "/member/profile",
      weight: 10,
    });
  }

  if (!m.emergencyContactName || !m.emergencyContactPhone) {
    out.push({
      id: `sys:${m.id}:emergency_contact_missing`,
      code: "emergency_contact_missing",
      kind: "system",
      title: "Add an emergency contact",
      body: "Someone we can call if you pick up an injury. Just a name and a number — saved straight from your profile.",
      href: "/member/profile",
      weight: 20,
    });
  }

  if (m.paymentStatus === "overdue") {
    out.push({
      id: `sys:${m.id}:payment_overdue`,
      code: "payment_overdue",
      kind: "system",
      title: "Update your payment method",
      body: "Your last payment didn't go through. Card may have expired or your bank flagged it — quickest fix is to update it in Billing.",
      href: "/member/billing",
      weight: 5, // higher priority than waiver — blocks training under most policies
    });
  }

  return out.sort((a, b) => a.weight - b.weight);
}
