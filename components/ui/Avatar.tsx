"use client";

/**
 * Avatar — a single component for every member/staff face across the app.
 *
 * Track A — Phase A1 (feat/member-profile-pictures).
 *
 * Behaviour:
 *   - If `pictureUrl` is a non-empty string AND the browser can actually load
 *     it, renders an <img> with object-cover, rounded-full, and an alt text
 *     built from `name`. data:/blob:/https: are all permitted by the project
 *     CSP (next.config.ts img-src directive).
 *   - Otherwise — no URL at all, OR a URL that failed to load — renders the
 *     `initials(name)` two-letter fallback on a coloured circle. The colour is
 *     picked deterministically from `colorSeed` (usually `member.id`) so a
 *     given person ALWAYS renders with the same hue across pages — list,
 *     register, member detail, task modal, every spot.
 *   - Four sizes (sm/md/lg/xl) cover everything from a 24px combobox chip to
 *     a 96px profile header. Sizes are exposed as a single union so callers
 *     pick by intent, not by px.
 *
 * Why "use client":
 *   The onError fallback needs a state hook. Every consumer today is already a
 *   client component (AddTaskModal, AdminCheckin, MemberProfile, MembersList,
 *   AvatarUploader), so nothing loses server rendering by this.
 *
 * Why it remembers WHICH src failed, not merely THAT one did:
 *   docs/RULES.md §2 — an HTTP error is never an empty state. Branching only on
 *   "is there a URL" meant a 404/401/502 from the image endpoint painted a
 *   blank circle: the initials fallback below existed but was unreachable,
 *   because the URL existed. Keying the failure to the source string means a
 *   fresh upload renders straight away with no effect needed to reset a flag,
 *   and a repeat failure of the same source cannot loop.
 *
 * Why no Next.js <Image>?
 *   The avatar URL is per-member and not known at build time. Vercel's image
 *   optimiser would issue a per-URL transform request — pointless when we
 *   already downscale to 256x256 WebP at upload time (Phase A2). Plain <img>
 *   is simpler, faster on cache hit, and keeps the bundle smaller.
 */
import { useState } from "react";
import { initials, colorSeedBucket, AVATAR_HUES } from "@/lib/initials";
import { toBlobProxyUrl } from "@/lib/blob-url";

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
  // The exact src string that failed to load, if any. Compared against the
  // current src so a different picture always gets its own attempt.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

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

  const src = pictureUrl ? toBlobProxyUrl(pictureUrl) ?? pictureUrl : null;

  if (src && src !== failedSrc) {
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
          src={src}
          alt={name}
          width={px}
          height={px}
          // A 200-member list otherwise fires 200 image requests on mount,
          // each one a serverless invocation plus a Blob API call.
          loading="lazy"
          decoding="async"
          onError={() => setFailedSrc(src)}
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
