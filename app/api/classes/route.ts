import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination } from "@/lib/pagination";
import { classCreateSchema as createSchema } from "@/lib/schemas/class";
import { NextResponse } from "next/server";

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Hard-cap response size to avoid unbounded reads. Cursor support is opt-in
  // via ?cursor/?take query params; default behaviour returns up to 100 active
  // classes — sufficient for the largest gym we anticipate without forcing
  // existing callers (which expect an array) to change.
  const { take, cursor, skip } = parsePagination(req, { defaultTake: 100, maxTake: 100 });

  try {
    const classes = await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.findMany({
        where: { tenantId: session.user.tenantId, isActive: true },
        include: {
          schedules: { where: { isActive: true }, orderBy: { dayOfWeek: "asc" } },
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
        },
        orderBy: { name: "asc" },
        cursor: cursor ? { id: cursor } : undefined,
        skip,
        take,
      }),
    );
    return NextResponse.json(classes);
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

  const { schedules, ...classData } = parsed.data;

  try {
    const cls = await withTenantContext(session.user.tenantId, (tx) =>
      tx.class.create({
        data: {
          tenantId: session.user.tenantId,
          ...classData,
          schedules: schedules
            ? {
                create: schedules.map((s: typeof schedules[number]) => ({
                  dayOfWeek: s.dayOfWeek,
                  startTime: s.startTime,
                  endTime: s.endTime,
                  startDate: s.startDate ? new Date(s.startDate) : new Date(),
                  endDate: s.endDate ? new Date(s.endDate) : null,
                })),
              }
            : undefined,
        },
        include: {
          schedules: true,
          requiredRank: true,
          maxRank: true,
          coachUser: { select: { id: true, name: true } },
        },
      }),
    );
    return NextResponse.json(cls, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Failed to create class" }, { status: 500 });
  }
}
