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

const ON_LIGHT = "#0f172a";
const ON_DARK = "#ffffff";

/** WCAG 2.1 relative luminance (sRGB). */
function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: number, b: number): number {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Pick a readable text colour for content sitting on an arbitrary fill —
 * dark slate on light fills, white on dark ones. Robust to 3-digit hex and a
 * missing leading "#"; anything unparseable falls back to white (assumes a
 * dark fill).
 *
 * Chooses whichever candidate has the HIGHER WCAG contrast against the fill,
 * rather than thresholding BT.601 luma. The luma threshold disagreed with WCAG
 * across a wide mid-tone band and picked the less readable colour there: on a
 * mid-blue accent (#3b82f6) it returned white at 3.68:1 when dark slate scores
 * 4.85:1 — the difference between failing and passing AA on every primary
 * button a tenant with that accent renders.
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

// Return type is written against the constants rather than repeating their
// literals, so changing ON_LIGHT/ON_DARK cannot leave the signature lying.
export function readableOn(hexColour: string): typeof ON_LIGHT | typeof ON_DARK {
  let value = hexColour.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) {
    value = value.split("").map((char) => char + char).join("");
  }
  if (!/^[0-9a-f]{6}$/i.test(value)) return ON_DARK;
  const n = parseInt(value, 16);
  const fill = relativeLuminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const onLight = relativeLuminance(15, 23, 42); // ON_LIGHT
  const onDark = relativeLuminance(255, 255, 255); // ON_DARK
  return contrast(fill, onLight) >= contrast(fill, onDark) ? ON_LIGHT : ON_DARK;
}
