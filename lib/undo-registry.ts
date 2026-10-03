/**
 * Undo registry — which audit rows an OWNER can reverse, and how (1 Oct 2026,
 * "give them the option to undo to points"; hardened after the independent
 * review the same night).
 *
 * Honest model, not time-travel: a row is reversible only when it carries
 * enough to put the RECORDED FIELDS back (a `before` snapshot, a from→to diff,
 * or a pure state flip whose inverse is known). Linked records a change
 * created or removed on the way — bookings, rank history, Stripe objects,
 * sessions — are not reconstructed; where that would leave the club in a
 * state the owner did not ask for, the row is refused with a sentence that
 * says why, and the Activity page shows that sentence.
 *
 * Every handler runs inside the caller's `withTenantContext` transaction and
 * is given the tenant-scoped `tx`; handlers always filter on `tenantId` as
 * well (RLS is the backstop). Stale protection: before restoring, a handler
 * compares the current row with what the audit row says the action produced
 * (`after`, or the diff's `to`); if someone has changed it since, the undo is
 * refused rather than forced.
 */
import type { Prisma } from "@prisma/client";
import { revalidateTag } from "next/cache";
import { restorePackCreditsForAttendance } from "@/lib/checkin";
import { CONFIRMED_BY } from "@/lib/guardianship";

export type TxLike = Prisma.TransactionClient;

export type AuditRowLike = {
  id: string;
  tenantId: string | null;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
};

export type UndoDecision = { ok: true } | { ok: false; reason: string };

export type UndoHandler = {
  /** Pure: can this row be reversed from what it carries? */
  decide: (row: AuditRowLike) => UndoDecision;
  /** Reverse it. Throw `UndoStale` when the entity has moved on since. */
  apply: (tx: TxLike, row: AuditRowLike) => Promise<void>;
};

export class UndoStale extends Error {
  constructor(message = "This has been changed since, so it can't be undone from here.") {
    super(message);
    this.name = "UndoStale";
  }
}

/** Reasons shown verbatim on the Activity page. */
export const REASON = {
  money: "Money moved — reverse it from Payments (refund), not from here.",
  stripe: "This talked to Stripe. Undo it from the member's profile so Stripe is told too.",
  email: "An email was sent and can't be unsent.",
  security: "Sign-in and security events are a record, not a change to undo.",
  operator: "This was done by MatFlow, not by your staff.",
  importer: "Use the import's own Rollback — it knows exactly which rows it created.",
  noSnapshot: "Recorded before snapshots were kept, so the previous values aren't known.",
  record: "This is a record of something that happened, not a change.",
  alreadyUndone: "Already undone.",
  undoOfUndo: "An undo can't itself be undone — redo the action instead.",
  deleteNoRestore: "Deleted members can't be restored yet — the row is gone.",
  cascade: "This also removed class bookings, which can't be restored from here.",
  cancellation: "Cancellations and reactivations are handled from the member's profile, where billing is handled too.",
  tooLong: "The text was too long to keep a safe copy of, so it can't be put back from here.",
  reMark: "A removed check-in is put back by marking them again on the register.",
  batchScan: "A card-scan batch can't be undone from here — remove individual check-ins on the register.",
  firstGrading: "A first grading can't be undone from here — demote from the member's profile.",
  retyped: "This link also changed the account type; undo it from the member's profile.",
  defaultVenue: "The default venue can't be undone — choose another default in Settings.",
  erased: "This member was erased under GDPR; nothing is written back onto an erased record.",
  privateText: "Notes and medical details are never kept in the log, so they can't be put back from here.",
  rankGated: "This class is now rank-gated; add them back from the class roster, which checks their rank.",
  emailAdopted: "Confirming also made the payer's address their login; change that from the guardian's profile.",
  tickFoundRow: "They were already checked in when this was ticked, so the tick added nothing to undo.",
  importedRow: "This check-in is imported history. Undo the import with its own Rollback, or remove it on the register.",
} as const;

const meta = (row: AuditRowLike): Record<string, unknown> =>
  row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Fields a `before` snapshot may legitimately restore per entity — never ids, tenancy, secrets, money or health data. */
