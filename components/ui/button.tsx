"use client";

import { forwardRef } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Button primitive — see docs/UI-RULES.md §5 and §5a (control geometry).
 *
 * Variants: primary (tenant accent), secondary, ghost, destructive.
 * Sizes: default (h-9 / 36px), compact (h-8 / 32px, dense tables),
 * mobile (h-11 / 44px, primary mobile CTAs).
 *
 * The compact size is fixed-geometry (`.ui-fixed-size`) and meets the
 * WCAG 44px floor with a `::before` hit-area overlay rather than by
 * inflating the visual control. `loading` shows a spinner and disables
 * the button, preventing double-submit (UI-RULES §6).
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--r-md)] border border-transparent text-sm font-medium whitespace-nowrap transition-colors select-none outline-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--color-primary)] text-[var(--tx-on-accent)] hover:opacity-90",
        secondary:
          "bg-sf-2 text-tx-1 border-bd-default hover:border-bd-hover",
        ghost: "text-tx-2 hover:bg-sf-2 hover:text-tx-1",
        destructive:
          "bg-[var(--sf-danger)] text-[var(--tx-on-danger)] hover:opacity-90",
      },
      size: {
        default: "h-9 px-4",
        compact:
          "ui-fixed-size relative h-8 px-3 text-[13px] before:absolute before:inset-x-0 before:top-1/2 before:h-11 before:-translate-y-1/2 before:content-['']",
        mobile: "h-11 px-5",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Shows a spinner and disables the button while true. */
  loading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
});

export { Button, buttonVariants };
