/**
 * The Activity timeline's server half (5 Nov 2026).
 *
 * Turns AuditLog rows into what the timeline shows: a type, a sentence whose
 * people and subjects are links, a detail line, a source, and — for the owner
 * — whether the row can be undone. Also builds the queries: which rows a set
 * of activity types selects, and what a manager may never be sent.
 *
 * Three rules hold everywhere in this file:
 *  1. Nothing is read from a member's or class's CURRENT state to describe a
 *     past event. A sentence is built only from ids stored on the row.
 *  2. A raw AuditLog row never leaves this module. `FeedEntry` is the only
 *     shape serialised: no metadata, no ids of other records, no addresses.
 *  3. The type a row shows (`typeOf`) and the filter that finds it
 *     (`whereForTypes`) are compiled from the same rules, so they cannot
 *     drift. tests/unit/activity-feed-where.test.ts proves it in memory;
 *     tests/integration/activity-feed-db.test.ts proves the SQL agrees.
 *
 * Server-only: client components import lib/activity-types.ts, never this.
 */
import "server-only";
import { Prisma } from "@prisma/client";
import {
  ACTIVITY_TYPES,
  OTHER_TYPE,
  activityType,
  fieldLabel,
  typeKeyForAction,
  visibleTypeKeys,
  type ActivityRole,
  type FeedChange,
  type FeedEntry,
  type FeedSource,
  type FeedSubject,
  type FeedUndo,
  type Part,
  type SubjectKind,
} from "@/lib/activity-types";
import { UNDO_PREFIX, auditEntryLabel, classLifecycleOf, isUndoAction } from "@/lib/audit-labels";
import { clubDayKey } from "@/lib/club-month";
import { formatDate } from "@/lib/date";
import { parseIdParam } from "@/lib/id-param";
import { ERASED_EMAIL } from "@/lib/login-email";
import { formatMoney } from "@/lib/payment-totals";
import { sessionLabel } from "@/lib/session-label";
import type { UndoDecision } from "@/lib/undo-registry";

/**
 * "£45.00". A currency code that Intl does not know (a hand-typed "1AB" on a
 * desk payment) must not fail the page: the amount is then shown with the code
 * as written.
 */
export function money(pence: number, currency: string | null | undefined): string {
  const code = (currency ?? "GBP").toUpperCase();
  try {
    return formatMoney(pence, code);
  } catch {
    return `${(pence / 100).toFixed(2)} ${code}`;
  }
}

type Where = Prisma.AuditLogWhereInput;
type Meta = Record<string, unknown>;

const record = (v: unknown): Meta | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : null);
const metaOf = (row: { metadata: unknown }): Meta => record(row.metadata) ?? {};
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const idOf = (v: unknown): string | null => parseIdParam(v);

// ── Row rules: types decided by a row's metadata, not only its action ─────────

/**
 * In SQL, `NOT (metadata #> path = 'x')` is NULL — not true — when the path is
 * absent, so a naive negation silently drops ordinary rows (a member edit that
 * never touched `status`). Every `whereNot` below is therefore written out by
 * hand to include the absent cases; `absent` is the building block.
 */
const absent = (path: string[]): Where[] => [{ metadata: { equals: Prisma.DbNull } }, { metadata: { path, equals: Prisma.AnyNull } }];

export type RowRule = {
  /** The activity type that claims the row. */
  type: string;
  /** The one action the rule looks at. */
  action: string;
  /** Rows of that action the rule claims. */
  where: Where;
  /**
   * Every other row of that action, including rows with no metadata at all.
   * Absent when it cannot be written (see the check-in rule): the type that
   * owns the action then keeps ALL its rows, the claimed ones included.
   */
  whereNot?: Where;
  /** The same decision in memory. */
  test: (metadata: unknown) => boolean;
};

const EXCEPTION_FLAGS = ["on_hold", "waiver_unsigned", "kids_class"] as const;
const hasFlag = (flag: string): Where => ({ metadata: { path: ["acknowledged"], array_contains: [flag] } });

const STATUS_TO = ["changes", "status", "to"];
const CANCELLED: Where = { metadata: { path: STATUS_TO, equals: "cancelled" } };
const TIER_CHANGE = ["changes", "membershipTierId"];
const CHARGE_SUCCEEDED: Where = { metadata: { path: ["outcome"], equals: "succeeded" } };

/** Tested in this order, before any exact action name. The first rule that claims a row wins. */
export const ROW_RULES: RowRule[] = [
  {
    // No `whereNot`. Prisma renders NOT (array contains x) as "is an array that does not contain x", so "everything
    // else" — which has to include a value that is not a list at all — cannot be written, and a row in neither half
    // would be found by no filter (measured against Postgres, 5 Nov 2026). So the two types overlap instead: Check-in
    // finds every staff check-in, and this type finds the ones with a warning. A warned check-in is still a check-in.
    type: "checkin_exception",
    action: "attendance.mark",
    where: { OR: EXCEPTION_FLAGS.map(hasFlag) },
    test: (metadata) => {
      const flags = metaOf({ metadata }).acknowledged;
      return Array.isArray(flags) && EXCEPTION_FLAGS.some((f) => flags.includes(f));
    },
  },
  {
    type: "cancellation",
    action: "member.update",
    where: CANCELLED,
    whereNot: { OR: [...absent(STATUS_TO), { NOT: CANCELLED }] },
    test: (metadata) => record(record(metaOf({ metadata }).changes)?.status)?.to === "cancelled",
  },
  {
    type: "membership_changed",
    action: "member.update",
    where: { NOT: { OR: absent(TIER_CHANGE) } },
    whereNot: { OR: absent(TIER_CHANGE) },
    test: (metadata) => record(metaOf({ metadata }).changes)?.membershipTierId != null,
  },
  {
    // A charge the card refused, or one never confirmed. A row written before
    // the outcome was recorded has no `outcome` and stays a Payment.
    type: "payment_failed",
    action: "payment.adhoc.charge",
    where: { AND: [{ NOT: { OR: absent(["outcome"]) } }, { NOT: CHARGE_SUCCEEDED }] },
    whereNot: { OR: [...absent(["outcome"]), CHARGE_SUCCEEDED] },
    test: (metadata) => {
      const outcome = metaOf({ metadata }).outcome;
      return outcome != null && outcome !== "succeeded";
    },
  },
];

/**
 * The type a row SHOWS: the first row rule that claims it, else its action's type, else Other.
 * Every filter that finds a row is either that type's or, for a rule without a complement, the
 * type that owns the action as well (`typesFinding`).
 */
export function typeOf(row: { action: string; metadata: unknown }): string {
  for (const rule of ROW_RULES) if (rule.action === row.action && rule.test(row.metadata)) return rule.type;
  return typeKeyForAction(row.action);
}

/** The types whose filter finds a row: the one it shows, plus the action's own type where the claiming rule has no complement. */
export function typesFinding(row: { action: string; metadata: unknown }): string[] {
  const shown = typeOf(row);
  const rule = ROW_RULES.find((r) => r.type === shown && r.action === row.action && r.test(row.metadata));
  return rule && !rule.whereNot ? [shown, typeKeyForAction(row.action)] : [shown];
}

// ── Queries ──────────────────────────────────────────────────────────────────

const rulesOn = (action: string) => ROW_RULES.filter((r) => r.action === action);
const KNOWN_ACTIONS = [...new Set(ACTIVITY_TYPES.flatMap((t) => t.actions))];
const KNOWN_PREFIXES = [...new Set(ACTIVITY_TYPES.flatMap((t) => t.prefixes))];

/** Everything no type names. `action` is never null, so this negation is safe. */
const OTHER_WHERE: Where = { NOT: { OR: [{ action: { in: KNOWN_ACTIONS } }, ...KNOWN_PREFIXES.map((p) => ({ action: { startsWith: p } }))] } };

/** Matches no row. */
const NOTHING: Where = { id: { in: [] } };

function compile(keys: string[]): Where {
  const plain: string[] = [];
  const or: Where[] = [];
  for (const key of keys) {
    if (key === OTHER_TYPE) {
      or.push(OTHER_WHERE);
      continue;
    }
    const type = activityType(key);
    if (!type) continue;
    for (const action of type.actions) {
      // An action some row rule claims: this type keeps only the rows no rule took — where the rule can say what
      // it did not take. A rule without a complement leaves the whole action here.
      const complements = rulesOn(action).flatMap((r) => (r.whereNot ? [r.whereNot] : []));
      if (complements.length) or.push({ AND: [{ action }, ...complements] });
      else plain.push(action);
    }
    for (const prefix of type.prefixes) or.push({ action: { startsWith: prefix } });
    ROW_RULES.forEach((rule, i) => {
      if (rule.type !== key) return;
      // First match wins: a later rule on the same action takes only what the earlier ones left.
      const earlier = ROW_RULES.slice(0, i).filter((r) => r.action === rule.action);
      or.push({ AND: [{ action: rule.action }, rule.where, ...earlier.flatMap((r) => (r.whereNot ? [r.whereNot] : []))] });
    });
  }
  if (plain.length) or.unshift({ action: { in: plain } });
  if (or.length === 0) return NOTHING;
  return or.length === 1 ? or[0] : { OR: or };
}

