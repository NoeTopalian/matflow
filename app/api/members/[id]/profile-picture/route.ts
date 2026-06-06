/**
 * PUT    /api/members/[id]/profile-picture  { url }   → upsert MemberPhoto kind='profile'
 * DELETE /api/members/[id]/profile-picture            → remove profile picture row
 *
 * feat/member-profile-pictures Track A Phase A2.
 *
 * Auth:
 *   - Staff (owner | manager | coach | admin) can set/clear ANY member in their tenant.
 *   - Members can set/clear their OWN profile picture (session.user.memberId === id).
 *
 * Idempotency:
 *   - Upsert keyed on (tenantId, memberId, kind='profile'). The partial
 *     unique index from migration 20260606100000 guarantees at most one row.
 *   - Concurrent PUTs converge: last-writer-wins on `url`, both audit-logged.
 *
 * The URL must be a Vercel Blob URL the caller obtained from POST /api/upload
 * with purpose=profile-pic. We do NOT re-validate the bytes (the upload route
 * already did magic-byte + sharp processing); we DO validate the URL host so
 * a malicious caller can't point the profile picture at arbitrary origins.
 */
import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";

export const runtime = "nodejs";

const STAFF_ROLES = ["owner", "manager", "coach", "admin"] as const;

// Vercel Blob URLs are https://*.public.blob.vercel-storage.com/<path>. We
// also accept data: URLs (the upload route falls back to base64 when blob
// is unconfigured in dev) and the same-origin /api/blob path for tests.
const URL_SCHEMA = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (s) =>
      s.startsWith("data:image/") ||
      /^https:\/\/[\w-]+\.public\.blob\.vercel-storage\.com\//.test(s) ||
      s.startsWith("/api/blob/"),
    { message: "URL must be a Vercel Blob URL, a data:image/* URL, or a same-origin /api/blob path." },
  );

const putSchema = z.object({ url: URL_SCHEMA });

async function authoriseTarget(
  targetMemberId: string,
): Promise<
  | { ok: true; tenantId: string; userId: string; isSelf: boolean }
  | { ok: false; response: NextResponse }
> {
  const session = await auth();
  if (!session?.user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const tenantId = session.user.tenantId;
  const userId = session.user.id;
  const callerMemberId = (session.user as { memberId?: string }).memberId ?? null;
  const callerRole = session.user.role;
  const isStaff = STAFF_ROLES.includes(callerRole as (typeof STAFF_ROLES)[number]);
  const isSelf = callerMemberId !== null && callerMemberId === targetMemberId;

  if (!isStaff && !isSelf) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  // Verify the target member belongs to this tenant.
  const member = await withTenantContext(tenantId, (tx) =>
    tx.member.findFirst({
      where: { id: targetMemberId, tenantId },
      select: { id: true },
    }),
  );
  if (!member) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Member not found in this gym" }, { status: 404 }),
    };
  }

  return { ok: true, tenantId, userId, isSelf };
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { id: memberId } = await params;
  const authz = await authoriseTarget(memberId);
  if (!authz.ok) return authz.response;
  const { tenantId, userId, isSelf } = authz;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const url = parsed.data.url;

  try {
    const row = await withTenantContext(tenantId, async (tx) => {
      // Upsert via find + (update | create). Prisma upsert needs a unique
      // key — our partial unique index isn't a Prisma-recognised composite,
      // so we drive the upsert manually inside the transaction. The partial
      // unique still backs the create() so a concurrent racing write surfaces
      // as P2002, which we catch and retry as an update.
      const existing = await tx.memberPhoto.findFirst({
        where: { tenantId, memberId, kind: "profile" },
        select: { id: true, url: true },
      });
      if (existing) {
        return tx.memberPhoto.update({
          where: { id: existing.id },
          data: { url, uploadedAt: new Date() },
          select: { id: true, url: true, uploadedAt: true },
        });
      }
      try {
        return await tx.memberPhoto.create({
          data: {
            tenantId,
            memberId,
            url,
            kind: "profile",
            uploadedByMemberId: isSelf ? memberId : null,
          },
          select: { id: true, url: true, uploadedAt: true },
        });
      } catch (e: unknown) {
        if ((e as { code?: string }).code === "P2002") {
          // Lost the race to a concurrent create — re-resolve and update.
          const winner = await tx.memberPhoto.findFirst({
            where: { tenantId, memberId, kind: "profile" },
            select: { id: true },
          });
          if (!winner) throw e;
          return tx.memberPhoto.update({
            where: { id: winner.id },
            data: { url, uploadedAt: new Date() },
            select: { id: true, url: true, uploadedAt: true },
          });
        }
        throw e;
      }
    });

    await logAudit({
      tenantId,
      userId,
      action: "member.profile_picture.set",
      entityType: "Member",
      entityId: memberId,
      metadata: { byRole: isSelf ? "self" : "staff" },
      req,
    });

    return NextResponse.json({
      profilePictureUrl: row.url,
      updatedAt: row.uploadedAt.toISOString(),
    });
  } catch (e) {
    console.error("[profile-picture] PUT failed", e);
    return NextResponse.json({ error: "Failed to set profile picture" }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const { id: memberId } = await params;
  const authz = await authoriseTarget(memberId);
  if (!authz.ok) return authz.response;
  const { tenantId, userId, isSelf } = authz;

  try {
    const removed = await withTenantContext(tenantId, async (tx) => {
      const existing = await tx.memberPhoto.findFirst({
        where: { tenantId, memberId, kind: "profile" },
        select: { id: true, url: true },
      });
      if (!existing) return null;
      await tx.memberPhoto.delete({ where: { id: existing.id } });
      return existing;
    });

    // Best-effort blob deletion. Failure does NOT fail the API — the row is
    // already gone from the DB and the blob will eventually be orphaned.
    // Vercel Blob has no GC sweep; orphan cleanup is a future feature-follow-up.
    if (removed && removed.url.startsWith("https://")) {
      try {
        const { del } = await import("@vercel/blob");
        await del(removed.url);
      } catch (e) {
        console.warn("[profile-picture] DELETE: blob cleanup failed", e);
      }
    }

    await logAudit({
      tenantId,
      userId,
      action: "member.profile_picture.clear",
      entityType: "Member",
      entityId: memberId,
      metadata: { byRole: isSelf ? "self" : "staff", removed: removed !== null },
      req,
    });

    return NextResponse.json({ profilePictureUrl: null });
  } catch (e) {
    console.error("[profile-picture] DELETE failed", e);
    return NextResponse.json({ error: "Failed to clear profile picture" }, { status: 500 });
  }
}
