/**
 * POST /api/admin/auth/logout - clears all admin auth cookies.
 */
import { NextResponse } from "next/server";
import { adminCookieClearHeaderValue } from "@/lib/admin-auth";
import {
  operatorCookieClearHeaderValue,
  operatorTotpChallengeCookieClearHeaderValue,
} from "@/lib/operator-auth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", adminCookieClearHeaderValue());
  res.headers.append("Set-Cookie", operatorCookieClearHeaderValue());
  res.headers.append("Set-Cookie", operatorTotpChallengeCookieClearHeaderValue());
  return res;
}
