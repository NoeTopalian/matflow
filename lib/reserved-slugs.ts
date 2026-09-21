/**
 * The single-segment paths that are NOT public club slugs — one entry per real
 * top-level route folder under `app/`. Both the edge middleware (`proxy.ts`)
 * and the public `app/[slug]/page.tsx` consult THIS one list:
 *
 *  - the page 404s a reserved name so a club can never claim a route's path;
 *  - the middleware treats any OTHER bare single segment as a public club page,
 *    which is only safe because every authenticated single-segment route
 *    (`/dashboard`, `/member`, `/admin`, …) is reserved here.
 *
 * Edge-safe on purpose: no imports, pure data + a pure predicate. The page's
 * own module pulls in Prisma (via withRlsBypass), which the edge runtime cannot
 * load, so the middleware must not import the page — it imports this instead.
 *
 * `tests/unit/public-club-slug-reserved.test.ts` pins this set against the real
 * `app/` folder listing, so a newly-added top-level route that forgets to
 * register here fails a test rather than silently becoming a public,
 * auth-bypassed path.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "apply",
  "dashboard",
  "kiosk",
  "leaderboard",
  "legal",
  "login",
  "member",
  "onboarding",
  "preview",
  "print",
  "waiver",
]);

/** True when `slug` (already lowercased/normalised) is a real route, not a club. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}
