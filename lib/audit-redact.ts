/**
 * A member's erasure redacts their personal values from the Activity log (6 Nov 2026).
 *
 * Activity (AuditLog) is kept permanently (docs/RULES.md §5d), so values recorded on a member's rows would
 * outlive their Article 17 erasure for ever: `member.update` stores `changes.<field>.from/to` for name,
 * phone, date of birth and emergency contacts (app/api/members/[id]/route.ts), and a restore stores
 * `before`. Inside the erase transaction this module rewrites the METADATA of the subject's rows only:
 *
 *  - scope: this club (`tenantId`) AND the subject's rows (`entityId` = the member, `metadata.memberId` =
 *    the member, or `metadata.childId` = the member: a parent's upload of a child's photo is logged against
 *    the photo, with the child's name);
 *  - `changes`: every field keeps its key; `from` and `to` become null;
 *  - `before` / `after`: every key kept, every value null;
 *  - `name`, `childName`, `memberName`, `signerName`, `email`, `phone`: null;
 *  - `redactedForErasure: true` is added, so a reader can tell a redacted row from one that never had values.
 *
 * Rows keyed by an ADDRESS. Until 6 Nov 2026 the kiosk waiver row (`member.waiver.signed_via_kiosk`) stored
 * the signer's email as its `entityId`. The erasure also finds this club's rows whose `entityId` is an address
 * the subject held (current or earlier), redacts their metadata, and replaces that address, which is personal
 * data, so it does not outlive the erasure. The caller decides, per address (`addressRow`):
 *  - "repoint": no other member of the club ever held it, so the row is the subject's: `entityId` = member id;
 *  - "neutral": another member held it at some time, so the row may be theirs: `entityId` = "erased"
 *    (ERASED_ENTITY_ID), which points at no one, rather than at the wrong member.
 * A row found both by id and by address is changed (and counted) once.
 *
 * Actor and correlation columns (userId, operatorId, requestId, action, entityType, createdAt) are never
 * touched. This is the ONE place the application writes to an existing AuditLog row: its `metadata`, and an
 * address-valued `entityId` replaced by the member id or "erased" — the documented exception in
 * tests/unit/audit-actor-columns-immutability.test.ts (widened to the entityId rewrite by the 6 Nov 2026 review).
 */
import type { Prisma } from "@prisma/client";

type Tx = Pick<Prisma.TransactionClient, "auditLog">;

const PERSONAL_KEYS = ["name", "childName", "memberName", "signerName", "email", "phone"] as const;

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

/** The `entityId` an address-keyed row gets when the address may have been another member's: it names no one. */
export const ERASED_ENTITY_ID = "erased";

export type AddressRowDecision = "repoint" | "neutral" | null;

export type RedactionSubject = { memberId: string; addressRow?: (address: string) => AddressRowDecision };

/** Whose id an address-keyed row gets: the one subject who alone held the address, else no one ("erased"). */
function entityFor(address: string, subjects: RedactionSubject[]): string | null {
  const claims = subjects.map((s) => ({ memberId: s.memberId, decision: s.addressRow ? s.addressRow(address) : null })).filter((c) => c.decision);
  if (claims.length === 0) return null;
  return claims.length === 1 && claims[0].decision === "repoint" ? claims[0].memberId : ERASED_ENTITY_ID;
}

/**
 * Redact the subjects' rows in this club (a member, and the children erased with them): one read by id for all of
 * them, one read of the address-keyed rows, then a write per row that changes. A row naming several subjects is
 * changed, and counted, once. `dryRun` counts without writing (the erasure's fulfilment record is written before the
 * redaction, in the same transaction). Each subject's `addressRow` decides an address-valued `entityId`: null when
 * the address was never theirs. Returns how many rows were (or would be) changed.
 */
export async function redactSubjectsFromAuditLog(tx: Tx, tenantId: string, subjects: RedactionSubject[], opts: { dryRun?: boolean } = {}): Promise<number> {
  if (subjects.length === 0) return 0;
  const ids = subjects.map((s) => s.memberId);
  const byId = await tx.auditLog.findMany({
    where: {
      tenantId,
      OR: [
        { entityId: { in: ids } },
        ...ids.flatMap((id) => [{ metadata: { path: ["memberId"], equals: id } }, { metadata: { path: ["childId"], equals: id } }]),
      ],
    },
    select: { id: true, metadata: true },
  });
  const rows = new Map<string, { metadata: unknown; entityTo: string | null }>();
  for (const r of byId) rows.set(r.id, { metadata: r.metadata, entityTo: null });
  if (subjects.some((s) => s.addressRow)) {
    const candidates = await tx.auditLog.findMany({ where: { tenantId, entityId: { contains: "@" } }, select: { id: true, entityId: true, metadata: true } });
    for (const r of candidates) {
      const entityTo = r.entityId ? entityFor(r.entityId, subjects) : null;
      if (!entityTo) continue;
      // Once per row, even when it was also found by id.
      rows.set(r.id, { metadata: r.metadata, entityTo });
    }
  }
  let changed = 0;
  for (const [id, row] of rows) {
    const next = redactAuditMetadata(row.metadata);
    if (!next && !row.entityTo) continue;
    changed += 1;
    if (opts.dryRun) continue;
    // The metadata, and an address-valued entityId replaced by the member id or "erased": never an actor or
    // correlation column.
    const data = { ...(next ? { metadata: next as Prisma.InputJsonValue } : {}), ...(row.entityTo ? { entityId: row.entityTo } : {}) };
    await tx.auditLog.updateMany({ where: { id, tenantId }, data });
  }
  return changed;
}