/**
 * The rows the chosen activity types select, for this role. Keys the role may
 * not see are dropped here as well as by the caller; an empty selection
 * matches nothing rather than everything.
 */
export function whereForTypes(keys: string[], role: ActivityRole): Where {
  const visible = visibleTypeKeys(role);
  const chosen = visible.filter((k) => keys.includes(k));
  if (role === "owner" && chosen.length === visible.length) return {};
  return compile(chosen);
}

/** A row not written during a MatFlow support session: no `metadata.actingAs`. Null-safe on purpose (see `absent`). */
export const NO_SUPPORT_SESSION: Where = { OR: absent(["actingAs"]) };

/**
 * What a manager may ever be sent, whatever the request asks for: only the
 * types they can see, written positively so an action nobody has mapped yet
 * is excluded, and nothing done by or through MatFlow support. `{}` for the
 * owner.
 */
export function visibleWhere(role: ActivityRole): Where {
  if (role === "owner") return {};
  return { AND: [compile(visibleTypeKeys("manager")), { operatorId: null }, NO_SUPPORT_SESSION] };
}

/**
 * Activity about one member: rows on their record, rows that name them
 * (a check-in, a card-scan batch, a parent acting for a child), and rows on
 * their payments — a refund carries no member id of its own.
 */
export function memberWhere(memberId: string, paymentIds: string[]): Where {
  const named = ["memberId", "actorId", "parentMemberId", "childMemberId"].map((key): Where => ({ metadata: { path: [key], equals: memberId } }));
  return {
    OR: [
      { entityType: "Member", entityId: memberId },
      ...named,
      { metadata: { path: ["memberIds"], array_contains: [memberId] } },
      ...(paymentIds.length ? [{ entityType: "Payment", entityId: { in: paymentIds } }] : []),
    ],
  };
}

/** Changes to one class, and rows that name it. */
export function classWhere(classId: string): Where {
  return { OR: [{ entityType: "Class", entityId: classId }, { metadata: { path: ["classId"], equals: classId } }] };
}

/** One payment's trail. A Stripe payment's "paid" row carries only the invoice id. */
export function paymentWhere(paymentId: string, stripeInvoiceId: string | null): Where {
  return {
    OR: [
      { entityType: "Payment", entityId: paymentId },
      { metadata: { path: ["paymentId"], equals: paymentId } },
      ...(stripeInvoiceId ? [{ metadata: { path: ["stripeInvoiceId"], equals: stripeInvoiceId } }] : []),
    ],
  };
}

/** Activity that names one plan: changes to it, and members put on it, moved off it or cancelling it. */
export function tierWhere(tierId: string): Where {
  const paths = [["tierId"], ["membershipTierId"], [...TIER_CHANGE, "from"], [...TIER_CHANGE, "to"]];
  return { OR: [{ entityType: "MembershipTier", entityId: tierId }, ...paths.map((path): Where => ({ metadata: { path, equals: tierId } }))] };
}

// ── Rows, subjects and lookups ───────────────────────────────────────────────

/** The columns the feed reads. `operatorId` is used to say "MatFlow support" and is never returned. */
export type FeedRow = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
  userId: string | null;
  operatorId: string | null;
  /** The staff member behind `userId`. The route drops a joined user that is not of this club before anything reads it. */
  user?: { id: string; name: string | null; tenantId?: string } | null;
};

export const FEED_ROW_SELECT = {
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  metadata: true,
  createdAt: true,
  userId: true,
  operatorId: true,
  user: { select: { id: true, name: true, tenantId: true } },
} satisfies Prisma.AuditLogSelect;


type PaymentInfo = { id: string; memberId: string | null; amountPence: number; currency: string; stripeInvoiceId: string | null };

/** Names for the ids a page of rows carries. Built once per page by `loadLookups`. */
export type ActivityLookups = {
  members: Map<string, { name: string; erased: boolean }>;
  /** A hard-deleted member's name, from their own "deleted" row (kept for the year the log lives). */
  deletedMemberNames: Map<string, string>;
  classes: Map<string, { name: string }>;
  sessions: Map<string, { classId: string; className: string; date: Date; startTime: string }>;
  payments: Map<string, PaymentInfo>;
  paymentsByInvoice: Map<string, PaymentInfo>;
  orders: Map<string, { orderRef: string; memberId: string | null; totalPence: number; currency: string }>;
  tiers: Map<string, { name: string }>;
  packs: Map<string, { name: string }>;
  venues: Map<string, { name: string }>;
  staff: Map<string, { name: string }>;
  ranks: Map<string, { name: string }>;
};

export function emptyLookups(): ActivityLookups {
  return {
    members: new Map(),
    deletedMemberNames: new Map(),
    classes: new Map(),
    sessions: new Map(),
    payments: new Map(),
    paymentsByInvoice: new Map(),
    orders: new Map(),
    tiers: new Map(),
    packs: new Map(),
    venues: new Map(),
    staff: new Map(),
    ranks: new Map(),
  };
}

type RefKind = "member" | "class" | "session" | "payment" | "invoice" | "order" | "tier" | "pack" | "venue" | "staff" | "rank";
export type SubjectRefs = Record<RefKind, Set<string>>;

/** What an entity row points at. `AttendanceRecord`, `ClassRoster`, `Task` and the rest name nothing linkable themselves. */
const ENTITY_KIND: Record<string, RefKind> = {
  Member: "member",
  Class: "class",
  ClassInstance: "session",
  Payment: "payment",
  Order: "order",
  MembershipTier: "tier",
  ClassPack: "pack",
  Location: "venue",
  User: "staff",
  RankSystem: "rank",
};

/** Metadata keys that hold the id of a record the feed names. A unit test fails on an id key that is neither here nor in IGNORED_ID_KEYS. */
export const RESOLVED_ID_KEYS: Record<string, RefKind> = {
  memberId: "member",
  actorId: "member",
  parentMemberId: "member",
  childMemberId: "member",
  previousParentMemberId: "member",
  assigneeMemberId: "member",
  targetMemberId: "member",
  childId: "member",
  assignedToId: "staff",
  classId: "class",
  classInstanceId: "session",
  paymentId: "payment",
  stripeInvoiceId: "invoice",
  tierId: "tier",
  membershipTierId: "tier",
  classPackId: "pack",
  locationId: "venue",
  fromRankId: "rank",
  toRankId: "rank",
};

/**
 * Id keys the feed deliberately does not turn into a name or a link: provider
 * references, ids of records with no page of their own, and operator-plane
 * ids. Listed so that a NEW id key has to be put in one list or the other.
 */
export const IGNORED_ID_KEYS = new Set([
  "allowedTierIds",
  "bookingsKeptIneligibleClassIds",
  "folderId",
  "hasStripePriceId",
  "holderId",
  "initiativeId",
  "loginEventId",
  "memberClassPackId",
  "memberRankId",
  "newOwnerId",
  // A shop order has no page of its own; its reference (orderRef) is what a person reads.
  "orderId",
  "ownerId",
  "ownerUserId",
  "previousOwnerId",
  "paymentIntentId",
  "paymentMethodId",
  "portalSessionId",
  "priceId",
  "recordId",
  "replacesSubscriptionId",
  "sessionId",
  "signedWaiverId",
  "stripeAccountId",
  "stripeCustomerId",
  "stripeFailedIds",
  "stripeRefundId",
  "stripeSubscriptionId",
  "stripeSubscriptionIds",
  "targetId",
  // Handled by hand in `subjectRefs`, not through RESOLVED_ID_KEYS.
  "memberIds",
]);

/** Changed fields whose value is the id of a named record. */
const ID_FIELD_KIND: Record<string, "tier" | "venue" | "staff" | "rank"> = {
  membershipTierId: "tier",
  locationId: "venue",
  instructorId: "staff",
  coachUserId: "staff",
  requiredRankId: "rank",
  maxRankId: "rank",
};

/**
 * `member.waiver.signed_via_kiosk` stores the signer's EMAIL as its entity id.
 * It is never looked up and never returned.
 */
const ENTITY_IS_NOT_AN_ID = new Set(["member.waiver.signed_via_kiosk"]);

/** Members named per card-scan row: the sentence shows three. */
const SCAN_MEMBERS_RESOLVED = 5;

/**
 * Every id a page of rows names, by kind. `focusMemberId` is the member the
 * page is filtered to: a card-scan batch is told as theirs even when they were
 * the twentieth card scanned, so they are always looked up.
 */
