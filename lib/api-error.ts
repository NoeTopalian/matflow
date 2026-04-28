import { NextResponse } from "next/server";

/**
 * Returns a JSON error response with a generic, client-safe message and logs
 * the underlying error server-side. Use this in route handlers instead of
 * surfacing `error.message` to clients (which can leak Prisma SQL fragments,
 * Stripe SDK internals, OAuth token-exchange details, etc.).
 *
 * Example:
 *   try { ... } catch (e) { return apiError("Failed to refund", 500, e, "[refund]"); }
 */
export function apiError(
  message: string,
  status: number,
  e?: unknown,
  tag?: string,
) {
  if (e !== undefined) {
    if (tag) console.error(tag, e);
    else console.error(e);
  }
  return NextResponse.json({ ok: false, error: message }, { status });
}
