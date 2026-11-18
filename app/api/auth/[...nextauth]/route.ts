import { handlers } from "@/auth";
import { recordSignOut } from "@/lib/session-signout";

/**
 * GET /api/auth/session while the revocation check cannot run (SF-44, lane A2,
 * 9 Oct 2026). Auth.js answers 200 with the session callback's result; for a
 * token awaiting revalidation that is `{ authUnavailable: true }` with no user,
 * which a client would read as "signed in, no user". It becomes a retryable
 * 503 here, with the re-issued (NOT cleared) session cookie passed through.
 * next-auth/react reads a non-OK session response as "no session" for that
 * fetch and keeps the cookie for the next one. Every other action is untouched.
 */
export async function GET(req: Request): Promise<Response> {
  const res = await (handlers.GET as (r: Request) => Promise<Response>)(req);
  if (!new URL(req.url).pathname.endsWith("/session") || res.status !== 200) return res;
  let body: unknown = null;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (!body || (body as { authUnavailable?: unknown }).authUnavailable !== true) return res;
  const out = Response.json(
    { ok: false, error: "We couldn't confirm your sign-in just now. Please try again in a moment.", retryable: true },
    { status: 503, headers: { "retry-after": "15", "cache-control": "private, no-store" } },
  );
  for (const cookie of res.headers.getSetCookie()) out.headers.append("set-cookie", cookie);
  return out;
}

/**
 * POST /api/auth/signout records this session as ended BEFORE Auth.js clears the cookie (Round 8, 16 Nov 2026;
 * lib/session-signout.ts). If the record cannot be written the answer is a 503 and Auth.js never runs: the cookie is
 * kept and the person is told sign-out did not work. Every other action goes straight to Auth.js.
 */
export async function POST(req: Request): Promise<Response> {
  if (new URL(req.url).pathname.endsWith("/signout")) {
    const refused = await recordSignOut(req);
    if (refused) return refused;
  }
  return (handlers.POST as (r: Request) => Promise<Response>)(req);
}
