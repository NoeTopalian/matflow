// GET /api/blob-image?url=<encoded-blob-url>
//
// Signed-URL proxy for private Vercel Blob images. Requires an authenticated
// session so unauthenticated users cannot enumerate tenant assets, AND that the
// blob sits inside the caller's own tenant prefix — otherwise any logged-in user
// of any gym could mint a signed URL for another gym's member photos.
//
// Session shape: every NextAuth session carries `user.tenantId` (see the
// session() callback in auth.ts). The super-admin/operator console does NOT use
// NextAuth — it authenticates via the separate `matflow_admin` /
// `matflow_op_session` cookies (lib/admin-auth.ts) and never reaches this route.
// Operators who view a gym's assets do so through impersonation, which rewrites
// token.tenantId to the target tenant, so the prefix check below is correct for
// them too. There is therefore no cross-tenant session to exempt.
//
// The response is a 302 redirect to a time-limited Vercel download URL.
// Cache-Control is set to 55 minutes so the browser reuses the redirect
// within the signed URL's 1-hour validity window.

import { NextResponse } from "next/server";
import { head } from "@vercel/blob";
import { auth } from "@/auth";
import { isVercelBlobUrl } from "@/lib/blob-url";

export const runtime = "nodejs";

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
  try {
    if (!new URL(url).pathname.startsWith(expectedPathPrefix)) {
      return NextResponse.json(
        { error: "URL is not in your tenant's blob namespace" },
        { status: 403 },
      );
    }
  } catch {
    return NextResponse.json({ error: "Invalid blob URL" }, { status: 400 });
  }

  try {
    const blob = await head(url);
    return NextResponse.redirect(blob.downloadUrl, {
      status: 302,
      headers: {
        "Cache-Control": "private, max-age=3300",
      },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
