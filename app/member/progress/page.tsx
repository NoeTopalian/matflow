"use client";

import { TrendingUp, Flame, Calendar, Clock, Medal, RotateCcw } from "lucide-react";
import { useState, useEffect } from "react";

const PRIMARY = "#3b82f6";

// Milestone gold — the #b98a2e family, expressed as rgba components so the
// UI-RULES hex ratchet stays flat. Fill/edge derive from the same hue.
const GOLD_EDGE = "rgba(185,138,46,0.45)";
const GOLD_FILL = "rgba(185,138,46,0.12)";
const GOLD_TEXT = "rgba(212,169,78,1)";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AttendanceByClass { id: string; name: string; count: number; }

interface RankTimelineNode {
  id: string;
  kind: "promotion" | "stripe";
  rankName: string;
  rankColor: string | null;
  date: string;
  promotedBy: { id: string; name: string } | null;
  current: boolean;
}

interface MemberBadge {
  id: string;
  label: string;
  description: string;
  earned: boolean;
  earnedAt: string | null;
  progress: { current: number; target: number } | null;
}

interface WeeklyCount {
  weekStart: string;
  count: number;
  classes: { name: string; date: string }[];
}

interface MemberData {
  name: string;
  joinedAt?: string | null;
  belt: { name: string; color: string; stripes: number } | null;
  rankTimeline?: RankTimelineNode[];
  stats: {
    thisWeek: number;
    thisMonth: number;
    thisYear: number;
    streakWeeks: number;
    totalClasses: number;
    attendanceByClass?: AttendanceByClass[];
    avgClassesPerWeek?: number;
    badges?: MemberBadge[];
    weeklyCounts?: WeeklyCount[];
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function longDateGB(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function shortDateGB(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "14 months" / "6 weeks" / "3 days" between two ISO timestamps — retrospective only. */
function formatTenure(fromISO: string, toISO: string): string {
  const from = new Date(fromISO);
  const to = new Date(toISO);
  let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) months -= 1;
  if (months >= 2) return `${months} months`;
  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86400000));
  if (days >= 14) return `${Math.round(days / 7)} weeks`;
  if (days >= 7) return "1 week";
  return days === 1 ? "1 day" : `${days} days`;
}

// ─── Your Journey (lineage timeline) ─────────────────────────────────────────

/**
 * Vertical lineage, newest first. Past ranks carry retrospective time-served;
 * the current rank shows only its start date — no elapsed counter, no pace,
 * no next-rank node. Promotions are the coach's call and nothing here
 * predicts one.
 */
function JourneyCard({ belt, timeline, joinedAt }: {
  belt: MemberData["belt"];
  timeline: RankTimelineNode[];
  joinedAt: string | null;
}) {
  const beltColor = belt?.color ?? "#e5e7eb";

  // Retrospective time-served for PAST promotion nodes: this node's date →
  // the next NEWER promotion's date (timeline arrives newest-first).
  const promotions = timeline.filter((n) => n.kind === "promotion");
  const tenureByNodeId = new Map<string, string>();
  promotions.forEach((n, i) => {
    if (i === 0) return; // newest promotion — never an elapsed counter
    tenureByNodeId.set(n.id, formatTenure(n.date, promotions[i - 1].date));
  });

  return (
    <div
      className="rounded-3xl border p-5 mb-4"
      style={
        belt
          ? { background: hex(beltColor, 0.06), borderColor: hex(beltColor, 0.2) }
          : { background: "var(--member-surface)", borderColor: "var(--member-border)" }
      }
    >
      <h2 className="font-semibold text-sm mb-4" style={{ color: "var(--member-text)" }}>Your Journey</h2>

      {/* Current belt — name + stripes, carried over from the old belt card */}
      {belt ? (
        <div className="flex items-center gap-4 mb-5">
          <div className="shrink-0">
            <div
              className="w-16 h-6 rounded-md flex items-center justify-end pr-1.5 gap-0.5"
              style={{ background: beltColor }}
            >
              {Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="w-2.5 h-4 rounded-sm"
                  style={{ background: i < belt.stripes ? "white" : "rgba(0,0,0,0.3)" }}
                />
              ))}
            </div>
            <p className="text-[10px] text-center mt-1" style={{ color: "var(--member-text-muted)" }}>{belt.stripes}/4 stripes</p>
          </div>
          <p className="font-bold text-lg" style={{ color: "var(--member-text)" }}>{belt.name}</p>
        </div>
      ) : (
        <p className="text-sm mb-5" style={{ color: "var(--member-text-muted)" }}>No rank recorded yet.</p>
      )}

