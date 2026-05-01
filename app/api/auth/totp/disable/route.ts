import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * POST /api/auth/totp/disable
 *
 * Fix 4: mandatory TOTP for owner role. Disabling is no longer permitted —
 * the only escape is to change the user's role (manager / coach / etc.) and
 * then disable from that account. Non-owner roles get the same 401 they did
 * before.
 */
export async function POST() {
  const session = await auth();
  if (!session || session.user.role !== "owner") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    { error: "TOTP is required for owner accounts and cannot be disabled." },
    { status: 403 },
  );
}
