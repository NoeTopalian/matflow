import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { buildDefaultWaiverTitle, buildDefaultWaiverContent } from "@/lib/default-waiver";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tenant = await withTenantContext(session.user.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: session.user.tenantId },
        select: { name: true, waiverTitle: true, waiverContent: true },
      }),
    );

    return NextResponse.json({
      title: tenant?.waiverTitle ?? buildDefaultWaiverTitle(tenant?.name),
      content: tenant?.waiverContent ?? buildDefaultWaiverContent(tenant?.name),
      isCustom: !!(tenant?.waiverTitle || tenant?.waiverContent),
    });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
