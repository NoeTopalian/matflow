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

export default async function PromotionsPage() {
  const { session } = await requireStaff();

  // Owner / manager only — coaches see this in the future via a softer
  // surface; for now route them away.
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

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <header className="flex items-start gap-4">
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0"
          style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}
        >
          <Award className="w-6 h-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--tx-1)" }}>
            Ready for promotion
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            Members who have met the attendance + time-at-rank thresholds for their current belt.
            {" "}
            <span style={{ color: "var(--tx-4)" }}>
              Defaults: 50 attendances + 6 months for BJJ stripes; 30 + 6 for other disciplines.
              Override per discipline in Settings → Ranks (coming soon).
            </span>
          </p>
        </div>
      </header>

      {candidates.length === 0 ? (
        <div
          className="rounded-2xl border p-8 text-center"
          style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
        >
          <p className="text-sm" style={{ color: "var(--tx-3)" }}>
            No members are currently due for promotion. Check back as your members log more attendances.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {candidates.map((c) => {
            const attDone = c.attendancesSinceRank >= c.threshold.minAttendances;
            const timeDone = c.monthsAtRank >= c.threshold.minMonths;
            const stripeSuffix = c.currentStripes > 0
              ? ` · ${c.currentStripes} stripe${c.currentStripes > 1 ? "s" : ""}`
              : "";
            return (
              <Link
                key={`${c.memberId}-${c.rankSystemId}`}
                href={`/dashboard/members/${c.memberId}`}
                className="flex items-center gap-4 rounded-2xl border px-4 py-3.5 transition-colors group"
                style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
              >
                <AvatarInitials name={c.memberName} color={primaryColor} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>
                    {c.memberName}
                  </p>
                  <p className="text-xs truncate" style={{ color: "var(--tx-4)" }}>
                    {c.rankSystemName} · {c.discipline}{stripeSuffix}
                  </p>
                </div>
                <div className="hidden sm:flex items-center gap-2 shrink-0">
                  <StatusPill
                    icon={CheckCircle2}
                    label={`${c.attendancesSinceRank} / ${c.threshold.minAttendances}`}
                    bg={attDone ? "rgba(16,185,129,0.12)" : "rgba(96,165,250,0.12)"}
                    color={attDone ? "#10b981" : "#60a5fa"}
                  />
                  <StatusPill
                    icon={Clock}
                    label={`${c.monthsAtRank} / ${c.threshold.minMonths} mo`}
                    bg={timeDone ? "rgba(16,185,129,0.12)" : "rgba(245,158,11,0.12)"}
                    color={timeDone ? "#10b981" : "#f59e0b"}
                  />
                </div>
                <span
                  className="hidden sm:inline-flex items-center gap-1 text-xs font-semibold transition-opacity group-hover:opacity-100 opacity-80"
                  style={{ color: primaryColor }}
                >
                  Promote
                </span>
                <ChevronRight className="w-4 h-4 shrink-0" style={{ color: "var(--tx-4)" }} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
