import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { buildAuthUrl } from "@/lib/google-drive";
import { apiError } from "@/lib/api-error";

export async function GET() {
  const { tenantId } = await requireOwner();

  // Sprint 5 US-502: surface specific missing-env-var error instead of the
  // generic 503 from the buildAuthUrl catch — the owner needs to know
  // which Vercel env var to set.
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return apiError(
      "Google Drive not configured. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.",
      503,
      undefined,
      "[drive/connect]",
    );
  }

  try {
    const url = buildAuthUrl(tenantId);
    return NextResponse.json({ url });
  } catch (e) {
    return apiError("Google Drive operation failed", 503, e, "[drive/connect]");
  }
}
