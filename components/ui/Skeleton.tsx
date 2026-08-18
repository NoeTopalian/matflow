import { cn } from "@/lib/utils";

/**
 * Skeleton — token-driven so it is visible on BOTH shells (UI-RULES §5.5).
 *
 * The old `bg-white/5` fill was white-on-white on the light staff shell:
 * every dashboard loading state rendered as blank space. `currentColor`
 * inherits the surrounding text colour, so the bar is dark on the light
 * staff shell and light on the dark member shell without either polarity
 * being hardcoded (§1).
 */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-lg bg-[color-mix(in_srgb,currentColor_12%,transparent)]",
        className,
      )}
      aria-hidden="true"
    />
  );
}
