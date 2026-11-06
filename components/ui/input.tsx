"use client";

import { forwardRef, type InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * Input primitive — docs/UI-RULES.md §5 item 2 (the required set) and §5a
 * (control geometry). The companion of `Select`: the native text field
 * restyled to tokens, so it reads correctly on the light staff shell and the
 * dark member shell, and keeps the platform's own behaviour (date picker,
 * search keyboard, autofill) for free.
 *
 * GEOMETRY IS FIXED BY THE CALLER. The field fills the width it is given and
 * is 36px tall on a fine pointer; on a coarse pointer it grows to the 44px
 * floor (a replaced element cannot carry the `::before` hit-area overlay the
 * compact Button uses — the rule is in app/globals.css beside the Select's).
 *
 * `aria-label` is required: a field with no accessible name is the commonest
 * failure the input-accessible-names scan catches. A visible caption above the
 * field does not replace it unless it is wired with `htmlFor`.
 *
 * No `outline-none`: the base-layer :focus-visible ring is the keyboard focus
 * indicator (§8 — never regress it).
 */
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  "aria-label": string;
}

const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, "aria-label": ariaLabel, type = "text", ...props }, ref) {
  return (
    <input
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      data-slot="input"
      className={cn(
        "ui-fixed-size h-9 w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 text-sm text-tx-1 transition-colors placeholder:text-tx-3 hover:border-bd-hover disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
});

export { Input };
