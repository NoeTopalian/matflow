/**
 * Activity types — the one taxonomy behind the Activity timeline (5 Nov 2026).
 *
 * Every audit action belongs to exactly one type. The type decides the label
 * and icon a row shows, which filter finds it, whether a manager may see it,
 * and whether it is in the default "Club activity" view. The server builds its
 * queries from this same data (lib/activity-feed.ts), so the Type column and
 * the filter cannot drift apart.
 *
 * Client-safe: no Prisma, no server imports. Client components import this
 * file and never lib/activity-feed.ts.
 *
 * Type KEYS ARE PERMANENT. They live in shared links and in people's saved
 * default view; never rename or reuse one. Retire a key by adding it to
 * RETIRED_TYPE_KEYS (old key -> the key that replaced it).
 */
import { AUDIT_LABELS } from "@/lib/audit-labels";

export type ActivityRole = "owner" | "manager";

export const ACTIVITY_GROUPS = ["Attendance", "Members", "Memberships & money", "Classes", "Communication", "Staff & club"] as const;
export type ActivityGroup = (typeof ACTIVITY_GROUPS)[number];

export type ActivityType = {
  key: string;
  label: string;
  group: ActivityGroup;
  /** lucide-react icon name; the client maps it to a component. */
  icon: string;
  /** Exact action names that are always this type. */
  actions: string[];
  /**
   * Actions this type claims only for some rows, decided from the row's
   * metadata (the predicates are in lib/activity-feed.ts). A row rule is
   * tested before any exact name: `member.update` is "Member details" unless
   * it changed the plan or cancelled the membership. One rule overlaps
   * instead of dividing: a check-in with a warning shows as that type and is
   * also found by "Check-in", because a warned check-in is still a check-in.
   */
  ruleActions: string[];
  /** Name prefixes, only for names minted at run time: "undo.<action>", "stripe.dispute.<status>". */
  prefixes: string[];
  /** Who may see rows of this type. A manager sees a type only if they can open the page those records live on. */
  roles: ActivityRole[];
  /** In the default "Club activity" view. */
  defaultOn: boolean;
};

/** Every labelled action in one of these namespaces. Exact names at run time; a new action in the namespace joins its type. */
function labelled(...prefixes: string[]): string[] {
  return Object.keys(AUDIT_LABELS).filter((action) => prefixes.some((p) => action.startsWith(p)));
}

const BOTH: ActivityRole[] = ["owner", "manager"];
const OWNER: ActivityRole[] = ["owner"];

type Spec = Omit<ActivityType, "ruleActions" | "prefixes"> & Partial<Pick<ActivityType, "ruleActions" | "prefixes">>;
const type = (spec: Spec): ActivityType => ({ ruleActions: [], prefixes: [], ...spec });

