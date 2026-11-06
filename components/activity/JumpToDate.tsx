"use client";

/**
 * The day button on the Activity page, and the sheet it opens. The timeline is
 * continuous — a chosen day is only where it STARTS: the list begins at the
 * end of that club day and carries on backwards. So there is no range and no
 * "from": Today, Yesterday, one day back, one day forward, or a date.
 *
 * The button says which day the list starts at ("Today", "Yesterday",
 * "Thu 5 Nov"); everything else is in the sheet (there is no popover
 * primitive — UI-RULES §4a.3). Today and Yesterday apply and close; the day
 * steps and the date field apply at once and leave the sheet open, so a
 * person can walk back a day at a time.
 *
 * Every day here is a CLUB day ("YYYY-MM-DD"). `todayKey` and `minDayKey` come
 * from the server; this component never asks the browser what day it is.
 */
import { useState } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { formatDayLabel } from "@/lib/date";
import { shiftDay } from "@/lib/activity-url";

/** One height with the fields beside it: 36px with a mouse, 44px on a touch screen (UI-RULES §5a). */
const FIELD_BUTTON = "ui-fixed-size ui-field h-9";
/** The pressed day keeps a dark border, so it still reads as pressed when the club's accent is white (UI-RULES §2a). */
const PRESSED = "border-[var(--tx-2)]";

/** "Today", "Yesterday", or "Thu 5 Nov" — what the day button says. */
export function dayButtonLabel(dayKey: string | null, todayKey: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey) || !dayKey || dayKey === todayKey) return "Today";
  if (dayKey === shiftDay(todayKey, -1)) return "Yesterday";
  // Noon UTC names the calendar date in any zone.
  return formatDayLabel(`${dayKey}T12:00:00Z`, "UTC");
}

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
  const [open, setOpen] = useState(false);
  // Until the first answer arrives the club's today is not known: the button is drawn, in place, but inert.
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(todayKey);
  const inert = disabled || !ready;
  const current = dayKey ?? todayKey;
  const yesterday = ready ? shiftDay(todayKey, -1) : "";
  /** Today is the absence of a day; nothing later than today or earlier than the log exists. */
  const go = (next: string) => onChange(next >= todayKey ? null : next < minDayKey ? minDayKey : next);
  const label = dayButtonLabel(dayKey, todayKey);

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        className={`${FIELD_BUTTON} gap-2 bg-sf-1 px-3 font-normal`}
        aria-haspopup="dialog"
        aria-label={`Day: ${label}`}
        disabled={inert}
        onClick={() => setOpen(true)}
        data-testid="date-button"
      >
        <CalendarDays className="size-4 shrink-0 text-tx-3" aria-hidden="true" />
        <span className="whitespace-nowrap">{label}</span>
        <ChevronDown className="size-4 shrink-0 text-tx-3" aria-hidden="true" />
      </Button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Jump to date"
        description="The list starts at the end of the day you choose and carries on back from there."
        footer={
          <Button type="button" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="space-y-4" data-testid="jump-to-date">
          <div className="flex items-center gap-2" role="group" aria-label="Day">
            <Button
              type="button"
              variant={ready && current === todayKey ? "primary" : "secondary"}
              aria-pressed={ready && current === todayKey}
              className={`${FIELD_BUTTON} px-3 ${ready && current === todayKey ? PRESSED : ""}`}
              disabled={inert}
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Today
            </Button>
            <Button
              type="button"
              variant={ready && current === yesterday ? "primary" : "secondary"}
              aria-pressed={ready && current === yesterday}
              className={`${FIELD_BUTTON} px-3 ${ready && current === yesterday ? PRESSED : ""}`}
              disabled={inert}
              onClick={() => {
                go(yesterday);
                setOpen(false);
              }}
            >
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
      </Sheet>
    </>
  );
}

export default JumpToDate;
