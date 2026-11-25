"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "./button";
import { useOverlay } from "./overlay";

/**
 * Popover primitive — a small titled panel hung from the control that opened
 * it, for a short list to choose from on a wide window (the staff register's
 * class picker, 25 Nov 2026). Where there is no room for it, callers use
 * `Sheet` instead: `placePopover` makes that choice.
 *
 * Behaviour is the overlay standard's (`useOverlay`): role="dialog",
 * aria-modal, labelled by its title, Escape closes, focus loops inside and
 * returns to the opener, background scroll is locked. A whole-screen layer
 * sits under the panel and takes the tap that dismisses it, so that tap never
 * also lands on whatever is underneath, and nothing behind can be tapped
 * while it is open.
 */

export type PopoverPlacement = { left: number; width: number; maxHeight: number; top?: number; bottom?: number };

const WIDTH = 420;
const MIN_HEIGHT = 280;
const EDGE = 12;
const GAP = 4;

/**
 * Where a popover hung from `anchor` goes: below it when a usable list fits
 * there, else above, kept inside the window's edges. `null` when the window
 * is narrow or neither side has room — use a Sheet. Pure, so the choice can
 * be tested without a browser.
 */
export function placePopover(
  anchor: { top: number; bottom: number; left: number },
  viewport: { width: number; height: number },
): PopoverPlacement | null {
  if (viewport.width < 1024) return null;
  const below = viewport.height - anchor.bottom - EDGE - GAP;
  const above = anchor.top - EDGE - GAP;
  if (Math.max(below, above) < MIN_HEIGHT) return null;
  const width = Math.min(WIDTH, viewport.width - 2 * EDGE);
  const left = Math.max(EDGE, Math.min(anchor.left, viewport.width - width - EDGE));
  return below >= MIN_HEIGHT || below >= above
    ? { left, width, maxHeight: Math.min(below, 560), top: anchor.bottom + GAP }
    : { left, width, maxHeight: Math.min(above, 560), bottom: viewport.height - anchor.top + GAP };
}

export function Popover({
  placement,
  title,
  description,
  onClose,
  initialFocusRef,
  children,
}: {
  placement: PopoverPlacement;
  title: string;
  description?: string;
  onClose: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  useOverlay({ open: true, onClose, panelRef, initialFocusRef });
  // The control it hangs from moves when the window changes size: close rather than float.
  useEffect(() => {
    window.addEventListener("resize", onClose);
    return () => window.removeEventListener("resize", onClose);
  }, [onClose]);
  return createPortal(
    <div
      className="fixed inset-0 z-50"
      data-slot="popover-layer"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-slot="popover"
        className="fixed flex flex-col overflow-hidden rounded-[var(--r-md)] border border-bd-default bg-sf-3 shadow-lg outline-none"
        style={{ left: placement.left, width: placement.width, maxHeight: placement.maxHeight, top: placement.top, bottom: placement.bottom }}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-bd-default px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-sm font-semibold text-tx-1">{title}</h2>
            {description && <p id={descriptionId} className="text-[13px] text-tx-3">{description}</p>}
          </div>
          <Button variant="secondary" size="compact" onClick={onClose}>Close</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export default Popover;
