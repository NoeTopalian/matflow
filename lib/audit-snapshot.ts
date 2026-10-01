/**
 * Before/after snapshots for audit rows (1 Oct 2026) — what makes an action
 * reversible from the owner's Activity page (lib/undo-registry.ts).
 *
 * `snapshotDiff(before, after, fields)` keeps only the fields that actually
 * changed, as two small objects: `before` is what undo restores, `after` is
 * what undo checks is still there (stale protection). Dates become ISO
 * strings so the row is plain JSON; the registry turns them back. Nothing
 * secret or special-category belongs in here — callers pass the editable
 * fields only (never notes or medical conditions: audit rows outlive an
 * erasure).
 *
 * Text longer than MAX_TEXT is NOT kept cut short — a truncated `before`
 * would be written back as the real value on undo. The diff records
 * `truncated: true` instead and the registry refuses the undo honestly.
 */
export type Snapshot = Record<string, unknown>;

/** Longest text kept whole. The waiver fields allow 20,000 characters. */
export const MAX_TEXT = 20_000;

export function snapshotDiff<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
  fields: readonly (keyof T & string)[],
): { before: Snapshot; after: Snapshot; changed: string[]; truncated: boolean } {
  const b: Snapshot = {};
  const a: Snapshot = {};
  const changed: string[] = [];
  let truncated = false;
  if (!before || !after) return { before: b, after: a, changed, truncated };
  for (const f of fields) {
    const bv = plain(before[f]);
    const av = plain(after[f]);
    if (JSON.stringify(bv ?? null) === JSON.stringify(av ?? null)) continue;
    if (tooLong(bv) || tooLong(av)) {
      truncated = true;
      changed.push(f);
      continue;
    }
    b[f] = bv ?? null;
    a[f] = av ?? null;
    changed.push(f);
  }
  return { before: b, after: a, changed, truncated };
}

function plain(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}

function tooLong(v: unknown): boolean {
  return typeof v === "string" && v.length > MAX_TEXT;
}

/** Audit metadata for an update: field list plus the diff when anything changed. */
export function updateMetadata<T extends Record<string, unknown>>(
  sentFields: string[],
  before: T | null | undefined,
  after: T | null | undefined,
  fields: readonly (keyof T & string)[],
): Record<string, unknown> {
  const d = snapshotDiff(before, after, fields);
  if (d.changed.length === 0) return { fields: sentFields };
  return {
    fields: sentFields,
    before: d.before,
    after: d.after,
    ...(d.truncated ? { truncated: true } : {}),
  };
}
