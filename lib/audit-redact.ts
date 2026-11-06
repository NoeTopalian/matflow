/**
 * A member's erasure redacts their personal values from the Activity log (6 Nov 2026).
 *
 * Activity (AuditLog) is kept permanently (docs/RULES.md §5d), so values recorded on a member's rows would
 * outlive their Article 17 erasure for ever: `member.update` stores `changes.<field>.from/to` for name,
 * phone, date of birth and emergency contacts (app/api/members/[id]/route.ts), and a restore stores
 * `before`. Inside the erase transaction this module rewrites the METADATA of the subject's rows only:
 *
 *  - scope: this club (`tenantId`) AND the subject's rows (`entityId` = the member, or `metadata.memberId` =
 *    the member);
 *  - `changes`: every field keeps its key; `from` and `to` become null;
 *  - `before` / `after`: every key kept, every value null;
 *  - `name`, `childName`, `memberName`, `email`, `phone`: null;
 *  - `redactedForErasure: true` is added, so a reader can tell a redacted row from one that never had values.
 *
 * Actor and correlation columns (userId, operatorId, requestId, action, entity, createdAt) are never
 * touched. This is the ONE place the application writes to an existing AuditLog row, and only its
 * `metadata` — the documented exception in tests/unit/audit-actor-columns-immutability.test.ts.
 */
import type { Prisma } from "@prisma/client";

type Tx = Pick<Prisma.TransactionClient, "auditLog">;

const PERSONAL_KEYS = ["name", "childName", "memberName", "email", "phone"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Pure: the metadata with the personal values removed, or null when there was nothing to remove. */
export function redactAuditMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!isObject(metadata) || metadata.redactedForErasure === true) return null;
  let changed = false;
  const out: Record<string, unknown> = { ...metadata };
  if (isObject(metadata.changes)) {
    const changes: Record<string, unknown> = {};
    for (const [field, v] of Object.entries(metadata.changes)) {
      if (isObject(v) && (v.from != null || v.to != null)) changed = true;
      changes[field] = isObject(v) ? { ...v, from: null, to: null } : null;
      if (!isObject(v) && v != null) changed = true;
    }
    out.changes = changes;
  }
  for (const key of ["before", "after"] as const) {
    const v = metadata[key];
    if (isObject(v)) {
      if (Object.values(v).some((x) => x != null)) changed = true;
      out[key] = Object.fromEntries(Object.keys(v).map((k) => [k, null]));
    }
  }
  for (const key of PERSONAL_KEYS) {
    if (metadata[key] != null) {
      changed = true;
      out[key] = null;
    }
  }
  if (!changed) return null;
  out.redactedForErasure = true;
  return out;
}

/**
 * Redact the subject's rows in this club. `dryRun` counts without writing (the erasure's fulfilment record is
 * written before the redaction, in the same transaction). Returns how many rows were (or would be) redacted.
 */
export async function redactSubjectFromAuditLog(tx: Tx, tenantId: string, memberId: string, opts: { dryRun?: boolean } = {}): Promise<number> {
  const rows = await tx.auditLog.findMany({
    where: { tenantId, OR: [{ entityId: memberId }, { metadata: { path: ["memberId"], equals: memberId } }] },
    select: { id: true, metadata: true },
  });
  let redacted = 0;
  for (const row of rows) {
    const next = redactAuditMetadata(row.metadata);
    if (!next) continue;
    redacted += 1;
    if (opts.dryRun) continue;
    // Metadata only: never an actor, correlation or entity column.
    await tx.auditLog.updateMany({ where: { id: row.id, tenantId }, data: { metadata: next as Prisma.InputJsonValue } });
  }
  return redacted;
}
