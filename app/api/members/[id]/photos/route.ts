import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";
import { isVercelBlobUrl } from "@/lib/blob-url";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

const STAFF_ROLES = ["owner", "manager", "coach", "admin"];

// Accept a Vercel Blob URL or an inline data:image/(png|jpeg|webp);base64 URL
// (the upload route resizes member photos to ≤1600px WebP and falls back to a
// base64 data URL when Blob is unavailable). Cap covers a resized photo.
const photoUrlSchema = z
  .string()
  .min(1)
  .max(2_500_000)
  .refine(
    (s) =>
      s.startsWith("data:image/png;base64,") ||
      s.startsWith("data:image/jpeg;base64,") ||
      s.startsWith("data:image/webp;base64,") ||
      isVercelBlobUrl(s),
    { message: "URL must be a Vercel Blob URL or a data:image/(png|jpeg|webp);base64 URL" },
  );

const postSchema = z.object({
  url: photoUrlSchema,
  caption: z.string().max(300).optional().nullable(),
});

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);
  if (!STAFF_ROLES.includes(session.user.role)) return apiError("Forbidden", 403);

  const tenantId: string = session.user.tenantId;
  const { id: memberId } = await params;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const m = await tx.member.findFirst({
        where: { id: memberId, tenantId },
        select: { id: true },
      });
      if (!m) return { kind: "not-found" } as const;
      const rows = await tx.memberPhoto.findMany({
        where: { memberId, tenantId },
        orderBy: { uploadedAt: "desc" },
        select: { id: true, url: true, caption: true, kind: true, uploadedAt: true, uploadedByMemberId: true },
      });
      return { kind: "ok", rows } as const;
    });
    if (outcome.kind === "not-found") return apiError("Not found", 404);
    return NextResponse.json(outcome.rows.map((p) => ({
      id: p.id,
      url: p.url,
      caption: p.caption,
      kind: p.kind,
      uploadedAt: p.uploadedAt.toISOString(),
      uploadedByMemberId: p.uploadedByMemberId,
    })));
  } catch (e) {
    return apiError("Failed to list photos", 500, e, "[members/[id]/photos GET]");
  }
}

// POST — staff attaches an image to a member's account (a gallery photo,
// kind="evidence"). The image was already uploaded via POST /api/upload
// (purpose=member-photo); this persists the returned URL.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);
  if (!STAFF_ROLES.includes(session.user.role)) return apiError("Forbidden", 403);

  const tenantId: string = session.user.tenantId;
  const { id: memberId } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError("Invalid JSON", 400);
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const m = await tx.member.findFirst({ where: { id: memberId, tenantId }, select: { id: true } });
      if (!m) return { kind: "not-found" } as const;
      const photo = await tx.memberPhoto.create({
        data: {
          tenantId,
          memberId,
          url: parsed.data.url,
          caption: parsed.data.caption ?? null,
          kind: "evidence",
        },
        select: { id: true, url: true, caption: true, kind: true, uploadedAt: true },
      });
      return { kind: "ok", photo } as const;
    });
    if (outcome.kind === "not-found") return apiError("Not found", 404);

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "member.photo.add",
      entityType: "Member",
      entityId: memberId,
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
    return apiError("Failed to add photo", 500, e, "[members/[id]/photos POST]");
  }
}

// DELETE ?photoId=… — staff removes a member gallery photo. The profile
// picture has its own route (a guard refuses kind="profile" here).
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;

  const session = await auth();
  if (!session?.user) return apiError("Unauthorized", 401);
  if (!STAFF_ROLES.includes(session.user.role)) return apiError("Forbidden", 403);

  const tenantId: string = session.user.tenantId;
  const { id: memberId } = await params;
  const photoId = new URL(req.url).searchParams.get("photoId");
  if (!photoId) return apiError("photoId required", 400);

  try {
    const removed = await withTenantContext(tenantId, async (tx) => {
      const p = await tx.memberPhoto.findFirst({
        where: { id: photoId, memberId, tenantId },
        select: { id: true, url: true, kind: true },
      });
      if (!p) return null;
      if (p.kind === "profile") throw new Error("use_profile_route");
      await tx.memberPhoto.delete({ where: { id: p.id } });
      return p;
    });
    if (!removed) return apiError("Not found", 404);

    // Best-effort blob cleanup (no-op for inline data: URLs).
    if (removed.url.startsWith("https://")) {
      try {
        const { del } = await import("@vercel/blob");
        await del(removed.url);
      } catch (e) {
        console.warn("[members/[id]/photos DELETE] blob cleanup failed", e);
      }
    }

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "member.photo.remove",
      entityType: "Member",
      entityId: memberId,
      req,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof Error && e.message === "use_profile_route") {
      return apiError("Use the profile-picture control to change the profile photo", 400);
    }
    return apiError("Failed to remove photo", 500, e, "[members/[id]/photos DELETE]");
  }
}
