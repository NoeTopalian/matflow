import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { NextResponse } from "next/server";
import { z } from "zod";

const createSchema = z.object({
  discipline: z.string().min(1).max(60),
  name: z.string().min(1).max(60),
  order: z.number().int().min(0).max(999),
  color: z.string().max(20).optional(),
  stripes: z.number().int().min(0).max(10).optional(),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const ranks = await withTenantContext(session.user.tenantId, (tx) =>
      tx.rankSystem.findMany({
        where: { tenantId: session.user.tenantId },
        orderBy: [{ discipline: "asc" }, { order: "asc" }],
      }),
    );
    return NextResponse.json(ranks);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = ["owner", "manager"].includes(session.user.role);
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const rank = await withTenantContext(session.user.tenantId, (tx) =>
      tx.rankSystem.create({
        data: {
          tenantId: session.user.tenantId,
          discipline: parsed.data.discipline,
          name: parsed.data.name,
          order: parsed.data.order,
          color: parsed.data.color,
          stripes: parsed.data.stripes ?? 0,
        },
      }),
    );
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "rank.created",
      entityType: "RankSystem",
      entityId: rank.id,
      metadata: { discipline: rank.discipline, name: rank.name, order: rank.order },
      req,
    });
    return NextResponse.json(rank, { status: 201 });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json(
        { error: "A rank with that order already exists in this discipline" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Failed to create rank" }, { status: 500 });
  }
}