/** In display order. Names are disjoint between types, so order never decides a match. */
export const ACTIVITY_TYPES: ActivityType[] = [
  // ── Attendance ─────────────────────────────────────────────────────────────
  type({ key: "checkin_exception", label: "Check-in with a warning", group: "Attendance", icon: "TriangleAlert", actions: [], ruleActions: ["attendance.mark"], roles: BOTH, defaultOn: true }),
  type({ key: "checkin", label: "Check-in", group: "Attendance", icon: "ClipboardCheck", actions: ["attendance.mark", "attendance.self_checkin", "attendance.kiosk_checkin", "attendance.card_scan"], roles: BOTH, defaultOn: true }),
  type({ key: "checkin_removed", label: "Check-in removed", group: "Attendance", icon: "ClipboardX", actions: ["attendance.override", "attendance.unmark", "attendance.undo"], roles: BOTH, defaultOn: true }),

  // ── Members ────────────────────────────────────────────────────────────────
  type({ key: "member_joined", label: "New member", group: "Members", icon: "UserPlus", actions: ["member.create", "member.create.kid"], roles: BOTH, defaultOn: true }),
  type({ key: "rank", label: "Rank promotion", group: "Members", icon: "Award", actions: ["member.rank.promote", "member.rank.demote", "rank.photo_attached"], roles: BOTH, defaultOn: true }),
  type({ key: "hold", label: "Membership on hold", group: "Members", icon: "CirclePause", actions: ["member.hold.start", "member.hold.end"], roles: BOTH, defaultOn: true }),
  type({
    key: "waiver",
    label: "Waiver",
    group: "Members",
    icon: "FileSignature",
    actions: ["waiver.sign", "waiver.sign.supervised", "waiver.sign-for-child", "member.waiver.signed_via_kiosk", "member.waiver_link.generated"],
    roles: BOTH,
    defaultOn: true,
  }),
  type({ key: "member_removed", label: "Member removed or restored", group: "Members", icon: "UserMinus", actions: ["member.delete", "member.child.delete", "member.archive", "member.child.archive", "member.restore"], roles: BOTH, defaultOn: true }),
  type({
    key: "member_updated",
    label: "Member details",
    group: "Members",
    icon: "UserPen",
    actions: [
      "member.update",
      "member.self_update",
      "member.child.update",
      "member.photo.add",
      "member.photo.create",
      "member.photo.remove",
      "member.photo.delete",
      "member.profile_picture.set",
      "member.profile_picture.upload",
      "member.profile_picture.clear",
      "member.link.child",
      "member.unlink.child",
      "member.guardian.confirmed",
      "member.guardian.rejected",
      "member.promoted_to_adult",
    ],
    roles: BOTH,
    defaultOn: true,
  }),
  // Sign-in help, and the record of who opened a signed waiver: access to a member's account or papers, not a change to them.
  type({ key: "member_access", label: "Member sign-in and access", group: "Members", icon: "KeyRound", actions: ["member.unlock", "member.totp_reset", "member.invite_link.generated", "member.bulk_invite", "member.card_revoked", "waiver.signature.view"], roles: BOTH, defaultOn: false }),
  // Off by default: the member form sends these fields with every save and the row is written whether or not
  // they changed, so until the writer records only real changes it would add a line to every profile save.
  type({ key: "attribution", label: "Conversion credit", group: "Members", icon: "Target", actions: ["member.attribution.update"], roles: BOTH, defaultOn: false }),

  // ── Memberships & money ────────────────────────────────────────────────────
  type({ key: "membership_started", label: "Membership started", group: "Memberships & money", icon: "BadgeCheck", actions: ["member.subscription.create.kid"], roles: BOTH, defaultOn: true }),
  type({ key: "membership_changed", label: "Membership changed", group: "Memberships & money", icon: "Repeat", actions: ["member.subscription.migrated"], ruleActions: ["member.update"], roles: BOTH, defaultOn: true }),
  type({
    key: "cancellation",
    label: "Membership cancelled",
    group: "Memberships & money",
    icon: "CircleX",
    actions: ["member.subscription.cancel", "member.subscription.cancel.kid", "member.subscription.cancelled_by_stripe"],
    ruleActions: ["member.update"],
    roles: BOTH,
    defaultOn: true,
  }),
  type({ key: "payment", label: "Payment", group: "Memberships & money", icon: "CreditCard", actions: ["member.payment.succeeded", "payment.manual", "payment.adhoc.charge", "order.mark_paid"], roles: BOTH, defaultOn: true }),
  type({
    key: "payment_failed",
    label: "Payment failed or disputed",
    group: "Memberships & money",
    icon: "CircleAlert",
    actions: ["member.payment.failed", "stripe.payment_intent.failed", "stripe.checkout.expired", "stripe.checkout.class_pack_payment_failed"],
    ruleActions: ["payment.adhoc.charge"],
    prefixes: ["stripe.dispute."],
    roles: BOTH,
    defaultOn: true,
  }),
  type({ key: "refund", label: "Refund", group: "Memberships & money", icon: "Undo2", actions: ["payment.refund"], roles: BOTH, defaultOn: true }),
  type({ key: "payment_reminder", label: "Payment reminder", group: "Memberships & money", icon: "BellRing", actions: ["payment.chase"], roles: BOTH, defaultOn: true }),
  type({ key: "billing_details", label: "Billing details", group: "Memberships & money", icon: "Wallet", actions: ["billing.portal.open", "member.subscription.portal.kid", "stripe.payment_method.detached"], roles: BOTH, defaultOn: false }),

  // ── Classes ────────────────────────────────────────────────────────────────
  type({ key: "session_cancelled", label: "Session cancelled", group: "Classes", icon: "CalendarX", actions: ["class.instance_cancelled", "class.instance_restored"], roles: BOTH, defaultOn: true }),
  type({
    key: "class_changed",
    label: "Classes",
    group: "Classes",
    icon: "Calendar",
    // Mats and the split are set on the Timetable page, by owners and managers (RULES §5b): club life a manager sees.
    actions: [
      "class.created", "class.updated", "class.deleted", "class.roster.add", "class.roster.remove", "class.bookings.kept_ineligible", "class.instances_generated",
      "mat.create", "mat.update", "mat.delete", "mat.reorder", "mat.adopt", "timetable.layout.update",
    ],
    roles: BOTH,
    defaultOn: true,
  }),

  // ── Communication ──────────────────────────────────────────────────────────
  type({ key: "announcement", label: "Announcement", group: "Communication", icon: "Megaphone", actions: labelled("announcement."), roles: BOTH, defaultOn: true }),
  type({ key: "task", label: "Tasks and notes", group: "Communication", icon: "ListChecks", actions: labelled("task.", "initiative."), roles: BOTH, defaultOn: true }),

  // ── Staff & club ───────────────────────────────────────────────────────────
  type({ key: "rank_setup", label: "Ranks (set-up)", group: "Staff & club", icon: "Medal", actions: ["rank.created", "rank.updated", "rank.deleted"], roles: BOTH, defaultOn: true }),
  type({ key: "plan_setup", label: "Plans and packs (set-up)", group: "Staff & club", icon: "Tag", actions: [...labelled("membership.tier."), "class_pack.create", "class_pack.update", "class_pack.deactivate"], roles: OWNER, defaultOn: true }),
  type({
    key: "support",
    label: "MatFlow support",
    group: "Staff & club",
    icon: "LifeBuoy",
    actions: [...labelled("admin."), "support.edit.refused", "support.impersonate", "support.edit", "owner.login_email", "owner.profile", "member.contact_email"],
    roles: OWNER,
    defaultOn: true,
  }),
  type({ key: "undo", label: "Undone changes", group: "Staff & club", icon: "RotateCcw", actions: [], prefixes: ["undo."], roles: OWNER, defaultOn: true }),
  type({ key: "data_request", label: "Data requests", group: "Staff & club", icon: "ShieldCheck", actions: ["member.dsar_export", "member.dsar_erase", "member.dsar_erase.requested", "member.dsar_erase.import_files"], roles: OWNER, defaultOn: false }),
  type({ key: "staff", label: "Staff accounts", group: "Staff & club", icon: "Users", actions: labelled("staff."), roles: OWNER, defaultOn: false }),
  type({ key: "sign_in", label: "Sign-in and security", group: "Staff & club", icon: "Lock", actions: labelled("auth.", "user."), roles: OWNER, defaultOn: false }),
  type({
    key: "settings",
    label: "Club settings",
    group: "Staff & club",
    icon: "Settings",
    actions: [
      ...labelled("tenant.", "location.", "drive."),
      "stripe.connect",
      "stripe.disconnect",
      "stripe.account.deauthorized",
      "stripe.webhook.account_updated",
      "onboarding.csv_handoff",
      "email.test_sent",
      "report.generate",
      "payments.export",
      "upload.image",
    ],
    roles: OWNER,
    defaultOn: false,
  }),
  type({ key: "import", label: "Imports", group: "Staff & club", icon: "Upload", actions: labelled("import."), roles: OWNER, defaultOn: false }),
  // Anything no type above names. Owner-only and on by default: an unmapped
  // action is never invisible to the owner and never shown to a manager.
  type({ key: "other", label: "Other", group: "Staff & club", icon: "History", actions: [], roles: OWNER, defaultOn: true }),
];

