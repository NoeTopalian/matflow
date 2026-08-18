"use client";

import {
  useEffect,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Shared overlay machinery for the Dialog and Sheet primitives
 * (docs/UI-RULES.md §4a.3, §5.3, §8).
 *
 * Everything the accessibility floor demands lives here exactly once:
 * `role="dialog"` + `aria-modal`, a title that labels the dialog, Escape to
 * close, a looping focus trap, scroll lock on the real scroll container, and
 * focus restoration to whatever opened the overlay. Dialog and Sheet differ
 * only in geometry, so they pass their own container/panel classes into
 * `OverlayShell` and inherit an identical behavioural contract.
 *
 * Surface note: the panel is a solid `--sf-*` surface with `--tx-*` text, the
 * same choice the Toast primitive settled on — a light panel with dark text
 * reads correctly floated over the light staff shell AND the dark member
 * shell, so nothing here hardcodes a polarity (§1).
 */

// ── Focus trap ───────────────────────────────────────────────────────────────

export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Tabbable descendants of `container`, in document order. */
export function getFocusable(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (el) =>
      !el.hasAttribute("hidden") &&
      el.getAttribute("aria-hidden") !== "true" &&
      el.getAttribute("tabindex") !== "-1",
  );
}

/**
 * Where Tab should send focus to keep it inside the overlay, or `null` to let
 * the browser do its normal thing. Pure so the trap logic is testable without
 * a real focus ring.
 */
export function nextFocusTarget(
  focusable: HTMLElement[],
  active: Element | null,
  shiftKey: boolean,
): HTMLElement | null {
  if (focusable.length === 0) return null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const index = active instanceof HTMLElement ? focusable.indexOf(active) : -1;

  // Focus has escaped the overlay (or never entered it) — pull it back.
  if (index === -1) return shiftKey ? last : first;
  if (shiftKey && active === first) return last;
  if (!shiftKey && active === last) return first;
  return null;
}

// ── Scroll lock ──────────────────────────────────────────────────────────────

/**
 * Freeze background scrolling. Locking `document.body` alone is not enough on
 * the staff dashboard: `app/dashboard/layout.tsx` scrolls `<main>`, not the
 * body. So we also walk up from whatever had focus when the overlay opened and
 * lock every scrollable ancestor. Returns the undo function.
 */
export function lockScroll(from: Element | null): () => void {
  if (typeof document === "undefined") return () => {};
  const locked: Array<[HTMLElement, string]> = [];
  const lock = (el: HTMLElement) => {
    locked.push([el, el.style.overflow]);
    el.style.overflow = "hidden";
  };

  lock(document.body);

  let node = from instanceof HTMLElement ? from.parentElement : null;
  while (node && node !== document.body) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") lock(node);
    node = node.parentElement;
  }

  return () => {
    for (const [el, previous] of locked) el.style.overflow = previous;
  };
}

// ── Hydration guard (portals need a real document) ───────────────────────────

const subscribeToNothing = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** `false` during SSR and the hydration pass, `true` once on the client. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribeToNothing, clientSnapshot, serverSnapshot);
}

// ── Escape stack ─────────────────────────────────────────────────────────────

/**
 * Open overlays, in mount order — the last entry is the topmost.
 *
 * Escape is handled on a `document` listener, so `stopPropagation` cannot stop
 * a sibling overlay's listener from firing: with two overlays stacked (a
 * ConfirmDialog opened from inside a Sheet) one Escape would close both. Only
 * the overlay at the top of this stack acts on Escape; the rest ignore it.
 */
const openOverlays: symbol[] = [];

// ── The behaviour hook ───────────────────────────────────────────────────────

export function useOverlay({
  open,
  onClose,
  panelRef,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  panelRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
}) {
  // Callers routinely pass an inline arrow for onClose. Reading it through a
  // ref keeps the effect below keyed on `open` alone, so the scroll lock and
  // initial focus are not torn down and rebuilt on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const releaseScroll = lockScroll(previouslyFocused);

    // Claim the top of the Escape stack for as long as this overlay is open.
    const escapeToken = Symbol("overlay");
    openOverlays.push(escapeToken);

    const panel = panelRef.current;
    const initial = initialFocusRef?.current ?? getFocusable(panel)[0] ?? panel;
    initial?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        // Topmost overlay only — see `openOverlays`.
        if (openOverlays[openOverlays.length - 1] !== escapeToken) return;
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const target = nextFocusTarget(
        getFocusable(panelRef.current),
        document.activeElement,
        event.shiftKey,
      );
      if (target) {
        event.preventDefault();
        target.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const index = openOverlays.indexOf(escapeToken);
      if (index !== -1) openOverlays.splice(index, 1);
      releaseScroll();
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open, panelRef, initialFocusRef]);
}

// ── The shared shell ─────────────────────────────────────────────────────────

/** What a bottom sheet has to clear on mobile (UI-RULES §5.3). */
export type NavClearance = "safe-area" | "member-nav";

export interface OverlayShellProps {
  open: boolean;
  onClose: () => void;
  /** Labels the dialog. Required — an unlabelled dialog fails §8. */
  title: string;
  /** Optional subtitle under the title; also wired to `aria-describedby`. */
  description?: string;
  children?: ReactNode;
  /** Action row pinned to the bottom of the panel. */
  footer?: ReactNode;
  /** Drop the header close button (blocking flows only). */
  hideClose?: boolean;
  /** Below the breakpoint the panel is a bottom sheet — this is what it clears. */
  navClearance?: NavClearance;
  /** Focus this on open instead of the panel's first focusable child. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  className?: string;
  /** Internal: geometry supplied by Dialog / Sheet. */
  slot: "dialog" | "sheet";
  containerClassName: string;
  panelClassName: string;
}

/**
 * Internal. Use `Dialog` or `Sheet` — they are this component with geometry.
 */
export function OverlayShell({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  hideClose = false,
  navClearance = "safe-area",
  initialFocusRef,
  className,
  slot,
  containerClassName,
  panelClassName,
}: OverlayShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const hydrated = useHydrated();
  const active = open && hydrated;

  useOverlay({ open: active, onClose, panelRef, initialFocusRef });

  if (!active) return null;

  return createPortal(
    <div className={containerClassName}>
      {/* Scrim — bg-black/60, never blurred (UI-RULES §4a.3). */}
      <div
        data-slot={`${slot}-scrim`}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 motion-safe:animate-in motion-safe:fade-in duration-[var(--dur-fast)] ease-[var(--ease-out)]"
      />

      <div
        ref={panelRef}
        data-slot={slot}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={cn(
          panelClassName,
          navClearance === "member-nav"
            ? "pb-[var(--member-nav-clearance)]"
            : "pb-safe",
          className,
        )}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-bd-default px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold text-tx-1">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-1 text-[13px] text-tx-2">
                {description}
              </p>
            ) : null}
          </div>
          {hideClose ? null : (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="ui-fixed-size relative -mr-1 flex size-8 shrink-0 items-center justify-center rounded-[var(--r-sm)] border border-bd-default text-tx-3 transition-colors hover:border-bd-hover hover:text-tx-1 before:absolute before:top-1/2 before:left-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-sm text-tx-2">
          {children}
        </div>

        {footer ? (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-bd-default px-5 py-4">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
