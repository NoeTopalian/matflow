"use client";

/**
 * Task 15: shown on /member/home when the member has a recent (≤14 day)
 * demotion. Reads /api/member/me/recent-demotion. Dismissable via localStorage
 * (per-history-row key, so re-promotion + re-demotion shows the new banner).
 *
 * To wire into the existing home page, render <DemotionBanner /> near the top
 * of the main content. Self-fetches; no props.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";

type DemotionInfo = {
  demoted: true;
  rankName: string;
  discipline: string;
  at: string;
  historyId: string;
} | { demoted: false };

export default function DemotionBanner() {
  const [info, setInfo] = useState<DemotionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/member/me/recent-demotion")
      .then((r) => r.json())
      .then((data: DemotionInfo) => {
        if (cancelled) return;
        setInfo(data);
        if (data.demoted) {
          const k = `demotion-dismissed-${data.historyId}`;
          if (typeof window !== "undefined" && window.localStorage.getItem(k) === "1") {
            setDismissed(true);
          }
        }
      })
      .catch(() => { /* silent — no banner */ });
    return () => { cancelled = true; };
  }, []);

  if (!info || !info.demoted || dismissed) return null;

  const dismiss = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(`demotion-dismissed-${info.historyId}`, "1");
    }
    setDismissed(true);
  };

  return (
    <div
      className="rounded-2xl px-4 py-3 mb-4 flex items-start gap-3"
      style={{
        background: "rgba(245,158,11,0.10)",
        border: "1px solid rgba(245,158,11,0.25)",
      }}
    >
      <div className="flex-1">
        <p className="text-sm font-semibold" style={{ color: "#fbbf24" }}>
          Your rank has been updated to {info.rankName}
        </p>
        <p className="text-xs mt-0.5" style={{ color: "rgba(251,191,36,0.75)" }}>
          Some class reminders may have been turned off. If this is unexpected, speak to your coach.
        </p>
      </div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="shrink-0 p-1 rounded-lg hover:bg-white/5 transition-colors"
      >
        <X className="w-4 h-4" style={{ color: "rgba(251,191,36,0.75)" }} />
      </button>
    </div>
  );
}
