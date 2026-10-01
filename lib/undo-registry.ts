/**
 * Undo registry — which audit rows an OWNER can reverse, and how (1 Oct 2026,
 * "give them the option to undo to points").
 *
 * Honest model, not time-travel: a row is reversible only when it carries
 * enough to put the entity back (a `before` snapshot, a from→to diff, or a
 * pure state flip whose inverse is known). Anything that moved money, called
 * Stripe, sent mail, touched sign-in security, or was MatFlow's own doing is
 * refused with a sentence that says why. "Undo to a point" is this registry
 * applied newest→oldest over one staff member's rows (lib/undo-batch.ts).
 *
 * Every handler runs inside the caller's `withTenantContext` transaction and
 * is given the tenant-scoped `tx`; handlers always filter on `tenantId` as
 * well (RLS is the backstop). Stale protection: before restoring, a handler
 * compares the current row with what the audit row says the action produced
 * (`after`, or the diff's `to`); if someone has changed it since, the undo is
 * refused rather than forced.
 */
import type { Prisma } from "@prisma/client";

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
  deleteNoRestore: "Deleted before soft-delete existed — the row is gone.",
  cascade: "This also removed class bookings, which can't be restored from here.",
} as const;

const meta = (row: AuditRowLike): Record<string, unknown> =>
  row.metadata && typeof row.metadata === "object" ? (row.metadata as Record<string, unknown>) : {};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Fields a `before` snapshot may legitimately restore per entity — never ids, tenancy, secrets or money. */
const RESTORABLE: Record<string, readonly string[]> = {
  Member: [
    "name", "email", "phone", "membershipType", "status", "paymentStatus", "notes",
    "emergencyContactName", "emergencyContactPhone", "emergencyContactRelation", "dateOfBirth",
    "medicalConditions", "accountType", "membershipTierId", "nextDueAt", "holdUntil", "holdPriorStatus",
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

/** Restore `before` for the fields that the action changed, refusing if `after` no longer matches. */
function snapshotHandler(entityType: string): UndoHandler {
  const allowed = new Set(RESTORABLE[entityType] ?? []);
  return {
    decide(row) {
      const m = meta(row);
      const before = asRecord(m.before);
      const changes = asRecord(m.changes);
      if (!before && !changes) return { ok: false, reason: REASON.noSnapshot };
      return { ok: true };
    },
    async apply(tx, row) {
      const m = meta(row);
      const before = asRecord(m.before);
      const after = asRecord(m.after);
      const changes = asRecord(m.changes);
      const d = delegate(tx, entityType);
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
      // Dates come back from JSON as strings; Prisma wants Date for DateTime.
      for (const f of Object.keys(restore)) {
        if (current[f] instanceof Date && typeof restore[f] === "string") restore[f] = new Date(restore[f] as string);
      }
      await d.update({ where: { id: row.entityId }, data: restore });
    },
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date) a = a.toISOString();
  if (b instanceof Date) b = b.toISOString();
  if (typeof a === "string" && typeof b === "string") {
    // "2026-10-01" vs "2026-10-01T00:00:00.000Z" (date-only diffs are stored as ISO dates)
    if (a.length === 10 && b.startsWith(a)) return true;
    if (b.length === 10 && a.startsWith(b)) return true;
  }
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

const stripeTouched = (row: AuditRowLike) => {
  const m = meta(row);
  return Boolean(m.stripePaused || m.stripeResumed || m.stripe || m.stripeSubscriptionId);
};

/** The registry proper. Anything absent falls through to the prefix rules in `decide`. */
export const UNDO_HANDLERS: Record<string, UndoHandler> = {
  "member.update": snapshotHandler("Member"),
  "tenant.settings.update": snapshotHandler("Tenant"),
  "staff.update": snapshotHandler("User"),
  "class.updated": snapshotHandler("Class"),
  "membership.tier.update": snapshotHandler("MembershipTier"),
  "rank.updated": snapshotHandler("RankSystem"),
  "location.update": snapshotHandler("Location"),

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
      const exists = await tx.classRoster.findFirst({ where: { classId, memberId } });
      if (exists) throw new UndoStale("They are already back on that roster.");
      await tx.classRoster.create({ data: { tenantId, classId, memberId, addedByUserId: row.userId } });
    },
  },

  "member.link.child": {
    decide: (row) => (meta(row).childMemberId ? { ok: true } : { ok: false, reason: REASON.noSnapshot }),
    async apply(tx, row) {
      const m = meta(row) as { parentMemberId: string; childMemberId: string; previousParentMemberId?: string | null };
      const r = await tx.member.updateMany({
        where: { id: m.childMemberId, tenantId: row.tenantId ?? undefined, parentMemberId: m.parentMemberId },
        data: { parentMemberId: m.previousParentMemberId ?? null },
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
        data: { parentMemberId: m.parentMemberId },
      });
      if (r.count === 0) throw new UndoStale();
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

  "attendance.mark": attendanceHandler(),
  "attendance.override": attendanceHandler(),
  "attendance.kiosk_checkin": attendanceHandler(),
  "attendance.card_scan": attendanceHandler(),
  "attendance.self_checkin": attendanceHandler(),
};

/**
 * Rank changes live on MemberRank (one row per member per discipline). Promote
 * records `fromRankId` (null on a first grading) and `toRankId`; `fromStripes`
 * is recorded from 1 Oct 2026 — older rows restore to 0 stripes, said on screen.
 * A demotion that also removed class bookings is refused: those bookings are
 * gone and this registry does not pretend otherwise.
 */
function rankHandler(): UndoHandler {
  return {
    decide(row) {
      const m = meta(row);
      if (typeof m.cancelledSubscriptions === "number" && m.cancelledSubscriptions > 0) return { ok: false, reason: REASON.cascade };
      if (!("fromRankId" in m) || typeof m.toRankId !== "string") return { ok: false, reason: REASON.noSnapshot };
      return { ok: true };
    },
    async apply(tx, row) {
      const m = meta(row) as { fromRankId: string | null; toRankId: string; fromStripes?: number };
      const current = await tx.memberRank.findFirst({
        where: { memberId: row.entityId, rankSystemId: m.toRankId, member: { tenantId: row.tenantId ?? undefined } },
        select: { id: true },
      });
      if (!current) throw new UndoStale("Their rank has changed again since.");
      if (m.fromRankId === null) {
        await tx.memberRank.delete({ where: { id: current.id } });
        return;
      }
      await tx.memberRank.update({
        where: { id: current.id },
        data: { rankSystemId: m.fromRankId, stripes: m.fromStripes ?? 0, promotedById: row.userId },
      });
    },
  };
}

function attendanceHandler(): UndoHandler {
  return {
    decide: (row) => (row.entityType === "AttendanceRecord" && row.entityId ? { ok: true } : { ok: false, reason: REASON.noSnapshot }),
    async apply(tx, row) {
      const r = await tx.attendanceRecord.deleteMany({ where: { id: row.entityId, member: { tenantId: row.tenantId ?? undefined } } });
      if (r.count === 0) throw new UndoStale("That check-in was already removed.");
    },
  };
}

/** Prefix rules for everything without a handler — the reason is what the owner reads. */
const IRREVERSIBLE: [RegExp, string][] = [
  [/^undo\./, REASON.undoOfUndo],
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
