"use client";

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Tab bar primitive — the underline rail first drawn on the member profile,
 * shared so every page with sections or views uses one look.
 *
 * The active tab is underlined in the tenant accent — the one place colour is
 * allowed to appear (UI-RULES §1.5.3) — through the runtime CSS variable, so it
 * stays correct under any tenant palette (§2a). The old `border-white` active
 * state painted nothing on the light staff shell (§4a.5).
 *
 * `TabList` owns the rail and the keyboard: Left/Right move to the previous or
 * next tab and activate it, Home/End the first and last. A page that wants a
 * single Tab stop gives the selected tab `tabIndex={0}` and the rest `-1`.
 *
 * On a narrow screen the rail scrolls sideways; the selected tab is kept in
 * view (sideways only — the page itself is never scrolled), so a link that
 * opens on the last tab does not hide which tab is shown.
 */
export function TabList({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const rail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = rail.current;
    const selected = box?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!box || !selected || box.scrollWidth <= box.clientWidth) return;
    // Measured against the rail itself, whatever the tabs' offset parent is.
    const left = selected.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft;
    if (left < box.scrollLeft) box.scrollLeft = left;
    else if (left + selected.offsetWidth > box.scrollLeft + box.clientWidth) box.scrollLeft = left + selected.offsetWidth - box.clientWidth;
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')];
    const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1 || tabs.length === 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (at + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  };
  return (
    <div ref={rail} role="tablist" aria-label={label} onKeyDown={onKeyDown} className={cn("flex overflow-x-auto border-b border-bd-default scrollbar-hide lg:overflow-x-visible", className)}>
      {children}
    </div>
  );
}

export function Tab({ label, active, onClick, count, tabIndex }: { label: ReactNode; active: boolean; onClick: () => void; count?: number; tabIndex?: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={tabIndex}
      onClick={onClick}
      className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
        active
          ? "text-tx-1"
          : "border-transparent text-tx-3 hover:border-bd-hover hover:text-tx-2"
      }`}
      style={active ? { borderColor: "var(--color-primary)" } : undefined}
    >
      {label}{count !== undefined ? ` (${count})` : ""}
    </button>
  );
}