const RESTORABLE: Record<string, readonly string[]> = {
  Member: [
    "name", "email", "phone", "membershipType", "status", "paymentStatus",
    "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation", "dateOfBirth",
    "accountType", "membershipTierId", "nextDueAt", "holdUntil", "holdPriorStatus",
    "leaderboardOptOut", "preferredPaymentMethod",
  ],
  Tenant: [
    "name", "timezone", "checkinWindowBeforeMin", "checkinWindowAfterMin", "primaryColor", "secondaryColor",
    "textColor", "bgColor", "fontFamily", "logoUrl", "logoSize", "waiverTitle", "waiverContent",
    "kidsWaiverTitle", "kidsWaiverContent", "paymentRail", "acceptsBacs", "memberSelfBilling",
    "billingContactEmail", "billingContactUrl", "privacyContactEmail", "privacyPolicyUrl", "contactEmail",
    "instagramUrl", "facebookUrl", "tiktokUrl", "youtubeUrl", "twitterUrl", "websiteUrl", "groupChatUrl",
  ],
  User: ["name", "role", "email"],
  Class: [
    "name", "description", "instructorId", "coachName", "coachUserId", "location", "locationId", "duration",
    "maxCapacity", "isKids", "requiredRankId", "maxRankId", "color", "isActive",
  ],
  MembershipTier: ["name", "description", "pricePence", "currency", "billingCycle", "maxClassesPerWeek", "isKids", "isActive", "locationId"],
  RankSystem: ["discipline", "name", "order", "color", "stripes"],
  Location: ["name", "address", "isDefault"],
};

/** DateTime columns: restored strings become Dates whatever the current value is. */
const DATE_FIELDS = new Set(["dateOfBirth", "nextDueAt", "holdUntil", "joinedAt", "cancelledAt"]);

const MODEL_KEY: Record<string, keyof TxLike> = {
  Member: "member",
  Tenant: "tenant",
  User: "user",
  Class: "class",
  MembershipTier: "membershipTier",
  RankSystem: "rankSystem",
  Location: "location",
};

type Delegate = {
  findFirst: (args: unknown) => Promise<Record<string, unknown> | null>;
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
};

function delegate(tx: TxLike, entityType: string): Delegate {
  const key = MODEL_KEY[entityType];
  if (!key) throw new Error(`No delegate for ${entityType}`);
  return tx[key] as unknown as Delegate;
}

type SnapshotOptions = {
  /** Runs after a successful restore (cache busting etc.). */
  after?: (row: AuditRowLike) => void;
  /** Extra refusals a pure decide can make from the metadata alone. */
  decide?: (m: Record<string, unknown>, restoreFields: string[]) => UndoDecision | null;
  /** A last check against the live row before writing (throw UndoStale to refuse). */
  guard?: (current: Record<string, unknown>, restore: Record<string, unknown>) => void;
  /** Extra data to write alongside the restore (e.g. a session bump). */
  extra?: (restore: Record<string, unknown>) => Record<string, unknown>;
};

/** What a snapshot row would restore, as field names, from metadata alone. */
function restoreFieldsOf(m: Record<string, unknown>, allowed: Set<string>): string[] {
  const before = asRecord(m.before);
  const after = asRecord(m.after);
  const changes = asRecord(m.changes);
  if (before) return (after ? Object.keys(after) : Object.keys(before)).filter((f) => allowed.has(f));
  if (changes) return Object.keys(changes).filter((f) => allowed.has(f));
  return [];
}

