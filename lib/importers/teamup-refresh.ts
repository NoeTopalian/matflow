/**
 * TeamUp status refresh (readiness spec v3 §7; contract
 * docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md §3).
 *
 * A fresh TeamUp memberships export updates the standing of people the first
 * import already created — and nothing else. Matching is by the person key the
 * first import stored as `Member.externalRef` ("teamup:<email>|<name>"); a
 * person whose name or email changed at TeamUp is an exception, never a guess.
 *
 * Pure: the preview, the commit and the rollback routes share these rules so
 * what the owner previews is what the commit writes and what the rollback undoes.
 */
import type { MemberDraft } from "@/lib/importers";
import { membershipTierWrite, type ResolvedMembershipTier } from "@/lib/membership-tier";

/**
 * The only Member columns a refresh may write. Everything else — name, email,
 * phone, date of birth, emergency contact, medical notes, waiver, photo, parent
 * links, notes, holdUntil, nextDueAt — is MatFlow's and is never touched.
 */
export const REFRESH_OWNED_FIELDS = ["status", "paymentStatus", "cancelledAt", "membershipType", "membershipTierId"] as const;
export type RefreshOwnedField = (typeof REFRESH_OWNED_FIELDS)[number];

/** A member's TeamUp-owned standing, JSON-safe (dates as ISO strings). */
export type Standing = {
  status: string;
  paymentStatus: string;
  cancelledAt: string | null;
  membershipType: string | null;
  membershipTierId: string | null;
  billingStatusAsOf: string | null;
  billingStatusSource: string | null;
};

/** The member columns a refresh reads. */
export type RefreshMember = {
  id: string;
  name: string;
  externalRef: string | null;
  billedBy: string;
  status: string;
  paymentStatus: string;
  cancelledAt: Date | null;
  membershipType: string | null;
  membershipTierId: string | null;
  billingStatusAsOf: Date | null;
  billingStatusSource: string | null;
};

export const REFRESH_MEMBER_SELECT = {
  id: true,
  name: true,
  externalRef: true,
  billedBy: true,
  status: true,
  paymentStatus: true,
  cancelledAt: true,
  membershipType: true,
  membershipTierId: true,
  billingStatusAsOf: true,
  billingStatusSource: true,
} as const;

/** One person's recorded change: enough to show it and to undo it. */
export type RefreshChange = {
  memberId: string;
  name: string;
  sourceKey: string;
  /** The owned fields whose value changes (empty when only "status as of" moves). */
  fields: RefreshOwnedField[];
  before: Standing;
  after: Standing;
};

export type RefreshExceptions = {
  /** In the file, but no member carries that key: new at TeamUp, or their name or email changed there. */
  notInMatFlow: { name: string; email: string | null; sourceKey: string; rows: number[] }[];
  /** Billed by TeamUp in this club, but not in the file. */
  notInFile: { memberId: string; name: string }[];
  /** Matched, but MatFlow bills them now (migrated) — a refresh never changes their standing. */
  billedByMatFlow: { memberId: string; name: string }[];
  /** Rows the parser refused. */
  refused: { row: number; reason: string }[];
};

export type RefreshPlan = {
  /** Every matched TeamUp-billed member, changed or not (each gets the new "status as of"). */
  matched: RefreshChange[];
  changed: number;
  unchanged: number;
  exceptions: RefreshExceptions;
  /** Payer/guardian records the first import made from emergency contacts — not TeamUp rows, never refreshed. */
  payerRecords: number;
  /** Every person in the file is exactly one of: matched, not in MatFlow, billed by MatFlow, payer record. */
  reconciles: boolean;
};

export const PAYER_KEY_PREFIX = "teamup-payer:";

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString();
}

export function standingOf(m: RefreshMember): Standing {
  return {
    status: m.status,
    paymentStatus: m.paymentStatus,
    cancelledAt: iso(m.cancelledAt),
    membershipType: m.membershipType ?? null,
    membershipTierId: m.membershipTierId ?? null,
    billingStatusAsOf: iso(m.billingStatusAsOf),
    billingStatusSource: m.billingStatusSource ?? null,
  };
}

/** The standing a draft states, plan resolved to a tier exactly as the create commit does. */
export function standingFromDraft(
  d: MemberDraft,
  tierByName: Map<string, ResolvedMembershipTier>,
  job: { id: string; sourceExportedAt: Date | string | null },
): Standing {
  const matched = d.membershipType ? tierByName.get(d.membershipType.trim().toLowerCase()) : undefined;
  // No opts: a refresh never seeds nextDueAt — that date is MatFlow's.
  const tierCols = membershipTierWrite(matched ?? null);
  return {
    status: d.status ?? "active",
    paymentStatus: d.paymentStatus ?? "paid",
    cancelledAt: iso(d.cancelledAt ?? null),
    membershipType: tierCols.membershipType ?? d.membershipType ?? null,
    membershipTierId: tierCols.membershipTierId ?? null,
    billingStatusAsOf: iso(job.sourceExportedAt),
    billingStatusSource: job.id,
  };
}

export function changedFields(before: Standing, after: Standing): RefreshOwnedField[] {
  return REFRESH_OWNED_FIELDS.filter((f) => before[f] !== after[f]);
}

