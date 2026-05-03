import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomBytes } from "crypto";
import { logAudit } from "@/lib/audit-log";

const createSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(["manager", "coach", "admin"]),
  password: z.string().min(8).optional(),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canView = ["owner", "manager"].includes(session.user.role);
  if (!canView) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const staff = await withTenantContext(session.user.tenantId, (tx) =>
      tx.user.findMany({
        where: { tenantId: session.user.tenantId },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: [{ role: "asc" }, { name: "asc" }],
      }),
    );
    return NextResponse.json(staff);
  } catch {
    return NextResponse.json([]);
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can add staff" }, { status: 403 });

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

  const { name, email, role, password } = parsed.data;
  const rawPassword = password ?? (randomBytes(16).toString("hex") + "Aa1!");
  const passwordHash = await bcrypt.hash(rawPassword, 12);

  try {
    const user = await withTenantContext(session.user.tenantId, (tx) =>
      tx.user.create({
        data: {
          tenantId: session.user.tenantId,
          email,
          name,
          role,
          passwordHash,
        },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      }),
    );

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "staff.invite",
      entityType: "User",
      entityId: user.id,
      metadata: { name: user.name, email: user.email, role: user.role },
      req,
    });
    return NextResponse.json(
      { ...user, mustChangePassword: !password },
      { status: 201 }
    );
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A user with that email already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create staff member" }, { status: 500 });
  }
}