/** Restore `before` for the fields that the action changed, refusing if `after` no longer matches. */
function snapshotHandler(entityType: string, opts: SnapshotOptions = {}): UndoHandler {
  const allowed = new Set(RESTORABLE[entityType] ?? []);
  return {
    decide(row) {
      const m = meta(row);
      if (m.truncated === true) return { ok: false, reason: REASON.tooLong };
      const fields = restoreFieldsOf(m, allowed);
      const extra = opts.decide?.(m, fields);
      if (extra) return extra;
      if (fields.length === 0) return { ok: false, reason: REASON.noSnapshot };
      return { ok: true };
    },
    async apply(tx, row) {
      const m = meta(row);
      const before = asRecord(m.before);
      const after = asRecord(m.after);
      const changes = asRecord(m.changes);
      const d = delegate(tx, entityType);
      if (entityType === "Tenant" && row.entityId !== row.tenantId) throw new UndoStale("This row does not belong to this club.");
      const where = entityType === "Tenant"
        ? { id: row.entityId }
        : { id: row.entityId, tenantId: row.tenantId ?? undefined };
      const current = await d.findFirst({ where });
      if (!current) throw new UndoStale("This no longer exists.");

      // What to put back: full snapshot wins; else the diff's `from` values.
      const restore: Record<string, unknown> = {};
      const expectNow: Record<string, unknown> = {};
      if (before) {
        const fields = after ? Object.keys(after) : Object.keys(before);
        for (const f of fields) {
          if (!allowed.has(f)) continue;
          restore[f] = before[f] ?? null;
          if (after && f in after) expectNow[f] = after[f];
        }
      } else if (changes) {
        for (const [f, v] of Object.entries(changes)) {
          const pair = asRecord(v);
          if (!pair || !allowed.has(f)) continue;
          restore[f] = pair.from ?? null;
          expectNow[f] = pair.to;
        }
      }
      if (Object.keys(restore).length === 0) throw new UndoStale("Nothing restorable was recorded.");

      // Stale check: every field the action set must still hold that value.
      for (const [f, v] of Object.entries(expectNow)) {
        if (!sameValue(current[f], v)) throw new UndoStale();
      }
      opts.guard?.(current, restore);
      // Dates come back from JSON as strings; Prisma wants Date for DateTime —
      // decided by column, not by the current value (a cleared date is null).
      for (const f of Object.keys(restore)) {
        if (DATE_FIELDS.has(f) && typeof restore[f] === "string") restore[f] = new Date(restore[f] as string);
      }
      await d.update({ where: { id: row.entityId }, data: { ...restore, ...(opts.extra?.(restore) ?? {}) } });
      opts.after?.(row);
    },
  };
}