export function subjectRefs(rows: FeedRow[], focusMemberId?: string | null): SubjectRefs {
  const refs: SubjectRefs = { member: new Set(), class: new Set(), session: new Set(), payment: new Set(), invoice: new Set(), order: new Set(), tier: new Set(), pack: new Set(), venue: new Set(), staff: new Set(), rank: new Set() };
  const add = (kind: RefKind | undefined, value: unknown) => {
    const id = kind === "invoice" ? str(value) : idOf(value);
    if (kind && id) refs[kind].add(id);
  };
  if (rows.length) add("member", focusMemberId);
  for (const row of rows) {
    const m = metaOf(row);
    if (!ENTITY_IS_NOT_AN_ID.has(row.action)) add(ENTITY_KIND[row.entityType], row.entityId);
    if (row.userId) add("staff", row.userId);
    for (const [key, kind] of Object.entries(RESOLVED_ID_KEYS)) add(kind, m[key]);
    if (Array.isArray(m.memberIds)) for (const id of m.memberIds.slice(0, SCAN_MEMBERS_RESOLVED)) add("member", id);
    if (row.action === "waiver.sign-for-child") add("member", m.collectedBy);
    for (const [field, from, to] of changedPairs(m)) {
      add(ID_FIELD_KIND[field], from);
      add(ID_FIELD_KIND[field], to);
    }
  }
  return refs;
}

/** At most this many ids of one kind are looked up for a page. */
export const LOOKUP_CAP = 300;

type LookupTx = Pick<Prisma.TransactionClient, "member" | "class" | "classInstance" | "payment" | "order" | "membershipTier" | "classPack" | "location" | "user" | "rankSystem" | "auditLog">;

/**
 * Names for everything a page of rows points at. Each lookup runs only when
 * the page has ids of that kind, and every one is scoped to the club — an id
 * from another club resolves to nothing. Runs in its own transaction: if it
 * fails, the page is still served as plain sentences.
 */
export async function loadLookups(tx: LookupTx, tenantId: string, rows: FeedRow[], focusMemberId?: string | null): Promise<ActivityLookups> {
  const refs = subjectRefs(rows, focusMemberId);
  const out = emptyLookups();
  const list = (ids: Set<string>) => [...ids].slice(0, LOOKUP_CAP);

  // Actors arrive with the rows themselves.
  for (const row of rows) if (row.user?.name) out.staff.set(row.user.id, { name: row.user.name });

  // Payments and orders first: the member a refund or an order belongs to is on the record, not on the row.
  if (refs.payment.size || refs.invoice.size) {
    const either: Prisma.PaymentWhereInput[] = [];
    if (refs.payment.size) either.push({ id: { in: list(refs.payment) } });
    if (refs.invoice.size) either.push({ stripeInvoiceId: { in: list(refs.invoice) } });
    const payments = await tx.payment.findMany({ where: { tenantId, OR: either }, select: { id: true, memberId: true, amountPence: true, currency: true, stripeInvoiceId: true } });
    for (const p of payments) {
      out.payments.set(p.id, p);
      if (p.stripeInvoiceId) out.paymentsByInvoice.set(p.stripeInvoiceId, p);
      if (p.memberId) refs.member.add(p.memberId);
    }
  }
  if (refs.order.size) {
    const orders = await tx.order.findMany({ where: { tenantId, id: { in: list(refs.order) } }, select: { id: true, orderRef: true, memberId: true, totalPence: true, currency: true } });
    for (const o of orders) {
      out.orders.set(o.id, o);
      if (o.memberId) refs.member.add(o.memberId);
    }
  }
  if (refs.session.size) {
    // ClassInstance has no tenantId of its own: scoped through its class.
    const sessions = await tx.classInstance.findMany({ where: { id: { in: list(refs.session) }, class: { tenantId } }, select: { id: true, date: true, startTime: true, class: { select: { id: true, name: true } } } });
    for (const s of sessions) out.sessions.set(s.id, { classId: s.class.id, className: s.class.name, date: s.date, startTime: s.startTime });
  }
  if (refs.class.size) {
    const classes = await tx.class.findMany({ where: { tenantId, id: { in: list(refs.class) } }, select: { id: true, name: true } });
    for (const c of classes) out.classes.set(c.id, { name: c.name });
  }
  if (refs.member.size) {
    const ids = list(refs.member);
    // The address is read only to recognise an erased member; it goes no further.
    const members = await tx.member.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, email: true } });
    for (const m of members) out.members.set(m.id, { name: m.name, erased: ERASED_EMAIL.test(m.email) });
    const gone = ids.filter((id) => !out.members.has(id));
    if (gone.length) {
      const deletions = await tx.auditLog.findMany({ where: { tenantId, action: { in: ["member.delete", "member.child.delete"] }, entityType: "Member", entityId: { in: gone } }, select: { entityId: true, metadata: true } });
      for (const d of deletions) {
        const name = (str(metaOf(d).name) ?? str(metaOf(d).childName))?.trim();
        if (name) out.deletedMemberNames.set(d.entityId, name);
      }
    }
  }
  if (refs.tier.size) {
    const tiers = await tx.membershipTier.findMany({ where: { tenantId, id: { in: list(refs.tier) } }, select: { id: true, name: true } });
    for (const t of tiers) out.tiers.set(t.id, { name: t.name });
  }
  if (refs.pack.size) {
    const packs = await tx.classPack.findMany({ where: { tenantId, id: { in: list(refs.pack) } }, select: { id: true, name: true } });
    for (const p of packs) out.packs.set(p.id, { name: p.name });
  }
  if (refs.venue.size) {
    const venues = await tx.location.findMany({ where: { tenantId, id: { in: list(refs.venue) } }, select: { id: true, name: true } });
    for (const v of venues) out.venues.set(v.id, { name: v.name });
  }
  const unknownStaff = list(refs.staff).filter((id) => !out.staff.has(id));
  if (unknownStaff.length) {
    const users = await tx.user.findMany({ where: { tenantId, id: { in: unknownStaff } }, select: { id: true, name: true } });
    for (const u of users) if (u.name) out.staff.set(u.id, { name: u.name });
  }
  if (refs.rank.size) {
    const ranks = await tx.rankSystem.findMany({ where: { tenantId, id: { in: list(refs.rank) } }, select: { id: true, name: true } });
    for (const r of ranks) out.ranks.set(r.id, { name: r.name });
  }
  return out;
}

/**
 * Where a subject's name leads, for this role — decided here so a link is
 * never sent to someone the destination would turn away. `null` is plain text.
 */
export function hrefFor(subject: { kind: SubjectKind; id: string; memberId?: string | null }, role: ActivityRole): string | null {
  const id = encodeURIComponent(subject.id);
  switch (subject.kind) {
    case "member":
      return `/dashboard/members/${id}`;
    case "class":
      return `/dashboard/timetable?classId=${id}`;
    case "session":
      return `/dashboard/attendance?instance=${id}`;
    case "payment":
      return subject.memberId ? `/dashboard/members/${encodeURIComponent(subject.memberId)}?tab=payments&paymentId=${id}` : null;
    case "staff":
      return `/dashboard/activity?userId=${id}`;
    case "rank":
      return "/dashboard/ranks";
    // Plans and packs live on an owner-only page.
    case "tier":
    case "pack":
      return role === "owner" ? "/dashboard/memberships" : null;
    // A venue has no page of its own to open.
    case "venue":
      return null;
  }
}

// ── The entry: the only shape that leaves the server ─────────────────────────

export type FeedContext = {
  lookups: ActivityLookups;
  role: ActivityRole;
  /** The club's IANA zone: every date in a sentence is on the club's clock. */
  timeZone: string;
  /** The member the page is filtered to, so a card-scan batch can be told as theirs. */
  focusMemberId?: string | null;
  /** The club's currency, for an amount whose row does not record one (a card charge, a reminder). */
  currency?: string | null;
};

export type EntryExtras = { undone?: boolean; undo?: UndoDecision };

const text = (value: string): Part => ({ text: value });
const isSubject = (part: Part): part is { subject: FeedSubject; possessive?: boolean } => "subject" in part;

function plainOf(parts: Part[]): string {
  return parts.map((p) => (isSubject(p) ? p.subject.name + (p.possessive ? "'s" : "") : p.text)).join("");
}

const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** Strings become text, nulls vanish, neighbouring text is merged, and the sentence starts with a capital. */
function sentence(...items: (Part | string | null)[]): Part[] {
  const out: Part[] = [];
  for (const item of items) {
    if (item == null || item === "") continue;
    const part = typeof item === "string" ? text(item) : item;
    const last = out[out.length - 1];
    if (!isSubject(part) && last && !isSubject(last)) out[out.length - 1] = text(last.text + part.text);
    else out.push(part);
  }
  // A real name is shown exactly as the club wrote it; only our own words ("a deleted member") are capitalised.
  const first = out[0];
  if (first && isSubject(first)) {
    if (first.subject.gone) out[0] = { ...first, subject: { ...first.subject, name: upperFirst(first.subject.name) } };
  } else if (first) out[0] = text(upperFirst(first.text));
  return out;
}

