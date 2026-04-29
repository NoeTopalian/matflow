import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { randomBytes } from "crypto";

const schema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional(),
  membershipType: z.string().max(60).optional(),
  dateOfBirth: z.string().optional().nullable(),
  accountType: z.enum(["adult", "junior", "kids"]).optional(),
  parentMemberId: z.string().min(1).max(50).optional(),
});

// Synthesised kid emails: kid-{nanoid}@no-login.matflow.local
// Sprint 3 P1 fix: tenantId removed from the email to prevent leakage of internal
// CUID identifiers via logs / CSV exports. Per-tenant uniqueness is still guaranteed
// by @@unique([tenantId, email]) at the schema level. The 16-byte hex nanoid provides
// 2^128 collision resistance — sufficient even when shared across tenants.
function synthesiseKidEmail(): string {
  const nanoid = randomBytes(16).toString("hex");
  return `kid-${nanoid}@no-login.matflow.local`;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Sprint 3 P1 fix: this endpoint exposes member PII (incl. kid synthesised emails),
  // so it must be staff-only. Members and unauthenticated callers cannot list other members.
  const isStaff = ["owner", "manager", "admin", "coach"].includes(session.user.role);
  if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const cursor = searchParams.get("cursor") ?? undefined;
  const rawTake = parseInt(searchParams.get("take") ?? "50", 10);
  const take = Math.min(isNaN(rawTake) || rawTake < 1 ? 50 : rawTake, 200);
  const filter = searchParams.get("filter");

  // Server-side filter pushdown so the chip works across the entire tenant,
  // not just the first page of results.
  const where: { tenantId: string; parentMemberId?: { not: null } } = {
    tenantId: session.user.tenantId,
  };
  if (filter === "kids") where.parentMemberId = { not: null };

  try {
    const members = await prisma.member.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        status: true,
        paymentStatus: true,
        membershipType: true,
        joinedAt: true,
        waiverAccepted: true,
        accountType: true,
        dateOfBirth: true,
        parentMemberId: true,
        hasKidsHint: true,
        memberRanks: {
          take: 1,
          orderBy: { achievedAt: "desc" },
          select: {
            stripes: true,
            achievedAt: true,
            rankSystem: { select: { name: true, color: true, discipline: true } },
          },
        },
      },
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
      take,
      orderBy: { joinedAt: "desc" },
    });

    const nextCursor = members.length === take ? members[members.length - 1].id : null;
    return NextResponse.json({ members, nextCursor });
  } catch {
    return NextResponse.json({ members: [], nextCursor: null });
  }
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canAdd = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canAdd) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const isKid = parsed.data.accountType === "kids" || !!parsed.data.parentMemberId;

  // Kids policy: only owners can create kid sub-accounts.
  if (isKid && session.user.role !== "owner") {
    return apiError("Only owners can create kid sub-accounts", 403);
  }

  // Kids must have a parent. Adults must not.
  let parentMemberId: string | null = null;
  if (isKid) {
    if (!parsed.data.parentMemberId) {
      return apiError("Kid sub-accounts require a parent member", 400);
    }
    const parent = await prisma.member.findFirst({
      where: { id: parsed.data.parentMemberId, tenantId: session.user.tenantId },
      select: { id: true, parentMemberId: true },
    });
    if (!parent) return apiError("Parent member not found in this tenant", 404);
    if (parent.parentMemberId !== null) {
      return apiError("Cannot nest sub-accounts: parent must be top-level", 400);
    }
    parentMemberId = parent.id;
  }

  // Synthesise email server-side for kids — never trust the client field.
  const email = isKid ? synthesiseKidEmail() : parsed.data.email;

  if (!email) return apiError("Email is required for adult members", 400);

  try {
    const member = await prisma.member.create({
      data: {
        tenantId: session.user.tenantId,
        name: parsed.data.name,
        email,
        // Kids: passwordless invariant. Adults: handled via signup flow elsewhere.
        passwordHash: null,
        phone: isKid ? null : parsed.data.phone,
        membershipType: parsed.data.membershipType,
        dateOfBirth: parsed.data.dateOfBirth ? new Date(parsed.data.dateOfBirth) : null,
        accountType: parsed.data.accountType ?? "adult",
        parentMemberId,
      },
    });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: isKid ? "member.create.kid" : "member.create",
      entityType: "Member",
      entityId: member.id,
      metadata: isKid
        ? { name: member.name, parentMemberId, accountType: member.accountType }
        : { name: member.name, email: member.email },
      req,
    });
    return NextResponse.json(member, { status: 201 });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A member with that email already exists" }, { status: 409 });
    }
    return apiError("Failed to create member", 500, e, "[members.POST]");
  }
}