/**
 * Equal for the stale check. The one shortcut: a date-only value
 * ("1990-01-01", how dateOfBirth is recorded) matches the ISO instant of
 * that day — nothing else is loosened.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (typeof a === "string" && typeof b === "string") {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    if (dateOnly.test(a) && b.startsWith(a + "T")) return true;
    if (dateOnly.test(b) && a.startsWith(b + "T")) return true;
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const stripeTouched = (row: AuditRowLike) => {
  const m = meta(row);
  return Boolean(m.stripePaused || m.stripeResumed || m.stripe || m.stripeSubscriptionId);
};

/** The registry proper. Anything absent falls through to the prefix rules in `decide`. */
export const UNDO_HANDLERS: Record<string, UndoHandler> = {
  "member.update": snapshotHandler("Member", {
    decide(m, fields) {
      // A notes/medical-only edit never enters the log (health data outlives
      // an erasure); say so rather than "recorded before snapshots".
      const sent = Array.isArray(m.fields) ? (m.fields as unknown[]) : [];
      if (fields.length === 0 && sent.length > 0 && sent.every((f) => f === "notes" || f === "medicalConditions")) {
        return { ok: false, reason: REASON.privateText };
      }
      // A PATCH that cancelled (or reactivated) a member also cancels the
      // Stripe subscription and stamps cancelledAt; restoring `status` alone
      // would show them active while Stripe stays cancelled.
      if (m.stripe) return { ok: false, reason: REASON.stripe };
      if (fields.includes("status")) {
        const ch = asRecord(m.changes)?.status as { from?: unknown; to?: unknown } | undefined;
        const b = asRecord(m.before)?.status;
        const a = asRecord(m.after)?.status;
        const touched = [ch?.from, ch?.to, b, a];
        if (touched.includes("cancelled")) return { ok: false, reason: REASON.cancellation };
      }
      return null;
    },
    guard(current) {
      // Erasure nulls the personal fields; a "cleared" diff would pass the
      // stale check and write them back. The member PATCH refuses erased
      // members (members/[id]/route.ts); so does the undo.
      if (typeof current.email === "string" && /^deleted-.*@deleted.invalid$/.test(current.email)) {
        throw new UndoStale(REASON.erased);
      }
    },
  }),
  "tenant.settings.update": snapshotHandler("Tenant", {
    after(row) {
      try {
        revalidateTag(`gym-branding-${row.tenantId}`, { expire: 0 });
      } catch {
        // Outside a Next request store (unit tests) revalidateTag throws; the
        // 60 s cache then expires on its own clock — same as the settings PATCH.
      }
    },
  }),
  "staff.update": snapshotHandler("User", {
    // A role or email change forces re-sign-in on the staff PATCH; the undo
    // must do the same or the person keeps the undone role on a live session.
    extra: (restore) => ("role" in restore || "email" in restore ? { sessionVersion: { increment: 1 } } : {}),
  }),
  "class.updated": snapshotHandler("Class"),
  "membership.tier.update": snapshotHandler("MembershipTier", {
    guard(current, restore) {
      if (current.stripePriceId && ("pricePence" in restore || "currency" in restore || "billingCycle" in restore)) {
        throw new UndoStale("This plan has a Stripe price; change the price from the Memberships page so Stripe is updated too.");
      }
    },
  }),
  "rank.updated": snapshotHandler("RankSystem"),
  "location.update": snapshotHandler("Location", {
    decide(m) {
      // Undoing "make default" would leave the club with no default venue.
      const b = asRecord(m.before);
      const a = asRecord(m.after);
      if (a?.isDefault === true && b?.isDefault === false) return { ok: false, reason: REASON.defaultVenue };
      return null;
    },
  }),

  "class.roster.add": {
    decide: (row) => (meta(row).classId && meta(row).memberId ? { ok: true } : { ok: false, reason: REASON.noSnapshot }),
    async apply(tx, row) {
      const { classId, memberId } = meta(row) as { classId: string; memberId: string };
      const r = await tx.classRoster.deleteMany({ where: { classId, memberId, member: { tenantId: row.tenantId ?? undefined } } });
      if (r.count === 0) throw new UndoStale("They are no longer on that roster.");
    },
  },
  "class.roster.remove": {
    decide: (row) => (meta(row).classId && meta(row).memberId ? { ok: true } : { ok: false, reason: REASON.noSnapshot }),
    async apply(tx, row) {
      const { classId, memberId } = meta(row) as { classId: string; memberId: string };
      const tenantId = row.tenantId ?? "";
      const cls = await tx.class.findFirst({ where: { id: classId, tenantId }, select: { id: true, requiredRankId: true, maxRankId: true } });
      const mem = await tx.member.findFirst({ where: { id: memberId, tenantId }, select: { id: true } });
      if (!cls || !mem) throw new UndoStale("The class or member no longer exists.");
      if (cls.requiredRankId || cls.maxRankId) throw new UndoStale(REASON.rankGated);
      const exists = await tx.classRoster.findFirst({ where: { classId, memberId } });
      if (exists) throw new UndoStale("They are already back on that roster.");
      await tx.classRoster.create({ data: { tenantId, classId, memberId, addedByUserId: row.userId } });
    },
  },

  "member.link.child": {
    decide(row) {
      const m = meta(row);
      if (!m.childMemberId) return { ok: false, reason: REASON.noSnapshot };
      if ("accountType" in m) return { ok: false, reason: REASON.retyped };
      return { ok: true };
    },
    async apply(tx, row) {
      const m = meta(row) as { parentMemberId: string; childMemberId: string; previousParentMemberId?: string | null };
      const prev = m.previousParentMemberId ?? null;
      const r = await tx.member.updateMany({
        where: { id: m.childMemberId, tenantId: row.tenantId ?? undefined, parentMemberId: m.parentMemberId },
        // A staff member putting a link back is a staff-made link: confirmed.
        data: prev ? { parentMemberId: prev, ...CONFIRMED_BY("staff") } : { parentMemberId: null, guardianConfirmedAt: null, guardianSuggestedBy: null },
      });
      if (r.count === 0) throw new UndoStale();
    },
  },
  "member.unlink.child": {
    decide: (row) => (meta(row).childMemberId && meta(row).parentMemberId ? { ok: true } : { ok: false, reason: REASON.noSnapshot }),
    async apply(tx, row) {
      const m = meta(row) as { parentMemberId: string; childMemberId: string };
      const r = await tx.member.updateMany({
        where: { id: m.childMemberId, tenantId: row.tenantId ?? undefined, parentMemberId: null },
        data: { parentMemberId: m.parentMemberId, ...CONFIRMED_BY("staff") },
      });
      if (r.count === 0) throw new UndoStale();
    },
  },

  // Guardian suggestions (2 Oct 2026). Confirming is undone by making the link
  // SUGGESTED again (the parent loses access immediately); rejecting is undone
  // by putting the suggestion back exactly as it was. Nothing here touches a
  // login address: a confirm that also adopted the payer's email is refused.
  "member.guardian.confirmed": {
    decide(row) {
      const m = meta(row);
      if (!m.parentMemberId) return { ok: false, reason: REASON.noSnapshot };
      if (m.emailAdopted) return { ok: false, reason: REASON.emailAdopted };
      return { ok: true };
    },
    async apply(tx, row) {
      const m = meta(row) as { parentMemberId: string; wasConfirmed?: boolean };
      if (m.wasConfirmed) return; // confirming an already-confirmed link changed nothing
      const r = await tx.member.updateMany({
        where: { id: row.entityId, tenantId: row.tenantId ?? undefined, parentMemberId: m.parentMemberId, guardianConfirmedAt: { not: null } },
        data: { guardianConfirmedAt: null },
      });
      if (r.count === 0) throw new UndoStale("The guardian link has changed since.");
    },
  },
  "member.guardian.rejected": {
    decide: (row) => (meta(row).parentMemberId ? { ok: true } : { ok: false, reason: REASON.noSnapshot }),
    async apply(tx, row) {
      const m = meta(row) as { parentMemberId: string; suggestedBy?: string | null; wasConfirmed?: boolean };
      const r = await tx.member.updateMany({
        where: { id: row.entityId, tenantId: row.tenantId ?? undefined, parentMemberId: null },
        data: {
          parentMemberId: m.parentMemberId,
          guardianConfirmedAt: m.wasConfirmed ? new Date() : null,
          guardianSuggestedBy: m.suggestedBy ?? null,
        },
      });
      if (r.count === 0) throw new UndoStale("They have been linked to a guardian since.");
    },
  },

  "member.hold.start": {
    decide: (row) => (stripeTouched(row) ? { ok: false, reason: REASON.stripe } : { ok: true }),
    async apply(tx, row) {
      const prior = (meta(row).priorPaymentStatus as string | undefined) ?? "paid";
      const r = await tx.member.updateMany({
        where: { id: row.entityId, tenantId: row.tenantId ?? undefined, paymentStatus: "paused" },
        data: { paymentStatus: prior, holdUntil: null, holdPriorStatus: null },
      });
      if (r.count === 0) throw new UndoStale("They are no longer on hold.");
    },
  },
  "member.hold.end": {
    decide: (row) => (stripeTouched(row) ? { ok: false, reason: REASON.stripe } : { ok: true }),
    async apply(tx, row) {
      const holdUntil = meta(row).holdUntil as string | null | undefined;
      const current = await tx.member.findFirst({ where: { id: row.entityId, tenantId: row.tenantId ?? undefined }, select: { paymentStatus: true } });
      if (!current) throw new UndoStale("This member no longer exists.");
      if (current.paymentStatus === "paused") throw new UndoStale("They are already on hold.");
      await tx.member.update({
        where: { id: row.entityId },
        data: { paymentStatus: "paused", holdUntil: holdUntil ? new Date(holdUntil) : null, holdPriorStatus: current.paymentStatus },
      });
    },
  },

  "member.rank.promote": rankHandler(),
  "member.rank.demote": rankHandler(),

  // A check-in is removed the way the register removes it: pack credits
  // restored in the same transaction, then the record deleted. Self/kiosk
  // rows store the record id as entityId; staff marks store the
  // (classInstanceId, memberId) pair, and since 3 Oct 2026 also `recordId`
  // and `created` (whether the tick made the row). The handler removes only a
  // row the action created, and never an imported one.
  "attendance.mark": attendanceHandler(),
  "attendance.kiosk_checkin": attendanceHandler(),
  "attendance.self_checkin": attendanceHandler(),
};

