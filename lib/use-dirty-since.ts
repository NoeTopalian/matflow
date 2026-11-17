import { useState } from "react";

/**
 * Round 11 (baseline 6.1): has this form changed since its overlay opened? For an overlay's
 * `confirmDiscard`, so a stray scrim tap or Escape asks before throwing the input away.
 *
 * The snapshot is taken on the first render with `open` true. Callers seed the form in the same
 * handler that opens the overlay, so that render already holds the seeded values. Closing clears
 * the snapshot, and the next open takes a new one. Values are compared as JSON, so give it plain
 * data: strings, numbers, arrays, sets spread to arrays.
 */
export function useDirtySince(open: boolean, value: unknown): boolean {
  const now = JSON.stringify(value);
  const [opened, setOpened] = useState<string | null>(open ? now : null);
  // Adjusting state while rendering (react.dev "storing information from previous renders").
  if (open && opened === null) setOpened(now);
  if (!open && opened !== null) setOpened(null);
  return open && opened !== null && now !== opened;
}
