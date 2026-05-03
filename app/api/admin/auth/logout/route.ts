/**
 * POST /api/admin/auth/logout — clears the matflow_admin cookie.
 */
import { NextResponse } from "next/server";
import { adminCookieClearHeaders } from "@/lib/admin-auth";

export async function POST() {
  return NextResponse.json({ ok: true }, { headers: adminCookieClearHeaders() });
}
