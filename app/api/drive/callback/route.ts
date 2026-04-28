import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/authz";
import { exchangeCodeAndStore, verifyState } from "@/lib/google-drive";
import { logAudit } from "@/lib/audit-log";

export async function GET(req: Request) {
  const { tenantId, userId } = await requireOwner();
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) {
    return NextResponse.redirect(new URL(`/dashboard/settings?tab=integrations&error=${error}`, req.url));
  }
  if (!code || !state) {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=integrations&error=missing_params", req.url));
  }

  const verified = verifyState(state);
  if (!verified || verified.tenantId !== tenantId) {
    return NextResponse.redirect(new URL("/dashboard/settings?tab=integrations&error=invalid_state", req.url));
  }

  try {
    await exchangeCodeAndStore({ code, tenantId, userId });
    await logAudit({
      tenantId,
      userId,
      action: "drive.connect",
      entityType: "GoogleDriveConnection",
      entityId: tenantId,
      req,
    });
    return NextResponse.redirect(new URL("/dashboard/settings?tab=integrations&drive=connected", req.url));
  } catch (e) {
    console.error("[drive/callback]", e);
    return NextResponse.redirect(new URL(`/dashboard/settings?tab=integrations&error=oauth_exchange_failed`, req.url));
  }
}
