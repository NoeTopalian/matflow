/**
 * Later uploads never silently overwrite MatFlow (owner decision, 25 Oct 2026):
 * "Add genuinely new records, skip exact duplicates, and show conflicting or
 * ambiguous records for an authorised person to resolve. Where previous
 * ownership or edit history is unknown, preserve the current value and flag
 * the conflict."
 *
 * Pure: the member import (create mode) and the status refresh both classify
 * each file person against the club with these rules, and the conflicts route
 * re-reads current values to show beside the stored upload values. Nothing here
 * writes; resolution is the normal member edit, with its own permission check.
 */
import type { MemberDraft } from "@/lib/importers";
import { normaliseEmail } from "@/lib/email-normalise";

/** The values an upload is compared on. Everything else on a member is never compared or written by a re-upload. */
export const COMPARED_FIELDS = ["name", "email", "phone", "dateOfBirth", "accountType", "plan", "status", "paymentStatus", "cancelledAt"] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

const FIELD_LABEL: Record<ComparedField, string> = {
  name: "name",
  email: "email",
  phone: "phone",
  dateOfBirth: "date of birth",
  accountType: "account type",
  plan: "plan",
  status: "status",
  paymentStatus: "payment status",
  cancelledAt: "cancellation date",
};

export function comparedFieldLabel(f: ComparedField): string {
  return FIELD_LABEL[f];
}

/** One field that differs: what the upload said and what MatFlow held when the upload was read. */
export type ConflictField = { field: ComparedField; upload: string | null; matflow: string | null };

export type ImportConflict =
  | {
      kind: "conflict";
      /** The member in this club the file person matched. */
      memberId: string;
      name: string;
      sourceKey: string | null;
      rows: number[];
      fields: ConflictField[];
    }
  | {
      kind: "ambiguous";
      /** Every member in this club the file person could be; none was chosen. */
      memberIds: string[];
      name: string;
      sourceKey: string | null;
      rows: number[];
      reason: string;
    };

/** The member columns a match is compared on. */
export type CandidateMember = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  dateOfBirth: Date | null;
  accountType: string;
  membershipType: string | null;
  membershipTierId: string | null;
  status: string;
  paymentStatus: string;
  cancelledAt: Date | null;
  externalRef: string | null;
  importJobId: string | null;
};

export const CANDIDATE_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true,
  dateOfBirth: true,
  accountType: true,
  membershipType: true,
  membershipTierId: true,
  status: true,
  paymentStatus: true,
  cancelledAt: true,
  externalRef: true,
  importJobId: true,
} as const;

/** A synthesised login (no-email adults, kids, guardian drafts): never compared as an address. */
export function isSynthesisedEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith("@no-login.matflow.local");
}

const day = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const x = d instanceof Date ? d : new Date(d.length === 10 ? `${d}T00:00:00.000Z` : d);
  return Number.isNaN(x.getTime()) ? null : x.toISOString().slice(0, 10);
};

/** The plan as a person reads it: the tier's name (MatFlow writes the tier name as the label) or the free-text label. */
type Plan = { tierId: string | null; label: string | null };

/**
 * What the upload states, field by field. A field the file does not state is
 * absent: no information is never a difference.
 */
export function uploadValues(d: MemberDraft, plan: Plan): Partial<Record<ComparedField, string | null>> & { _plan?: Plan } {
  const out: Partial<Record<ComparedField, string | null>> & { _plan?: Plan } = {};
  if (d.name?.trim()) out.name = d.name.trim();
  if (d.email && !d.nonContactable && !d.unverified && !isSynthesisedEmail(d.email)) out.email = normaliseEmail(d.email);
  if (d.phone?.trim()) out.phone = d.phone.trim();
  if (d.dateOfBirth) out.dateOfBirth = day(d.dateOfBirth);
  if (d.accountType) out.accountType = d.accountType;
  if (plan.tierId || plan.label) { out.plan = plan.label ?? null; out._plan = plan; }
  if (d.status) out.status = d.status;
  if (d.paymentStatus) out.paymentStatus = d.paymentStatus;
  if (d.cancelledAt) out.cancelledAt = day(d.cancelledAt);
  return out;
}

