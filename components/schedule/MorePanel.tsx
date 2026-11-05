"use client";

/**
 * The opened "+N more" on a one-day grid (the staff phone, the members' day):
 * every class of a clash too wide to draw side by side, as full-width rows,
 * then "Show fewer". PosterDay places it over the grid; the surface gives the
 * rows and the paint.
 *
 * Behaviour, the same on both surfaces: focus goes to the first row when it
 * opens; Escape and "Show fewer" close it and hand focus back to the "+N more"
 * button; moving focus out of it (Tab past the last row, a tap elsewhere)
 * closes it and leaves focus where it went.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Press handlers for a "+N more" button that opens a panel in place.
 *
 * Pressing the button while its panel is open takes focus out of the panel,
 * which closes it (below) BEFORE the click arrives; a plain toggle would then
 * open it again, so the button could never close its own panel. Whether the
 * panel was open is read at pointer-down, which comes first. A keyboard press
 * has no pointer-down: the panel is always closed by the time focus is on the
 * button, so it opens.
 */
export function useMoreToggle(expanded: boolean, onOpen: () => void, onClose?: () => void) {
  const wasOpen = useRef(false);
  return {
    onPointerDown: () => {
      wasOpen.current = expanded;
    },
    onClick: () => {
      const closing = wasOpen.current;
      wasOpen.current = false;
      if (closing) onClose?.();
      else onOpen();
    },
  };
}

export function MorePanel({
  label,
  onClose,
  children,
  className = "",
  style,
  closeClassName = "",
}: {
  /** Accessible name: "5 classes, 10:00 to 11:00". */
  label: string;
  /** `returnFocus`: the reader closed it on purpose, so focus belongs back on the "+N more" button. */
  onClose: (returnFocus: boolean) => void;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  closeClassName?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("button:not([disabled]), a[href]")?.focus();
  }, []);
  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      data-testid="more-panel"
      className={["flex flex-col gap-1 rounded-[var(--r-md)] border border-bd-active p-1", className].join(" ")}
      style={style}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose(true);
      }}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (!next || !root.current?.contains(next)) onClose(false);
      }}
    >
      {children}
      <Button variant="ghost" size="compact" onClick={() => onClose(true)} className={["w-full text-[11px] font-semibold", closeClassName].join(" ")}>
        Show fewer
      </Button>
    </div>
  );
}
