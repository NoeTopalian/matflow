/**
 * /dashboard/promotions — owner/manager queue of "ready for promotion"
 * candidates. Live-computed via lib/promotion-candidates.ts on every page
 * load (no cache; gym sizes are small enough that <500ms is the typical
 * cost).
 *
 * Each row links to the member detail page where the owner can apply
 * the promotion via the existing /api/members/[id]/rank endpoint.
 */
import { requireStaff } from "@/lib/authz";
import { redirect } from "next/navigation";
import Link from "next/link";
import { listPromotionCandidates } from "@/lib/promotion-candidates";
import { Award, ChevronRight, CheckCircle2, Clock } from "lucide-react";
import { AvatarInitials } from "@/components/ui/AvatarInitials";
import { StatusPill } from "@/components/ui/StatusPill";

export const dynamic = "force-dynamic";

function hex(h: string, a: number): string {
  const clean = h.replace("#", "");
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

export default async function PromotionsPage() {
  const { session } = await requireStaff();

  if (!["owner", "manager"].includes(session!.user.role)) {
    redirect("/dashboard");
  }

  let candidates: Awaited<ReturnType<typeof listPromotionCandidates>> = [];
  try {
    candidates = await listPromotionCandidates(session!.user.tenantId);
  } catch (e) {
    console.error("[promotions]", e);
  }

  const primaryColor = session!.user.primaryColor;
  const readyCount = candidates.filter(
    (c) =>
      c.attendancesSinceRank >= c.threshold.minAttendances &&
      c.monthsAtRank >= c.threshold.minMonths,
  ).length;

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <header className="flex items-start gap-4">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
          style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}
        >
          <Award className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="text-2xl font-bold tracking-tight"
              style={{ color: "var(--tx-1)" }}
            >
              Ready for promotion
            </h1>
            {readyCount > 0 && (
              <span
                className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold"
                style={{
                  background: hex(primaryColor, 0.12),
                  color: primaryColor,
                }}
              >
                {readyCount} {readyCount === 1 ? "member" : "members"} ready
              </span>
            )}
          </div>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            Members who have met the attendance and time-at-rank thresholds for
            their current belt.
          </p>
        </div>
      </header>

      {candidates.length === 0 ? (
        /* Empty state */
        <div
          className="rounded-2xl border p-12 flex flex-col items-center text-center gap-4"
          style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
        >
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center"
            style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}
          >
            <Award className="w-8 h-8" />
          </div>
          <div className="space-y-1">
            <p className="text-base font-bold" style={{ color: "var(--tx-1)" }}>
              No promotions due
            </p>
            <p className="text-sm max-w-sm" style={{ color: "var(--tx-3)" }}>
              Members will appear once they hit the attendance and time
              thresholds.
            </p>
          </div>
          <Link
            href="/dashboard/ranks"
            className="text-xs font-medium underline-offset-2 hover:underline"
            style={{ color: primaryColor }}
          >
            Settings → Ranks
          </Link>
        </div>
      ) : (
        <>
          {/* Summary bar */}
          <p className="text-sm" style={{ color: "var(--tx-3)" }}>
            {readyCount} of {candidates.length}{" "}
            {candidates.length === 1 ? "member" : "members"} ready · Click a
            member to promote them.
          </p>

          {/* Candidate cards */}
          <div className="grid grid-cols-1 space-y-3">
            {candidates.map((c) => {
              const attDone =
                c.attendancesSinceRank >= c.threshold.minAttendances;
              const timeDone = c.monthsAtRank >= c.threshold.minMonths;
              const bothDone = attDone && timeDone;
              const stripeSuffix =
                c.currentStripes > 0
                  ? ` · ${c.currentStripes} stripe${c.currentStripes > 1 ? "s" : ""}`
                  : "";

              const attPct = Math.min(
                100,
                Math.round(
                  (c.attendancesSinceRank / c.threshold.minAttendances) * 100,
                ),
              );
              const timePct = Math.min(
                100,
                Math.round((c.monthsAtRank / c.threshold.minMonths) * 100),
              );

              return (
                <Link
                  key={`${c.memberId}-${c.rankSystemId}`}
                  href={`/dashboard/members/${c.memberId}`}
                  className="flex flex-col sm:flex-row items-start sm:items-center gap-4 rounded-2xl border-l-4 border px-4 py-4 transition-colors group"
                  style={{
                    background: "var(--sf-1)",
                    borderLeftColor: bothDone
                      ? primaryColor
                      : "var(--bd-default)",
                    borderColor: "var(--bd-default)",
                    borderLeftWidth: "4px",
                  }}
                >
                  {/* Left: avatar + name */}
                  <div className="flex items-center gap-3 shrink-0 min-w-0 sm:w-48">
                    <AvatarInitials name={c.memberName} color={primaryColor} />
                    <div className="min-w-0">
                      <p
                        className="text-sm font-semibold truncate"
                        style={{ color: "var(--tx-1)" }}
                      >
                        {c.memberName}
                      </p>
                      <p
                        className="text-xs truncate"
                        style={{ color: "var(--tx-4)" }}
                      >
                        {c.rankSystemName} · {c.discipline}
                        {stripeSuffix}
                      </p>
                    </div>
                  </div>

                  {/* Middle: progress bars */}
                  <div className="flex-1 min-w-0 w-full sm:w-auto space-y-2">
                    {/* Attendance bar */}
                    <div className="space-y-1">
                      <div
                        className="flex justify-between text-xs"
                        style={{ color: "var(--tx-3)" }}
                      >
                        <span style={{ color: "var(--tx-4)" }}>Sessions</span>
                        <span>
                          {c.attendancesSinceRank} /{" "}
                          {c.threshold.minAttendances}
                        </span>
                      </div>
                      <div
                        className="h-1.5 rounded-full overflow-hidden"
                        style={{ background: "var(--sf-2)" }}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${attPct}%`,
                            background: hex(primaryColor, attDone ? 1 : 0.6),
                          }}
                        />
                      </div>
                    </div>

                    {/* Time bar */}
                    <div className="space-y-1">
                      <div
                        className="flex justify-between text-xs"
                        style={{ color: "var(--tx-3)" }}
                      >
                        <span style={{ color: "var(--tx-4)" }}>Time</span>
                        <span>
                          {c.monthsAtRank} / {c.threshold.minMonths} mo
                        </span>
                      </div>
                      <div
                        className="h-1.5 rounded-full overflow-hidden"
                        style={{ background: "var(--sf-2)" }}
                      >
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${timePct}%`,
                            background: hex(primaryColor, timeDone ? 1 : 0.6),
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Right: status chip + chevron */}
                  <div className="flex items-center gap-2 shrink-0 self-center">
                    {bothDone ? (
                      <span
                        className="inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold"
                        style={{
                          background: hex(primaryColor, 0.12),
                          color: primaryColor,
                        }}
                      >
                        Ready →
                      </span>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {!attDone && (
                          <StatusPill
                            icon={CheckCircle2}
                            label={`${c.attendancesSinceRank}/${c.threshold.minAttendances}`}
                            bg={hex(primaryColor, 0.1)}
                            color={primaryColor}
                          />
                        )}
                        {!timeDone && (
                          <StatusPill
                            icon={Clock}
                            label={`${c.monthsAtRank}/${c.threshold.minMonths}mo`}
                            bg="rgba(245,158,11,0.1)"
                            color="#f59e0b"
                          />
                        )}
                      </div>
                    )}
                    <ChevronRight
                      className="w-4 h-4 shrink-0"
                      style={{ color: "var(--tx-4)" }}
                    />
                  </div>
                </Link>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
