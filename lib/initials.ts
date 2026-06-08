/**
 * Canonical "initials from a name" helper.
 *
 * Lives in one place so the Avatar component (and any future place that needs
 * the same fallback) shares a single behaviour. Before this file landed the
 * same function was inlined in:
 *   - components/dashboard/MembersList.tsx
 *   - components/dashboard/MemberProfile.tsx
 *   - app/member/profile/page.tsx
 *   - components/dashboard/AdminCheckin.tsx
 *   - app/member/layout.tsx (gym-logo fallback)
 *
 * Rules:
 *   - Splits on any whitespace run (handles "  Ada  Lovelace  " correctly).
 *   - Takes the first character of each word.
 *   - Caps at two characters.
 *   - Uppercases.
 *   - Falls back to `fallback` (default "?") when the input has no letters —
 *     callers can pass a domain-specific fallback like "G" for gym/owner or
 *     "M" for member if they want a typed empty state.
 */
export function initials(name: string | null | undefined, fallback = "?"): string {
  if (!name) return fallback;
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return letters || fallback;
}

/**
 * Map a stable per-entity string (typically `member.id`) to one of 8 brand-
 * safe hue buckets. Same input → same bucket forever, so a given member
 * always renders with the same colour across every page they appear on.
 *
 * Hash is a cheap djb2-style accumulator — collision-resistant enough for
 * an 8-bucket visual partition and stable across runtime/JS engine.
 */
export function colorSeedBucket(seed: string | null | undefined): number {
  if (!seed) return 0;
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = ((h << 5) - h + seed.charCodeAt(i)) | 0; // h*31 + ch, kept in int32
  }
  return Math.abs(h) % AVATAR_HUES.length;
}

/**
 * Eight foreground/background pairs picked for accessibility on both light
 * and dark gym themes. Each background is dark enough (≥ contrast 4.5 on
 * white text) so the initials are readable without per-theme branching.
 *
 * Order matters — `colorSeedBucket` returns `0..AVATAR_HUES.length - 1`
 * and the index is what stays stable per-member.
 */
export const AVATAR_HUES: ReadonlyArray<{ bg: string; fg: string; ring: string }> = [
  { bg: "#0f172a", fg: "#ffffff", ring: "#1e293b" }, // slate
  { bg: "#1e3a8a", fg: "#ffffff", ring: "#1d4ed8" }, // blue
  { bg: "#3730a3", fg: "#ffffff", ring: "#4338ca" }, // indigo
  { bg: "#6d28d9", fg: "#ffffff", ring: "#7c3aed" }, // violet
  { bg: "#9d174d", fg: "#ffffff", ring: "#be185d" }, // pink
  { bg: "#9f1239", fg: "#ffffff", ring: "#be123c" }, // rose
  { bg: "#92400e", fg: "#ffffff", ring: "#b45309" }, // amber
  { bg: "#065f46", fg: "#ffffff", ring: "#047857" }, // emerald
];