/** Free text someone typed, or a provider's code: one line, no snake_case, never the whole essay. */
function tidy(value: string, max = 140): string {
  const flat = value.replace(/\s+/g, " ").trim();
  const words = /^[a-z0-9]+(_[a-z0-9]+)+$/.test(flat) ? flat.replace(/_/g, " ") : flat;
  return words.length > max ? `${words.slice(0, max - 1).trimEnd()}…` : words;
}

/** Field, old value, new value — from a `changes` diff, else from `before` / `after` snapshots. */
function changedPairs(m: Meta): [string, unknown, unknown][] {
  const changes = record(m.changes);
  if (changes) {
    return Object.entries(changes).flatMap(([field, pair]): [string, unknown, unknown][] => {
      const p = record(pair);
      return p ? [[field, p.from, p.to]] : [];
    });
  }
  const before = record(m.before);
  const after = record(m.after);
  if (!before || !after) return [];
  return Object.keys(after)
    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map((field): [string, unknown, unknown] => [field, before[field], after[field]]);
}

/** Reads one row against the page's lookups and hands out the sentence's parts. */
function reader(row: FeedRow, ctx: FeedContext) {
  const { lookups: L, role } = ctx;
  const m = metaOf(row);

  const subject = (kind: SubjectKind, id: string, name: string, extra: { memberId?: string | null } = {}): FeedSubject => ({ kind, name, href: hrefFor({ kind, id, ...extra }, role) });
  const gone = (kind: SubjectKind, name: string, how: "deleted" | "erased" = "deleted"): FeedSubject => ({ kind, name, href: null, gone: how });

  function member(value: unknown, possessive = false): Part | null {
    const id = idOf(value);
    if (!id) return null;
    const found = L.members.get(id);
    const flag = possessive ? { possessive: true } : {};
    if (found?.erased) return { subject: gone("member", "Deleted member", "erased"), ...flag };
    if (found) return { subject: subject("member", id, found.name), ...flag };
    const recorded = L.deletedMemberNames.get(id);
    return { subject: gone("member", recorded ? `${recorded} (deleted)` : "a deleted member"), ...flag };
  }

  /** True when the member can be named in full: old and new values are shown only then. */
  function memberIsLive(value: unknown): boolean {
    const id = idOf(value);
    const found = id ? L.members.get(id) : undefined;
    return !!found && !found.erased;
  }

  function named_(kind: "class" | "tier" | "pack" | "venue" | "rank", value: unknown, map: Map<string, { name: string }>, missing: string): Part | null {
    const id = idOf(value);
    if (!id) return null;
    const found = map.get(id);
    return { subject: found ? subject(kind, id, found.name) : gone(kind, missing) };
  }
  const klass = (value: unknown) => named_("class", value, L.classes, "a deleted class");
  const tier = (value: unknown) => named_("tier", value, L.tiers, "a deleted plan");
  const pack = (value: unknown) => named_("pack", value, L.packs, "a deleted class pack");
  const venue = (value: unknown) => named_("venue", value, L.venues, "a deleted venue");
  const rank = (value: unknown) => named_("rank", value, L.ranks, "a deleted rank");

  function session(value: unknown): Part | null {
    const id = idOf(value);
    if (!id) return null;
    const found = L.sessions.get(id);
    if (found) return { subject: subject("session", id, sessionLabel(found.className, found.date, found.startTime)) };
    // A cancelled-session row records the class, day and time itself.
    const className = L.classes.get(idOf(m.classId) ?? "")?.name;
    const date = str(m.date);
    const startTime = str(m.startTime);
    if (className && date && startTime && Number.isFinite(new Date(date).getTime())) return { subject: gone("session", sessionLabel(className, date, startTime)) };
    return { subject: gone("session", "a deleted session") };
  }

  function staff(value: unknown, possessive = false): Part | null {
    const id = idOf(value);
    if (!id) return null;
    const name = (row.user?.id === id ? row.user.name : null) ?? L.staff.get(id)?.name;
    const flag = possessive ? { possessive: true } : {};
    if (!name) return { subject: gone("staff", "a former staff member"), ...flag };
    return { subject: subject("staff", id, name), ...flag };
  }

  /**
   * Who did it: the staff member, or null when the row has none (a member,
   * Stripe, a schedule). A change made during a MatFlow support session was
   * made by MatFlow, whichever account it was made through — the row says so,
   * and so does the sentence.
   */
  const actor = (possessive = false): Part | null => {
    if (bySupport(row)) return text(possessive ? "MatFlow support's" : "MatFlow support");
    return row.userId ? staff(row.userId, possessive) : null;
  };

  /** "£45.00", linked to the payment when the page knows which one it is. */
  function amount(pence: unknown, currency: unknown, payment?: PaymentInfo | null): Part | null {
    const value = num(pence) ?? payment?.amountPence ?? null;
    if (value == null) return null;
    const label = money(value, str(currency) ?? payment?.currency ?? ctx.currency);
    return payment ? { subject: subject("payment", payment.id, label, { memberId: payment.memberId }) } : text(label);
  }

  /** What the row is about, for a sentence that has no template of its own. */
  function entity(): Part | null {
    if (ENTITY_IS_NOT_AN_ID.has(row.action)) return null;
    switch (row.entityType) {
      case "Member":
        return member(row.entityId);
      case "Class":
        return klass(row.entityId);
      case "ClassInstance":
        return session(row.entityId);
      case "Payment": {
        const payment = L.payments.get(row.entityId);
        return payment ? amount(null, null, payment) : null;
      }
      case "Order": {
        const order = L.orders.get(row.entityId);
        return order ? text(`order ${order.orderRef}`) : null;
      }
      case "MembershipTier":
        return tier(row.entityId);
      case "ClassPack":
        return pack(row.entityId);
      case "Location":
        return venue(row.entityId);
      case "User":
        return row.entityId === row.userId ? null : staff(row.entityId);
      case "RankSystem":
        return rank(row.entityId);
      default:
        return member(m.memberId ?? m.targetMemberId ?? m.childId);
    }
  }

  return { m, member, memberIsLive, klass, tier, pack, venue, rank, session, staff, actor, amount, entity };
}

type Reader = ReturnType<typeof reader>;

/** " in to [session]", or " in" when the row does not say which. */
const inTo = (where: Part | null): (Part | string)[] => (where ? [" in to ", where] : [" in"]);

