"use client";

import { useState } from "react";
import { Medal, Flame, Zap, CalendarCheck, Shapes, RotateCcw } from "lucide-react";
import { selectVisibleBadges, type MemberBadge, type BadgeTrack } from "@/lib/member-stats";

// Milestone gold — the #b98a2e family, expressed as rgba components so the
// UI-RULES hex ratchet stays flat. Fill/edge derive from the same hue.
const GOLD_EDGE = "rgba(185,138,46,0.45)";
const GOLD_FILL = "rgba(185,138,46,0.12)";
const GOLD_TEXT = "rgba(212,169,78,1)";

/**
 * The icon is the ONLY thing carrying track identity. Per-track colours were
 * considered and rejected twice over: they would add hex literals against the
 * ratchet, and they would fight the tenant's accent — a gym running #ffe14d or
 * #111111 would get unreadable tiles (UI-RULES §2a).
 */
const TRACK_ICON: Record<BadgeTrack, typeof Medal> = {
  volume: Medal,
  consistency: Flame,
  intensity: Zap,
  tenure: CalendarCheck,
  breadth: Shapes,
  resilience: RotateCcw,
};

const TRACK_LABEL: Record<BadgeTrack, string> = {
  volume: "Classes",
  consistency: "Streaks",
  intensity: "Big weeks",
  tenure: "Time on the mat",
  breadth: "Variety",
  resilience: "Coming back",
};

const TRACK_ORDER: BadgeTrack[] = ["volume", "consistency", "intensity", "tenure", "breadth", "resilience"];

function shortDateGB(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function EarnedTile({ badge, showDescription }: { badge: MemberBadge; showDescription?: boolean }) {
  const Icon = TRACK_ICON[badge.track] ?? Medal;
  return (
    <div
      className="rounded-xl p-2.5 flex flex-col items-center text-center"
      style={{ background: GOLD_FILL, border: `1px solid ${GOLD_EDGE}` }}
    >
      <Icon aria-hidden="true" className="w-4 h-4 mb-1.5" style={{ color: GOLD_TEXT }} />
      <p className="text-[11px] font-semibold leading-tight" style={{ color: "var(--member-text)" }}>{badge.label}</p>
      {badge.earnedAt && (
        <p className="text-[10px] mt-0.5" style={{ color: GOLD_TEXT }}>{shortDateGB(badge.earnedAt)}</p>
      )}
      {showDescription && (
        <p className="text-[10px] mt-0.5 leading-tight" style={{ color: "var(--member-text-muted)" }}>
          {badge.description}
        </p>
      )}
    </div>
  );
}

function LockedTile({ badge }: { badge: MemberBadge }) {
  const Icon = TRACK_ICON[badge.track] ?? Medal;
  return (
    <div
      className="rounded-xl p-2.5 flex flex-col items-center text-center"
      style={{ border: "1.5px dashed var(--member-border)" }}
    >
      <Icon aria-hidden="true" className="w-4 h-4 mb-1.5" style={{ color: "var(--member-inactive)" }} />
      <p className="text-[11px] font-medium leading-tight" style={{ color: "var(--member-text-muted)" }}>{badge.label}</p>
      {badge.progress ? (
        <>
          <p className="text-[10px] mt-0.5 tabular-nums" style={{ color: "var(--member-text-muted)" }}>
            {Math.min(badge.progress.current, badge.progress.target)} of {badge.progress.target} {badge.progress.unit}
          </p>
          {/*
            Decorative only — the line above already states the progress in
            full. The bar is filled with the tenant accent, which can be any
            colour at all (including near-black on this dark shell), so it must
            never be the sole carrier of the information. Do not "fix" its
            contrast by hardcoding a colour: that just breaks a different
            tenant's branding instead (UI-RULES §2a, §8).
          */}
          <div
            aria-hidden="true"
            className="w-full h-0.5 rounded-full mt-1 overflow-hidden"
            style={{ background: "var(--member-border)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.round((badge.progress.current / badge.progress.target) * 100))}%`,
                background: "var(--color-primary)",
              }}
            />
          </div>
        </>
      ) : (
        <p className="text-[10px] mt-0.5 leading-tight" style={{ color: "var(--member-text-muted)" }}>{badge.description}</p>
      )}
    </div>
  );
}

/**
 * Milestones. Earned = filled gold with the real achievement date; locked =
 * dashed outline with live progress. Everything derives from actual attendance
 * rows — no fabricated milestones (UI-RULES §7) — and nothing here touches
 * rank: promotions are the coach's call.
 *
 * By default this shows only what is relevant: what the member has earned, plus
 * the immediate next rung in each track. Without that filter a member on their
 * first class was shown "250 classes — 1 of 250", which is discouraging rather
 * than motivating. `selectVisibleBadges` owns that rule and is unit-tested.
 *
 * "Show all" expands in place rather than opening a sheet — there is no Dialog
 * or Sheet primitive in components/ui yet, hand-rolling an overlay would breach
 * the hand-rolled-overlay ratchet, and the heat strip on this same page already
 * uses tap-to-expand-inline. One interaction idiom per page.
 */
export default function MilestonesCard({ badges }: { badges: MemberBadge[] }) {
  const [showAll, setShowAll] = useState(false);
  const { earned, next, earnedTotal, hiddenCount } = selectVisibleBadges(badges);

  const grouped = TRACK_ORDER.map((track) => ({
    track,
    items: badges.filter((b) => b.track === track),
  })).filter((g) => g.items.length > 0);

  return (
    <div
      className="rounded-2xl border p-4 mb-4"
      style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
    >
      <div className="flex items-baseline justify-between mb-3 gap-3">
        <h2 className="font-semibold text-sm" style={{ color: "var(--member-text)" }}>Milestones</h2>
        {earnedTotal > 0 && (
          <p className="text-[11px] tabular-nums" style={{ color: "var(--member-text-muted)" }}>
            {earnedTotal} earned
          </p>
        )}
      </div>

      {earnedTotal === 0 && !showAll && (
        <p className="text-[11px] mb-2.5 leading-snug" style={{ color: "var(--member-text-muted)" }}>
          Check in to your first class to start earning these.
        </p>
      )}

      {showAll ? (
        <div className="space-y-3">
          {grouped.map(({ track, items }) => (
            <div key={track}>
              <p
                className="text-[10px] font-semibold uppercase tracking-wide mb-1.5"
                style={{ color: "var(--member-text-muted)" }}
              >
                {TRACK_LABEL[track]}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {items.map((b) =>
                  b.earned
                    ? <EarnedTile key={b.id} badge={b} showDescription />
                    : <LockedTile key={b.id} badge={b} />,
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {earned.map((b) => <EarnedTile key={b.id} badge={b} />)}
          {next.map((b) => <LockedTile key={b.id} badge={b} />)}
        </div>
      )}

      {(hiddenCount > 0 || showAll) && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 w-full text-[11px] font-medium rounded-lg py-2 transition-colors"
          style={{ color: "var(--member-text-muted)", border: "1px solid var(--member-border)" }}
        >
          {showAll ? "Show fewer" : `Show all (${badges.length})`}
        </button>
      )}
    </div>
  );
}
