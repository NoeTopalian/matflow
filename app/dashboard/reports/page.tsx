import ReportsView from "@/components/dashboard/ReportsView";
import { getReportsData } from "@/lib/reports";
import { requireRole } from "@/lib/authz";

interface Props {
  searchParams: Promise<{ weeks?: string; classId?: string; ageGroup?: string; rate?: string }>;
}

export default async function ReportsPage({ searchParams }: Props) {
  // Audit iter-1-dashboard A4C-1: use centralised authz helper, not raw auth().
  const { session } = await requireRole(["owner", "manager"]);

  // Weeks/class/age-group controls (ReportsView) drive these via the URL so
  // the server page re-queries on every change — no client refetch, no
  // stale-while-revalidate flash. `weeks` clamps 4-24 in lib/reports.ts;
  // an out-of-range or non-numeric value degrades to the 12-week default
  // rather than throwing. classId/ageGroup are validated against the real
  // data in getReportsData (see lib/reports.ts) — a stale value here is
  // dropped there, never applied as a phantom filter.
  const { weeks, classId, ageGroup: rawAgeGroup, rate } = await searchParams;
  const weeksBack = weeks !== undefined ? Number(weeks) : undefined;
  const ageGroup = rawAgeGroup === "adult" || rawAgeGroup === "kids" ? rawAgeGroup : undefined;
  // `rate` (Track G): which attendance-rate DEFINITION is active. An
  // unrecognised/stale value degrades to the default mode inside
  // getReportsData, same pattern as weeks/classId/ageGroup above — never
  // thrown, never a phantom filter.

  // UI-RULES §7: no try/catch here on purpose. This page used to fall back to
  // createEmptyReportsData() on failure, rendering a complete report of zeros
  // that is indistinguishable from a genuinely terrible month — the single
  // most dangerous shape of this bug, because an owner can act on it. A throw
  // now reaches app/dashboard/error.tsx and the owner is told the report
  // couldn't load, with a retry.
  const data = await getReportsData(session.user.tenantId, {
    weeksBack,
    classId,
    ageGroup,
    attendanceRateMode: rate,
  });

  return (
    <ReportsView
      data={data}
      primaryColor={session.user.primaryColor}
    />
  );
}