/** The member's current value for each compared field, in the same form as uploadValues. */
export function memberValues(m: CandidateMember): Record<ComparedField, string | null> & { _plan: Plan } {
  return {
    name: m.name,
    email: isSynthesisedEmail(m.email) ? null : normaliseEmail(m.email),
    phone: m.phone ?? null,
    dateOfBirth: day(m.dateOfBirth),
    accountType: m.accountType,
    plan: m.membershipType ?? null,
    _plan: { tierId: m.membershipTierId ?? null, label: m.membershipType ?? null },
    status: m.status,
    paymentStatus: m.paymentStatus,
    cancelledAt: day(m.cancelledAt),
  };
}

const squash = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const digits = (s: string) => s.replace(/\D/g, "");

function same(field: ComparedField, upload: string | null, current: string | null, plans?: { upload?: Plan; current: Plan }): boolean {
  if (field === "plan" && plans?.upload) {
    // Both resolve to a tier: the tier decides (a renamed tier is still the same plan).
    if (plans.upload.tierId && plans.current.tierId) return plans.upload.tierId === plans.current.tierId;
    return squash(plans.upload.label ?? "") === squash(plans.current.label ?? "");
  }
  if (upload === null || current === null) return upload === current;
  if (field === "name") return squash(upload) === squash(current);
  if (field === "phone") return digits(upload) === digits(current);
  return upload === current;
}

/**
 * Whether a stored upload value still differs from a member's value NOW (the
 * conflicts list re-reads members, so a conflict someone has since resolved by
 * hand reads "matches now"). Plan compares labels here: the stored conflict
 * keeps the label, not a tier id.
 */
export function stillDiffers(field: ComparedField, upload: string | null, now: string | null): boolean {
  if (field === "plan") return squash(upload ?? "") !== squash(now ?? "");
  return !same(field, upload, now);
}

/** Every stated upload value that differs from the member's current one. */
export function differences(upload: ReturnType<typeof uploadValues>, m: CandidateMember): ConflictField[] {
  const cur = memberValues(m);
  const out: ConflictField[] = [];
  for (const f of COMPARED_FIELDS) {
    if (!(f in upload)) continue;
    const u = upload[f] ?? null;
    if (!same(f, u, cur[f], { upload: upload._plan, current: cur._plan })) out.push({ field: f, upload: u, matflow: cur[f] });
  }
  return out;
}

export type Classification =
  | { kind: "new" }
  /** This job created it on an earlier, interrupted call: its own work, not a duplicate. */
  | { kind: "own"; memberId: string }
  | { kind: "duplicate"; memberId: string }
  | Extract<ImportConflict, { kind: "conflict" }>
  | Extract<ImportConflict, { kind: "ambiguous" }>;

/**
 * Classify one file person against the members its identifiers point at.
 * `byIdentity` is the match by the identity the importer has always used (the
 * login email; name and date of birth for a no-email adult; the payer address
 * for a guardian draft; parent, name and date of birth for a child) — possibly
 * several for the name-based ones. `byKey` is the member carrying the file's
 * own record key (`externalRef`), if any. Several candidates, or identifiers
 * pointing at different people, are AMBIGUOUS: nothing is guessed.
 */
export function classify(input: {
  draft: MemberDraft;
  plan: Plan;
  byIdentity: CandidateMember[];
  byKey: CandidateMember | null;
  jobId: string;
}): Classification {
  const { draft: d } = input;
  const ids = new Map<string, CandidateMember>();
  for (const m of input.byIdentity) ids.set(m.id, m);
  if (input.byKey) ids.set(input.byKey.id, input.byKey);
  const base = { name: d.name, sourceKey: d.sourceKey ?? null, rows: d.sourceRows ?? [] };
  if (ids.size === 0) return { kind: "new" };
  if (ids.size > 1) {
    const reason =
      input.byIdentity.length > 1
        ? `${input.byIdentity.length} members in this club match this person's details`
        : "the file's details match one member and its record key matches another";
    return { kind: "ambiguous", memberIds: [...ids.keys()], ...base, reason };
  }
  const m = [...ids.values()][0];
  if (m.importJobId === input.jobId) return { kind: "own", memberId: m.id };
  // Same identity, but the member already carries a DIFFERENT record key from an
  // earlier import: two source records claim one member.
  if (d.sourceKey && m.externalRef && m.externalRef !== d.sourceKey) {
    return { kind: "ambiguous", memberIds: [m.id], ...base, reason: "this member already carries a different record from an earlier import" };
  }
  const fields = differences(uploadValues(d, input.plan), m);
  if (fields.length === 0) return { kind: "duplicate", memberId: m.id };
  return { kind: "conflict", memberId: m.id, ...base, fields };
}
