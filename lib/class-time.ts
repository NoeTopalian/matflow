/**
 * Shared time helpers for class scheduling.
 * Used by the checkin API route and the member portal self-check-in UI.
 */

export function parseTime(hhmm: string, baseDate: Date): Date {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(baseDate);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d;
}

function formatHHmm(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, "0")} ${ampm}`;
}

export type ClassStatusVariant = "future" | "soon" | "ongoing" | "ended";

export interface ClassStatus {
  label: string;
  variant: ClassStatusVariant;
}

export function classStatus(
  inst: { date: Date; startTime: string; endTime: string },
  now: Date = new Date(),
): ClassStatus {
  const start = parseTime(inst.startTime, inst.date);
  const end = parseTime(inst.endTime, inst.date);
  const minToStart = (start.getTime() - now.getTime()) / 60_000;

  if (now > end) return { label: "Ended", variant: "ended" };
  if (now >= start) return { label: "Ongoing", variant: "ongoing" };
  if (minToStart <= 60)
    return { label: `Starts in ${Math.ceil(minToStart)} min`, variant: "soon" };
  return { label: `Starts at ${formatHHmm(start)}`, variant: "future" };
}
