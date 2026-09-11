/**
 * POST /api/upload/delete-orphan
 *
 * Lane 1 iter-1 V-01 [Critical] fix: cleanup endpoint for blobs that were
 * uploaded via POST /api/upload but never persisted to a DB row (e.g. the
 * subsequent `PUT /api/members/[id]/profile-picture` failed). Without this
 * endpoint the blob is permanently orphaned — Vercel Blob has no GC sweep.
 *
 * Security:
 *   - CSRF-guarded.
 *   - Authenticated session required.
 *   - URL is validated to be in the caller's tenant blob prefix
 *     (`tenants/<callerTenantId>/...`). Cross-tenant cleanup is rejected.
 *
 * No DB writes. No audit log on success (this is a routine cleanup that
 * happens on the failure path of another already-audited mutation). Failures
 * are logged to console for ops.
 */
import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/csrf";
import { isVercelBlobUrl } from "@/lib/blob-url";
import { withTenantContext } from "@/lib/prisma-tenant";

export const runtime = "nodejs";

const schema = z.object({
  url: z
    .string()
    .min(1)
    .max(2048)
    // Uploads are private since Bug 3 — their host has no `.public.` label, so
    // the previous bespoke shape check rejected every current blob URL and
    // orphan cleanup silently 400'd. Use the shared allowlist (https-only,
    // anchored to blob.vercel-storage.com) instead.
    .refine(isVercelBlobUrl, { message: "URL must be a Vercel Blob URL" }),
});

export async function POST(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid data", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { url } = parsed.data;

  // Defence in depth: the upload route stores at `tenants/<tenantId>/<id>.<ext>`.
  // Refuse cleanup of blobs that don't carry the caller's tenant prefix in
  // their pathname — prevents a hijacked session from issuing cross-tenant
  // blob deletes.
  const expectedPathPrefix = `/tenants/${session.user.tenantId}/`;
  try {
    const parsedUrl = new URL(url);
    if (!parsedUrl.pathname.startsWith(expectedPathPrefix)) {
      return NextResponse.json(
        { error: "URL is not in your tenant's blob namespace" },
        { status: 403 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // The prefix check above proves same-TENANT, not same-OWNER. Without the
  // check below, any authenticated member could delete any blob belonging to
  // their own club once they learned its URL — another member's photo, the
  // club logo, or a signed waiver image, which is the gym's liability
  // evidence. "Orphan" means unreferenced, so that is what we verify: if any
  // row still points at this blob it is live data, not litter, and the delete
  // is refused. Every column that can hold a blob URL is checked.
  const referenced = await withTenantContext(session.user.tenantId, async (tx) => {
    const [photo, logo, announcement, waiver, attachment, importJob] = await Promise.all([
      tx.memberPhoto.findFirst({ where: { tenantId: session.user.tenantId, url }, select: { id: true } }),
      tx.tenant.findFirst({ where: { id: session.user.tenantId, logoUrl: url }, select: { id: true } }),
      tx.announcement.findFirst({ where: { tenantId: session.user.tenantId, imageUrl: url }, select: { id: true } }),
      tx.signedWaiver.findFirst({ where: { tenantId: session.user.tenantId, signatureImageUrl: url }, select: { id: true } }),
      tx.initiativeAttachment.findFirst({ where: { blobUrl: url, initiative: { tenantId: session.user.tenantId } }, select: { id: true } }),
      tx.importJob.findFirst({ where: { tenantId: session.user.tenantId, fileBlobUrl: url }, select: { id: true } }),
    ]);
    return Boolean(photo ?? logo ?? announcement ?? waiver ?? attachment ?? importJob);
  });

  if (referenced) {
    return NextResponse.json(
      { error: "That file is still in use and was not deleted." },
      { status: 409 },
    );
  }

  try {
    const { del } = await import("@vercel/blob");
    await del(url);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.warn("[upload/delete-orphan] blob delete failed", { url, error: e });
    // Don't surface the underlying error to the client — return 200 anyway
    // since orphan cleanup is best-effort and the next ops sweep can re-try.
    return NextResponse.json({ ok: false, reason: "delete failed" });
  }
}
