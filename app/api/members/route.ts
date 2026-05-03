import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { parsePagination, nextCursorFor } from "@/lib/pagination";
import { memberCreateSchema } from "@/lib/schemas/member";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { sendEmail } from "@/lib/email";
import { randomBytes } from "crypto";
import { hashToken } from "@/lib/token-hash";
import { getBaseUrl } from "@/lib/env-url";

// LB-003: invite tokens for adult members live for 7 days. Kids never get a
// token (they're passwordless by design — parent manages the account).
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function buildInviteUrl(req: Request, token: string) {
  // Prefer NEXTAUTH_URL in production; fall back to the request origin in dev
  // so local testing doesn't require the env var to be set.
  const base = getBaseUrl(req);
  return `${base}/login/accept-invite?token=${encodeURIComponent(token)}`;
}

const schema = memberCreateSchema;

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
  const { take, cursor, skip } = parsePagination(searchParams, { defaultTake: 50, maxTake: 100 });
  const filter = searchParams.get("filter");

  // Server-side filter pushdown so the chip works across the entire tenant,
  // not just the first page of results.
  const where: { tenantId: string; parentMemberId?: { not: null } } = {
    tenantId: session.user.tenantId,
  };
  if (filter === "kids") where.parentMemberId = { not: null };

  try {
    const members = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findMany({
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
        skip,
        take,
        orderBy: { joinedAt: "desc" },
      }),
    );

    return NextResponse.json({ members, nextCursor: nextCursorFor(members, take) });
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
    const parent = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.findFirst({
        where: { id: parsed.data.parentMemberId, tenantId: session.user.tenantId },
        select: { id: true, parentMemberId: true },
      }),
    );
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
    const member = await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.create({
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
      }),
    );
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

    // LB-003 (audit H8): adult members created by staff need a way to log in.
    // Mint a one-time invite token, send the email, and return the URL so the
    // owner has a fallback they can copy if email delivery fails. Kids are
    // passwordless by design — skip the invite path for them.
    let inviteUrl: string | null = null;
    if (!isKid) {
      try {
        // Fix 1: persist HMAC of the token, not the raw value — see lib/token-hash.ts.
        // The raw token goes in the invite email + URL; the DB stores only the hash.
        const token = randomBytes(24).toString("hex");
        const tenant = await withTenantContext(session.user.tenantId, async (tx) => {
          await tx.magicLinkToken.create({
            data: {
              tenantId: session.user.tenantId,
              email,
              tokenHash: hashToken(token),
              purpose: "first_time_signup",
              expiresAt: new Date(Date.now() + INVITE_TOKEN_TTL_MS),
            },
          });
          // Look up gym name for the email subject inside the same transaction.
          return tx.tenant.findUnique({
            where: { id: session.user.tenantId },
            select: { name: true },
          });
        });
        inviteUrl = buildInviteUrl(req, token);
        await sendEmail({
          tenantId: session.user.tenantId,
          templateId: "invite_member",
          to: email,
          vars: {
            memberName: member.name,
            gymName: tenant?.name ?? "your gym",
            link: inviteUrl,
          },
        });
      } catch (e) {
        // Token / email failure must not break the member creation flow.
        // The owner still gets back the new Member row; inviteUrl will be null
        // and they can resend the invite later from the member detail page.
        console.error("[members.POST] invite token / email failed", e);
      }
    }

    return NextResponse.json({ ...member, inviteUrl }, { status: 201 });
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A member with that email already exists" }, { status: 409 });
    }
    return apiError("Failed to create member", 500, e, "[members.POST]");
  }
}
