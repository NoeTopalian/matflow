/**
 * Per-field preconditions for club settings saves (Round 4, 10 Nov 2026,
 * CONCURRENCY-1).
 *
 * A settings save may carry `expected`: for each field it changes, the value
 * the client last saw. A field is written only while the club still holds
 * that value. A retried save that finds its own value already there (the
 * first attempt committed but its reply was lost) writes nothing and succeeds.
 * Any other value means someone changed it since: the save is refused as a
 * whole and the current values are returned, so the client can keep the
 * owner's draft and offer the latest.
 *
 * A field sent without an `expected` entry is written as before (last write
 * wins); the routes that do so are listed in the Round 4 evidence.
 */

export type SettingsConflict = { field: string; current: unknown };

/** Stable JSON for comparing stored and sent values: key order and undefined never matter. */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sameSettingValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/**
 * What to write, given the stored row, the fields sent and their `expected`
 * values. `apply` holds the fields that really change; `conflicts` is
 * non-empty when the whole save must be refused.
 */
export function resolveSettingsPreconditions(
  stored: Record<string, unknown>,
  sent: Record<string, unknown>,
  expected: Record<string, unknown>,
): { apply: Record<string, unknown>; conflicts: SettingsConflict[] } {
  const apply: Record<string, unknown> = {};
  const conflicts: SettingsConflict[] = [];
  for (const [field, next] of Object.entries(sent)) {
    if (!(field in expected)) {
      apply[field] = next;
      continue;
    }
    const current = stored[field];
    if (sameSettingValue(current, expected[field])) {
      if (!sameSettingValue(current, next)) apply[field] = next;
    } else if (!sameSettingValue(current, next)) {
      conflicts.push({ field, current: current ?? null });
    }
    // current === next: already saved (a retried save); nothing to write.
  }
  return { apply, conflicts };
}
