"use client";

import { DIALOG_CONTAINER_CLASS, DIALOG_PANEL_CLASS, OverlayShell, type OverlayShellProps } from "./overlay";

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
      containerClassName={DIALOG_CONTAINER_CLASS}
      panelClassName={DIALOG_PANEL_CLASS}
    />
  );
}

export default Dialog;
