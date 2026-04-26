import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { listFolders } from "@/lib/google-drive";

export async function GET(req: Request) {
  const { tenantId } = await requireOwner();
  const { searchParams } = new URL(req.url);
  const parentId = searchParams.get("parentId") ?? undefined;
  try {
    const folders = await listFolders(tenantId, parentId);
    return NextResponse.json(folders);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to list folders";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
