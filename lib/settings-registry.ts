/**
 * Settings registry — one typed description per club setting (execution
 * prompt §6). It does NOT replace the `.strict()` zod schema in
 * `app/api/settings/route.ts`, which stays the validator; it answers, for
 * every key that schema accepts, the five questions a consequential change
 * must answer at the point of change: what does it do, where does it apply,
 * who is affected, when does it take effect, can it be undone. A unit test
 * keeps the two in step so neither can gain a key the other lacks.
 *
 * Precedence today is short because only one scope exists: a platform
 * safety constraint (fixed in code, not editable) wins, then the club's own
 * value, then the product default. Group defaults and location overrides
 * (ADR-001 D3/D2) slot in between when they exist; `resolveSetting` already
 * takes them in that order so callers do not change when they arrive.
 */

export type SettingGroup = "club" | "branding" | "operations" | "money" | "people" | "legal" | "integrations";
export type SettingKind = "string" | "colour" | "url" | "email" | "boolean" | "int" | "enum" | "json" | "text";
export type SettingRisk = "low" | "medium" | "high";

export interface SettingSpec {
  key: string;
  group: SettingGroup;
  kind: SettingKind;
  /** Who may edit it through the API today. */
  editRole: "owner";
  risk: SettingRisk;
  /** What it does, in the owner's words. */
  what: string;
  /** Where the value shows up. */
  where: string[];
  /** Who feels the change. */
  who: "staff" | "members" | "members and staff" | "nobody yet";
  /** When it takes effect. */
  when: "immediately" | "next sign-in" | "next page load";
  /** Whether editing it back restores the previous state. */
  undo: "edit back" | "edit back, but sent messages stay sent" | "edit back; existing contracts unchanged";
  /** Values the platform fixes regardless of the club (documented, not editable). */
  constraint?: string;
  /** Whether a group default may set it (ADR-001 D3). Personal identity, money and contracts never inherit. */
  inheritable: boolean;
}

const spec = (s: SettingSpec) => s;

