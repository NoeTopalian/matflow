/**
 * /dashboard/promotions — owner/manager queue of "ready for promotion"
 * candidates. Live-computed via lib/promotion-candidates.ts on every page
 * load (no cache; gym sizes are small enough that <500ms is the typical
 * cost).
 *
 * Server component: it does the tenant-scoped query and hands the rows to
 * the client `PromotionsList`, which owns the DataTable (the same server
 * page → client list split the members page uses). Each row links to the
 * member detail page where the owner applies the promotion via the existing
 * /api/members/[id]/rank endpoint.
 */
import { requireStaff } from "@/lib/authz";
import { redirect } from "next/navigation";
import { listPromotionCandidates } from "@/lib/promotion-candidates";
import PromotionsList from "@/components/dashboard/PromotionsList";

export const dynamic = "force-dynamic";

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

  return (
    <PromotionsList
      candidates={candidates}
      primaryColor={session!.user.primaryColor}
    />
  );
}
