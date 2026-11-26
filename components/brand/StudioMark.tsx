import Image from "next/image";

/**
 * MatFlow's own mark: the approved MF tile with STUDIO in the patch underneath
 * (brand/app-icon-mf-studio.svg, generated to public/icons/icon-512.png by
 * scripts/generate-brand-icons.mjs). Used wherever MatFlow shows its own logo;
 * never for a club, whose logo or initials stay its own.
 *
 * Size: STUDIO is drawn at about 7.7% of the tile's height, so the tile is at
 * least 72 CSS px wherever it appears; at 64 px and below STUDIO is not
 * readable at normal zoom (measured on rendered pages, 26 Nov 2026).
 * The 512 px file keeps it sharp on 3x phone screens. "?v=2" because
 * public/sw.js keeps /icons/ cache-first, so installed browsers would
 * otherwise keep showing the previous artwork.
 *
 * Decorative (alt=""): every placement has the word MatFlow next to it.
 *
 * Loading: eager by default, because the sign-in screen, the application
 * header and the landing bar show it on the first screen; next/image's own
 * default (lazy) left it unpainted until after layout on a cold load. Only a
 * placement below the fold (the landing footer) passes loading="lazy".
 */
export const STUDIO_MARK_SRC = "/icons/icon-512.png?v=2";
export const STUDIO_MARK_MIN_PX = 72;

export function StudioMark({ size = STUDIO_MARK_MIN_PX, className = "", loading = "eager" }: { size?: number; className?: string; loading?: "eager" | "lazy" }) {
  return (
    <Image
      src={STUDIO_MARK_SRC}
      alt=""
      width={size}
      height={size}
      unoptimized
      loading={loading}
      data-studio-mark=""
      className={`shrink-0 ${className}`.trim()}
    />
  );
}