export const SETTINGS: readonly SettingSpec[] = [
  spec({ key: "name", group: "club", kind: "string", editRole: "owner", risk: "medium", what: "The club's name.", where: ["login page", "member app", "emails", "receipts", "leaderboard"], who: "members and staff", when: "immediately", undo: "edit back, but sent messages stay sent", inheritable: false }),
  spec({ key: "timezone", group: "operations", kind: "enum", editRole: "owner", risk: "high", what: "The zone class times and check-in windows are read in.", where: ["timetable", "check-in window", "reports month and week boundaries", "leaderboard month"], who: "members and staff", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "checkinWindowBeforeMin", group: "operations", kind: "int", editRole: "owner", risk: "medium", what: "How many minutes before a class a member may check in.", where: ["member app check-in", "kiosk"], who: "members", when: "immediately", undo: "edit back", constraint: "0–180 minutes (database CHECK)", inheritable: true }),
  spec({ key: "checkinWindowAfterMin", group: "operations", kind: "int", editRole: "owner", risk: "medium", what: "How many minutes after a class starts a member may still check in.", where: ["member app check-in", "kiosk"], who: "members", when: "immediately", undo: "edit back", constraint: "0–180 minutes (database CHECK)", inheritable: true }),
  spec({ key: "primaryColor", group: "branding", kind: "colour", editRole: "owner", risk: "low", what: "Buttons and highlights in the member app and on the login page.", where: ["login page", "member app", "kiosk", "leaderboard"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "secondaryColor", group: "branding", kind: "colour", editRole: "owner", risk: "low", what: "Secondary accent.", where: ["member app", "kiosk"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "textColor", group: "branding", kind: "colour", editRole: "owner", risk: "low", what: "Text colour on the club's own surfaces.", where: ["login page", "member app", "kiosk"], who: "members", when: "immediately", undo: "edit back", constraint: "contrast is checked by the branding validator", inheritable: true }),
  spec({ key: "bgColor", group: "branding", kind: "colour", editRole: "owner", risk: "low", what: "Background of the club's own surfaces.", where: ["login page", "member app", "kiosk"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "fontFamily", group: "branding", kind: "enum", editRole: "owner", risk: "low", what: "Typeface of the club's own surfaces.", where: ["login page", "member app", "kiosk"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "logoUrl", group: "branding", kind: "url", editRole: "owner", risk: "low", what: "The club's logo.", where: ["login page", "member app", "kiosk", "leaderboard", "printed cards"], who: "members", when: "immediately", undo: "edit back", constraint: "must be an uploaded image on the club's own blob store; no external URLs", inheritable: true }),
  spec({ key: "logoSize", group: "branding", kind: "enum", editRole: "owner", risk: "low", what: "How large the logo renders.", where: ["login page", "member app"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "onboardingCompleted", group: "club", kind: "boolean", editRole: "owner", risk: "low", what: "Whether the setup wizard has been finished.", where: ["dashboard"], who: "staff", when: "immediately", undo: "edit back", inheritable: false }),
  spec({ key: "onboardingAnswers", group: "club", kind: "json", editRole: "owner", risk: "low", what: "The answers given in the setup wizard.", where: ["dashboard"], who: "staff", when: "immediately", undo: "edit back", inheritable: false }),
  spec({ key: "waiverTitle", group: "legal", kind: "string", editRole: "owner", risk: "high", what: "Title of the adult waiver members sign.", where: ["waiver page", "kiosk waiver"], who: "members", when: "immediately", undo: "edit back; existing contracts unchanged", inheritable: false }),
  spec({ key: "waiverContent", group: "legal", kind: "text", editRole: "owner", risk: "high", what: "The adult waiver text. Members who already signed keep the version they signed.", where: ["waiver page", "kiosk waiver"], who: "members", when: "immediately", undo: "edit back; existing contracts unchanged", constraint: "20,000 characters", inheritable: false }),
  spec({ key: "kidsWaiverTitle", group: "legal", kind: "string", editRole: "owner", risk: "high", what: "Title of the waiver a parent signs for a child.", where: ["waiver page"], who: "members", when: "immediately", undo: "edit back; existing contracts unchanged", inheritable: false }),
  spec({ key: "kidsWaiverContent", group: "legal", kind: "text", editRole: "owner", risk: "high", what: "The kids waiver text.", where: ["waiver page"], who: "members", when: "immediately", undo: "edit back; existing contracts unchanged", constraint: "20,000 characters", inheritable: false }),
  spec({ key: "paymentRail", group: "money", kind: "enum", editRole: "owner", risk: "high", what: "Whether members pay online through the club's Stripe or at the desk.", where: ["member app billing", "shop", "subscribe drawer"], who: "members and staff", when: "immediately", undo: "edit back; existing contracts unchanged", constraint: "pay_at_desk | stripe; online needs a connected Stripe account", inheritable: false }),
  spec({ key: "acceptsBacs", group: "money", kind: "boolean", editRole: "owner", risk: "medium", what: "Whether Direct Debit is offered alongside cards.", where: ["member app billing", "migration preview"], who: "members", when: "immediately", undo: "edit back; existing contracts unchanged", inheritable: false }),
  spec({ key: "memberSelfBilling", group: "money", kind: "boolean", editRole: "owner", risk: "high", what: "Whether members can start and cancel their own subscriptions.", where: ["member app billing"], who: "members", when: "immediately", undo: "edit back; existing contracts unchanged", inheritable: false }),
  spec({ key: "contactEmail", group: "club", kind: "email", editRole: "owner", risk: "low", what: "The club's public address members write to; also the Reply-To on every email we send for you. Not a login.", where: ["member app gym card", "receipts and reminders (Reply-To)", "legal pages when the privacy contact is empty"], who: "members", when: "immediately", undo: "edit back, but sent messages stay sent", inheritable: false }),
  spec({ key: "billingContactEmail", group: "money", kind: "email", editRole: "owner", risk: "low", what: "Who members contact about payments. Falls back to the contact email when empty.", where: ["member app billing", "receipts"], who: "members", when: "immediately", undo: "edit back", inheritable: false }),
  spec({ key: "billingContactUrl", group: "money", kind: "url", editRole: "owner", risk: "low", what: "A page members are sent to for billing help.", where: ["member app billing"], who: "members", when: "immediately", undo: "edit back", inheritable: false }),
  spec({ key: "privacyContactEmail", group: "legal", kind: "email", editRole: "owner", risk: "low", what: "Who members contact about their data.", where: ["legal pages", "member app"], who: "members", when: "immediately", undo: "edit back", inheritable: false }),
  spec({ key: "privacyPolicyUrl", group: "legal", kind: "url", editRole: "owner", risk: "low", what: "The club's own privacy policy, if it has one.", where: ["legal pages"], who: "members", when: "immediately", undo: "edit back", inheritable: false }),
  spec({ key: "instagramUrl", group: "club", kind: "url", editRole: "owner", risk: "low", what: "Instagram link.", where: ["member app gym card"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "facebookUrl", group: "club", kind: "url", editRole: "owner", risk: "low", what: "Facebook link.", where: ["member app gym card"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "tiktokUrl", group: "club", kind: "url", editRole: "owner", risk: "low", what: "TikTok link.", where: ["member app gym card"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "youtubeUrl", group: "club", kind: "url", editRole: "owner", risk: "low", what: "YouTube link.", where: ["member app gym card"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "twitterUrl", group: "club", kind: "url", editRole: "owner", risk: "low", what: "X / Twitter link.", where: ["member app gym card"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "websiteUrl", group: "club", kind: "url", editRole: "owner", risk: "low", what: "The club's website.", where: ["member app gym card", "public page"], who: "members", when: "immediately", undo: "edit back", inheritable: true }),
  spec({ key: "groupChatUrl", group: "club", kind: "url", editRole: "owner", risk: "low", what: "WhatsApp / Telegram / Discord invite.", where: ["member app gym card"], who: "members", when: "immediately", undo: "edit back", inheritable: false }),
];

export const SETTINGS_KEYS: readonly string[] = SETTINGS.map((s) => s.key);

export function settingSpec(key: string): SettingSpec | undefined {
  return SETTINGS.find((s) => s.key === key);
}

/**
 * Precedence: a platform constraint is not a value, so it never resolves —
 * it bounds whatever resolves. Then the location's override (only for keys
 * that allow it), then the club's value, then the group default (only for
 * inheritable keys), then the product default. Returns the value and where
 * it came from, so a settings screen can show "inherited from <group>".
 */
export function resolveSetting<T>(
  key: string,
  values: { location?: T | null; club?: T | null; group?: T | null; productDefault: T },
): { value: T; source: "location" | "club" | "group" | "default" } {
  const s = settingSpec(key);
  if (values.location != null && s && s.group === "operations") return { value: values.location, source: "location" };
  if (values.club != null) return { value: values.club, source: "club" };
  if (values.group != null && s?.inheritable) return { value: values.group, source: "group" };
  return { value: values.productDefault, source: "default" };
}

/** The five answers, ready for a confirm dialog or an impact preview. */
export function describeChange(key: string): { what: string; where: string; who: string; when: string; undo: string; risk: SettingRisk } | null {
  const s = settingSpec(key);
  if (!s) return null;
  return { what: s.what, where: s.where.join(", "), who: s.who, when: s.when, undo: s.undo, risk: s.risk };
}
