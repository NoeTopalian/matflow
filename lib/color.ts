/**
 * Convert a hex colour string ("#3b82f6") + alpha (0..1) to rgba().
 * Used across the dashboard to derive tinted backgrounds + chip
 * surfaces from the tenant primaryColor + role/status colours.
 *
 * Inline copies of this helper exist in several legacy components
 * (MembersList, AdminCheckin, RanksManager, etc.) — those can be
 * migrated to import from here over time.
 */
export function hex(h: string, a: number): string {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
