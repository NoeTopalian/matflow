import { billingSourceLabel } from "@/lib/billing-source";

/**
 * A small "TeamUp" marker for a member TeamUp bills during the bridge
 * (readiness spec v3 §7). The full sentence — "Billed by TeamUp · status as of
 * <date>" — is the title and the accessible name. Renders nothing for a member
 * MatFlow bills.
 */
export function BilledByTeamUpPill({ member }: { member: { billedBy?: string | null; billingStatusAsOf?: string | Date | null } }) {
  const label = billingSourceLabel(member);
  if (!label) return null;
  return (
    <span
      title={label}
      aria-label={label}
      data-testid="billed-by-teamup"
      className="inline-flex items-center rounded-full border border-bd-default bg-sf-2 px-1.5 py-0.5 text-[10px] font-semibold text-tx-2"
    >
      TeamUp
    </span>
  );
}
