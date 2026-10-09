/**
 * Per-request nonce Content-Security-Policy (security campaign iteration 2,
 * lane C2, 9 Oct 2026 — SF-30 / SEC-041 / SEC-044).
 *
 * The static policy in next.config.ts allows `'unsafe-inline'` scripts, so a
 * single injected `<script>` (or an `on*=` attribute) would run. This module
 * builds the strict policy the Next 16 guide describes
 * (node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md):
 * a fresh nonce per request, issued by proxy.ts, `'strict-dynamic'` so the
 * framework's own chunk loader is trusted transitively, and no
 * `'unsafe-inline'` for scripts.
 *
 * Rollout is report-only first. proxy.ts sends this policy as
 * `Content-Security-Policy-Report-Only` unless MATFLOW_CSP_ENFORCE is "1" or
 * "true", in which case it is sent as the enforcing `Content-Security-Policy`.
 * The static next.config.ts policy keeps enforcing in both modes, so turning
 * the flag on can only make the effective policy stricter.
 *
 * Next reads the nonce from the REQUEST header (`content-security-policy`, or
 * `content-security-policy-report-only` when the former is absent —
 * node_modules/next/dist/server/app-render/app-render.js:209) and stamps it on
 * every framework script, so proxy.ts forwards the header on the request as
 * well as setting it on the response. That only works for dynamically rendered
 * pages, which is why app/layout.tsx awaits connection().
 *
 * Styles keep `'unsafe-inline'`: React `style={…}` props render as style
 * attributes, which a nonce cannot cover, and a nonce in style-src would make
 * browsers IGNORE `'unsafe-inline'` there. Script injection is the XSS vector;
 * style injection is not closed by this change (recorded as a residual).
 *
 * Edge-safe: no Node or Prisma imports (proxy.ts imports it).
 */

/** Hosts a script may come from in a CSP2-only browser (CSP3 ignores host lists under 'strict-dynamic'). */
export const SCRIPT_HOSTS = ["https://va.vercel-scripts.com", "https://js.stripe.com"] as const;

/**
 * Outbound connections. Kept identical to the static policy in next.config.ts
 * (tests/unit/sec-c2-csp.test.ts pins the two together).
 */
export const CONNECT_HOSTS = [
  "https://*.vercel-storage.com",
  "https://*.vercel-insights.com",
  "https://*.ingest.sentry.io",
  "https://*.ingest.us.sentry.io",
  "https://*.ingest.de.sentry.io",
  "https://api.stripe.com",
  "https://accounts.google.com",
] as const;

export const FRAME_HOSTS = ["https://js.stripe.com", "https://hooks.stripe.com"] as const;

/** Where browsers send violation reports (app/api/csp-report/route.ts). */
export const CSP_REPORT_PATH = "/api/csp-report";
/** Reporting API group name used by `report-to` and the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = "csp-endpoint";

export type CspMode = "report-only" | "enforce";

/** Report-only unless MATFLOW_CSP_ENFORCE is exactly "1" or "true" (case-insensitive). */
export function cspMode(env: Record<string, string | undefined> = process.env): CspMode {
  const v = (env.MATFLOW_CSP_ENFORCE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" ? "enforce" : "report-only";
}

export function cspHeaderName(mode: CspMode): "Content-Security-Policy" | "Content-Security-Policy-Report-Only" {
  return mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only";
}

/** 128 random bits, base64 — unpredictable and unique per request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const NONCE_RE = /^[A-Za-z0-9+/]{16,64}={0,2}$/;

export function buildNonceCsp(
  nonce: string,
  opts: { isDev: boolean; mode: CspMode },
): string {
  // A nonce that is not plain base64 would let a caller break out of the
  // source list; newNonce() never produces one, so this is a programming error.
  if (!NONCE_RE.test(nonce)) throw new Error("buildNonceCsp: malformed nonce");
  const directives = [
    "default-src 'self'",
    // 'self' and the hosts are for CSP2 browsers only: a CSP3 browser that sees
    // 'strict-dynamic' ignores them and trusts the nonce plus whatever a
    // nonced script loads. No 'unsafe-inline'. 'unsafe-eval' only in dev,
    // where React uses eval for error-stack reconstruction (Next guide).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${SCRIPT_HOSTS.join(" ")}${opts.isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' ${CONNECT_HOSTS.join(" ")}${opts.isDev ? " ws://localhost:* http://localhost:*" : ""}`,
    `frame-src 'self' ${FRAME_HOSTS.join(" ")}`,
    // Explicit, so the service worker (public/sw.js) is governed by 'self'
    // rather than falling back to script-src, where 'strict-dynamic' would
    // make 'self' meaningless.
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    // Ignored (with a console warning) in a report-only policy, so only sent
    // when enforcing in production.
    ...(opts.mode === "enforce" && !opts.isDev ? ["upgrade-insecure-requests"] : []),
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ];
  return directives.join("; ");
}

/** The Reporting-Endpoints header value that names the report-to group. */
export function reportingEndpointsHeader(): string {
  return `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;
}

/**
 * Document requests that reach proxy.ts but never need the session stack: the
 * kiosk tablet and the leaderboard TV authenticate with a token in the URL,
 * so the next-auth wrapper is skipped for them (it was skipped before by a
 * matcher exclusion; they now enter the proxy only to receive the CSP).
 */
export function isTokenDocumentPath(pathname: string): boolean {
  return (
    pathname === "/kiosk" ||
    pathname.startsWith("/kiosk/") ||
    pathname === "/leaderboard" ||
    pathname.startsWith("/leaderboard/")
  );
}

/** API responses are JSON/CSV/bytes, not documents; they get no nonce policy. */
export function wantsDocumentCsp(pathname: string): boolean {
  return !(pathname === "/api" || pathname.startsWith("/api/"));
}