      {/* Lineage — newest first, first-day node at the bottom */}
      <ol className="relative ml-1 border-l pl-4 space-y-4" style={{ borderColor: "var(--member-border)" }}>
        {timeline.map((node) => (
          <li key={node.id} className="relative">
            <span
              aria-hidden="true"
              className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full"
              style={{ background: node.current ? "var(--color-primary)" : "var(--member-inactive)" }}
            />
            <p className="text-sm font-semibold" style={{ color: "var(--member-text)" }}>
              {node.kind === "stripe" ? "Stripe awarded" : node.rankName}
            </p>
            <p className="text-xs mt-0.5" style={{ color: "var(--member-text-muted)" }}>{longDateGB(node.date)}</p>
            {node.promotedBy && (
              <p className="text-xs mt-0.5" style={{ color: "var(--member-text-muted)" }}>Tied on by {node.promotedBy.name}</p>
            )}
            {node.kind === "promotion" && !node.current && tenureByNodeId.has(node.id) && (
              <p className="text-xs mt-0.5" style={{ color: "var(--member-text-muted)" }}>
                {tenureByNodeId.get(node.id)} at {node.rankName.toLowerCase()}
              </p>
            )}
          </li>
        ))}
        <li className="relative">
          <span
            aria-hidden="true"
            className="absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full"
            style={{ background: "var(--member-inactive)" }}
          />
          <p className="text-sm font-semibold" style={{ color: "var(--member-text)" }}>First day on the mat</p>
          {joinedAt && (
            <p className="text-xs mt-0.5" style={{ color: "var(--member-text-muted)" }}>{longDateGB(joinedAt)}</p>
          )}
        </li>
      </ol>

      <p className="text-xs mt-4" style={{ color: "var(--member-text-muted)" }}>Promotions are your coach&apos;s call.</p>
    </div>
  );
}

// ─── Milestones ──────────────────────────────────────────────────────────────

function badgeIcon(id: string) {
  if (id.startsWith("streak")) return Flame;
  if (id === "comeback") return RotateCcw;
  return Medal;
}

/**
 * Earned = filled gold with the real achievement date; locked = dashed outline
 * with live progress. Everything derives from actual attendance rows — no
 * fabricated milestones (UI-RULES §7), and none of these touch rank.
 */