export const OTHER_TYPE = "other";

/** Old key -> current key. Empty today; see the header before removing or renaming a key. */
export const RETIRED_TYPE_KEYS: Record<string, string> = {};

const BY_KEY = new Map(ACTIVITY_TYPES.map((t) => [t.key, t]));

export function activityType(key: string): ActivityType | undefined {
  return BY_KEY.get(key);
}

/** The type an ACTION NAME belongs to, ignoring row rules (lib/activity-feed.ts `typeOf` applies those first). */
export function typeKeyForAction(action: string): string {
  for (const t of ACTIVITY_TYPES) {
    if (t.actions.includes(action) || t.prefixes.some((p) => action.startsWith(p))) return t.key;
  }
  return OTHER_TYPE;
}

export function visibleTypeKeys(role: ActivityRole): string[] {
  return ACTIVITY_TYPES.filter((t) => t.roles.includes(role)).map((t) => t.key);
}

export function defaultTypeKeys(role: ActivityRole): string[] {
  return ACTIVITY_TYPES.filter((t) => t.defaultOn && t.roles.includes(role)).map((t) => t.key);
}

// ── Views: one-tap presets, carried in the URL by key ─────────────────────────

export type ActivityView = { key: string; label: string; typeKeys: (role: ActivityRole) => string[] };

const inGroup = (group: ActivityGroup) => (role: ActivityRole) => ACTIVITY_TYPES.filter((t) => t.group === group && t.roles.includes(role)).map((t) => t.key);
const STAFF_CHANGES = ["member_updated", "member_removed", "hold", "rank", "membership_changed", "cancellation", "class_changed", "session_cancelled", "rank_setup", "plan_setup", "staff", "settings", "undo"];

