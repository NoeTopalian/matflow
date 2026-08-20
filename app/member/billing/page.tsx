"use client";

/**
 * /member/billing — the member's payment method, subscription and invoice history.
 *
 * Why this route exists: `lib/member-actions.ts` has always pointed the
 * "Update your payment method" system action here, and the route did not
 * exist. That action fires on `paymentStatus === "overdue"` at weight 5 —
 * ABOVE the waiver's 10 — so the single highest-priority thing MatFlow ever
 * tells a member to do led straight to a 404. The only billing UI was
 * MemberBillingTab, embedded halfway down /member/profile.
 *
 * MemberBillingTab already renders payment method, self-service state and the
 * full payment history (date / amount / status, and an honest error state
 * rather than a false "no payments yet"). It is reused verbatim — this page
 * gives it a home and an address, nothing more.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import MemberBillingTab from "@/components/member/MemberBillingTab";
import { ErrorState } from "@/components/ui/ErrorState";

type GymBilling = {
  memberSelfBilling: boolean;
  billingContactEmail: string | null;
  billingContactUrl: string | null;
  name: string;
};

export default function MemberBillingPage() {
  const [accent, setAccent] = useState<string | null>(null);
  // null = still loading. Distinguishing null from a default object matters:
  // rendering the billing card with `memberSelfBilling: false` before the
  // fetch lands would tell a member to email the gym when in fact they can
  // self-serve (UI-RULES §7 — never assert state you do not yet know).
  const [gym, setGym] = useState<GymBilling | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    setGym(null);
    try {
      const res = await fetch("/api/me/gym");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        name?: string;
        primaryColor?: string;
        memberSelfBilling?: boolean;
        billingContactEmail?: string | null;
        billingContactUrl?: string | null;
      } | null;
      if (data?.primaryColor) setAccent(data.primaryColor);
      setGym({
        memberSelfBilling: data?.memberSelfBilling ?? false,
        billingContactEmail: data?.billingContactEmail ?? null,
        billingContactUrl: data?.billingContactUrl ?? null,
        name: data?.name ?? "your gym",
      });
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="px-4 pt-4">
      <div className="flex items-center gap-2 mb-5">
        <Link
          href="/member/profile"
          className="inline-flex items-center gap-1 text-sm"
          style={{ color: "var(--member-text-muted)" }}
        >
          <ChevronLeft className="w-4 h-4" />
          Profile
        </Link>
      </div>

      <h1 className="text-xl font-bold mb-1" style={{ color: "var(--member-text)" }}>
        Billing
      </h1>
      <p className="text-xs mb-5" style={{ color: "var(--member-text-muted)" }}>
        Your payment method, subscription and payment history.
      </p>

      {loadError ? (
        <ErrorState
          message="Couldn't load your billing details — tap to retry"
          onRetry={() => void load()}
        />
      ) : gym === null ? (
        <div
          className="rounded-2xl border p-5 text-sm"
          style={{ background: "var(--member-surface)", borderColor: "var(--member-border)", color: "var(--member-text-muted)" }}
        >
          Loading your billing details…
        </div>
      ) : (
        // accent omitted while unknown: MemberBillingTab carries the same
        // default, and restating the literal here would be a second source of
        // truth for the fallback brand colour.
        <MemberBillingTab primaryColor={accent ?? undefined} gym={gym} />
      )}
    </div>
  );
}