/**
 * Rank changes live on MemberRank (one row per member per discipline).
 * Promote/demote record `fromRankId` (null on a first grading), `toRankId`,
 * `stripes` (new) and `fromStripes` (previous, from 1 Oct 2026). A first
 * grading is refused (its RankHistory row blocks the delete; demote from the
 * profile instead); a demotion that removed class bookings is refused.
 */
function rankHandler(): UndoHandler {
  return {
    decide(row) {
      const m = meta(row);
      if (typeof m.cancelledSubscriptions === "number" && m.cancelledSubscriptions > 0) return { ok: false, reason: REASON.cascade };
      if (!("fromRankId" in m) || typeof m.toRankId !== "string") return { ok: false, reason: REASON.noSnapshot };
      if (m.fromRankId === null) return { ok: false, reason: REASON.firstGrading };
      if (typeof m.fromStripes !== "number") return { ok: false, reason: REASON.noSnapshot };
      return { ok: true };
    },
    async apply(tx, row) {
      const m = meta(row) as { fromRankId: string; toRankId: string; stripes?: number; fromStripes: number };
      const current = await tx.memberRank.findFirst({
        where: {
          memberId: row.entityId,
          rankSystemId: m.toRankId,
          ...(typeof m.stripes === "number" ? { stripes: m.stripes } : {}),
          member: { tenantId: row.tenantId ?? undefined },
        },
        select: { id: true },
      });
      if (!current) throw new UndoStale("Their rank has changed again since.");
      await tx.memberRank.update({
        where: { id: current.id },
        data: { rankSystemId: m.fromRankId, stripes: m.fromStripes, promotedById: row.userId },
      });
    },
  };
}