export function tierMap(tiers: ResolvedMembershipTier[]): Map<string, ResolvedMembershipTier> {
  return new Map(tiers.map((t) => [t.name.trim().toLowerCase(), t]));
}

/**
 * Match the file against the club and work out every change, without writing.
 * `members` must include every member whose externalRef is a key in the file
 * and every member billed by TeamUp.
 */
export function planRefresh(input: {
  drafts: MemberDraft[];
  errors: { row: number; reason: string }[];
  members: RefreshMember[];
  tiers: ResolvedMembershipTier[];
  job: { id: string; sourceExportedAt: Date | string | null };
}): RefreshPlan {
  const tierByName = tierMap(input.tiers);
  const byKey = new Map<string, RefreshMember>();
  for (const m of input.members) if (m.externalRef) byKey.set(m.externalRef, m);

  const keysInFile = new Set<string>();
  const matched: RefreshChange[] = [];
  const exceptions: RefreshExceptions = { notInMatFlow: [], notInFile: [], billedByMatFlow: [], refused: input.errors };
  let payerRecords = 0;
  let people = 0;

  for (const d of input.drafts) {
    if (!d.sourceKey) continue;
    people += 1;
    keysInFile.add(d.sourceKey);
    if (d.sourceKey.startsWith(PAYER_KEY_PREFIX)) { payerRecords += 1; continue; }
    const m = byKey.get(d.sourceKey);
    if (!m) {
      exceptions.notInMatFlow.push({ name: d.name, email: d.nonContactable ? null : d.email, sourceKey: d.sourceKey, rows: d.sourceRows ?? [] });
      continue;
    }
    if (m.billedBy !== "teamup") {
      exceptions.billedByMatFlow.push({ memberId: m.id, name: m.name });
      continue;
    }
    const before = standingOf(m);
    const after = standingFromDraft(d, tierByName, input.job);
    matched.push({ memberId: m.id, name: m.name, sourceKey: d.sourceKey, fields: changedFields(before, after), before, after });
  }

  for (const m of input.members) {
    if (m.billedBy !== "teamup") continue;
    if (m.externalRef && keysInFile.has(m.externalRef)) continue;
    // A payer record made from an emergency contact is not a TeamUp row; its
    // absence from a later export says nothing.
    if (m.externalRef?.startsWith(PAYER_KEY_PREFIX)) continue;
    exceptions.notInFile.push({ memberId: m.id, name: m.name });
  }

  const changed = matched.filter((c) => c.fields.length > 0).length;
  return {
    matched,
    changed,
    unchanged: matched.length - changed,
    exceptions,
    payerRecords,
    reconciles: matched.length + exceptions.notInMatFlow.length + exceptions.billedByMatFlow.length + payerRecords === people,
  };
}

/** The Member columns one change writes (owned fields and the provenance pair only). */
export function refreshWrite(s: Standing) {
  return {
    status: s.status,
    paymentStatus: s.paymentStatus,
    cancelledAt: s.cancelledAt ? new Date(s.cancelledAt) : null,
    membershipType: s.membershipType,
    membershipTierId: s.membershipTierId,
    billingStatusAsOf: s.billingStatusAsOf ? new Date(s.billingStatusAsOf) : null,
    billingStatusSource: s.billingStatusSource,
  };
}

const FIELD_WORDS: Record<keyof Standing, string> = {
  status: "status",
  paymentStatus: "payment status",
  cancelledAt: "cancellation date",
  membershipType: "plan",
  membershipTierId: "membership tier",
  billingStatusAsOf: "status date",
  billingStatusSource: "status date",
};

export type RefreshRollbackKept = { memberId: string; name: string; reasons: string[] };

/**
 * Which recorded changes can be undone. A member is restored only when every
 * value this refresh wrote is still what it wrote; otherwise someone (or a
 * later refresh) has changed them since and they are kept, with the reason.
 */
export function planRefreshRollback(
  changes: RefreshChange[],
  current: RefreshMember[],
  alreadyRestored: ReadonlySet<string> = new Set(),
): { restore: RefreshChange[]; kept: RefreshRollbackKept[] } {
  const byId = new Map(current.map((m) => [m.id, m]));
  const restore: RefreshChange[] = [];
  const kept: RefreshRollbackKept[] = [];
  for (const c of changes) {
    if (alreadyRestored.has(c.memberId)) continue;
    const m = byId.get(c.memberId);
    if (!m) { kept.push({ memberId: c.memberId, name: c.name, reasons: ["no longer in MatFlow"] }); continue; }
    const now = standingOf(m);
    const moved = (Object.keys(c.after) as (keyof Standing)[]).filter((k) => now[k] !== c.after[k]);
    if (moved.length === 0) { restore.push(c); continue; }
    const reasons = new Set<string>();
    if (moved.includes("billingStatusSource")) reasons.add("a later status refresh has updated them — roll that back first");
    for (const k of moved) {
      if (k === "billingStatusSource" || k === "billingStatusAsOf") continue;
      reasons.add(`${FIELD_WORDS[k]} changed since this refresh`);
    }
    if (reasons.size === 0) reasons.add("status date changed since this refresh");
    kept.push({ memberId: m.id, name: m.name, reasons: [...reasons] });
  }
  return { restore, kept };
}

/** Human words for a field, for the preview list. */
export function refreshFieldLabel(f: RefreshOwnedField): string {
  return FIELD_WORDS[f];
}
