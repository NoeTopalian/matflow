import { auth } from "@/auth";
import { NextResponse } from "next/server";

/**
 * POST /api/auth/totp/disable
 *
 * No-self-disable invariant (2FA-optional spec, 2026-05-07): once a user has
 * enrolled in TOTP, NO role may turn it off via this route. The only paths
 * that may clear `totpEnabled` are the operator support routes:
 *   - User:   POST /api/admin/customers/[id]/totp-reset
 *   - Member: POST /api/admin/customers/[id]/member-totp-reset (operator)
 *           + POST /api/members/[id]/totp-reset (staff)
 *
 * Previously: owner-only 403, non-owners got 401. Widened to 403 for any
 * authenticated session — the response signals "endpoint exists but the
 * action is forbidden", matching the actual policy.
 */
export async function POST() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    { error: "Two-factor authentication cannot be self-disabled. Contact support to reset." },
    { status: 403 },
  );
}
