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
};

async function getRanks(tenantId: string): Promise<RankRow[]> {
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.rankSystem.findMany({
      where: { tenantId },
      orderBy: [{ discipline: "asc" }, { order: "asc" }],
    }),
  );
  return rows.map((r) => ({
    id: r.id,
    discipline: r.discipline,
    name: r.name,
    order: r.order,
    color: r.color,
    stripes: r.stripes,
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
