// One way to find a day of the staff week grid, for every timetable test. The
// grid is `data-testid="week-grid"` and each day a `data-day="mon"` group
// (components/schedule/PosterGrid.tsx). Tests used to reach for the layout's
// own class names, so a layout change broke a dozen files at once.

const SLUGS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export const weekGrid = (container: HTMLElement): HTMLElement | null => container.querySelector('[data-testid="week-grid"]');

/**
 * A day of the week grid: `"mon"` / `"Mon"` / `"Monday"`, or an index with
 * 0 = Monday. Throws when the week grid is not on the page, so a wrong selector
 * can never read as "no chips".
 */
export function weekDay(container: HTMLElement, day: string | number): HTMLElement {
  const grid = weekGrid(container);
  if (!grid) throw new Error("the week grid is not rendered");
  const slug = typeof day === "number" ? SLUGS[day] : day.slice(0, 3).toLowerCase();
  const el = grid.querySelector<HTMLElement>(`[data-day="${slug}"]`);
  if (!el) throw new Error(`the week grid has no day "${slug}"`);
  return el;
}

/** The session cells of a day, in DOM (time, then column) order. */
export const weekCells = (dayEl: HTMLElement): HTMLElement[] => Array.from(dayEl.querySelectorAll<HTMLElement>("[data-cell-key]"));

/** The chip buttons of a day, in DOM order ("+N more" is not one of them). */
export const weekChips = (dayEl: HTMLElement): HTMLButtonElement[] =>
  weekCells(dayEl).map((cell) => cell.querySelector("button") as HTMLButtonElement);

/**
 * How many chips of a class a day shows. With no live class the page shows its
 * empty state instead of a week: that is 0. Anything else without a grid throws.
 */
export function weekChipCount(container: HTMLElement, day: string | number, className: string): number {
  if (!weekGrid(container)) {
    if (container.ownerDocument.body.textContent?.includes("No classes yet")) return 0;
    throw new Error("neither the week grid nor the empty state is rendered");
  }
  return weekChips(weekDay(container, day)).filter((b) => (b.getAttribute("aria-label") ?? "").replace(/^Edit /, "").startsWith(`${className},`)).length;
}
