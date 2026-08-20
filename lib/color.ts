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

/**
 * Pick a readable text colour for content sitting on an arbitrary fill —
 * dark slate on light fills, white on dark ones. Luma-based (BT.601
 * weights). Robust to 3-digit hex and a missing leading "#"; anything
 * unparseable falls back to white (assumes a dark fill).
 *
 * Canonical home of this logic per UI-RULES §2a — inline copies (e.g. the
 * member schedule's local readableText) migrate here over time.
 */
/**
 * Deterministic per-user tone for avatar gradients: display name → hue.
 * Blended over the tenant primary it gives every account a genuinely unique
 * two-toned avatar (Noe, 2026-08-17) while staying primary-anchored.
 */
export function userTone(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsla(${h}, 70%, 72%, 0.55)`;
}

export function readableOn(hexColour: string): "#0f172a" | "#ffffff" {
  let value = hexColour.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) {
    value = value.split("").map((char) => char + char).join("");
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) return "#ffffff";
  const n = parseInt(value, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const luma = (r * 299 + g * 587 + b * 114) / 1000;
  return luma > 155 ? "#0f172a" : "#ffffff";
}
