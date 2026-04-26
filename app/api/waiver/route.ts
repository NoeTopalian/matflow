import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { DEFAULT_WAIVER_TITLE, DEFAULT_WAIVER_CONTENT } from "@/lib/default-waiver";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: { waiverTitle: true, waiverContent: true },
    });

    return NextResponse.json({
      title: tenant?.waiverTitle ?? DEFAULT_WAIVER_TITLE,
      content: tenant?.waiverContent ?? DEFAULT_WAIVER_CONTENT,
      isCustom: !!(tenant?.waiverTitle || tenant?.waiverContent),
    });
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
