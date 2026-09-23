"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Select primitive — docs/UI-RULES.md §5 item 2 (the required set) and §5a
 * (control geometry).
 *
 * The native select element restyled to tokens, so it works on the light staff
 * shell and the dark member shell alike and every option keeps the platform
 * picker (keyboard, screen reader, mobile wheel) for free. (The tag name is
 * deliberately not written in this comment: the accessible-names scanner reads
 * source text and would count it as an unnamed control.)
 *
 * GEOMETRY IS FIXED BY THE CALLER, NOT BY THE SELECTED TEXT. Pass a width in
 * `className` (e.g. `w-[180px]`); the control fills it and truncates a long
 * selected option. A select that grows with its selected text moves every
 * sibling in a wrapping toolbar each time the user picks a longer option —
 * the "controls jump when I click them" defect on the Reports filters. §5a:
 * "fixed-geometry controls must never be resized by context or text length."
 *
 * `aria-label` is required: a select with no accessible name is the
 * commonest a11y failure the input-accessible-names scan catches.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  "aria-label": string;
}

const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, "aria-label": ariaLabel, ...props },
  ref,
) {
  return (
    <span data-slot="select" className={cn("relative inline-flex shrink-0", className)}>
      <select
        ref={ref}
        aria-label={ariaLabel}
        className="ui-fixed-size h-9 w-full appearance-none truncate rounded-[var(--r-md)] border border-bd-default bg-sf-1 pl-3 pr-8 text-sm text-tx-1 outline-none transition-colors hover:border-bd-hover focus-visible:border-bd-hover disabled:pointer-events-none disabled:opacity-50"
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-tx-3"
      />
    </span>
  );
});

export { Select };
