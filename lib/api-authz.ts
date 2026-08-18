import { auth } from "@/auth";
import { apiError } from "@/lib/api-error";
import { STAFF_ROLES, type AuthContext } from "@/lib/authz";
import type { NextResponse } from "next/server";

/**
 * ROUTE-HANDLER auth gates (P0-4).
 *
 * ## Why this file exists
 *
 * `@/lib/authz` answers an auth failure with `redirect("/login")`. In a
 * server component that is right. In a route handler it is a data-loss
 * illusion: Next.js turns the `NEXT_REDIRECT` throw into
 *
 *     new Response(null, { status: 307, headers: { Location: "/login" } })
 *
 * (next/dist/server/route-modules/app-route/module.js, the `isRedirectError`
 * branch). `fetch()` defaults to `redirect: "follow"`, so the client silently
 * follows it, receives the login PAGE as `200 text/html`, and `res.json()`
 * throws on the leading `<`. The caller's catch branch runs and the UI
 * renders an empty state — "you have no members" — when the truth is "your
 * session expired". Every route that gated on `@/lib/authz` amplified one
 * expired cookie into apparent data loss.
 *
 * ## Why distinct helpers rather than sniffing the request
 *
 * Detecting "am I in a route handler?" at runtime was rejected. `Accept`
 * and `sec-fetch-dest` are client-controlled and absent on server-to-server
 * calls, and Next's own answer — the `page`/`route` field on
 * `work-async-storage.external` — is private API that can change under a
 * minor upgrade. Both fail OPEN: a missed detection re-introduces the 307
 * with no compile-time signal. Two explicit modules cannot fail that way,
 * and the union return below makes `tsc` prove the migration is complete —
 * a route that forgets the failure branch does not type-check, because
 * `ApiAuthFailure` carries no `tenantId`.
 *
 * `unauthorized()` / `forbidden()` (Next's `authInterrupts`) were rejected
 * too: the same module answers them with `new Response(null, { status })`,
 * i.e. a body-less 401/403, which cannot carry the `{ ok, error }` shape
 * clients already parse.
 *
 * ## Usage
 *
 *     export async function GET() {
 *       const gate = await requireApiStaff();
 *       if (!gate.ok) return gate.response;
 *       const { tenantId } = gate;
 *       ...
 *     }
 *
 * The body shape is whatever `lib/api-error.ts` produces — `{ ok: false,
 * error }` — so no client needs special-casing. No `reference` is minted:
 * `apiError` only mints one when something was logged for an owner to find,
 * and an expired session is not a diagnosable fault.
 */

export type ApiAuthSuccess = AuthContext & { ok: true };
export type ApiAuthFailure = { ok: false; response: NextResponse };
export type ApiAuthResult = ApiAuthSuccess | ApiAuthFailure;

/** 401 — no valid session. Distinct from 403 so clients can re-authenticate. */
export function apiUnauthenticated(): ApiAuthFailure {
  return {
    ok: false,
    response: apiError("Your session has expired. Please sign in again.", 401),
  };
}

/** 403 — authenticated, but the role is not permitted. Re-authenticating won't help. */
export function apiForbidden(): ApiAuthFailure {
  return {
    ok: false,
    response: apiError("You do not have permission to do this.", 403),
  };
}

export async function requireApiSession(): Promise<ApiAuthResult> {
  const session = await auth();
  // `session.user` is undefined once the session callback in auth.ts
  // invalidates a token (sessionVersion bump). Checking the user rather than
  // the session avoids dereferencing undefined and returning a 500 instead
  // of the 401 the client needs.
  if (!session?.user) return apiUnauthenticated();
  return {
    ok: true,
    session,
    tenantId: session.user.tenantId,
    userId: session.user.id,
    role: session.user.role,
  };
}

export async function requireApiRole(roles: string[]): Promise<ApiAuthResult> {
  const gate = await requireApiSession();
  if (!gate.ok) return gate;
  if (!roles.includes(gate.role)) return apiForbidden();
  return gate;
}

export async function requireApiOwner(): Promise<ApiAuthResult> {
  return requireApiRole(["owner"]);
}

export async function requireApiOwnerOrManager(): Promise<ApiAuthResult> {
  return requireApiRole(["owner", "manager"]);
}

export async function requireApiStaff(): Promise<ApiAuthResult> {
  return requireApiRole(STAFF_ROLES);
}
