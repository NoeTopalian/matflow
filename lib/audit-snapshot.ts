/**
 * Before/after snapshots for audit rows (1 Oct 2026) — what makes an action
 * reversible from the owner's Activity page (lib/undo-registry.ts).
 *
 * `snapshotDiff(before, after, fields)` keeps only the fields that actually
 * changed, as two small objects: `before` is what undo restores, `after` is
 * what undo checks is still there (stale protection). Dates become ISO
 * strings so the row is plain JSON; the registry turns them back. Nothing
 * secret belongs in here — callers pass the editable fields only.
 */
export type Snapshot = Record<string, unknown>;

export function snapshotDiff<T extends Record<string, unknown>>(
  before: T | null | undefined,
  after: T | null | undefined,
  fields: readonly (keyof T & string)[],
): { before: Snapshot; after: Snapshot; changed: string[] } {
  const b: Snapshot = {};
  const a: Snapshot = {};
  const changed: string[] = [];
  if (!before || !after) return { before: b, after: a, changed };
  for (const f of fields) {
    const bv = plain(before[f]);
    const av = plain(after[f]);
    if (JSON.stringify(bv ?? null) === JSON.stringify(av ?? null)) continue;
    b[f] = bv ?? null;
    a[f] = av ?? null;
    changed.push(f);
  }
  return { before: b, after: a, changed };
}

function plain(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v.length > 2000) return v.slice(0, 2000) + "…";
  return v;
}

/** Audit metadata for an update: field list plus the diff when anything changed. */
export function updateMetadata<T extends Record<string, unknown>>(
  sentFields: string[],
  before: T | null | undefined,
  after: T | null | undefined,
  fields: readonly (keyof T & string)[],
): Record<string, unknown> {
  const d = snapshotDiff(before, after, fields);
  return d.changed.length > 0 ? { fields: sentFields, before: d.before, after: d.after } : { fields: sentFields };
}
