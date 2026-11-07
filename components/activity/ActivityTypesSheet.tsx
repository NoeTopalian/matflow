"use client";

/**
 * Choose which kinds of activity to show. Opens in the Sheet (the one overlay
 * standard, UI-RULES §4a.3): a slide-over on a laptop, a bottom sheet on a
 * phone.
 *
 * The selection is STAGED: ticking changes nothing behind the sheet until
 * the apply button is pressed, so twenty ticks cost one request, and Cancel,
 * Escape and the scrim all leave the page exactly as it was. "None" is not a
 * state — with nothing ticked the button is disabled and says why.
 *
 * Only the types this person may see are listed; the server enforces the same
 * list whatever is asked for.
 */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet } from "@/components/ui/sheet";
import { ACTIVITY_GROUPS, ACTIVITY_TYPES, defaultTypeKeys, visibleTypeKeys, type ActivityRole } from "@/lib/activity-types";
import { ActivityIcon } from "./activity-icons";

/** The row is the hit area, so the box's own 44px overlay is switched off inside it. */
const ROW = "flex min-h-11 cursor-pointer items-center gap-3 px-4 hover:bg-sf-2 [@media(pointer:fine)]:lg:min-h-9";

export function ActivityTypesSheet({
  open,
  onClose,
  role,
  selected,
  onApply,
  applyLabel = "Show activity",
}: {
  open: boolean;
  onClose: () => void;
  role: ActivityRole;
  /** What the page is showing now. */
  selected: string[];
  /** Called once, with the new selection, when the apply button is pressed. */
  onApply: (keys: string[]) => void;
  /** The apply button's words: "Show activity" when it changes the list, "Done" when it hands back to another sheet. */
  applyLabel?: string;
}) {
  // Mounted only while open, so the staged copy always starts from what the page is showing.
  if (!open) return null;
  return <Staged onClose={onClose} role={role} selected={selected} onApply={onApply} applyLabel={applyLabel} />;
}

function Staged({ onClose, role, selected, onApply, applyLabel }: { onClose: () => void; role: ActivityRole; selected: string[]; onApply: (keys: string[]) => void; applyLabel: string }) {
  const visible = visibleTypeKeys(role);
  const [staged, setStaged] = useState<Set<string>>(() => new Set(selected.filter((k) => visible.includes(k))));
  const types = ACTIVITY_TYPES.filter((t) => visible.includes(t.key));
  const count = staged.size;

  const set = (keys: string[], on: boolean) =>
    setStaged((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });

  return (
    <Sheet
      open
      onClose={onClose}
      title="Activity types"
      description="Choose which activity to show."
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-tx-3" role="status">
            {count === 0 ? "Choose at least one activity type" : null}
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={count === 0}
              onClick={() => {
                // In taxonomy order, whatever order they were ticked in.
                onApply(visible.filter((k) => staged.has(k)));
                onClose();
              }}
            >
              {applyLabel}
            </Button>
          </div>
        </div>
      }
    >
      {/* Full-bleed inside the Sheet's padded body: the rows run edge to edge and the bar pins to the very top. */}
      <div className="-mx-5 -my-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-bd-default bg-sf-3 px-4 py-2">
        <Button type="button" variant="secondary" size="compact" onClick={() => setStaged(new Set(defaultTypeKeys(role)))}>
          Club activity
        </Button>
        <Button type="button" variant="secondary" size="compact" onClick={() => setStaged(new Set(visible))}>
          Everything
        </Button>
        <p className="ml-auto text-xs text-tx-3" aria-live="polite" data-testid="types-count">
          {count} of {types.length} selected
        </p>
      </div>

      {ACTIVITY_GROUPS.map((group) => {
        const inGroup = types.filter((t) => t.group === group);
        if (inGroup.length === 0) return null;
        const ticked = inGroup.filter((t) => staged.has(t.key)).length;
        const state = ticked === 0 ? false : ticked === inGroup.length ? true : "mixed";
        return (
          <fieldset key={group} className="border-b border-bd-default py-1 last:border-b-0">
            <legend className="sr-only">{group}</legend>
            <label className={`${ROW} font-medium text-tx-1`}>
              <Checkbox className="before:hidden" checked={state} onCheckedChange={(on) => set(inGroup.map((t) => t.key), on)} aria-label={`${group}: all`} />
              <span className="text-sm">{group}</span>
            </label>
            {inGroup.map((t) => (
              <label key={t.key} className={`${ROW} pl-9`}>
                <Checkbox className="before:hidden" checked={staged.has(t.key)} onCheckedChange={(on) => set([t.key], on)} aria-label={t.label} />
                <ActivityIcon name={t.icon} className="size-3.5 shrink-0 text-tx-3" />
                <span className="text-sm text-tx-1">{t.label}</span>
              </label>
            ))}
          </fieldset>
        );
      })}
      </div>
    </Sheet>
  );
}

export default ActivityTypesSheet;
