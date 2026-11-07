/**
 * Who ever held an address in a club, for a member's erasure (app/api/admin/dsar/erase, 6 Nov 2026).
 *
 * An Activity row keyed by an ADDRESS (the kiosk waiver row before 6 Nov 2026) is repointed to the erased member
 * only when no other member of the club ever held that address; otherwise it may be the other member's, and its
 * address is replaced by the neutral "erased" (lib/audit-redact.ts). "Ever held" is every member's current
 * addresses and every change or release row of a member, compared in each form the club has written:
 *  - the keyed login-email digest (lib/login-email emailDigest, AH-E2);
 *  - the unkeyed SHA-256 of the trimmed, lower-cased address (rows written before AH-E2);
 *  - the DSAR fulfilment's hashToken, of the lower-cased address (since 7 Nov 2026) and of the address as it was
 *    stored (rows written before then hashed it without lower-casing).
 * Known gap: a member hard-deleted before release rows existed left no row, so their addresses are not known.
 */
import { createHash } from "node:crypto";
import { emailDigest } from "@/lib/login-email";
import { hashToken } from "@/lib/token-hash";
import { isSubjectsOwnAddress, type ErasureSubject } from "@/lib/importers/import-erasure";
import type { AddressRowDecision } from "@/lib/audit-redact";

export type AddressHolders = {
  /** Lower-cased current address → member ids. */
  byAddress: Map<string, Set<string>>;
  /** Any recorded digest of an address → the member ids whose rows recorded it. */
  byDigest: Map<string, Set<string>>;
  /** The keyed login-email digest of each member's CURRENT address → member ids. */
  byCurrentDigest: Map<string, Set<string>>;
};

/** Every digest form a recorded row may hold for this address. The first is the keyed login-email digest. */
export function addressDigestForms(address: string): string[] {
  const raw = address.trim();
  const lower = raw.toLowerCase();
  return [...new Set([emailDigest(lower), createHash("sha256").update(lower).digest("hex"), hashToken(lower), hashToken(raw)])];
}

/** Builds the holder maps from members' current addresses and their change or release rows' metadata. */
export function addressHolders(
  members: { id: string; email: string | null; unverifiedEmail: string | null }[],
  rows: { entityId: string; metadata: Record<string, unknown> | null }[],
): AddressHolders {
  const byAddress = new Map<string, Set<string>>();
  const byDigest = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, key: unknown, id: string) => {
    if (typeof key !== "string" || !key) return;
    const set = map.get(key) ?? new Set<string>();
    set.add(id);
    map.set(key, set);
  };
  const byCurrentDigest = new Map<string, Set<string>>();
  for (const m of members) {
    for (const a of [m.email, m.unverifiedEmail]) {
      if (!a) continue;
      add(byAddress, a.trim().toLowerCase(), m.id);
      add(byCurrentDigest, emailDigest(a), m.id);
    }
  }
  for (const r of rows) {
    const md = r.metadata ?? {};
    const released = Array.isArray(md.releasedEmailSha256) ? md.releasedEmailSha256 : [md.releasedEmailSha256];
    for (const d of [md.oldEmailSha256, md.newEmailSha256, md.oldEmailDigest, md.originalEmailHash, ...released]) add(byDigest, d, r.entityId);
  }
  return { byAddress, byDigest, byCurrentDigest };
}

const someoneElse = (ids: Set<string> | undefined, memberId: string) => !!ids && [...ids].some((id) => id !== memberId);

/** Whether another member of the club holds this address now (as their login or unverified address). */
export function heldByAnotherNow(holders: AddressHolders, memberId: string, address: string): boolean {
  return someoneElse(holders.byAddress.get(address.trim().toLowerCase()), memberId);
}

/** The subject's earlier-address digests another member of the club holds now (keyed login-email digests). */
export function digestsHeldByAnotherNow(holders: AddressHolders, memberId: string, digests: string[]): string[] {
  return digests.filter((d) => someoneElse(holders.byCurrentDigest.get(d), memberId));
}

/**
 * For an address-valued entityId: null when the subject never held it; "repoint" when only the subject ever held
 * it; "neutral" when another member of the club held it at some time.
 */
export function decideAddressRow(address: string, subject: ErasureSubject, holders: AddressHolders): AddressRowDecision {
  const lower = address.trim().toLowerCase();
  const forms = addressDigestForms(address);
  const ever = new Set([...(holders.byAddress.get(lower) ?? []), ...forms.flatMap((f) => [...(holders.byDigest.get(f) ?? [])])]);
  const theirs = ever.has(subject.memberId) || isSubjectsOwnAddress(subject, lower) || (subject.pastSharedAddressDigests ?? []).includes(forms[0]);
  if (!theirs) return null;
  ever.delete(subject.memberId);
  return ever.size === 0 ? "repoint" : "neutral";
}
