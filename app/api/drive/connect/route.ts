import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { buildAuthUrl } from "@/lib/google-drive";

export async function GET() {
  const { tenantId } = await requireOwner();
  try {
    const url = buildAuthUrl(tenantId);
    return NextResponse.json({ url });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to build OAuth URL";
    return NextResponse.json({ error: msg }, { status: 503 });
  }
}