function attendanceHandler(): UndoHandler {
  return {
    decide(row) {
      const m = meta(row);
      // A staff tick on a member already checked in was a no-op upsert: the
      // row belongs to whatever made it (a scan, a self check-in, an import).
      if (m.created === false) return { ok: false, reason: REASON.tickFoundRow };
      const byRecord = typeof m.recordId === "string";
      const byPair = typeof m.classInstanceId === "string" && typeof m.memberId === "string";
      const byId = row.entityType === "AttendanceRecord" && !!row.entityId && !row.entityId.includes(":");
      return byRecord || byPair || byId ? { ok: true } : { ok: false, reason: REASON.noSnapshot };
    },
    async apply(tx, row) {
      const m = meta(row);
      if (m.created === false) throw new UndoStale(REASON.tickFoundRow);
      const tenantId = row.tenantId ?? undefined;
      // The exact record id wins: `recordId` on staff marks, the entityId on
      // self/kiosk rows. Staff marks logged before `recordId` existed only
      // have the (classInstanceId, memberId) pair, so a later re-mark of the
      // same pair is what gets removed — the register shows that, the log says so.
      const hasRecordId = row.entityType === "AttendanceRecord" && !!row.entityId && !row.entityId.includes(":");
      const recordId = typeof m.recordId === "string" ? m.recordId : hasRecordId ? row.entityId : null;
      const where = recordId
        ? { id: recordId, member: { tenantId } }
        : { classInstanceId: m.classInstanceId as string, memberId: m.memberId as string, member: { tenantId } };
      const records = await tx.attendanceRecord.findMany({ where, select: { id: true, checkInMethod: true, importJobId: true } });
      if (records.length === 0) throw new UndoStale("That check-in was already removed.");
      // Imported history is never removed by an undo: no live check-in made it.
      const own = records.filter((r) => r.checkInMethod !== "import" && !r.importJobId);
      if (own.length === 0) throw new UndoStale(REASON.importedRow);
      const ids = own.map((r) => r.id);
      await restorePackCreditsForAttendance(tx, ids);
      await tx.attendanceRecord.deleteMany({ where: { id: { in: ids } } });
    },
  };
}

/** Prefix rules for everything without a handler — the reason is what the owner reads. */
const IRREVERSIBLE: [RegExp, string][] = [
  [/^undo\./, REASON.undoOfUndo],
  [/^attendance\.override$/, REASON.reMark],
  [/^attendance\.unmark$/, REASON.reMark],
  [/^attendance\.card_scan$/, REASON.batchScan],
  [/^(email\.|payment\.chase|member\.bulk_invite|staff\.invite)/, REASON.email],
  [/^(payment|payments|order|billing)\./, REASON.money],
  [/^member\.payment\./, REASON.money],
  [/^stripe\./, REASON.stripe],
  [/^member\.subscription\./, REASON.stripe],
  [/^(auth\.|user\.|member\.totp_reset|staff\.totp_reset|member\.unlock|staff\.unlock|member\.card_revoked)/, REASON.security],
  [/^admin\./, REASON.operator],
  [/^import\./, REASON.importer],
  [/^member\.dsar_/, REASON.record],
  [/^member\.delete$/, REASON.deleteNoRestore],
  [/^waiver\./, REASON.record],
  [/^(report\.|drive\.|onboarding\.|class\.instances_generated|member\.invite_link|member\.waiver_link|member\.waiver\.)/, REASON.record],
];

export function decideUndo(row: AuditRowLike, alreadyUndone: boolean): UndoDecision {
  if (alreadyUndone) return { ok: false, reason: REASON.alreadyUndone };
  const handler = UNDO_HANDLERS[row.action];
  if (handler) return handler.decide(row);
  for (const [re, reason] of IRREVERSIBLE) if (re.test(row.action)) return { ok: false, reason };
  return { ok: false, reason: REASON.noSnapshot };
}

export async function applyUndo(tx: TxLike, row: AuditRowLike): Promise<void> {
  const handler = UNDO_HANDLERS[row.action];
  if (!handler) throw new Error(`No undo handler for ${row.action}`);
  await handler.apply(tx, row);
}
