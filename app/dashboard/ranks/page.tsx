import { requireRole } from "@/lib/authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import RanksManager from "@/components/dashboard/RanksManager";

export type RankRow = {
  id: string;
  discipline: string;
  name: string;
  order: number;
  color: string | null;
  stripes: number;
  /**
   * Promotion requirements from the 1:1 RankRequirement row. Null when the
   * gym has never configured one — the table renders "—" rather than showing
   * the schema defaults, which would be fabricated data (UI-RULES §7).
   */
  minAttendances: number | null;
  minMonths: number | null;
};

async function getRanks(tenantId: string): Promise<RankRow[]> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.rankSystem.findMany({
      where: { tenantId },
      orderBy: [{ discipline: "asc" }, { order: "asc" }],
      include: { requirements: true },
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    discipline: r.discipline,
    name: r.name,
    order: r.order,
    color: r.color,
    stripes: r.stripes,
    // `requirements` is declared as a list but RankRequirement.rankSystemId is
    // @unique, so it holds at most one row.
    minAttendances: r.requirements[0]?.minAttendances ?? null,
    minMonths: r.requirements[0]?.minMonths ?? null,
  }));
}

export default async function RanksPage() {
  const { session } = await requireRole(["owner", "manager", "coach"]);

  let ranks: RankRow[] = [];
  try {
    ranks = await getRanks(session!.user.tenantId);
  } catch {
    // DB not connected
  }

  return (
    <RanksManager
      initialRanks={ranks}
      primaryColor={session!.user.primaryColor}
      role={session!.user.role}
    />
  );
}