/** Stripe gives `cancel_at` in seconds; older rows may hold an ISO string. */
function dateOf(value: unknown): Date | null {
  const n = num(value);
  const date = n != null ? new Date(n < 1e12 ? n * 1000 : n) : str(value) ? new Date(str(value)!) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

/**
 * The sentence for one row, or null when the action has no template (or the
 * row lacks what the template needs) — the caller then uses the row's label,
 * so no row ever says less than its label does.
 */
function template(row: FeedRow, r: Reader, ctx: FeedContext): Part[] | null {
  const { m } = r;
  const who = r.actor();
  const subjectMember = row.entityType === "Member" ? row.entityId : null;
  /** "… Adult Unlimited membership" when the row names a plan that still exists (rows written since 5 Nov 2026), else "… membership". */
  const plan = idOf(m.tierId) && ctx.lookups.tiers.has(idOf(m.tierId)!) ? r.tier(m.tierId) : null;
  const membership: (Part | string)[] = plan ? [" ", plan, " membership"] : [" membership"];

  switch (row.action) {
    case "attendance.self_checkin":
    case "attendance.kiosk_checkin": {
      const person = r.member(m.memberId);
      if (!person) return null;
      const where = r.session(m.classInstanceId);
      const onBehalf = idOf(m.actorId) && m.actorId !== m.memberId ? r.member(m.actorId) : null;
      return onBehalf ? sentence(onBehalf, " checked ", person, ...inTo(where)) : sentence(person, " checked", ...inTo(where));
    }
    case "attendance.mark": {
      const person = r.member(m.memberId);
      if (!person) return null;
      const where = r.session(m.classInstanceId);
      // The register was ticked for someone already checked in: nothing new happened.
      if (m.created === false) {
        const theirs = r.member(m.memberId, true);
        const on = where ? [" for ", where] : [];
        return who ? sentence(who, " confirmed ", theirs, " check-in", ...on) : sentence(theirs, " check-in was confirmed", ...on);
      }
      return who ? sentence(who, " checked ", person, ...inTo(where)) : sentence(person, " was checked", ...inTo(where));
    }
    case "attendance.card_scan": {
      const ids = Array.isArray(m.memberIds) ? m.memberIds.filter((id): id is string => typeof id === "string") : [];
      const where = r.session(m.classInstanceId ?? row.entityId);
      if (ctx.focusMemberId && ids.includes(ctx.focusMemberId)) return sentence(r.member(ctx.focusMemberId), " was scanned", ...inTo(where));
      if (ids.length === 0) return null;
      if (ids.length === 1) return who ? sentence(who, " scanned ", r.member(ids[0]), ...inTo(where)) : sentence(r.member(ids[0]), " was scanned", ...inTo(where));
      return who ? sentence(who, ` scanned ${ids.length} members`, ...inTo(where)) : sentence(`${ids.length} members were scanned`, ...inTo(where));
    }
    case "attendance.override":
    case "attendance.unmark":
    case "attendance.undo": {
      const person = r.member(m.memberId, true);
      if (!person) return null;
      const where = r.session(m.classInstanceId);
      const from = where ? [" from ", where] : [];
      return who ? sentence(who, " removed ", person, " check-in", ...from) : sentence(person, " check-in was removed", ...from);
    }

    case "member.update": {
      const person = r.member(subjectMember);
      const theirs = r.member(subjectMember, true);
      if (!person) return null;
      const type = typeOf(row);
      if (type === "cancellation") return who ? sentence(who, " cancelled ", theirs, ...membership) : sentence(theirs, ...membership, " was cancelled");
      if (type === "membership_changed") {
        const change = record(record(m.changes)?.membershipTierId);
        const from = r.tier(change?.from);
        const to = r.tier(change?.to);
        if (from && to) return who ? sentence(who, " moved ", person, " from ", from, " to ", to) : sentence(person, " was moved from ", from, " to ", to);
        if (to) return who ? sentence(who, " put ", person, " on ", to) : sentence(person, " was put on ", to);
        if (from) return who ? sentence(who, " took ", person, " off ", from) : sentence(person, " was taken off ", from);
      }
      return who ? sentence(who, " updated ", theirs, " details") : sentence(theirs, " details were updated");
    }
    case "member.self_update": {
      const person = r.member(subjectMember);
      return person ? sentence(person, " updated their details") : null;
    }
    case "member.child.update": {
      const child = r.member(subjectMember, true);
      if (!child) return null;
      const parent = r.member(m.parentMemberId);
      return parent ? sentence(parent, " updated ", child, " details") : sentence(child, " details were updated");
    }
    case "member.create": {
      const person = r.member(subjectMember);
      if (!person) return null;
      return who ? sentence(who, " added ", person) : sentence(person, " was added");
    }
    case "member.create.kid": {
      const child = r.member(subjectMember);
      if (!child) return null;
      const by = who ?? r.member(m.parentMemberId);
      return by ? sentence(by, " added ", child) : sentence(child, " was added");
    }
    case "member.delete": {
      // From PR C the deleted person's name is recorded on this row, and only this row, for the year the log is kept.
      const name = str(m.name)?.trim() || null;
      return who ? sentence(who, " deleted ", name ?? "a member") : sentence(name ?? "A member", " was deleted");
    }
    case "member.child.delete": {
      const parent = r.member(m.parentMemberId);
      const child = str(m.childName)?.trim() || "a child";
      return parent ? sentence(parent, " removed ", child) : null;
    }
    case "member.guardian.confirmed":
    case "member.guardian.rejected": {
      const child = r.member(subjectMember, true);
      const guardian = r.member(m.parentMemberId);
      if (!child || !guardian) return null;
      const confirmed = row.action === "member.guardian.confirmed";
      if (who) return confirmed ? sentence(who, " confirmed ", guardian, " as ", child, " guardian") : sentence(who, " removed ", guardian, " as ", child, " suggested guardian");
      return confirmed ? sentence(guardian, " was confirmed as ", child, " guardian") : sentence(guardian, " was removed as ", child, " suggested guardian");
    }
    case "member.link.child":
    case "member.unlink.child": {
      const child = r.member(m.childMemberId);
      const parent = r.member(m.parentMemberId);
      if (!child || !parent) return null;
      const linking = row.action === "member.link.child";
      if (who) return linking ? sentence(who, " linked ", child, " to ", parent) : sentence(who, " unlinked ", child, " from ", parent);
      return linking ? sentence(child, " was linked to ", parent) : sentence(child, " was unlinked from ", parent);
    }

    case "member.attribution.update": {
      const person = r.member(subjectMember);
      if (!person) return null;
      return who ? sentence(who, " changed who is credited for ", person) : sentence("Who is credited for ", person, " was changed");
    }

    case "member.rank.promote": {
      const person = r.member(subjectMember);
      const to = r.rank(m.toRankId);
      if (!person || !to) return null;
      const stripes = num(m.stripes);
      if (!("fromRankId" in m)) return who ? sentence(who, " promoted ", person, " to ", to) : sentence(person, " was promoted to ", to);
      if (m.fromRankId === null) return who ? sentence(who, " awarded ", person, " ", to) : sentence(person, " was awarded ", to);
      if (m.fromRankId === m.toRankId) {
        // Same belt: say what happened to the stripes only when the row records both counts.
        const before = num(m.fromStripes);
        const now = stripes != null ? ` (now ${stripes})` : "";
        const gained = stripes != null && before != null ? stripes - before : null;
        if (gained != null && gained > 0) {
          const what = gained === 1 ? " a stripe on " : ` ${gained} stripes on `;
          return who ? sentence(who, " awarded ", person, what, to, now) : sentence(person, " was awarded", what, to, now);
        }
        if (gained != null && gained < 0) {
          const what = gained === -1 ? " a stripe from " : ` ${-gained} stripes from `;
          return who ? sentence(who, " removed", what, r.member(subjectMember, true), " ", to, now) : sentence(r.member(subjectMember, true), " ", to, " lost", gained === -1 ? " a stripe" : ` ${-gained} stripes`, now);
        }
        return who ? sentence(who, " updated ", r.member(subjectMember, true), " ", to, now) : sentence(r.member(subjectMember, true), " ", to, " was updated", now);
      }
      const from = r.rank(m.fromRankId);
      return who ? sentence(who, " promoted ", person, " from ", from, " to ", to) : sentence(person, " was promoted from ", from, " to ", to);
    }
    case "member.rank.demote": {
      const person = r.member(subjectMember);
      const to = r.rank(m.toRankId);
      if (!person || !to) return null;
      return who ? sentence(who, " moved ", person, " back to ", to) : sentence(person, " was moved back to ", to);
    }

    case "member.hold.start": {
      const theirs = r.member(subjectMember, true);
      if (!theirs) return null;
      return who ? sentence(who, " put ", theirs, ...membership, " on hold") : sentence(theirs, ...membership, " was put on hold");
    }
    case "member.hold.end": {
      const theirs = r.member(subjectMember, true);
      if (!theirs) return null;
      return who ? sentence(who, " resumed ", theirs, ...membership) : sentence(theirs, ...membership, " was resumed");
    }

    case "member.subscription.cancel": {
      const person = r.member(subjectMember);
      if (!person) return null;
      const ends = dateOf(m.cancelAt);
      return sentence(person, " asked to cancel their", ...membership, ends ? ` — ends ${formatDate(ends, ctx.timeZone)}` : null);
    }
    case "member.subscription.cancel.kid": {
      const child = r.member(subjectMember, true);
      if (!child) return null;
      const parent = r.member(m.parentMemberId);
      const ends = dateOf(m.cancelAt);
      const tail = ends ? ` — ends ${formatDate(ends, ctx.timeZone)}` : null;
      return parent ? sentence(parent, " asked to cancel ", child, ...membership, tail) : sentence("A cancellation was requested for ", child, ...membership, tail);
    }
    case "member.subscription.cancelled_by_stripe": {
      const theirs = r.member(subjectMember, true);
      return theirs ? sentence(theirs, ...membership, " ended") : null;
    }
    case "member.subscription.create.kid": {
      const child = r.member(subjectMember);
      if (!child) return null;
      const parent = r.member(m.parentMemberId);
      const what = plan ?? text("a membership");
      return parent ? sentence(parent, " started ", what, " for ", child, " — awaiting first payment") : sentence(what, " was started for ", child, " — awaiting first payment");
    }
    case "member.subscription.purchased": {
      const person = r.member(subjectMember);
      if (!person) return null;
      const what = plan ?? text("a membership");
      // Nothing has been paid when this row is written: the payment is its own row when it comes.
      // A staff member is on the row only when one started it; otherwise the member did, in their app.
      if (row.userId && who) return sentence(who, " started ", what, " for ", person, " — awaiting first payment");
      // Started by staff whose account has since been removed: the row lost its user but still says a user wrote it.
      if (!row.userId && m.actorType === "user" && !idOf(m.actorId)) return sentence("A former staff member started ", what, " for ", person, " — awaiting first payment");
      return sentence(person, " started ", what, " — awaiting first payment");
    }
    case "class_pack.purchased": {
      const person = r.member(subjectMember ?? m.memberId);
      if (!person) return null;
      const pack = idOf(m.classPackId) && ctx.lookups.packs.has(idOf(m.classPackId)!) ? r.pack(m.classPackId) : null;
      return pack ? sentence(person, " bought the ", pack) : sentence(person, " bought a class pack");
    }
    case "order.paid": {
      const paid = r.amount(m.amountPence, m.currency);
      if (!paid) return null;
      const order = str(m.orderRef) ? ` for shop order ${tidy(str(m.orderRef)!, 60)}` : " for a shop order";
      const person = r.member(m.memberId);
      return person ? sentence(person, " paid ", paid, order) : sentence(paid, " was paid", order);
    }
    case "class.booking.created":
    case "class.booking.cancelled": {
      const person = r.member(subjectMember ?? m.memberId);
      const cls = r.klass(m.classId);
      if (!person || !cls) return null;
      return row.action === "class.booking.created" ? sentence(person, " booked ", cls) : sentence(person, " cancelled their booking for ", cls);
    }
    case "member.subscription.migrated": {
      const theirs = r.member(subjectMember, true);
      if (!theirs) return null;
      return who ? sentence(who, " moved ", theirs, " membership onto MatFlow billing") : sentence(theirs, " membership was moved onto MatFlow billing");
    }

    case "member.payment.succeeded": {
      const person = r.member(subjectMember);
      if (!person) return null;
      const paid = r.amount(m.amountPence, m.currency, ctx.lookups.paymentsByInvoice.get(str(m.stripeInvoiceId) ?? ""));
      return paid ? sentence(person, " paid ", paid) : sentence(person, " made a payment");
    }
    case "member.payment.failed": {
      const theirs = r.member(subjectMember, true);
      if (!theirs) return null;
      const due = r.amount(m.amountPence, m.currency, ctx.lookups.paymentsByInvoice.get(str(m.stripeInvoiceId) ?? ""));
      return due ? sentence(theirs, " payment of ", due, " failed") : sentence(theirs, " payment failed");
    }
    case "payment.manual": {
      const payment = ctx.lookups.payments.get(row.entityId);
      const paid = r.amount(m.amountPence, null, payment);
      const person = r.member(m.memberId ?? payment?.memberId);
      if (!paid) return null;
      if (who) return person ? sentence(who, " recorded a ", paid, " payment from ", person) : sentence(who, " recorded a ", paid, " payment");
      return person ? sentence(person, " paid ", paid, " at the desk") : null;
    }
    case "payment.adhoc.charge": {
      const theirs = r.member(subjectMember, true);
      const charge = r.amount(m.amountPence, m.currency);
      if (!theirs || !charge) return null;
      const outcome = m.outcome ?? "succeeded";
      if (outcome === "succeeded") return who ? sentence(who, " charged ", theirs, " card ", charge) : sentence(theirs, " card was charged ", charge);
      const ending = outcome === "declined" ? " card was declined" : outcome === "rejected" ? " card could not be made" : " card was not confirmed";
      const whose = r.actor(true);
      return whose ? sentence(whose, " ", charge, " charge to ", theirs, ending) : sentence("A ", charge, " charge to ", theirs, ending);
    }
    case "payment.refund": {
      const payment = ctx.lookups.payments.get(row.entityId);
      const refunded = r.amount(m.amountPence, null, payment) ?? text("a payment");
      const person = r.member(m.memberId ?? payment?.memberId);
      if (who) return person ? sentence(who, " refunded ", refunded, " to ", person) : sentence(who, " refunded ", refunded);
      return person ? sentence(refunded, " was refunded to ", person) : sentence(refunded, " was refunded");
    }
    case "payment.chase": {
      const person = r.member(subjectMember);
      if (!person) return null;
      const sent = m.emailSent !== false;
      if (who) return sent ? sentence(who, " sent ", person, " a payment reminder") : sentence(who, " tried to send ", person, " a payment reminder — not sent");
      return sent ? sentence(person, " was sent a payment reminder") : sentence("A payment reminder to ", person, " was not sent");
    }
    case "order.mark_paid": {
      if (!who) return null;
      const order = ctx.lookups.orders.get(row.entityId);
      return order ? sentence(who, ` marked shop order ${order.orderRef} as paid`) : sentence(who, " marked a shop order as paid");
    }
    case "stripe.payment_intent.failed": {
      const payment = ctx.lookups.payments.get(row.entityId);
      const theirs = r.member(payment?.memberId, true);
      const due = payment ? r.amount(null, null, payment) : null;
      return theirs && due ? sentence(theirs, " card payment of ", due, " failed") : null;
    }
    case "stripe.checkout.class_pack_payment_failed": {
      const theirs = r.member(m.memberId, true);
      if (!theirs) return null;
      // With no pack on the checkout the row's entity is a Stripe session id, which names nothing.
      const bought = ctx.lookups.packs.has(row.entityId) ? r.pack(row.entityId) : null;
      return bought ? sentence(theirs, " payment for the ", bought, " failed — no classes were added") : sentence(theirs, " class pack payment failed — no classes were added");
    }
    case "billing.portal.open": {
      const person = r.member(subjectMember);
      if (!person) return null;
      return who ? sentence(who, " opened the billing portal for ", person) : sentence(person, " opened the billing portal");
    }

    case "class.created":
    case "class.updated":
    case "class.deleted": {
      const cls = r.klass(row.entityId);
      if (!cls) return null;
      const verb = row.action === "class.created" ? "created" : row.action === "class.deleted" ? "archived" : (classLifecycleOf(m) ?? "updated");
      return who ? sentence(who, ` ${verb} `, cls) : sentence(cls, ` was ${verb}`);
    }
    case "class.roster.add":
    case "class.roster.remove": {
      const person = r.member(m.memberId);
      const cls = r.klass(m.classId);
      if (!person || !cls) return null;
      const adding = row.action === "class.roster.add";
      if (who) return adding ? sentence(who, " added ", person, " to the ", cls, " roster") : sentence(who, " removed ", person, " from the ", cls, " roster");
      return adding ? sentence(person, " was added to the ", cls, " roster") : sentence(person, " was removed from the ", cls, " roster");
    }
    case "class.instance_cancelled":
    case "class.instance_restored": {
      const where = r.session(row.entityId);
      if (!where) return null;
      const verb = row.action === "class.instance_cancelled" ? "cancelled" : "restored";
      return who ? sentence(who, ` ${verb} `, where) : sentence(where, ` was ${verb}`);
    }

    case "waiver.sign": {
      const person = r.member(subjectMember);
      return person ? sentence(person, " signed the waiver") : null;
    }
    case "waiver.sign.supervised": {
      const person = r.member(subjectMember);
      return person ? sentence(person, " signed the waiver at the desk") : null;
    }
    case "waiver.sign-for-child": {
      const child = r.member(subjectMember, true);
      if (!child) return null;
      const parent = r.member(m.collectedBy);
      return parent ? sentence(parent, " signed ", child, " waiver") : sentence(child, " waiver was signed by a parent");
    }
    case "task.member_note.create": {
      const person = r.member(m.assigneeMemberId);
      return who && person ? sentence(who, " left a note for ", person) : null;
    }
    case "task.staff_task.create": {
      const assignee = idOf(m.assignedToId) && m.assignedToId !== row.userId ? r.staff(m.assignedToId) : null;
      return who && assignee ? sentence(who, " created a task for ", assignee) : null;
    }
  }

  if (row.action.startsWith("stripe.dispute.")) {
    const status = row.action.slice("stripe.dispute.".length);
    const theirs = r.member(subjectMember, true);
    const payment = ctx.lookups.payments.get(idOf(m.paymentId) ?? "");
    const disputed = r.amount(m.amountPence, m.currency, payment);
    if (!theirs || !disputed) return null;
    const outcome: Record<string, string> = { won: " was won", lost: " was lost", needs_response: " needs a response", warning_needs_response: " needs a response", under_review: " is under review", warning_under_review: " is under review" };
    const due = dateOf(m.evidenceDueAt);
    const respondBy = due && outcome[status] === " needs a response" ? ` — respond by ${formatDate(due, ctx.timeZone)}` : null;
    return sentence("The dispute over ", theirs, " ", disputed, " payment", outcome[status] ?? ` is ${tidy(status)}`, respondBy);
  }

  if (isUndoAction(row.action) && who) {
    const original = auditEntryLabel(row.action, m).replace(/^Undid: /, "");
    const about = r.entity();
    return sentence(who, ` undid: ${lowerFirst(original)}`, about ? " — " : null, about);
  }
  return null;
}

/** The row's own label, then what it is about when that resolves. Used for every action without a template. */
function fallback(row: FeedRow, r: Reader): Part[] {
  const label = auditEntryLabel(row.action, r.m);
  const about = r.entity();
  return about ? sentence(label, " — ", about) : sentence(label);
}

const EXCEPTION_TEXT: Record<string, string> = {
  waiver_unsigned: "Admitted without a signed waiver",
  on_hold: "Admitted while on hold",
  kids_class: "Adult admitted to a kids class",
};

/** How one changed value reads. Ids become names, pence become money, dates are on the club's clock. */
function display(field: string, value: unknown, r: Reader, ctx: FeedContext, currency: string): string {
  if (value == null || value === "") return "—";
  const kind = ID_FIELD_KIND[field];
  if (kind) {
    const part = kind === "tier" ? r.tier(value) : kind === "venue" ? r.venue(value) : kind === "rank" ? r.rank(value) : r.staff(value);
    return part && isSubject(part) ? part.subject.name : "—";
  }
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "number") return field.endsWith("Pence") ? money(value, currency) : String(value);
  if (typeof value !== "string") return "(changed)";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(`${value}T12:00:00Z`, "UTC");
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value) && Number.isFinite(new Date(value).getTime())) return formatDate(value, ctx.timeZone);
  // A bare record id that names nothing here says nothing to a reader.
  if (/^c[a-z0-9]{24}$/.test(value)) return "(changed)";
  // A stored word ("past_due", "cancelled") is shown as a word ("Past due", "Cancelled").
  if (WORD_FIELDS.has(field) && /^[a-z]+(?:_[a-z]+)*$/.test(value)) return (value[0].toUpperCase() + value.slice(1)).replace(/_/g, " ");
  return tidy(value, 80);
}

