"use client";

import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Checkbox primitive — see docs/UI-RULES.md §5a (control geometry).
 *
 * Fixed 18×18px visual, 2px border, `--r-sm` radius. `.ui-fixed-size`
 * opts out of the global 44px min-height; the WCAG floor is met by a
 * centred 44×44px `::before` hit-area overlay. Accent fill uses the
 * tenant `--color-primary`.
 *
 * Controlled component: pass `checked` and `onCheckedChange`. Native
 * <button> semantics give Space/Enter activation for free.
 */
export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled = false,
  id,
  className,
  ...aria
}: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "ui-fixed-size relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[var(--r-sm)] border-2 disabled:cursor-not-allowed disabled:opacity-50",
        // ≥44px hit area without inflating the visual control (§5a)
        "before:absolute before:top-1/2 before:left-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
        className,
      )}
      style={{
        width: 18,
        height: 18,
        background: checked ? "var(--color-primary)" : "transparent",
        borderColor: checked ? "var(--color-primary)" : "var(--bd-active)",
        transition:
          "background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
      }}
      {...aria}
    >
      {checked && (
        <Check
          className="size-3"
          strokeWidth={3}
          aria-hidden="true"
          style={{ color: "var(--tx-on-accent)" }}
        />
      )}
    </button>
  );
}
