"use client";

import { OverlayShell, type OverlayShellProps } from "./overlay";

/**
 * Dialog primitive — the centred half of the one overlay standard
 * (docs/UI-RULES.md §4a.3). Use it for confirms and short forms; anything
 * with scrolling content or a multi-field form belongs in `Sheet`.
 *
 * Geometry: centred, capped at `max-w-lg`, `max-h-[calc(100dvh-2rem)]` with
 * the body region scrolling so the header and action row stay pinned. Below
 * `sm:` it becomes a bottom sheet (top-rounded, bottom-anchored) that clears
 * the fixed mobile nav via `navClearance` (§5.3).
 *
 * Behaviour comes from `OverlayShell`: role="dialog", aria-modal, labelled by
 * the title, Escape closes, focus is trapped and restored, background scroll
 * is locked, and the scrim is `bg-black/60` with no backdrop blur.
 */
export type DialogProps = Omit<
  OverlayShellProps,
  "slot" | "containerClassName" | "panelClassName"
>;

export function Dialog(props: DialogProps) {
  return (
    <OverlayShell
      {...props}
      slot="dialog"
      containerClassName="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
      panelClassName={[
        "relative flex w-full max-h-[calc(100dvh-2rem)] flex-col overflow-hidden",
        "border border-bd-default bg-sf-3",
        "rounded-t-[var(--r-lg)] sm:max-w-lg sm:rounded-[var(--r-md)] sm:pb-0",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom",
        "sm:motion-safe:slide-in-from-bottom-0 sm:motion-safe:zoom-in-95",
        "duration-[var(--dur-normal)] ease-[var(--ease-out)]",
      ].join(" ")}
    />
  );
}

export default Dialog;