export const DEFAULT_VIEW = "club";

export const ACTIVITY_VIEWS: ActivityView[] = [
  { key: DEFAULT_VIEW, label: "Club activity", typeKeys: defaultTypeKeys },
  { key: "attendance", label: "Attendance", typeKeys: inGroup("Attendance") },
  { key: "money", label: "Money", typeKeys: inGroup("Memberships & money") },
  { key: "staff_changes", label: "Staff changes", typeKeys: (role) => STAFF_CHANGES.filter((k) => BY_KEY.get(k)?.roles.includes(role)) },
  { key: "all", label: "Everything", typeKeys: visibleTypeKeys },
];

const VIEW_BY_KEY = new Map(ACTIVITY_VIEWS.map((v) => [v.key, v]));

// ── The `types` URL parameter ─────────────────────────────────────────────────

/** Longest `types` value read, and the most keys taken from it. */
export const TYPES_PARAM_MAX_LENGTH = 600;
export const TYPES_PARAM_MAX_KEYS = 40;

export type ParsedTypes = {
  /** The view the value named, or null for an explicit list. */
  view: string | null;
  /** The type keys to show: always at least one, always visible to the role. */
  keys: string[];
  /** Keys that are not (or no longer) types. The page says so; it is never an error. */
  ignored: string[];
  /** Real types this role may not see. */
  dropped: string[];
};

/**
 * `types` is a view key ("club", "money", …) or a comma list of type keys.
 * Absent, empty, over-long, or left with nothing usable: the default view.
 * A pasted or stale link must degrade, never fail.
 */
export function parseTypesParam(raw: string | null | undefined, role: ActivityRole): ParsedTypes {
  const fallback = (ignored: string[] = [], dropped: string[] = []): ParsedTypes => ({ view: DEFAULT_VIEW, keys: defaultTypeKeys(role), ignored, dropped });
  const value = (raw ?? "").trim();
  if (!value || value.length > TYPES_PARAM_MAX_LENGTH) return fallback();

  const view = VIEW_BY_KEY.get(value);
  if (view) return { view: view.key, keys: view.typeKeys(role), ignored: [], dropped: [] };

  const visible = new Set(visibleTypeKeys(role));
  const keys: string[] = [];
  const ignored: string[] = [];
  const dropped: string[] = [];
  const asked = [...new Set(value.split(",").map((k) => k.trim()).filter(Boolean))];
  for (const original of asked.slice(0, TYPES_PARAM_MAX_KEYS)) {
    const key = RETIRED_TYPE_KEYS[original] ?? original;
    if (!BY_KEY.has(key)) ignored.push(original);
    else if (!visible.has(key)) dropped.push(key);
    else if (!keys.includes(key)) keys.push(key);
  }
  ignored.push(...asked.slice(TYPES_PARAM_MAX_KEYS));
  return keys.length ? { view: null, keys, ignored, dropped } : fallback(ignored, dropped);
}

// ── What the server sends: the only shape the timeline is given ──────────────

export type SubjectKind = "member" | "class" | "session" | "payment" | "tier" | "pack" | "staff" | "venue" | "rank";

/** A person or thing a sentence names. `href: null` is plain text: gone, or a page this reader may not open. */
export type FeedSubject = { kind: SubjectKind; name: string; href: string | null; gone?: "deleted" | "erased" };
export type Part = { text: string } | { subject: FeedSubject; possessive?: boolean };
export type FeedChange = { label: string; from: string | null; to: string | null };
export type FeedSource = { label: string; staff: { id: string; name: string } | null; support: boolean };
export type FeedUndo = { ok: true; sinceHere: { userId: string; name: string } | null } | { ok: false; reason: string };

export type FeedEntry = {
  id: string;
  /** ISO instant. */
  at: string;
  /** The club day it falls on, "YYYY-MM-DD": drives the day headers. */
  dayKey: string;
  /** An ActivityType key. */
  type: string;
  parts: Part[];
  /** The sentence as plain text (dialog titles, accessible names). */
  plain: string;
  detail: Part[] | null;
  detailPlain: string | null;
  /** Every changed field. `from`/`to` are null for a manager, and for an erased or deleted member. */
  changes: FeedChange[] | null;
  source: FeedSource;
  undone: boolean;
  /** Owner only, and never on an embedded timeline. */
  undo?: FeedUndo;
};

