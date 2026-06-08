import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";

// Lane 1 iter-1 S-01 [Critical] fix: password is now REQUIRED. The previous
// `.optional()` allowed the owner to omit the password and have the server
// generate a random one that was NEVER returned or emailed — locking the new
// staff out permanently. Future feature follow-up: introduce a proper
// InviteToken flow mirroring app/api/members/route.ts so owners can send an
// accept-invite link instead of typing a temp password.
const createSchema = z.object({
  name: z.string().min(1).max(100),
  email: z.string().email(),
  role: z.enum(["manager", "coach", "admin"]),
  password: z.string().min(8),
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
    // Lane 1 iter-1 P-46 fix: per-tenant data must not be cached upstream.
    return NextResponse.json(staff, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (e) {
    console.error("[api/staff GET]", e);
    return NextResponse.json([], {
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}

export async function POST(req: Request) {
  // Lane 1 iter-1 S-03 [High] fix: CSRF guard. Mutation reachable without
  // preflight via multipart/x-www-form-urlencoded; same posture as members POST.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

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
  // Lane 1 iter-1 S-01 fix: password is required by the Zod schema above —
  // no more silent random-fallback that locks the new staff out.
  const passwordHash = await bcrypt.hash(password, 12);

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
      { ...user, mustChangePassword: false },
      { status: 201 }
    );
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A user with that email already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create staff member" }, { status: 500 });
  }
}
