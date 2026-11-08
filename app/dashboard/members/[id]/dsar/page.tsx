import { redirect } from "next/navigation";
import { requireRole } from "@/lib/authz";

/**
 * Data export and erasure moved to Settings → Data requests (PR 3, 6 Nov 2026;
 * Noe: "only the owner can delete specific user data under request and this
 * should appear under settings of owner"). This old address forwards the
 * owner there with the member already picked; anyone else is sent to the
 * dashboard by requireRole, as before.
 */
export default async function MemberDsarPage({ params }: { params: Promise<{ id: string }> }) {
  await requireRole(["owner"]);
  const { id } = await params;
  redirect(`/dashboard/settings?tab=requests&member=${encodeURIComponent(id)}`);
}