/** Fields that hold one of a fixed set of stored words, not text a person typed. */
const WORD_FIELDS = new Set(["status", "paymentStatus", "accountType", "membershipType", "preferredPaymentMethod", "billingCycle", "classLimitBasis", "role"]);

/**
 * The one changed field the sentence has already told in full — "cancelled
 * Melody's membership", "moved Melody from A to B". Said again after the
 * sentence ("· Status: active → cancelled") it is only noise. It stays in
 * `changes`, which is the complete list.
 */
function toldBySentence(row: FeedRow, m: Record<string, unknown>): string | null {
  if (row.action !== "member.update") return null;
  const type = typeOf(row);
  if (type === "cancellation") return fieldLabel("status");
  if (type === "membership_changed") {
    const change = record(record(m.changes)?.membershipTierId);
    // With neither plan named on the row the sentence is the general "updated … details", which tells nothing.
    return change && (idOf(change.from) || idOf(change.to)) ? fieldLabel("membershipTierId") : null;
  }
  return null;
}

/**
 * Every field a row changed. The owner sees old and new values; a manager
 * sees which fields changed, not what they held. For a member who has been
 * erased or deleted, nobody sees the old values.
 */
function changesOf(row: FeedRow, r: Reader, ctx: FeedContext): FeedChange[] | null {
  const pairs = changedPairs(r.m);
  if (pairs.length === 0) return null;
  const redact = ctx.role !== "owner" || (row.entityType === "Member" && !r.memberIsLive(row.entityId));
  const currency = str(record(r.m.after)?.currency) ?? str(record(r.m.before)?.currency) ?? ctx.currency ?? "GBP";
  // Paused / resumed / restored / archived is in the sentence; "Active: on → off" would only repeat it in database terms.
  const lifecycle = classLifecycleOf(r.m) != null || row.action === "class.deleted";
  return pairs
    .filter(([field]) => !(lifecycle && field === "isActive") && !NEVER_A_FIELD.has(field))
    .map(([field, from, to]) => ({
      label: fieldLabel(field),
      from: redact ? null : display(field, from, r, ctx, currency),
      to: redact ? null : display(field, to, r, ctx, currency),
    }));
}

