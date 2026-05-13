import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";

const STAFF_ROLES = ["owner", "manager", "coach", "admin"];

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);
  if (!STAFF_ROLES.includes(session.user.role)) return apiError("Forbidden", 403);

  const tenantId: string = session.user.tenantId;
  const { id: memberId } = await params;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const m = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: { id: true },
      });
      if (!m) return { kind: "not-found" } as const;
      const rows = await tx.memberPhoto.findMany({
        where: { memberId, tenantId },
        orderBy: { uploadedAt: "desc" },
        select: { id: true, url: true, caption: true, kind: true, uploadedAt: true, uploadedByMemberId: true },
      });
      return { kind: "ok", rows } as const;
    });
    if (outcome.kind === "not-found") return apiError("Not found", 404);
    return NextResponse.json(outcome.rows.map((p) => ({
      id: p.id,
      url: p.url,
      caption: p.caption,
      kind: p.kind,
      uploadedAt: p.uploadedAt.toISOString(),
      uploadedByMemberId: p.uploadedByMemberId,
    })));
  } catch (e) {
    return apiError("Failed to list photos", 500, e, "[members/[id]/photos GET]");
  }
}
