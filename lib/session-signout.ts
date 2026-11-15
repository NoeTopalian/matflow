import { NextResponse, after } from "next/server";
import { getToken } from "next-auth/jwt";
import { assertSameOrigin } from "@/lib/csrf";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { AUTH_SECRET_VALUE } from "@/lib/auth-secret";
import { SESSION_COOKIE_NAME, SESSION_COOKIE_SECURE } from "@/lib/auth-cookie";
import { REVOKED_SESSION_RETENTION_MS, sessionIdOf } from "@/lib/session-id";
import { SIGN_OUT_FAILED_MESSAGE } from "@/lib/sign-out-client";

/**
 * "Sign out" ends THIS session on the server (Round 8, 16 Nov 2026).
 *
 * Until now sign-out only cleared the cookie. The token stayed valid for up to 30 days, so any copy of it — a response
 * that was already on its way when the person signed out, a second tab, a copied cookie — kept working. Now the
 * sign-out POST records the session id BEFORE Auth.js clears the cookie, and the revocation check refuses that id on
 * every request (lib/session-revocation.ts). Other devices hold other ids and stay signed in. "Sign out everywhere"
 * is unchanged: it bumps the person's sessionVersion (app/api/auth/logout-all).
 *
 * Fails closed. If the record cannot be written, the request answers 503 and Auth.js never runs, so the cookie is
 * kept and the page tells the person it did not work (lib/sign-out-client.ts) — never "signed out" while the server
 * still honours the session. Not Auth.js's `events.signOut`: Auth.js logs and swallows that event's errors and clears
 * the cookie anyway.
 *
 * Safe to repeat. The insert ignores a record that already exists, so a retry after a lost response, a second tab
 * signing out, or a sign-out with an already-ended token all succeed.
 *
 * Access model. A RevokedSession row holds an opaque id and two timestamps — no club, no person, nothing tenant
 * scoped (pre-release tokens get a hashed per-person id, lib/session-id.ts). Row-level security admits only the
 * RLS-bypass helper, which only this module and the revocation check use; the runtime role cannot read or write the
 * table any other way (prisma/migrations/20261116120000_revoked_session).
 */

/** Record that this session has ended. Throws when the record could not be written. */
export async function revokeSessionId(sid: string, now: Date = new Date()): Promise<void> {
  await withRlsBypass((tx) =>
    tx.revokedSession.createMany({
      data: [{ sid, revokedAt: now, expiresAt: new Date(now.getTime() + REVOKED_SESSION_RETENTION_MS) }],
      skipDuplicates: true,
    }),
  );
}

/**
 * Remove records whose sessions can no longer authenticate (lib/session-id.ts REVOKED_SESSION_RETENTION_MS explains
 * why `expiresAt` is that point). Best effort: a failure leaves rows for the next sign-out to remove.
 */
export async function pruneExpiredRevocations(now: Date = new Date()): Promise<number> {
  const out = await withRlsBypass((tx) => tx.revokedSession.deleteMany({ where: { expiresAt: { lt: now } } }));
  return out.count;
}

/**
 * Runs in front of Auth.js's sign-out. Returns a response to send INSTEAD of Auth.js (the request is refused and the
 * cookie kept), or null to let Auth.js clear the cookie.
 */
export async function recordSignOut(req: Request): Promise<Response | null> {
  // A cross-site POST must not be able to end someone's session (Auth.js's own CSRF check runs only after this).
  const crossSite = assertSameOrigin(req);
  if (crossSite) return crossSite;

  const token = await getToken({
    req,
    secret: AUTH_SECRET_VALUE,
    cookieName: SESSION_COOKIE_NAME,
    secureCookie: SESSION_COOKIE_SECURE,
  }).catch(() => null);
  // No readable session: nothing on the server to end. Auth.js clears whatever cookie is there.
  if (!token) return null;
  const sid = sessionIdOf(token as Record<string, unknown>);
  // A pre-release token mid-support has no id of its own; auth.ts already refuses it on every request.
  if (!sid) return null;

  try {
    await revokeSessionId(sid);
  } catch (err) {
    console.error("[auth] sign-out could not be recorded — session kept, sign-out refused", {
      code: typeof (err as { code?: unknown } | null)?.code === "string" ? (err as { code: string }).code : undefined,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: SIGN_OUT_FAILED_MESSAGE, retryable: true },
      { status: 503, headers: { "retry-after": "5", "cache-control": "private, no-store" } },
    );
  }

  try {
    after(async () => {
      try {
        await pruneExpiredRevocations();
      } catch (err) {
        console.warn("[auth] expired sign-out records not pruned this time", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  } catch {
    /* outside a request scope (tests): pruning waits for the next sign-out */
  }
  return null;
}
