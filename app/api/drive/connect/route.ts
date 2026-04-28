import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { buildAuthUrl } from "@/lib/google-drive";
import { apiError } from "@/lib/api-error";

export async function GET() {
  const { tenantId } = await requireOwner();
  try {
    const url = buildAuthUrl(tenantId);
    return NextResponse.json({ url });
  } catch (e) {
    return apiError("Google Drive operation failed", 503, e, "[drive/connect]");
  }
}
