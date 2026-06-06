/**
 * Avatar — a single component for every member/staff face across the app.
 *
 * Track A — Phase A1 (feat/member-profile-pictures).
 *
 * Behaviour:
 *   - If `pictureUrl` is a non-empty string, renders an <img> with object-cover,
 *     rounded-full, and an alt text built from `name`. data:/blob:/https: are
 *     all permitted by the project CSP (next.config.ts img-src directive).
 *   - Otherwise, renders the `initials(name)` two-letter fallback on a coloured
 *     circle. The colour is picked deterministically from `colorSeed` (usually
 *     `member.id`) so a given person ALWAYS renders with the same hue across
 *     pages — list, register, member detail, task modal, every spot.
 *   - Four sizes (sm/md/lg/xl) cover everything from a 24px combobox chip to
 *     a 96px profile header. Sizes are exposed as a single union so callers
 *     pick by intent, not by px.
 *
 * Why no Next.js <Image>?
 *   The avatar URL is per-member and not known at build time. Vercel's image
 *   optimiser would issue a per-URL transform request — pointless when we
 *   already downscale to 256x256 WebP at upload time (Phase A2). Plain <img>
 *   is simpler, faster on cache hit, and keeps the bundle smaller.
 */
import { initials, colorSeedBucket, AVATAR_HUES } from "@/lib/initials";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

interface AvatarProps {
  /** When non-empty, renders as an <img> instead of initials. */
  pictureUrl?: string | null;
  /** Used for initials fallback AND the <img alt> attribute. */
  name: string;
  /**
   * Stable per-entity string (member.id / user.id) that picks the deterministic
   * colour bucket. Pass `null` to force the first hue — useful for "system"
   * tiles where there's no underlying entity.
   */
  colorSeed?: string | null;
  size?: AvatarSize;
  /** Extra Tailwind / inline-style classes from the parent. */
  className?: string;
  /**
   * Render a soft ring around the avatar. Off by default to avoid visual
   * noise in dense lists; turn on for the profile-page hero or active state.
   */
  ring?: boolean;
  /** Fallback character when name itself is empty (e.g. "G" for "guest"). */
  initialsFallback?: string;
}

// Tailwind doesn't ship arbitrary px utilities in the safelist by default,
// so we keep these as inline styles. Px values match the 4-pt design grid.
const SIZE_PX: Record<AvatarSize, number> = {
  xs: 20,
  sm: 28,
  md: 40,
  lg: 56,
  xl: 96,
};

const FONT_PX: Record<AvatarSize, number> = {
  xs: 9,
  sm: 11,
  md: 14,
  lg: 18,
  xl: 30,
};

export function Avatar({
  pictureUrl,
  name,
  colorSeed,
  size = "md",
  className,
  ring = false,
  initialsFallback,
}: AvatarProps) {
  const px = SIZE_PX[size];
  const fontPx = FONT_PX[size];
  const baseStyle: React.CSSProperties = {
    width: px,
    height: px,
    borderRadius: "9999px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
  };

  if (pictureUrl) {
    return (
      <span
        className={className}
        style={{
          ...baseStyle,
          boxShadow: ring ? `0 0 0 2px rgba(255,255,255,0.12)` : undefined,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={pictureUrl}
          alt={name}
          width={px}
          height={px}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </span>
    );
  }

  const hue = AVATAR_HUES[colorSeedBucket(colorSeed ?? name)];
  return (
    <span
      className={className}
      role="img"
      aria-label={name || "Avatar"}
      style={{
        ...baseStyle,
        background: hue.bg,
        color: hue.fg,
        fontSize: fontPx,
        fontWeight: 600,
        letterSpacing: "0.02em",
        userSelect: "none",
        boxShadow: ring ? `0 0 0 2px ${hue.ring}` : undefined,
      }}
    >
      {initials(name, initialsFallback)}
    </span>
  );
}

export default Avatar;
