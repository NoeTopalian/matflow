"use client";

import { cn } from "@/lib/utils";

/**
 * Switch primitive — see docs/UI-RULES.md §5a (control geometry).
 *
 * Hard geometry: track 40×22px, thumb 18px with 2px inset, 18px travel,
 * `var(--dur-fast) var(--ease-out)` transition. Pixel values live on the
 * element so no context, global CSS or text length can stretch it.
 * `.ui-fixed-size` opts out of the global 44px min-height; the WCAG floor
 * is met by a centred 44×44px `::before` hit-area overlay instead.
 *
 * Controlled component: pass `checked` and `onCheckedChange`. Native
 * <button> semantics give Space/Enter activation for free.
 */
export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export function Switch({
  checked,
  onCheckedChange,
  disabled = false,
  id,
  className,
  ...aria
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "ui-fixed-size relative inline-flex shrink-0 cursor-pointer rounded-full border border-transparent disabled:cursor-not-allowed disabled:opacity-50",
        // ≥44px hit area without inflating the visual control (§5a)
        "before:absolute before:top-1/2 before:left-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        className,
      )}
      style={{
        width: 40,
        height: 22,
        background: checked ? "var(--color-primary)" : "var(--bd-active)",
        transition: "background var(--dur-fast) var(--ease-out)",
      }}
      {...aria}
    >
      <span
        aria-hidden="true"
        className="absolute rounded-full"
        style={{
          width: 18,
          height: 18,
          top: 2,
          left: 2,
          background: "var(--sf-1)",
          // Hairline so the thumb stays visible when the tenant accent is
          // white/near-white (UI-RULES §2a worst-case accents). Longhands, not
          // the `border` shorthand — CSSOM drops the whole shorthand when it
          // can't eagerly parse color-mix(var()), computing width 0.
          borderWidth: 1,
          borderStyle: "solid",
          borderColor: "color-mix(in srgb, var(--tx-1) 25%, transparent)",
          boxShadow: "0 1px 2px color-mix(in srgb, var(--tx-1) 25%, transparent)",
          transform: checked ? "translateX(18px)" : "translateX(0)",
          transition: "transform var(--dur-fast) var(--ease-out)",
        }}
      />
    </button>
  );
}
