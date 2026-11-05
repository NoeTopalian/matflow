"use client";

/**
 * "Jump to date" on the Activity page. The timeline is continuous — a chosen
 * day is only where it STARTS: the list begins at the end of that club day and
 * carries on backwards. So there is no range and no "from": Today, Yesterday,
 * one day back, one day forward, or a date.
 *
 * Every day here is a CLUB day ("YYYY-MM-DD"). `todayKey` and `minDayKey` come
 * from the server; this component never asks the browser what day it is.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { shiftDay } from "@/lib/activity-url";

/** One height with the fields beside it: 36px with a mouse, 44px on a touch screen (UI-RULES §5a). */
const FIELD_BUTTON = "ui-fixed-size ui-field h-9";

export function JumpToDate({
  dayKey,
  todayKey,
  minDayKey,
  onChange,
  disabled = false,
}: {
  /** The chosen day, or null for today. */
  dayKey: string | null;
  todayKey: string;
  /** The first day the log reaches back to. */
  minDayKey: string;
  /** Null means today. */
  onChange: (dayKey: string | null) => void;
  disabled?: boolean;
}) {
  // Until the first answer arrives the club's today is not known: the controls are drawn, in place, but inert.
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(todayKey);
  const inert = disabled || !ready;
  const current = dayKey ?? todayKey;
  const yesterday = ready ? shiftDay(todayKey, -1) : "";
  /** Today is the absence of a day; nothing later than today or earlier than the log exists. */
  const go = (next: string) => onChange(next >= todayKey ? null : next < minDayKey ? minDayKey : next);

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="jump-to-date">
      <div className="flex items-center gap-1" role="group" aria-label="Day">
        <Button type="button" variant={ready && current === todayKey ? "primary" : "secondary"} aria-pressed={ready && current === todayKey} className={`${FIELD_BUTTON} px-3`} disabled={inert} onClick={() => onChange(null)}>
          Today
        </Button>
        <Button type="button" variant={ready && current === yesterday ? "primary" : "secondary"} aria-pressed={ready && current === yesterday} className={`${FIELD_BUTTON} px-3`} disabled={inert} onClick={() => go(yesterday)}>
          Yesterday
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <Button type="button" variant="ghost" aria-label="Previous day" className={`${FIELD_BUTTON} w-9 px-0`} disabled={inert || current <= minDayKey} onClick={() => go(shiftDay(current, -1))}>
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Button>
        <Input
          type="date"
          aria-label="Jump to date"
          className="w-[10rem]"
          value={current}
          min={minDayKey}
          max={todayKey}
          disabled={inert}
          onChange={(event) => {
            // An emptied or half-typed date is not a choice; wait for a whole one.
            if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) go(event.target.value);
          }}
        />
        <Button type="button" variant="ghost" aria-label="Next day" className={`${FIELD_BUTTON} w-9 px-0`} disabled={inert || current >= todayKey} onClick={() => go(shiftDay(current, 1))}>
          <ChevronRight className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

export default JumpToDate;
