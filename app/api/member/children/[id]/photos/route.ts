/**
 * US-5: kid photo evidence collection.
 *
 * GET  /api/member/children/[id]/photos — list photos for one of the
 *      caller's kids. Cross-parent attempts return 404.
 *
 * POST /api/member/children/[id]/photos — parent uploads a photo of
 *      their own kid. Body: { url: string, caption?: string, kind?:
 *      "evidence" | "milestone" | "promotion" }. The `url` is what the
 *      client received back from /api/upload (a blob URL when Vercel
 *      Blob is healthy, or a data: URL fallback per the prod-Blob
 *      outage noted in CLAUDE.md).
 *
 * Visibility: this route is parent-scoped (parentMemberId guard).
 * Staff-side photo browsing lives on a separate /api/members/[id]/photos
 * surface (out of scope for US-5).
 */

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { z } from "zod";

const ALLOWED_KINDS = ["evidence", "milestone", "promotion"] as const;
const MAX_URL_LENGTH = 3_500_000; // ~3MB — matches the /api/upload data: URL fallback cap

const createSchema = z.object({
  url: z.string().min(1).max(MAX_URL_LENGTH),
  caption: z.string().max(500).optional(),
  kind: z.enum(ALLOWED_KINDS).default("evidence"),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = session.user.memberId as string | undefined;
  if (!parentMemberId) return apiError("Not a member account", 403);
  const tenantId: string = session.user.tenantId;
  const { id: childId } = await params;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      // Parent-of-kid guard up front — if the caller isn't the parent we
      // return 404 instead of "empty photos list" so we don't reveal
      // existence.
      const kid = await tx.member.findFirst({
        where: { id: childId, tenantId, parentMemberId },
        select: { id: true },
      });
      if (!kid) return { kind: "not-found" } as const;

      const rows = await tx.memberPhoto.findMany({
        where: { memberId: childId, tenantId },
        orderBy: { uploadedAt: "desc" },
        select: {
          id: true,
          url: true,
          caption: true,
          kind: true,
          uploadedAt: true,
          uploadedByMemberId: true,
        },
      });
      return { kind: "ok", rows } as const;
    });

    if (outcome.kind === "not-found") return apiError("Not found", 404);

    return NextResponse.json(
      outcome.rows.map((p) => ({
        id: p.id,
        url: p.url,
        caption: p.caption,
        kind: p.kind,
        uploadedAt: p.uploadedAt.toISOString(),
        uploadedByMemberId: p.uploadedByMemberId,
      })),
    );
  } catch (e) {
    return apiError("Failed to list photos", 500, e, "[children/[id]/photos GET]");
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);

  const parentMemberId = session.user.memberId as string | undefined;
  if (!parentMemberId) return apiError("Not a member account", 403);
  const tenantId: string = session.user.tenantId;
  const { id: childId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  }
  const { url, caption, kind } = parsed.data;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const kid = await tx.member.findFirst({
        where: { id: childId, tenantId, parentMemberId },
        select: { id: true, name: true },
      });
      if (!kid) return { kind: "not-found" } as const;

      const photo = await tx.memberPhoto.create({
        data: {
          tenantId,
          memberId: kid.id,
          url,
          caption: caption ?? null,
          kind,
          uploadedByMemberId: parentMemberId,
        },
        select: {
          id: true,
          url: true,
          caption: true,
          kind: true,
          uploadedAt: true,
        },
      });
      return { kind: "ok", photo, kidName: kid.name } as const;
    });

    if (outcome.kind === "not-found") return apiError("Not found", 404);

    await logAudit({
      tenantId,
      userId: session.user.id ?? null,
      action: "member.photo.create",
      entityType: "MemberPhoto",
      entityId: outcome.photo.id,
      metadata: { parentMemberId, childId, kind, childName: outcome.kidName },
      req,
    });

    return NextResponse.json(
      {
        id: outcome.photo.id,
        url: outcome.photo.url,
        caption: outcome.photo.caption,
        kind: outcome.photo.kind,
        uploadedAt: outcome.photo.uploadedAt.toISOString(),
      },
      { status: 201 },
    );
  } catch (e) {
    return apiError("Failed to save photo", 500, e, "[children/[id]/photos POST]");
  }
}
