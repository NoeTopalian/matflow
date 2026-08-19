// GET /api/blob-image?url=<encoded-blob-url>
//
// Authenticated BYTE proxy for private Vercel Blob images. Requires an
// authenticated session so unauthenticated users cannot enumerate tenant
// assets, AND that the blob sits inside the caller's own tenant prefix —
// otherwise any logged-in user of any gym could read another gym's member
// photos.
//
// Session shape: every NextAuth session carries `user.tenantId` (see the
// session() callback in auth.ts). The super-admin/operator console does NOT use
// NextAuth — it authenticates via the separate `matflow_admin` /
// `matflow_op_session` cookies (lib/admin-auth.ts) and never reaches this route.
// Operators who view a gym's assets do so through impersonation, which rewrites
// token.tenantId to the target tenant, so the prefix check below is correct for
// them too. There is therefore no cross-tenant session to exempt.
//
// ── Why this streams instead of redirecting ─────────────────────────────────
// This route used to answer 302 to `head(url).downloadUrl`. That URL carries NO
// credential: @vercel/blob@2.3.3 builds `downloadUrl` as the plain blob URL
// with `?download=1` appended, while its own reader `get()` must send
// `authorization: Bearer <BLOB_READ_WRITE_TOKEN>` (both in dist/index.js).
// Uploads are written `access: "private"` (app/api/upload/route.ts), so a
// browser following that redirect arrived unauthenticated at a private blob and
// every avatar in the product rendered as blank space.
//
// The token therefore has to stay server-side: we fetch the bytes with `get()`
// and stream the response body back through this origin.
//
// Two consequences of serving bytes from OUR origin rather than redirecting to
// Vercel's:
//   1. Content-Type is constrained to `image/*`. A blob declaring `text/html`
//      would previously have executed on blob.vercel-storage.com; served from
//      here it would be same-origin stored XSS. Anything non-image is
//      downgraded to an opaque octet-stream attachment.
//   2. Caching is worth setting properly. Every blob is written with
//      `addRandomSuffix: true`, so a given URL's bytes never change — the
//      response is immutable. `private` keeps it out of shared caches, because
//      the auth and tenant checks above are per-user.

import { NextResponse } from "next/server";
import { get } from "@vercel/blob";
import { auth } from "@/auth";
import { isVercelBlobUrl } from "@/lib/blob-url";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";

// One day in the private browser cache. The bytes behind a given blob URL are
// immutable (addRandomSuffix), so the only thing bounding this is how long a
// revoked member photo may survive in the browser of someone who was allowed
// to see it at the time.
const IMAGE_CACHE_CONTROL = "private, max-age=86400, immutable";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.tenantId) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url || !isVercelBlobUrl(url)) {
    return NextResponse.json({ error: "Invalid blob URL" }, { status: 400 });
  }

  // Every blob this app has ever written to Vercel Blob is stored at
  // `tenants/<tenantId>/…` (true since f57be7a, the commit that introduced
  // Blob at all — see app/api/upload/route.ts and the other put() call sites),
  // so the pathname prefix is the tenant boundary. A URL without that prefix
  // cannot be attributed to a tenant, so it is denied rather than allowed.
  const expectedPathPrefix = `/tenants/${session.user.tenantId}/`;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return NextResponse.json({ error: "Invalid blob URL" }, { status: 400 });
  }
  if (!pathname.startsWith(expectedPathPrefix)) {
    return NextResponse.json(
      { error: "URL is not in your tenant's blob namespace" },
      { status: 403 },
    );
  }

  // The old bare `catch` collapsed three different worlds into one unlogged
  // 404: a Blob outage, an unset or invalid BLOB_READ_WRITE_TOKEN, and a file
  // that genuinely is not there. Nothing reached Sentry, so a store-wide
  // outage looked exactly like a member who had never uploaded a photo
  // (docs/RULES.md §2 — an HTTP error is never an empty state).
  //
  // `get()` separates them for us: it RETURNS null for a missing blob and
  // THROWS for everything else — a missing token throws BlobError "No token
  // found…". So the two branches below are genuinely different failures and
  // are reported as such: 404 for absence, 502 + Sentry (via apiError) for a
  // broken dependency.
  let result: Awaited<ReturnType<typeof get>>;
  try {
    result = await get(url, { access: "private" });
  } catch (e) {
    return apiError("Couldn't load this image. Try again.", 502, e, "[blob-image]", {
      req,
      tenantId: session.user.tenantId,
      userId: session.user.id,
    });
  }

  if (!result) {
    // A database row points at a blob that is not in the store. Worth its own
    // log line: it means an upload half-failed, or a blob was deleted without
    // the row that references it.
    console.warn(`[blob-image] blob missing from store: ${pathname}`);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 304 only happens when the caller sends `ifNoneMatch`, which we do not.
  // Treat a body-less response as a dependency fault rather than quietly
  // answering with an empty image.
  if (result.statusCode !== 200) {
    return apiError(
      "Couldn't load this image. Try again.",
      502,
      new Error(`unexpected statusCode ${result.statusCode} for ${pathname}`),
      "[blob-image]",
      { req, tenantId: session.user.tenantId, userId: session.user.id },
    );
  }

  const declaredType = result.blob.contentType;
  const isImage = declaredType.toLowerCase().startsWith("image/");

  return new NextResponse(result.stream, {
    status: 200,
    headers: {
      "Content-Type": isImage ? declaredType : "application/octet-stream",
      "Content-Disposition": isImage ? "inline" : "attachment",
      "Cache-Control": IMAGE_CACHE_CONTROL,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
