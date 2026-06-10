// GET /api/blob-image?url=<encoded-blob-url>
//
// Signed-URL proxy for private Vercel Blob images. Requires an authenticated
// session so unauthenticated users cannot enumerate tenant assets.
//
// The response is a 302 redirect to a time-limited Vercel download URL.
// Cache-Control is set to 55 minutes so the browser reuses the redirect
// within the signed URL's 1-hour validity window.

import { NextResponse } from "next/server";
import { head } from "@vercel/blob";
import { auth } from "@/auth";

export const runtime = "nodejs";

const BLOB_HOST_RE = /^https:\/\/[\w-]+(?:\.public)?\.blob\.vercel-storage\.com\//;

export async function GET(req: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url || !BLOB_HOST_RE.test(url)) {
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
