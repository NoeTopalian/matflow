"use client";

import { useState, useEffect, useCallback } from "react";
import { X, ChevronRight, Loader2 } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { ErrorState } from "@/components/ui/ErrorState";
import Link from "next/link";

type AlertMember = {
  id: string;
  name: string;
  dateOfBirth: string;
  accountType: string;
  parentMemberId: string | null;
  parent: { id: string; name: string } | null;
};

function computeAge(dob: string): number {
  const birth = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  return age;
}

export default function PromotionAlerts() {
  const { toast } = useToast();
  const [members, setMembers] = useState<AlertMember[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState(false);

  // UI-RULES §7: `r.ok ? r.json() : { members: [] }` made a failed check look
  // exactly like "nobody is due to move to an adult account" — the banner
  // simply never appeared, and kids stayed on child accounts indefinitely with
  // nothing on screen to say the check had failed.
  const fetchAlerts = useCallback(() => {
    setLoadError(false);
    fetch("/api/members/promotion-alerts")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: { members?: AlertMember[] }) => {
        setMembers(Array.isArray(data?.members) ? data.members : []);
      })
      .catch(() => setLoadError(true));
  }, []);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  async function promoteToAdult(memberId: string) {
    if (promoting) return;
    setPromoting(memberId);
    setErrors((e) => ({ ...e, [memberId]: "" }));
    try {
      const res = await fetch(`/api/members/${memberId}/promote-to-adult`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: window.location.origin,
        },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        const msg = data?.error ?? "Failed to promote member";
        setErrors((e) => ({ ...e, [memberId]: msg }));
        return;
      }
      setMembers((prev) => prev.filter((m) => m.id !== memberId));
      toast("Member promoted to adult account", "success");
    } catch {
      setErrors((e) => ({ ...e, [memberId]: "Network error — please try again" }));
    } finally {
      setPromoting(null);
    }
  }

  if (dismissed) return null;

  // A failed check is not "nobody to promote" — say so, and offer the retry.
  if (loadError) {
    return (
      <div className="mb-5">
        <ErrorState
          message="Couldn't check who's ready to move to an adult account — tap to retry"
          onRetry={fetchAlerts}
        />
      </div>
    );
  }

  if (members.length === 0) return null;

  return (
    <div
      className="mb-5 rounded-2xl border p-4"
      style={{
        background: "rgba(245,158,11,0.07)",
        borderColor: "rgba(245,158,11,0.28)",
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <p className="text-sm font-semibold" style={{ color: "#f59e0b" }}>
          {"🎂"}{" "}
          {members.length === 1
            ? "1 member ready for promotion to adult account"
            : `${members.length} members ready for promotion to adult account`}
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          className="shrink-0 transition-opacity hover:opacity-70"
          style={{ color: "#f59e0b" }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-2">
        {members.map((m) => {
          const age = computeAge(m.dateOfBirth);
          const isPromoting = promoting === m.id;
          const err = errors[m.id];

          return (
            <div
              key={m.id}
              className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 rounded-xl border px-3 py-2.5"
              style={{ background: "rgba(245,158,11,0.06)", borderColor: "rgba(245,158,11,0.16)" }}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <Link
                    href={`/dashboard/members/${m.id}`}
                    className="text-sm font-semibold hover:underline"
                    style={{ color: "var(--tx-1)" }}
                  >
                    {m.name}
                  </Link>
                  <span
                    className="text-[11px] px-2 py-0.5 rounded-full font-medium capitalize"
                    style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
                  >
                    {m.accountType}
                  </span>
                  <span className="text-xs" style={{ color: "var(--tx-3)" }}>
                    Age {age}
                  </span>
                  {m.parent && (
                    <span className="text-xs" style={{ color: "var(--tx-4)" }}>
                      · Parent:{" "}
                      <Link
                        href={`/dashboard/members/${m.parent.id}`}
                        className="hover:underline"
                        style={{ color: "var(--tx-3)" }}
                      >
                        {m.parent.name}
                      </Link>
                    </span>
                  )}
                </div>
                {err && (
                  <p className="text-xs mt-1" style={{ color: "#f87171" }}>
                    {err}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => void promoteToAdult(m.id)}
                  disabled={isPromoting || !!promoting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50 transition-opacity"
                  style={{ background: "#f59e0b" }}
                >
                  {isPromoting ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                  {isPromoting ? "Promoting…" : "Promote to adult"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