/** Keys a save sends that are not fields anyone edits (the concurrency token). */
const NEVER_A_FIELD = new Set(["updatedAt"]);

/** Member edits whose `fields` list is every key the form SENT, not what changed. */
const MEMBER_EDITS = new Set(["member.update", "member.self_update"]);
/** The member fields an edit can change that are never diffed: their values are private, so only the fact is kept. */
const UNDIFFED_MEMBER_FIELDS = ["notes", "medicalConditions"];

/**
 * Whose words a `reason` is. A provider's code or the reason a session was
 * cancelled is club business for anyone who may see the row; a reason staff
 * typed about a member (a demotion, a revoked card, a refund) is for the owner.
 */
const REASON_FOR_EVERYONE = new Set(["class.instance_cancelled", "member.payment.failed", "stripe.payment_intent.failed"]);

/** The line after the sentence: what was changed, or the one fact the sentence leaves out. */
function detailOf(row: FeedRow, r: Reader, ctx: FeedContext, changes: FeedChange[] | null): Part[] | null {
  const { m } = r;
  /** Text someone typed about this row's member is shown to nobody once that member is erased or deleted. */
  const memberGone = row.entityType === "Member" && !ENTITY_IS_NOT_AN_ID.has(row.action) && !r.memberIsLive(row.entityId);
  const bits: (Part | string)[][] = [];
  const add = (...bit: (Part | string | null)[]) => {
    const kept = bit.filter((b): b is Part | string => b != null && b !== "");
    if (kept.length) bits.push(kept);
  };

  switch (row.action) {
    case "attendance.mark": {
      const flags = Array.isArray(m.acknowledged) ? m.acknowledged : [];
      for (const flag of EXCEPTION_FLAGS) if (flags.includes(flag)) add(EXCEPTION_TEXT[flag]);
      if (m.paidByClassPack === true) add(num(m.packCreditsRemaining) != null ? `Used a class pack credit · ${m.packCreditsRemaining} left` : "Used a class pack credit");
      break;
    }
    case "attendance.card_scan": {
      const ids = Array.isArray(m.memberIds) ? m.memberIds.filter((id): id is string => typeof id === "string") : [];
      if (ids.length > 1 && !(ctx.focusMemberId && ids.includes(ctx.focusMemberId))) {
        const shown = ids.slice(0, 3).flatMap((id, i) => [i > 0 ? ", " : null, r.member(id)]);
        add(...shown, ids.length > 3 ? ` + ${ids.length - 3} more` : null);
      }
      break;
    }
    case "member.rank.promote":
      if (m.fromRankId === null && (num(m.stripes) ?? 0) > 0) add(`${m.stripes} ${m.stripes === 1 ? "stripe" : "stripes"}`);
      break;
    case "class_pack.purchased": {
      const credits = num(m.credits);
      if (credits != null) add(`${credits} ${credits === 1 ? "class" : "classes"}`);
      const paid = r.amount(m.amountPence, m.currency);
      if (paid) add(paid);
      break;
    }
    case "member.hold.start": {
      const until = dateOf(m.holdUntil);
      if (until) add(`Until ${formatDate(until, ctx.timeZone)}`);
      break;
    }
    case "payment.manual":
      if (str(m.method)) add(`Paid by ${tidy(str(m.method)!).toLowerCase()}`);
      break;
    case "payment.adhoc.charge":
      if (str(m.description) && !memberGone) add(tidy(str(m.description)!));
      break;
    case "payment.refund":
      if (typeof m.fullyRefunded === "boolean") add(m.fullyRefunded ? "Full refund" : "Part refund");
      break;
    case "payment.chase": {
      // The amount is the payment the reminder was about, not a running balance.
      const owed = r.amount(m.amountPence, m.currency);
      if (owed) add("Reminder for ", owed);
      break;
    }
    case "order.mark_paid": {
      const order = ctx.lookups.orders.get(row.entityId);
      if (order) add(money(order.totalPence, order.currency), order.memberId ? " · " : null, order.memberId ? r.member(order.memberId) : null);
      break;
    }
  }

  const sent = Array.isArray(m.fields) ? m.fields.filter((f): f is string => typeof f === "string" && !NEVER_A_FIELD.has(f)) : [];
  // What a member edit changed beyond its diff: the login address (recorded as two digests, never as text) and the
  // private fields. Everything else in `fields` is only what the form sent.
  const alsoChanged: string[] = [];
  if (MEMBER_EDITS.has(row.action)) {
    const emailChanged = (str(m.oldEmailSha256) != null && m.oldEmailSha256 !== m.newEmailSha256) || (sent.length === 1 && sent[0] === "email");
    if (emailChanged) alsoChanged.push(fieldLabel("email"));
    for (const field of UNDIFFED_MEMBER_FIELDS) if (sent.includes(field)) alsoChanged.push(fieldLabel(field));
  }
  const told = toldBySentence(row, m);
  const untold = changes?.filter((c) => c.label !== told) ?? [];
  if (untold.length) {
    const shown = untold.every((c) => c.from != null && c.to != null);
    add(shown ? untold.map((c) => `${c.label}: ${c.from} → ${c.to}`).join(" · ") : `Fields: ${[...untold.map((c) => c.label), ...alsoChanged].join(", ")}`);
    if (shown && alsoChanged.length) add(`Also changed: ${alsoChanged.join(", ")}`);
  } else if (changes?.length) {
    // Everything in the diff is in the sentence; only what the diff cannot hold is left to say.
    if (alsoChanged.length) add(`Also changed: ${alsoChanged.join(", ")}`);
  } else if (MEMBER_EDITS.has(row.action)) {
    if (alsoChanged.length) add(`Fields: ${alsoChanged.join(", ")}`);
  } else if (sent.length) {
    const lifecycle = classLifecycleOf(m) != null;
    const fields = sent.filter((f) => !(lifecycle && f === "isActive"));
    if (fields.length) add(`Fields: ${[...new Set(fields.map(fieldLabel))].join(", ")}`);
  }

  // Imports say which file, exported when, and what happened to how many.
  if (str(m.fileName)) {
    const file: string[] = [tidy(str(m.fileName)!, 80)];
    const exported = dateOf(m.sourceExportedAt);
    if (exported) file.push(`exported ${formatDate(exported, ctx.timeZone)}`);
    if (num(m.created) != null) file.push(`${m.created} created`);
    else if (num(m.imported) != null) file.push(`${m.imported} imported`);
    if (num(m.changed) != null) file.push(`${m.changed} changed`);
    if (num(m.removed) != null) file.push(`${m.removed} removed`);
    if ((num(m.kept) ?? 0) > 0) file.push(`${m.kept} kept`);
    if (m.resumed === true) file.push("resumed after an interruption");
    add(file.join(" · "));
  }

  if (str(m.reason) && !memberGone && (ctx.role === "owner" || REASON_FOR_EVERYONE.has(row.action) || row.action.startsWith("stripe.dispute."))) add(`Reason: ${tidy(str(m.reason)!)}`);

  if (bits.length === 0) return null;
  const out: Part[] = [];
  bits.forEach((bit, i) => {
    if (i > 0) out.push(text(" · "));
    for (const piece of bit) out.push(typeof piece === "string" ? text(piece) : piece);
  });
  // Merge neighbouring text, without re-capitalising a name.
  return out.reduce<Part[]>((acc, part) => {
    const last = acc[acc.length - 1];
    if (!isSubject(part) && last && !isSubject(last)) acc[acc.length - 1] = text(last.text + part.text);
    else acc.push(part);
    return acc;
  }, []);
}