/** GET /api/activity. Closed: no audit row, metadata, address, operator id or request id is ever in it. */
export type ActivityResponse = {
  entries: FeedEntry[];
  nextCursor: string | null;
  /** False when names could not be loaded: every entry is its plain label. */
  enriched: boolean;
  /** `minDayKey` is the club's first day: activity is kept permanently, so nothing older is hidden. */
  clock: { timeZone: string; todayKey: string; minDayKey: string };
  filters: {
    types: { view: string | null; keys: string[] };
    /** `name: null` means the id is not a record of this club (removed, or never was). */
    member: { id: string; name: string | null } | null;
    class: { id: string; name: string | null } | null;
    payment: { id: string; label: string | null } | null;
    tier: { id: string; name: string | null } | null;
    staff: { id: string; name: string | null } | null;
    dayKey: string | null;
  };
  ignoredTypes: string[];
  droppedTypes: string[];
};

// ── Field names, in words ────────────────────────────────────────────────────

/**
 * What a changed field is called on screen. Every field the member PATCH can
 * diff is here (a unit test checks); anything else is put into words by
 * `fieldLabel`, so a column name never reaches the page.
 */
export const ACTIVITY_FIELD_LABELS: Record<string, string> = {
  // Member
  name: "Name",
  email: "Email",
  phone: "Phone",
  membershipType: "Membership",
  status: "Status",
  paymentStatus: "Payment status",
  emergencyContactName: "Emergency contact",
  emergencyContactPhone: "Emergency phone",
  emergencyContactRelation: "Emergency relation",
  dateOfBirth: "Date of birth",
  accountType: "Account type",
  membershipTierId: "Plan",
  nextDueAt: "Next payment due",
  preferredPaymentMethod: "Payment method",
  leaderboardOptOut: "Hidden from the leaderboard",
  holdUntil: "On hold until",
  notes: "Notes",
  medicalConditions: "Medical details",
  // Class
  description: "Description",
  instructorId: "Coach",
  coachUserId: "Coach",
  coachName: "Coach name",
  location: "Room",
  locationId: "Venue",
  duration: "Length",
  maxCapacity: "Capacity",
  isKids: "For children",
  requiredRankId: "Lowest rank allowed",
  maxRankId: "Highest rank allowed",
  color: "Colour",
  isActive: "Active",
  category: "Category",
  deletedAt: "Archived",
  // Plan
  pricePence: "Price",
  currency: "Currency",
  billingCycle: "Billing cycle",
  maxClassesPerWeek: "Classes per week",
  classLimit: "Class allowance",
  classLimitBasis: "Allowance period",
  classLimitWeeks: "Allowance weeks",
  classLimitAnchor: "Allowance start date",
  // Staff, venue, club
  role: "Role",
  address: "Address",
  isDefault: "Default venue",
  timezone: "Time zone",
};

/** "emergencyContactName" → "Emergency contact"; an unlisted "someNewFieldId" → "Some new field". */
export function fieldLabel(key: string): string {
  const known = ACTIVITY_FIELD_LABELS[key];
  if (known) return known;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+ids?$/, "");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Field";
}

// ── A person's own default view (per device) ─────────────────────────────────

/** localStorage key for one user's default. Per user, so a shared front-desk browser keeps them apart. */
export const storedDefaultKey = (userId: string) => `activity.defaultTypes.v1:${userId}`;

export type StoredActivityDefault = { v: 1; view?: string; shown?: string[]; known: string[] };

/**
 * Reads what `storedDefaultKey` holds. Returns the `types` value to use, or
 * null to use the product default: bad JSON, another version, a view that no
 * longer exists, or nothing left once unknown and forbidden keys are dropped.
 * A type added since the default was saved (not in `known`) takes its product
 * default, so new kinds of activity are not silently hidden.
 */
export function readStoredActivityDefault(raw: string | null, role: ActivityRole, currentKeys: string[] = ACTIVITY_TYPES.map((t) => t.key)): { view: string | null; keys: string[] } | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const stored = parsed as Partial<StoredActivityDefault>;
  if (stored.v !== 1 || !Array.isArray(stored.known)) return null;

  if (typeof stored.view === "string") {
    const view = VIEW_BY_KEY.get(stored.view);
    return view ? { view: view.key, keys: view.typeKeys(role) } : null;
  }
  if (!Array.isArray(stored.shown)) return null;

  const visible = new Set(visibleTypeKeys(role));
  const known = new Set(stored.known.filter((k): k is string => typeof k === "string"));
  const shown = new Set(stored.shown.filter((k): k is string => typeof k === "string").map((k) => RETIRED_TYPE_KEYS[k] ?? k));
  const keys = currentKeys.filter((key) => {
    if (!visible.has(key)) return false;
    if (shown.has(key)) return true;
    return !known.has(key) && BY_KEY.get(key)?.defaultOn === true;
  });
  return keys.length ? { view: null, keys } : null;
}
