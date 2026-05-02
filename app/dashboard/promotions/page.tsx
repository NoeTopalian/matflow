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
import { Award, ArrowRight } from "lucide-react";

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
        <div
          className="rounded-2xl border overflow-hidden"
          style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--bd-default)" }}>
                <th className="text-left text-xs font-semibold uppercase tracking-wider px-5 py-3" style={{ color: "var(--tx-4)" }}>Member</th>
                <th className="text-left text-xs font-semibold uppercase tracking-wider px-5 py-3" style={{ color: "var(--tx-4)" }}>Current rank</th>
                <th className="text-left text-xs font-semibold uppercase tracking-wider px-5 py-3" style={{ color: "var(--tx-4)" }}>Attendances since rank</th>
                <th className="text-left text-xs font-semibold uppercase tracking-wider px-5 py-3" style={{ color: "var(--tx-4)" }}>Time at rank</th>
                <th className="text-left text-xs font-semibold uppercase tracking-wider px-5 py-3" style={{ color: "var(--tx-4)" }}>Threshold</th>
                <th className="text-right text-xs font-semibold uppercase tracking-wider px-5 py-3" style={{ color: "var(--tx-4)" }}></th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((c) => (
                <tr key={`${c.memberId}-${c.rankSystemId}`} className="border-b last:border-b-0" style={{ borderColor: "var(--bd-default)" }}>
                  <td className="px-5 py-4 text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
                    {c.memberName}
                  </td>
                  <td className="px-5 py-4 text-sm" style={{ color: "var(--tx-2)" }}>
                    <span className="font-medium">{c.rankSystemName}</span>
                    <span className="ml-1 text-xs" style={{ color: "var(--tx-4)" }}>
                      ({c.discipline}{c.currentStripes > 0 ? ` · ${c.currentStripes} stripe${c.currentStripes > 1 ? "s" : ""}` : ""})
                    </span>
                  </td>
                  <td className="px-5 py-4 text-sm" style={{ color: "var(--tx-2)" }}>
                    <span className="font-mono">{c.attendancesSinceRank}</span>
                    <span className="text-xs ml-1" style={{ color: "var(--tx-4)" }}>/ {c.threshold.minAttendances}</span>
                  </td>
                  <td className="px-5 py-4 text-sm" style={{ color: "var(--tx-2)" }}>
                    <span className="font-mono">{c.monthsAtRank}</span>
                    <span className="text-xs ml-1" style={{ color: "var(--tx-4)" }}>/ {c.threshold.minMonths} mo</span>
                  </td>
                  <td className="px-5 py-4 text-xs" style={{ color: "var(--tx-4)" }}>
                    {c.thresholdSource === "tenant_override" ? "Custom" : c.thresholdSource === "discipline_default" ? "Default" : "Fallback"}
                  </td>
                  <td className="px-5 py-4 text-right">
                    <Link
                      href={`/dashboard/members/${c.memberId}`}
                      className="inline-flex items-center gap-1 text-xs font-semibold transition-colors hover:underline"
                      style={{ color: session!.user.primaryColor }}
                    >
                      Promote
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
