import { NextResponse } from "next/server";
import { requireApiOwner } from "@/lib/api-authz";
import { listFolders } from "@/lib/google-drive";
import { apiError } from "@/lib/api-error";

export async function GET(req: Request) {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;
  const { searchParams } = new URL(req.url);
  const parentId = searchParams.get("parentId") ?? undefined;
  try {
    const folders = await listFolders(tenantId, parentId);
    return NextResponse.json(folders);
  } catch (e) {
    return apiError("Google Drive operation failed", 500, e, "[drive/folders]");
  }
}
