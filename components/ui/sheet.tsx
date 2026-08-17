"use client";

import { OverlayShell, type OverlayShellProps } from "./overlay";

/**
 * Sheet primitive — the slide-over half of the one overlay standard
 * (docs/UI-RULES.md §4a.3). Use it for anything with scrolling content or a
 * multi-field form; short confirms belong in `Dialog`.
 *
 * Geometry: at `lg:` and up it is a right-edge slide-over,
 * `w-full max-w-[480px] h-full border-l`, sliding in over `--dur-normal` with
 * `--ease-out` (the DashboardStats to-do panel, made accessibility-complete).
 * Below `lg:` it is a bottom sheet that clears the fixed navs — member
 * surfaces pass `navClearance="member-nav"`, staff mobile keeps the
 * safe-area default (§5.3). All motion sits behind `motion-safe:`, so
 * `prefers-reduced-motion` gets the panel with no travel.
 *
 * Behaviour is identical to Dialog: role="dialog", aria-modal, labelled by
 * the title, Escape closes, focus trapped and restored, scroll locked, scrim
 * `bg-black/60` with no blur.
 */
export type SheetProps = Omit<
  OverlayShellProps,
  "slot" | "containerClassName" | "panelClassName"
>;

export function Sheet(props: SheetProps) {
  return (
    <OverlayShell
      {...props}
      slot="sheet"
      containerClassName="fixed inset-0 z-50 flex items-end lg:items-stretch lg:justify-end"
      panelClassName={[
        "relative flex w-full max-h-[calc(100dvh-2rem)] flex-col overflow-hidden",
        "border-t border-bd-default bg-sf-3 rounded-t-[var(--r-lg)]",
        "lg:h-full lg:max-h-none lg:max-w-[480px] lg:rounded-none lg:border-t-0 lg:border-l lg:pb-0",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom",
        "lg:motion-safe:slide-in-from-bottom-0 lg:motion-safe:slide-in-from-right",
        "duration-[var(--dur-normal)] ease-[var(--ease-out)]",
      ].join(" ")}
    />
  );
}

export default Sheet;
