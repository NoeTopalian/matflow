import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontFamily: z.string().max(200).optional(),
  logoSize: z.enum(["sm", "md", "lg"]).optional(),
  logoUrl: z.string().url().optional().nullable(),
  onboardingCompleted: z.boolean().optional(),
});

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: session.user.tenantId },
      select: {
        id: true,
        name: true,
        slug: true,
        logoUrl: true,
        logoSize: true,
        primaryColor: true,
        secondaryColor: true,
        textColor: true,
        bgColor: true,
        fontFamily: true,
        subscriptionStatus: true,
        subscriptionTier: true,
        createdAt: true,
        _count: {
          select: {
            members: true,
            users: true,
            classes: { where: { isActive: true } },
          },
        },
      },
    });
    if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(tenant);
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can change gym settings" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const tenant = await prisma.tenant.update({
      where: { id: session.user.tenantId },
      data: parsed.data,
    });
    return NextResponse.json(tenant);
  } catch {
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
