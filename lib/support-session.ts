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
import type { SupportScope } from "@/lib/impersonation";

export const SUPPORT_READ_ONLY_MESSAGE =
  "Support access is read-only. End the support session to make changes.";
export const SUPPORT_EXPORT_MESSAGE =
  "Support access cannot export or connect accounts. Ask the club to do this.";
export const SUPPORT_OPERATOR_PLANE_MESSAGE =
  "End the support session before using the operator console.";
export const SUPPORT_EDIT_NOT_COVERED_MESSAGE =
  "Edit access doesn't cover this — it stays with the club owner.";

/** True when this session is an operator acting as someone (a support session). */
export function isSupportSession(session: unknown): boolean {
  const user = (session as { user?: { impersonatedBy?: unknown } } | null | undefined)?.user;
  return typeof user?.impersonatedBy === "string" && user.impersonatedBy.length > 0;
}

type RouteRule = { method: string; path: RegExp; why: string };

/**
 * Non-GET requests a VIEW support session may make. EMPTY on purpose.
 * Add an entry only for a request that genuinely only reads, with the proof.
 */
export const SUPPORT_MUTATION_ALLOWLIST: readonly RouteRule[] = [];

/**
 * Non-GET requests an EDIT support session may make (13 Oct 2026, hub club
 * edit access). Routine club operations only — the three families the owner
 * commissioned: timetable/classes, member details, ordinary settings. Default
 * deny: anything not matched here is refused, including every DELETE and every
 * page POST (a Server Action is a POST to a page, and no rule below matches a
 * page). Each entry names what it is; a reviewer diffs intent, not regexes.
 */
export const SUPPORT_EDIT_MUTATION_ALLOWLIST: readonly RouteRule[] = [
  { method: "POST", path: /^\/api\/classes\/?$/, why: "Create a class (mints its rolling instance window)." },
  { method: "PATCH", path: /^\/api\/classes\/[^/]+\/?$/, why: "Edit a class's details and schedule." },
  { method: "POST", path: /^\/api\/classes\/[^/]+\/instances\/?$/, why: "Generate schedule instances for a class." },
  { method: "PATCH", path: /^\/api\/classes\/[^/]+\/instances\/[^/]+\/?$/, why: "Edit one timetable instance (time, cancel flag)." },
  { method: "POST", path: /^\/api\/classes\/[^/]+\/roster\/?$/, why: "Add a member to a class roster." },
  { method: "POST", path: /^\/api\/members\/?$/, why: "Create a member record." },
  { method: "PATCH", path: /^\/api\/members\/[^/]+\/?$/, why: "Edit a member's details (name, contact, notes fields)." },
  { method: "POST", path: /^\/api\/members\/[^/]+\/rank\/?$/, why: "Award a rank (routine promotion)." },
  { method: "POST", path: /^\/api\/members\/[^/]+\/rank\/demote\/?$/, why: "Correct a rank (routine demotion)." },
  { method: "POST", path: /^\/api\/checkin\/?$/, why: "Staff-side attendance marking." },
  { method: "POST", path: /^\/api\/ranks\/?$/, why: "Create a rank in the club's rank system (ordinary settings)." },
  { method: "PATCH", path: /^\/api\/ranks\/[^/]+\/?$/, why: "Edit a rank's name/order/colour (ordinary settings)." },
  { method: "PATCH", path: /^\/api\/settings\/?$/, why: "Ordinary club settings (general/branding/timetable)." },
];

