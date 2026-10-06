/**
 * Support (impersonation) sessions are READ-ONLY. One policy, one place.
 *
 * Operator security audit 5 Oct 2026, Q3/Q4 and remediation lane B (6 Oct
 * 2026): an operator "logged in as" a club owner used to inherit every power
 * the owner has — set the owner's password, enrol the owner's authenticator,
 * create staff with chosen passwords, erase members, roll back imports, refund
 * payments. Nothing on the server read `impersonatedBy`.
 *
 * The rule now:
 *
 *   - Every request that is not GET/HEAD/OPTIONS, made with a support session,
 *     is refused (403) — every app/api route, every page POST (a Server Action
 *     is a POST to a page), every method a future route adds. The ALLOW-LIST
 *     below is the only exception and it is EMPTY: an entry needs a one-line
 *     justification proving the request has no side effect.
 *   - The exits are not exceptions to "read-only" because they only take
 *     authority away: ending the support session, and signing the operator out.
 *   - Some GETs are not reads: exporting personal-data files, and the OAuth
 *     connect/callback pairs that store payment or Drive credentials. Refused.
 *   - No nesting: a support session cannot use the operator plane (pages under
 *     /admin, operator routes under /api/admin) — that includes starting another
 *     support session. The owner-facing routes that happen to live under
 *     /api/admin (import, DSAR, test email) follow the ordinary rules above.
 *
 * Enforced centrally in proxy.ts (Node runtime — the jwt() swap runs there, so
 * `req.auth.user.impersonatedBy` is visible), and again inside the routes the
 * proxy matcher does not reach (/api/auth/*) and the credential/access routes
 * (defence in depth) via lib/api-authz.ts `refuseSupportSession`.
 *
 * Imports only next/server, so proxy.ts, route handlers and tests can all use
 * it (and a test that mocks lib/api-authz does not silently drop the guard).
 */
import { NextResponse } from "next/server";

export const SUPPORT_READ_ONLY_MESSAGE =
  "Support access is read-only. End the support session to make changes.";
export const SUPPORT_EXPORT_MESSAGE =
  "Support access cannot export or connect accounts. Ask the club to do this.";
export const SUPPORT_OPERATOR_PLANE_MESSAGE =
  "End the support session before using the operator console.";

/** True when this session is an operator acting as someone (a support session). */
export function isSupportSession(session: unknown): boolean {
  const user = (session as { user?: { impersonatedBy?: unknown } } | null | undefined)?.user;
  return typeof user?.impersonatedBy === "string" && user.impersonatedBy.length > 0;
}

type RouteRule = { method: string; path: RegExp; why: string };

/**
 * Non-GET requests a support session MAY make. EMPTY on purpose.
 * Add an entry only for a request that genuinely only reads, with the proof.
 */
export const SUPPORT_MUTATION_ALLOWLIST: readonly RouteRule[] = [];

/** Requests that only remove authority. Never refused, or support could not end. */
export const SUPPORT_EXIT_ROUTES: readonly RouteRule[] = [
  {
    method: "DELETE",
    path: /^\/api\/admin\/impersonate\/?$/,
    why: "Ends the support session itself; refusing it would trap the operator inside the club's identity.",
  },
  {
    method: "POST",
    path: /^\/api\/admin\/auth\/logout\/?$/,
    why: "Signs the operator out everywhere (sessionVersion bump), which also ends every support session bound to it.",
  },
];

/** GETs that are not plain reads. Refused for support sessions. */
export const SUPPORT_REFUSED_READS: readonly { path: RegExp; why: string }[] = [
  { path: /^\/api\/admin\/dsar\/export\/?$/, why: "Personal-data (subject access) export file." },
  { path: /^\/api\/payments\/export\.csv\/?$/, why: "Payments CSV export: personal and financial data file." },
  { path: /^\/api\/admin\/import\/attendance\/export\/?$/, why: "Attendance ledger export file." },
  { path: /^\/api\/admin\/import\/[^/]+\/exceptions\/?$/, why: "Import exceptions CSV: names and contact details." },
  { path: /^\/api\/stripe\/connect(\/callback)?\/?$/, why: "Connects a payment account; the callback writes the club's Stripe account." },
  { path: /^\/api\/drive\/(connect|callback)\/?$/, why: "Connects Google Drive; the callback stores OAuth tokens." },
  { path: /^\/api\/auth\/totp\/setup\/?$/, why: "GET mints and stores a new authenticator secret on the account." },
  { path: /^\/api\/member\/totp\/setup\/?$/, why: "GET mints and stores a new authenticator secret on the account." },
];

/** Owner-facing routes that live under /api/admin but are not the operator plane. */
const OWNER_ROUTES_UNDER_API_ADMIN = /^\/api\/admin\/(import|dsar|email)(\/|$)/;

export type SupportDecision =
  | { allowed: true }
  | { allowed: false; reason: "read_only" | "export" | "operator_plane"; message: string };

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function normalisePath(pathname: string): string {
  let p = pathname;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    /* malformed escape: match the raw path */
  }
  // Collapse duplicate slashes so "//api//staff" cannot dodge an anchored rule.
  return p.replace(/\/{2,}/g, "/");
}

/**
 * What a support session may do with this request. Pure; `method` defaults to
 * GET when absent (a navigation).
 */
export function supportRequestDecision(method: string | undefined | null, pathname: string): SupportDecision {
  const m = (method ?? "GET").toUpperCase();
  const path = normalisePath(pathname);

  if (SUPPORT_EXIT_ROUTES.some((r) => r.method === m && r.path.test(path))) return { allowed: true };

  const operatorPage = path === "/admin" || path.startsWith("/admin/");
  const operatorApi = path.startsWith("/api/admin/") && !OWNER_ROUTES_UNDER_API_ADMIN.test(path);
  if (operatorPage || operatorApi) {
    return { allowed: false, reason: "operator_plane", message: SUPPORT_OPERATOR_PLANE_MESSAGE };
  }

  if (!READ_METHODS.has(m)) {
    if (SUPPORT_MUTATION_ALLOWLIST.some((r) => r.method === m && r.path.test(path))) return { allowed: true };
    return { allowed: false, reason: "read_only", message: SUPPORT_READ_ONLY_MESSAGE };
  }

  if (SUPPORT_REFUSED_READS.some((r) => r.path.test(path))) {
    return { allowed: false, reason: "export", message: SUPPORT_EXPORT_MESSAGE };
  }
  return { allowed: true };
}

/**
 * Route guard, one line at the top of a handler:
 *
 *     const support = refuseSupportSession(session); if (support) return support;
 *
 * Returns the 403 to send when `session` is a support session, else null. Same
 * `{ ok: false, error }` body as lib/api-error.ts.
 */
export function refuseSupportSession(session: unknown, message: string = SUPPORT_READ_ONLY_MESSAGE): NextResponse | null {
  if (!isSupportSession(session)) return null;
  return NextResponse.json({ ok: false, error: message, supportReadOnly: true }, { status: 403 });
}
