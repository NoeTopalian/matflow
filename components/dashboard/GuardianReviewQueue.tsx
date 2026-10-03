"use client";

/**
 * Guardian suggestions to review (3 Oct 2026).
 *
 * An import SUGGESTS a parent link when a child's TeamUp row shares an email
 * address with an adult, or names an emergency contact. A suggested link
 * (parentMemberId set, guardianConfirmedAt null — lib/guardianship.ts) grants
 * the parent nothing until the owner or a manager confirms it. A first import
 * can leave a few hundred of these; before this queue the only way to clear
 * them was to open each child's profile in turn.
 *
 * One at a time, on purpose — there is no "confirm all". Each confirmation
 * gives an adult portal access to a child's record (name, date of birth,
 * attendance, check-in and waiver on their behalf), so each one is a decision
 * about a real family, made by someone who knows it. A bulk button would turn
 * a few hundred decisions into one click on an inferred guess.
 *
 * Data: GET /api/members?guardianReview=1 (owner/manager only). Actions: the
 * existing POST /api/members/[childId]/guardian, the same route the Family
 * card uses, so the server rules (an under-13 cannot be left without a
 * guardian; a link that changed meanwhile is a 409) apply unchanged.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";

export interface GuardianSuggestion {
  childId: string;
  childName: string;
  childAccountType: string | null;
  childDateOfBirth: string | null;
  childStatus: string;
  guardianId: string | null;
  guardianName: string | null;
  guardianCanSignIn: boolean;
  source: string | null;
  sourceLabel: string;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string; reference: string | null }
  | { kind: "ready" };

const AGE_BAND: Record<string, string> = { kids: "Under 13", junior: "13–17" };

export default function GuardianReviewQueue({
  onTotalChange,
}: {
  /** Told the number still to review after every load and every decision. */
  onTotalChange?: (total: number) => void;
}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<GuardianSuggestion[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<GuardianSuggestion | null>(null);

  const publishTotal = useCallback(
    (n: number) => {
      setTotal(n);
      onTotalChange?.(n);
    },
    [onTotalChange],
  );

  const fetchPage = useCallback(async (cursor: string | null) => {
    const qs = new URLSearchParams({ guardianReview: "1", take: "50" });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`/api/members?${qs.toString()}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false as const,
        message: typeof data?.error === "string" ? data.error : "Couldn't load the guardian suggestions.",
        reference: typeof data?.reference === "string" ? data.reference : null,
      };
    }
    return {
      ok: true as const,
      suggestions: (Array.isArray(data?.suggestions) ? data.suggestions : []) as GuardianSuggestion[],
      total: typeof data?.total === "number" ? data.total : 0,
      nextCursor: typeof data?.nextCursor === "string" ? data.nextCursor : null,
    };
  }, []);

  const loadFirst = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const page = await fetchPage(null);
      if (!page.ok) {
        setState({ kind: "error", message: page.message, reference: page.reference });
        return;
      }
      setRows(page.suggestions);
      setNextCursor(page.nextCursor);
      publishTotal(page.total);
      setState({ kind: "ready" });
    } catch {
      setState({ kind: "error", message: "Couldn't load the guardian suggestions.", reference: null });
    }
  }, [fetchPage, publishTotal]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor);
      if (!page.ok) {
        // The rows already shown are still true — keep them, say what failed.
        toast(page.message, "error");
        return;
      }
      setRows((prev) => {
        const seen = new Set(prev.map((r) => r.childId));
        return [...prev, ...page.suggestions.filter((s) => !seen.has(s.childId))];
      });
      setNextCursor(page.nextCursor);
      publishTotal(page.total);
    } catch {
      toast("Couldn't load more suggestions. Try again.", "error");
    } finally {
      setLoadingMore(false);
    }
  }

  async function decide(row: GuardianSuggestion, action: "confirm" | "reject") {
    setBusy(row.childId);
    try {
      const res = await fetch(`/api/members/${row.childId}/guardian`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Adopting a guardian draft's payer address as their login is a
        // separate decision with its own checks; it stays on the Family card.
        body: JSON.stringify({ action, adoptUnverifiedEmail: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(typeof data?.error === "string" ? data.error : "That didn't save. Try again.", "error");
        return;
      }
      toast(
        typeof data?.message === "string" ? data.message : action === "confirm" ? "Guardian confirmed" : "Suggestion removed",
        "success",
      );
      setRows((prev) => prev.filter((r) => r.childId !== row.childId));
      publishTotal(Math.max(0, (total ?? 1) - 1));
    } catch {
      toast("That didn't save. Check your connection and try again.", "error");
    } finally {
      setBusy(null);
      setRejectTarget(null);
    }
  }

  if (state.kind === "loading") {
    return (
      <Card aria-busy="true" aria-label="Loading guardian suggestions">
        <div className="space-y-3">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      </Card>
    );
  }

  if (state.kind === "error") {
    return <ErrorState message={state.message} reference={state.reference} onRetry={() => void loadFirst()} />;
  }

  return (
    <Card>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-tx-1">
          Guardian suggestions to review{total !== null ? ` · ${total}` : ""}
        </h2>
        <p className="mt-1 text-[13px] text-tx-3">
          Each link below was inferred by the import and gives the adult nothing yet. Confirm only the ones you know are
          right — confirming lets that adult see and act for the child in the member app once they can sign in.
        </p>
      </div>

      {rows.length === 0 && nextCursor ? (
        // Every loaded row has been decided but more wait behind the cursor:
        // never show the all-done message while the club still has suggestions.
        <div className="py-6 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-tx-2">
            {total !== null ? `${total.toLocaleString("en-GB")} more to review.` : "More suggestions are waiting."}
          </p>
          <Button variant="secondary" size="compact" onClick={() => void loadMore()} loading={loadingMore}>
            Show the next suggestions
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="No guardian suggestions to review" hint="Every imported family link has been confirmed or removed." />
      ) : (
        <ul className="divide-y divide-bd-default" aria-label="Guardian suggestions">
          {rows.map((r) => {
            const band = r.childAccountType ? AGE_BAND[r.childAccountType] : undefined;
            const guardian = r.guardianName ?? "Unknown guardian";
            const isUnder13 = r.childAccountType === "kids";
            return (
              <li key={r.childId} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid="guardian-review-row">
                <div className="min-w-0 text-[13px]">
                  <p className="truncate text-tx-1">
                    <Link href={`/dashboard/members/${r.childId}`} className="font-medium hover:underline">
                      {r.childName}
                    </Link>
                    {band ? <span className="text-tx-3"> · {band}</span> : null}
                    {r.childStatus !== "active" ? <span className="text-tx-3"> · {r.childStatus}</span> : null}
                  </p>
                  <p className="truncate text-tx-2">
                    Suggested guardian:{" "}
                    {r.guardianId ? (
                      <Link href={`/dashboard/members/${r.guardianId}`} className="hover:underline">
                        {guardian}
                      </Link>
                    ) : (
                      guardian
                    )}
                    <span className="text-tx-3"> · from {r.sourceLabel.toLowerCase()}</span>
                  </p>
                  <p className="text-[12px] text-tx-3">
                    {r.guardianCanSignIn
                      ? "Can sign in — confirming gives them access straight away."
                      : "No login yet — confirming grants nothing until you invite them from their profile."}
                  </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <Button
                    size="compact"
                    onClick={() => void decide(r, "confirm")}
                    loading={busy === r.childId}
                    disabled={busy !== null}
                    aria-label={`Confirm ${guardian} as ${r.childName}'s guardian`}
                  >
                    <ShieldCheck className="size-3.5" /> Confirm
                  </Button>
                  {isUnder13 ? (
                    // The database requires an under-13 to have a guardian, so
                    // the route refuses a plain reject (409). Replacing the
                    // suggestion is "Link existing" on the right guardian.
                    <span className="max-w-[12rem] text-[11px] text-tx-3">
                      Under 13 — if wrong, open the right guardian and use Link existing
                    </span>
                  ) : (
                    <Button
                      size="compact"
                      variant="secondary"
                      onClick={() => setRejectTarget(r)}
                      disabled={busy !== null}
                      aria-label={`${guardian} is not ${r.childName}'s guardian`}
                    >
                      Not a guardian
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {nextCursor && rows.length > 0 ? (
        <div className="mt-3 flex justify-center">
          <Button variant="secondary" size="compact" onClick={() => void loadMore()} loading={loadingMore}>
            Show more
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        onConfirm={async () => {
          if (rejectTarget) await decide(rejectTarget, "reject");
        }}
        title={rejectTarget ? `${rejectTarget.guardianName ?? "This adult"} is not ${rejectTarget.childName}'s guardian?` : "Not a guardian"}
        description="The suggested link is removed. Both profiles stay."
        confirmLabel="Remove suggestion"
        destructive
      />
    </Card>
  );
}
