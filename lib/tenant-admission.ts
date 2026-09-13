/**
 * Is this club's account in a state that admits a sign-in?
 *
 * There are three doors into MatFlow — password, magic link and Google OAuth —
 * and only the password one asked. `auth.ts`'s credentials provider refused a
 * suspended or soft-deleted tenant; `app/api/magic-link/verify` and the Google
 * `signIn` callback resolved the tenant, checked it EXISTED, and let everyone
 * through. So an operator suspending a club locked the front door and left two
 * others open, and the owner's own dashboard would tell them they were
 * suspended while they were reading it.
 *
 * That is not a policy question — the policy was already decided and written
 * down, it was simply enforced in one place out of three. This is the one place
 * now, so a fourth door cannot be added without answering the question.
 *
 * `cancelled` is included deliberately even though nothing in the product
 * currently writes it (the state is documented in docs/MATFLOW-PIPELINES.md and
 * has no writer). Closing the door before it is opened costs nothing; noticing
 * later that a newly-reachable state admits logins costs a great deal.
 *
 * `past_due` ADMITS. A club behind on MatFlow's own fee still has members
 * turning up to train tonight, and locking the owner out is how you guarantee
 * they never pay. It is flagged so the dashboard can say so.
 */

export type TenantAdmission =
  | { admits: true; flagged: boolean }
  | { admits: false; reason: "suspended" | "cancelled" | "deleted" };

export interface AdmissibleTenant {
  subscriptionStatus?: string | null;
  deletedAt?: Date | string | null;
}

export function tenantAdmission(tenant: AdmissibleTenant): TenantAdmission {
  if (tenant.deletedAt != null) return { admits: false, reason: "deleted" };

  const status = (tenant.subscriptionStatus ?? "").trim().toLowerCase();
  if (status === "suspended") return { admits: false, reason: "suspended" };
  if (status === "cancelled") return { admits: false, reason: "cancelled" };

  return { admits: true, flagged: status === "past_due" };
}

/** Convenience for the call sites that only need the boolean. */
export function tenantAdmitsSignIn(tenant: AdmissibleTenant): boolean {
  return tenantAdmission(tenant).admits;
}

/**
 * What to tell the person at the door.
 *
 * Deliberately vague about WHY for a member — "your club's account is paused"
 * is true, actionable (talk to your gym) and does not tell a stranger anything
 * about a club's commercial standing with MatFlow. The owner gets the version
 * that names who to contact, because they are the one who can fix it.
 */
export function admissionMessage(
  reason: "suspended" | "cancelled" | "deleted",
  audience: "staff" | "member",
): string {
  if (audience === "member") {
    return "Your club's account is paused. Please speak to your gym.";
  }
  return reason === "deleted"
    ? "This club's account has been closed. Contact MatFlow if this is unexpected."
    : "This club's account is paused. Contact MatFlow to reactivate it.";
}
