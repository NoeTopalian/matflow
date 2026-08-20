"use client";

import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

/**
 * Card primitive — see docs/UI-RULES.md §1.5 and §5.
 *
 * ONE treatment: `--sf-1` surface, hairline `--bd-default` border, `--r-md`
 * radius, `--pad-card` padding, no shadow. Being the only card kills the
 * white-in-white nesting the audit found (cards inside cards inside panels,
 * each inventing its own border and radius).
 *
 * The only knob is padding, because a card that scrolls a table or hosts a
 * chart needs to own its own inset:
 *   - `card`  (default) — `--pad-card` (p-6), the calm-shell spacing
 *   - `tight` — p-4, for dense list items and mobile row cards
 *   - `none`  — the child owns all padding (tables, media)
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "card" | "tight" | "none";
}

const PADDING: Record<NonNullable<CardProps["padding"]>, string> = {
  card: "p-[var(--pad-card)]",
  tight: "p-4",
  none: "",
};

export function Card({ padding = "card", className, ...props }: CardProps) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-[var(--r-md)] border border-bd-default bg-sf-1",
        PADDING[padding],
        className,
      )}
      {...props}
    />
  );
}

export default Card;