/**
 * Families that must NEVER be allowlisted for edit sessions — they stay in
 * their separately protected workflows. Spelled out so a future allowlist
 * entry that collides is caught by the unit matrix, not by a reviewer's eye:
 * /api/account*, /api/auth*, every TOTP/recovery route, login-email changes,
 * /api/staff* (staff management), transfer-ownership, /api/stripe* and every
 * billing/subscription/charge route, /api/admin/import* and rollbacks,
 * exports, DSAR/erasure, invite/waiver/display/kiosk token minting,
 * guardian/link-child/unlink-child (family authority), promote-to-adult,
 * unlock, waiver signing, photo/picture uploads, and EVERY DELETE method.
 */

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
export function supportRequestDecision(
  method: string | undefined | null,
  pathname: string,
  scope: SupportScope = "view",
): SupportDecision {
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
    if (scope === "edit") {
      if (SUPPORT_EDIT_MUTATION_ALLOWLIST.some((r) => r.method === m && r.path.test(path))) return { allowed: true };
      return { allowed: false, reason: "read_only", message: SUPPORT_EDIT_NOT_COVERED_MESSAGE };
    }
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

/**
 * In-route backstop for EXACTLY the routine operations on
 * SUPPORT_EDIT_MUTATION_ALLOWLIST: a view session is still refused, an EDIT
 * session is let through to the handler (whose own validation applies
 * unchanged). Every other handler keeps refuseSupportSession, which refuses
 * both scopes - a route is never relaxed by default. Anything but the literal
 * scope "edit" on the server-verified session refuses, so a client flag can
 * never grant authority (the scope comes from auth.ts, which copies it from
 * the HMAC-verified session token).
 */
export function refuseSupportSessionUnlessEdit(session: unknown, message: string = SUPPORT_READ_ONLY_MESSAGE): NextResponse | null {
  if (!isSupportSession(session)) return null;
  const scope = (session as { user?: { supportScope?: unknown } }).user?.supportScope;
  if (scope === "edit") return null;
  return NextResponse.json({ ok: false, error: message, supportReadOnly: true }, { status: 403 });
}

/**
 * Field-level policy for the three allowlisted operations whose handlers can
 * reach beyond "routine" (external review, 13 Oct 2026). Keys are RAW request
 * body keys, checked before any schema parsing or stripping, so a prohibited
 * field cannot hide behind zod stripping. Allow-only: a key absent from the
 * list is refused, so new schema fields are refused until classified here
 * (tests/unit/support-edit-field-policy.test.ts pins the classification
 * against each zod schema and fails on an unclassified field).
 *
 * Deliberately refused:
 * - member.update: email (sign-in/recovery address), status (cancellation
 *   cancels a live Stripe subscription), paymentStatus, membershipType,
 *   membershipTierId, trialRunById, creditedTo* (money/attribution).
 * - member.create: parentMemberId and accountType (a staff-created link is
 *   CONFIRMED guardian authority; there is no "suggested by operator" state,
 *   so kid/guardian creation is denied outright), credit attribution.
 * - settings.update: every billing/payment field, contactEmail (the club's
 *   mail identity), privacy fields, waiver content (legal text) and
 *   onboarding lifecycle fields.
 */
export const SUPPORT_EDIT_FIELD_POLICY = {
  "member.update": [
    "name", "phone",
    "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation",
    "notes", "dateOfBirth", "updatedAt",
  ],
  // I-3 (security review): no membership tier/type/status at create either -
  // creating a member straight onto a free tier is comped access, the exact
  // thing update already refuses.
  "member.create": [
    "name", "email", "phone", "dateOfBirth", "requestId",
  ],
  // I-1: no photoUrl/photoCaption - re-awarding the current rank with a photo
  // permanently deletes the previous promotion photos (blob files included),
  // and the photo write path accepts blob URLs this club does not own.
  "member.rank.award": ["rankSystemId", "stripes", "notes"],
  // I-2: no notify (and no free-text reason, which only exists to be sent) -
  // notify emails operator-written text to the member in the club's name.
  "member.rank.demote": ["toRankId"],
  "settings.update": [
    "name", "primaryColor", "secondaryColor", "textColor", "bgColor",
    "fontFamily", "logoSize", "logoUrl",
    "instagramUrl", "facebookUrl", "tiktokUrl", "youtubeUrl", "twitterUrl",
    "websiteUrl", "groupChatUrl",
    "checkinWindowBeforeMin", "checkinWindowAfterMin", "timezone",
  ],
} as const satisfies Record<string, readonly string[]>;

/**
 * Operation- and field-level backstop for edit sessions, called right after
 * refuseSupportSessionUnlessEdit in the routes named by
 * SUPPORT_EDIT_FIELD_POLICY, BEFORE any mutation, provider call or token
 * minting. The whole request is refused when ANY raw body key falls outside
 * the allowlist, so a prohibited field mixed with a legitimate edit never
 * partially applies. Non-support sessions pass through untouched; support
 * authority never derives from anything client-controlled (the scope is read
 * from the server-verified session).
 */
export function refuseSupportEditFields(
  session: unknown,
  rawBody: unknown,
  allowedKeys: readonly string[],
): NextResponse | null {
  if (!isSupportSession(session)) return null;
  const scope = (session as { user?: { supportScope?: unknown } }).user?.supportScope;
  if (scope !== "edit") {
    // Unreachable behind refuseSupportSessionUnlessEdit, but the helper stays
    // safe when called alone: a view session is refused, never field-checked.
    return NextResponse.json({ ok: false, error: SUPPORT_READ_ONLY_MESSAGE, supportReadOnly: true }, { status: 403 });
  }
  const keys = rawBody !== null && typeof rawBody === "object" && !Array.isArray(rawBody)
    ? Object.keys(rawBody as Record<string, unknown>)
    : null;
  if (keys === null) {
    return NextResponse.json({ ok: false, error: SUPPORT_EDIT_NOT_COVERED_MESSAGE, supportReadOnly: true }, { status: 403 });
  }
  const refused = keys.filter((k) => !allowedKeys.includes(k));
  if (refused.length === 0) return null;
  return NextResponse.json(
    {
      ok: false,
      error: `Edit access doesn't cover changing "${refused[0]}" — it stays with the club owner.`,
      supportReadOnly: true,
      refusedFields: refused,
    },
    { status: 403 },
  );
}
