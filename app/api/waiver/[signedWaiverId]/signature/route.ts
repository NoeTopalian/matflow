/**
 * GET /api/waiver/[signedWaiverId]/signature
 *
 * Authed proxy for SignedWaiver signature blobs (Fix 2). The underlying
 * Vercel Blob is technically still public (the SDK at v0.27.3 only supports
 * access:"public") — but we never expose the raw blob URL in any API
 * response or rendered HTML. All reads go through this handler:
 *
 * 1. Auth-check the requester (staff at any role, OR the member themselves)
 * 2. Tenant-scope the lookup so cross-tenant 404s
 * 3. Fetch the blob bytes server-side
 * 4. Stream them back with Cache-Control: private, no-store
 *
 * Result: a leaked client-side URL only points to OUR route, which still
 * requires a valid session to dereference. The blob URL itself never
 * leaves the server, so a stale browser cache / casually-shared URL no
 * longer grants perpetual access.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ signedWaiverId: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { signedWaiverId } = await params;

  // Tenant-scoped lookup. Returns null if cross-tenant — caller gets 404,
  // not 403, so existence is not disclosed.
  const signed = await withTenantContext(session.user.tenantId, (tx) =>
    tx.signedWaiver.findFirst({
      where: { id: signedWaiverId, tenantId: session.user.tenantId },
      select: { signatureImageUrl: true, memberId: true },
    }),
  );
  if (!signed?.signatureImageUrl) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Authorisation: staff (any role above member) OR the member themselves.
  const role = session.user.role;
  const isStaff = role === "owner" || role === "manager" || role === "admin" || role === "coach";
  const sessionMemberId = (session.user as { memberId?: string }).memberId;
  const isMemberSelf = role === "member" && !!sessionMemberId && sessionMemberId === signed.memberId;
  if (!isStaff && !isMemberSelf) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const upstream = await fetch(signed.signatureImageUrl);
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: "Signature unavailable" }, { status: 502 });
    }

    // Best-effort audit log — don't block the response on it.
    void logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "waiver.signature.view",
      entityType: "SignedWaiver",
      entityId: signedWaiverId,
      metadata: { viewerRole: role },
      req,
    });

    return new NextResponse(upstream.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return apiError("Failed to load signature", 500, e, "[waiver.signature.GET]");
  }
}
