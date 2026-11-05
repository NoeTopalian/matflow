"use client";

/**
 * One session in the poster grid, staff side: the time range first, then the
 * class name in full, then the place when the column does not already say it,
 * then the tags. Nothing is clamped or clipped — the grid's rows grow to fit
 * (plan §4.7). The colour treatment is the timetable's own: a 12 % tint of
 * the class colour with neutral ink and a colour dot.
 */

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { hex } from "@/lib/color";
import { sessionStateLabel, type SessionState } from "@/lib/schedule-state";

const PILL = "inline-flex max-w-full items-center gap-1 rounded-full px-1 text-[9px] font-bold leading-4 tracking-wide [overflow-wrap:anywhere]";

function Pill({ children, tint, ink = "var(--tx-2)", upper = true, testId }: { children: ReactNode; tint?: string; ink?: string; upper?: boolean; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className={[PILL, upper ? "uppercase" : ""].join(" ")}
      style={{
        // An opaque base under the tint, so the pill's text keeps its contrast on a tinted chip.
        background: tint ? `color-mix(in srgb, ${tint} 14%, var(--sf-1))` : "var(--sf-2)",
        border: `1px solid ${tint ? `color-mix(in srgb, ${tint} 45%, var(--sf-1))` : "var(--bd-default)"}`,
        color: ink,
      }}
    >
      {children}
    </span>
  );
}

export function WeekChip({
  name,
  dayName,
  startTime,
  endTime,
  color,
  place,
  showPlace,
  state = null,
  duplicate = false,
  kids = false,
  category = null,
  canManage,
  onEdit,
}: {
  name: string;
  /** "Monday" — part of the accessible name. */
  dayName: string;
  startTime: string;
  endTime: string;
  /** The class's own colour, else the club's. */
  color: string;
  /** The mat, else the typed place, else the coach. */
  place: string | null;
  /** False where a pinned column header already names the mat. */
  showPlace: boolean;
  state?: SessionState | null;
  duplicate?: boolean;
  kids?: boolean;
  category?: string | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  const showState = state !== null && state !== "upcoming";
  const dim = state === "ended" || state === "cancelled";
  const label =
    `${canManage ? "Edit " : ""}${name}, ${dayName} ${startTime} to ${endTime}${place ? `, ${place}` : ""}` +
    `${showState ? ` (${sessionStateLabel(state).toLowerCase()})` : ""}${duplicate ? " (possible duplicate)" : ""}`;
  return (
    <Button
      variant="ghost"
      disabled={!canManage}
      onClick={onEdit}
      aria-label={label}
      data-session-state={state ?? undefined}
      className="h-auto min-h-[44px] flex-col items-stretch justify-start gap-0.5 whitespace-normal rounded-[var(--r-sm)] border-bd-hover px-[5px] pb-[6px] pt-[5px] text-left font-normal text-tx-1 hover:bg-transparent hover:text-tx-1 enabled:hover:brightness-[0.97] disabled:cursor-default disabled:opacity-100"
      style={{
        // Ended and cancelled sessions dim their fill, never their ink (UI-RULES §8).
        background: hex(color, dim ? 0.06 : 0.12),
        borderLeft: duplicate ? "3px solid var(--hue-warning)" : state === "live" ? `3px solid ${color}` : undefined,
      }}
    >
      <span className="flex flex-wrap items-center text-[11px] font-bold leading-[14px] tabular-nums" data-chip-part="time">
        <span aria-hidden="true" className="mr-[3px] size-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span>{startTime}–</span>
        <span>{endTime}</span>
      </span>
      <span className={["text-xs font-semibold leading-[15px] [overflow-wrap:anywhere] hyphens-auto", state === "cancelled" ? "line-through" : ""].join(" ")} data-chip-part="name">
        {name}
      </span>
      {showPlace && place ? (
        <span className="line-clamp-2 text-[11px] leading-[14px] text-tx-2 [overflow-wrap:anywhere]" data-chip-part="place">
          {place}
        </span>
      ) : null}
      {showState || duplicate || kids || category ? (
        <span className="mt-px flex flex-wrap gap-[3px]">
          {showState ? (
            <Pill
              tint={state === "live" ? "var(--hue-success)" : state === "next" ? "var(--hue-info)" : undefined}
              ink={state === "live" ? "var(--hue-success-ink)" : state === "next" ? "var(--hue-info-ink)" : "var(--tx-2)"}
            >
              {state === "live" ? <span aria-hidden="true" className="size-1.5 rounded-full motion-safe:animate-pulse" style={{ background: "var(--hue-success)" }} /> : null}
              {sessionStateLabel(state)}
            </Pill>
          ) : null}
          {duplicate ? (
            <Pill tint="var(--hue-warning)" ink="var(--tx-1)">
              Duplicate?
            </Pill>
          ) : null}
          {kids ? <Pill>Kids</Pill> : null}
          {category ? (
            <Pill upper={false} testId="class-chip-category">
              {category}
            </Pill>
          ) : null}
        </span>
      ) : null}
    </Button>
  );
}

/** The folded classes of a clash wider than three lanes: one dashed button in the last lane. */
export function MoreChip({ count, label, hint, onOpen }: { count: number; label: string; hint: string; onOpen: () => void }) {
  return (
    <Button
      variant="ghost"
      onClick={onOpen}
      aria-label={label}
      data-testid="week-more"
      className="h-auto min-h-[44px] flex-col items-stretch justify-start gap-0.5 whitespace-normal rounded-[var(--r-sm)] border-dashed border-bd-active bg-sf-1 px-[5px] pb-[6px] pt-[5px] text-left font-normal text-tx-1 hover:bg-sf-1 hover:text-tx-1"
    >
      <span className="text-xs font-semibold leading-[15px]">+{count} more</span>
      <span className="text-[11px] leading-[14px] text-tx-2">
        {hint}
      </span>
    </Button>
  );
}