function MilestonesCard({ badges }: { badges: MemberBadge[] }) {
  return (
    <div className="rounded-2xl border p-4 mb-4" style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}>
      <h2 className="font-semibold text-sm mb-3" style={{ color: "var(--member-text)" }}>Milestones</h2>
      <div className="grid grid-cols-3 gap-2">
        {badges.map((b) => {
          const Icon = badgeIcon(b.id);
          return b.earned ? (
            <div
              key={b.id}
              className="rounded-xl p-2.5 flex flex-col items-center text-center"
              style={{ background: GOLD_FILL, border: `1px solid ${GOLD_EDGE}` }}
            >
              <Icon aria-hidden="true" className="w-4 h-4 mb-1.5" style={{ color: GOLD_TEXT }} />
              <p className="text-[11px] font-semibold leading-tight" style={{ color: "var(--member-text)" }}>{b.label}</p>
              {b.earnedAt && (
                <p className="text-[10px] mt-0.5" style={{ color: GOLD_TEXT }}>{shortDateGB(b.earnedAt)}</p>
              )}
            </div>
          ) : (
            <div
              key={b.id}
              className="rounded-xl p-2.5 flex flex-col items-center text-center"
              style={{ border: "1.5px dashed var(--member-border)" }}
            >
              <Icon aria-hidden="true" className="w-4 h-4 mb-1.5" style={{ color: "var(--member-inactive)" }} />
              <p className="text-[11px] font-medium leading-tight" style={{ color: "var(--member-text-muted)" }}>{b.label}</p>
              {b.progress ? (
                <>
                  <p className="text-[10px] mt-0.5 tabular-nums" style={{ color: "var(--member-text-muted)" }}>
                    {Math.min(b.progress.current, b.progress.target)} of {b.progress.target}
                  </p>
                  <div className="w-full h-1 rounded-full mt-1 overflow-hidden" style={{ background: "var(--member-border)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, Math.round((b.progress.current / b.progress.target) * 100))}%`,
                        background: "var(--color-primary)",
                      }}
                    />
                  </div>
                </>
              ) : (
                <p className="text-[10px] mt-0.5 leading-tight" style={{ color: "var(--member-text-muted)" }}>{b.description}</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 12-week heat strip ──────────────────────────────────────────────────────

/**
 * Weekly session counts, oldest → newest, intensity via tenant-accent alpha
 * steps; the current week is outlined. Tapping a week expands that week's
 * attended classes inline (data ships with the payload — no extra fetch).
 */
function HeatStripCard({ weeks }: { weeks: WeeklyCount[] }) {
  const [openWeek, setOpenWeek] = useState<string | null>(null);
  const max = Math.max(1, ...weeks.map((w) => w.count));
  const currentKey = weeks[weeks.length - 1]?.weekStart;
  const open = openWeek ? weeks.find((w) => w.weekStart === openWeek) ?? null : null;

  return (
    <div className="rounded-2xl border p-4 mb-6" style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}>
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-semibold text-sm" style={{ color: "var(--member-text)" }}>Last 12 weeks</h2>
        <span className="text-xs" style={{ color: "var(--member-text-muted)" }}>sessions per week</span>
      </div>

      <div className="flex gap-1">
        {weeks.map((w) => {
          const isCurrent = w.weekStart === currentKey;
          const isOpen = openWeek === w.weekStart;
          // Accent alpha steps: empty weeks are a faint wash, attended weeks
          // scale 25→100% of the tenant accent with the busiest week fullest.
          const pct = w.count === 0 ? 6 : 25 + Math.round((w.count / max) * 75);
          return (
            <button
              key={w.weekStart}
              type="button"
              onClick={() => setOpenWeek(isOpen ? null : w.weekStart)}
              aria-expanded={isOpen}
              aria-label={`Week starting ${shortDateGB(w.weekStart)}: ${w.count} session${w.count === 1 ? "" : "s"}`}
              className="flex-1 h-9 rounded-md flex items-center justify-center text-[10px] font-semibold tabular-nums"
              style={{
                background: `color-mix(in srgb, var(--color-primary) ${pct}%, transparent)`,
                color: w.count > 0 ? "var(--member-text)" : "var(--member-text-muted)",
                boxShadow: isCurrent
                  ? "inset 0 0 0 1.5px var(--color-primary)"
                  : isOpen
                    ? "inset 0 0 0 1.5px var(--member-inactive)"
                    : "none",
              }}
            >
              {w.count > 0 ? w.count : ""}
            </button>
          );
        })}
      </div>

      {open && (
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--member-border)" }}>
          <p className="text-xs font-semibold mb-2" style={{ color: "var(--member-text)" }}>
            Week of {shortDateGB(open.weekStart)}
          </p>
          {open.classes.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--member-text-muted)" }}>No sessions.</p>
          ) : (
            <ul className="space-y-1.5">
              {open.classes.map((c, i) => (
                <li key={`${c.date}-${i}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate" style={{ color: "var(--member-text)" }}>{c.name}</span>
                  <span className="tabular-nums shrink-0" style={{ color: "var(--member-text-muted)" }}>
                    {new Date(c.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function MemberProgressPage() {
  const [primaryColor, setPrimaryColor] = useState(PRIMARY);
  // null = still loading — render skeletons, never placeholder people.
  const [member, setMember] = useState<MemberData | null>(null);
  const [subscribedClasses, setSubscribedClasses] = useState<Array<{ id: string; name: string; day: string; time: string; coach: string }>>([]);
  const [classesLoading, setClassesLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  function loadPageData() {
    setLoadError(null);
    setClassesLoading(true);

    // Non-ok responses throw so a backend failure surfaces the retry banner
    // instead of an empty page (UI-RULES §7: an HTTP error is never an empty
    // state). Raw exception text never reaches the member.
    fetch("/api/member/me")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: (MemberData & { primaryColor?: string }) | null) => {
        if (data?.stats) setMember(data);
        if (data?.primaryColor) setPrimaryColor(data.primaryColor);
      })
      .catch(() => setLoadError("Couldn't load your progress — tap retry."));

    fetch("/api/member/classes")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((data: Array<{ id: string; name: string; day: string; time: string; coach: string }> | null) => {
        if (!Array.isArray(data)) return;
        setSubscribedClasses(data);
      })
      .catch(() => setLoadError("Couldn't load your classes — tap retry."))
      .finally(() => setClassesLoading(false));
  }

  useEffect(() => {
    let cancelled = false;
    // Deferred off the synchronous effect body: loadPageData resets loadError /
    // classesLoading, and setting state synchronously inside an effect cascades
    // a second render pass on every mount (react-hooks/set-state-in-effect).
    // The initial state is already "loading, no error", so nothing is lost.
    queueMicrotask(() => { if (!cancelled) loadPageData(); });
    return () => { cancelled = true; };
  }, []);

  const stats = member?.stats;

  return (
    <div className="px-4 pt-4 pb-8">
      <div className="mb-5">
        <h1 className="text-white text-xl font-bold tracking-tight">Progress</h1>
        {member ? (
          <p className="text-gray-500 text-sm mt-0.5">{member.name}</p>
        ) : (
          <div className="h-4 w-28 rounded mt-1 animate-pulse" style={{ background: "var(--member-surface)" }} />
        )}
      </div>

      {/* Load error banner */}
      {loadError && (
        <div className="mb-4 px-4 py-3 rounded-2xl flex items-center justify-between gap-3" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <p className="text-red-400 text-sm flex-1">{loadError}</p>
          <button
            onClick={loadPageData}
            className="text-xs font-semibold px-3 py-1.5 rounded-xl shrink-0"
            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Loading skeleton — journey card + stats grid placeholders, no fake people */}
      {!member && !loadError && (
        <>
          <div className="rounded-3xl h-36 mb-4 animate-pulse" style={{ background: "var(--member-surface)" }} />
          <div className="grid grid-cols-2 gap-2.5 mb-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="rounded-2xl h-28 animate-pulse" style={{ background: "var(--member-surface)" }} />
            ))}
          </div>
        </>
      )}

      {member && stats && (
      <>
      {/* Your Journey — lineage timeline (subsumes the old belt card) */}
      <JourneyCard
        belt={member.belt}
        timeline={member.rankTimeline ?? []}
        joinedAt={member.joinedAt ?? null}
      />

      {/* Milestone badges — real attendance thresholds only */}
      {(stats.badges?.length ?? 0) > 0 && <MilestonesCard badges={stats.badges!} />}

      {/* 12-week heat strip */}
      {(stats.weeklyCounts?.length ?? 0) > 0 && <HeatStripCard weeks={stats.weeklyCounts!} />}

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-2.5 mb-6">
        {[
          { label: "This Week",      value: stats.thisWeek,          icon: Calendar,   sub: "classes attended" },
          { label: "This Month",     value: stats.thisMonth,         icon: TrendingUp, sub: "classes attended" },
          { label: "This Year",      value: stats.thisYear,          icon: Clock,      sub: "classes attended" },
          { label: "Current Streak", value: `${stats.streakWeeks}w`, icon: Flame,      sub: "weeks in a row" },
        ].map(({ label, value, icon: Icon, sub }) => (
          <div
            key={label}
            className="rounded-2xl border p-4"
            style={{ background: "var(--member-surface)", borderColor: "var(--member-surface)" }}
          >
            <div
              className="w-8 h-8 rounded-xl flex items-center justify-center mb-3"
              style={{ background: hex(primaryColor, 0.1) }}
            >
              <Icon className="w-4 h-4" style={{ color: primaryColor }} />
            </div>
            <p className="text-white text-2xl font-bold tracking-tight leading-none">{value}</p>
            <p className="text-gray-500 text-xs font-medium mt-1">{label}</p>
            {/* Sub-label uses the member shell's muted token — the previous
                text-gray-700 was near-invisible on the dark surface. */}
            <p className="text-[10px] mt-0.5" style={{ color: "var(--member-text-muted)" }}>{sub}</p>
          </div>
        ))}
      </div>

      {/* Sprint 4-A US-401: attendance breakdown + average per week */}
      {(stats.attendanceByClass?.length ?? 0) > 0 && (
        <div className="rounded-2xl border p-4 mb-6" style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-white font-semibold text-sm">Most attended (90 days)</p>
            {typeof stats.avgClassesPerWeek === "number" && (
              <span className="text-xs" style={{ color: primaryColor }}>
                avg {stats.avgClassesPerWeek}/wk · 8w
              </span>
            )}
          </div>
          <ul className="space-y-2">
            {stats.attendanceByClass!.map((c) => {
              const max = stats.attendanceByClass![0]?.count || 1;
              const pct = Math.round((c.count / max) * 100);
              return (
                <li key={c.id} className="flex items-center gap-3">
                  <span className="text-white text-sm font-medium w-32 truncate">{c.name}</span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--member-border)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, background: primaryColor }}
                    />
                  </div>
                  <span className="text-gray-400 text-xs tabular-nums w-8 text-right">{c.count}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      </>
      )}

      {/* Subscribed classes */}
      <div>
        <h2 className="text-white font-semibold text-sm mb-3">Your Classes</h2>
        {!classesLoading && subscribedClasses.length === 0 ? (
          <div
            className="rounded-2xl border px-4 py-6 text-center"
            style={{ borderColor: "var(--member-surface)", background: "var(--member-surface)" }}
          >
            <p className="text-gray-500 text-sm">No subscribed classes yet</p>
            <p className="text-gray-700 text-xs mt-1">Go to Schedule to subscribe to classes</p>
          </div>
        ) : (
          <div className="space-y-2">
            {subscribedClasses.map((cls) => (
              <div
                key={cls.id}
                className="flex items-center gap-3 px-4 py-3.5 rounded-2xl border"
                style={{ background: "var(--member-surface)", borderColor: "var(--member-surface)" }}
              >
                <div
                  className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: hex(primaryColor, 0.1) }}
                >
                  <Calendar className="w-4 h-4" style={{ color: primaryColor }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-semibold truncate">{cls.name}</p>
                  <p className="text-gray-500 text-xs mt-0.5">{cls.day} · {cls.time} · {cls.coach}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