const KIOSK_ACTIONS = new Set(["attendance.kiosk_checkin", "member.waiver.signed_via_kiosk"]);
const STRIPE_ACTIONS = new Set(["member.subscription.cancelled_by_stripe", "class_pack.purchased", "order.paid"]);
const MEMBER_APP_ACTIONS = new Set(["billing.portal.open", "waiver.sign", "waiver.sign-for-child", "task.member_note.complete", "class.booking.created", "class.booking.cancelled"]);
/**
 * Actions only staff can take. A row of one of these with no staff member on it
 * was made by someone whose account has since been removed (the link is cleared
 * when a user is deleted) — it was not automatic.
 */
const STAFF_ONLY_ACTIONS = new Set([
  "attendance.mark", "attendance.override", "attendance.unmark", "attendance.card_scan",
  "member.update", "member.delete", "member.rank.promote", "member.rank.demote", "member.hold.start", "member.link.child", "member.unlink.child",
  "member.guardian.confirmed", "member.guardian.rejected",
  "payment.manual", "payment.adhoc.charge", "payment.chase", "order.mark_paid",
  "class.created", "class.updated", "class.deleted", "class.roster.add", "class.roster.remove", "class.instance_cancelled", "class.instance_restored",
  "waiver.sign.supervised", "task.member_note.create", "task.staff_task.create",
]);

/** True when the real actor behind the row was MatFlow: an operator route, or a change made during a support session. */
const bySupport = (row: FeedRow) => row.operatorId != null || typeof metaOf(row).actingAs === "string";

/**
 * Where the row came from. The staff member is named only when the sentence
 * has not already named them.
 */
export function sourceOf(row: FeedRow, lookups: ActivityLookups, namedInSentence: ReadonlySet<string> = new Set()): FeedSource {
  const m = metaOf(row);
  const support = bySupport(row);
  const name = row.userId ? ((row.user?.id === row.userId ? row.user.name : null) ?? lookups.staff.get(row.userId)?.name ?? null) : null;
  const staff = row.userId && name && !support && !namedInSentence.has(row.userId) ? { id: row.userId, name } : null;
  const label = support
    ? "MatFlow support"
    : KIOSK_ACTIONS.has(row.action)
      ? "Kiosk"
      : row.action === "attendance.card_scan"
        ? "Card scan"
        : row.userId
          ? "Staff"
          : STAFF_ONLY_ACTIONS.has(row.action) || (m.actorType === "user" && !idOf(m.actorId))
            ? "Staff (account removed)"
            : row.action.startsWith("stripe.") || row.action.startsWith("member.payment.") || STRIPE_ACTIONS.has(row.action)
            ? "Stripe"
            : idOf(m.actorId) || m.collectedBy === "self" || MEMBER_APP_ACTIONS.has(row.action)
              ? "Member app"
              : "Automatic";
  return { label, staff, support };
}

function undoOf(row: FeedRow, decision: UndoDecision | undefined, lookups: ActivityLookups): FeedUndo | undefined {
  if (!decision) return undefined;
  if (!decision.ok) return { ok: false, reason: decision.reason };
  const name = row.userId ? ((row.user?.id === row.userId ? row.user.name : null) ?? lookups.staff.get(row.userId)?.name ?? null) : null;
  return { ok: true, sinceHere: row.userId && name ? { userId: row.userId, name } : null };
}

function assemble(row: FeedRow, ctx: Pick<FeedContext, "lookups" | "timeZone">, extras: EntryExtras, body: Pick<FeedEntry, "parts" | "detail" | "changes">, named: ReadonlySet<string>): FeedEntry {
  const undo = undoOf(row, extras.undo, ctx.lookups);
  return {
    id: row.id,
    at: row.createdAt.toISOString(),
    dayKey: clubDayKey(row.createdAt, ctx.timeZone),
    type: typeOf(row),
    parts: body.parts,
    plain: plainOf(body.parts),
    detail: body.detail,
    detailPlain: body.detail ? plainOf(body.detail) : null,
    changes: body.changes,
    source: sourceOf(row, ctx.lookups, named),
    undone: extras.undone === true,
    ...(undo ? { undo } : {}),
  };
}

/** One row as the timeline shows it. */
export function toFeedEntry(row: FeedRow, ctx: FeedContext, extras: EntryExtras = {}): FeedEntry {
  const r = reader(row, ctx);
  const parts = template(row, r, ctx) ?? fallback(row, r);
  const changes = changesOf(row, r, ctx);
  const detail = detailOf(row, r, ctx, changes);
  // The source line names the staff member only when the sentence has not.
  const self = row.userId ? hrefFor({ kind: "staff", id: row.userId }, ctx.role) : null;
  const named = new Set(row.userId && parts.some((p) => isSubject(p) && p.subject.kind === "staff" && p.subject.href === self) ? [row.userId] : []);
  return assemble(row, ctx, extras, { parts, detail, changes }, named);
}

/**
 * One row when names could not be loaded: the action's label, no links, no
 * detail. The page still shows what happened and when.
 */
export function plainFallbackEntry(row: FeedRow, ctx: { timeZone: string }, extras: EntryExtras = {}): FeedEntry {
  const parts = sentence(auditEntryLabel(row.action, metaOf(row)));
  return assemble(row, { lookups: emptyLookups(), timeZone: ctx.timeZone }, extras, { parts, detail: null, changes: null }, new Set());
}

/** A photo added while promoting belongs to the promotion: the two rows are written seconds apart. */
const PHOTO_MERGE_MS = 60_000;

/**
 * A page of rows as entries, newest first. A "photo attached" row next to its
 * promotion is folded into that promotion's detail rather than shown twice.
 */
export function toFeedEntries(rows: FeedRow[], ctx: FeedContext, extrasFor: (row: FeedRow) => EntryExtras = () => ({})): FeedEntry[] {
  const folded = new Map<string, string>();
  for (const photo of rows) {
    if (photo.action !== "rank.photo_attached") continue;
    const promotion = rows.find(
      (row) => row.action === "member.rank.promote" && row.entityId === photo.entityId && Math.abs(row.createdAt.getTime() - photo.createdAt.getTime()) <= PHOTO_MERGE_MS,
    );
    if (promotion) folded.set(photo.id, promotion.id);
  }
  const withPhoto = new Set(folded.values());
  return rows
    .filter((row) => !folded.has(row.id))
    .map((row) => {
      let entry: FeedEntry;
      try {
        entry = toFeedEntry(row, ctx, extrasFor(row));
      } catch (e) {
        // One row the templates cannot tell must not take the page with it: it is shown as its label.
        console.error("[activity-feed] a row could not be described", JSON.stringify({ action: row.action, error: e instanceof Error ? e.name : typeof e }));
        return plainFallbackEntry(row, ctx, extrasFor(row));
      }
      if (!withPhoto.has(row.id)) return entry;
      const detail = entry.detail ? [...entry.detail, text(" · Photo attached")] : [text("Photo attached")];
      return { ...entry, detail, detailPlain: plainOf(detail) };
    });
}

/** The undo-row prefix, re-exported for the route's "already undone" lookup. */
export { UNDO_PREFIX };
