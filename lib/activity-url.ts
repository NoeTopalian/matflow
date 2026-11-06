/**
 * The Activity page's filters as they live in the address bar.
 *
 * The URL is the only copy of the filters: the page derives them from
 * `useSearchParams()` on every render and changes them by writing a new query
 * string (`window.history.replaceState`), never by keeping its own state. So a
 * link inside the timeline, the Back button, a pasted address and a reload all
 * behave the same. Everything here is pure and client-safe.
 */
import { ACTIVITY_VIEWS, DEFAULT_VIEW, activityType, visibleTypeKeys, type ActivityRole } from "@/lib/activity-types";
import { formatDateFull } from "@/lib/date";
import { parseIdParam } from "@/lib/id-param";

export type ActivityFilters = {
  /** A view key, a comma list of type keys, or null for the viewer's default. */
  types: string | null;
  memberId: string | null;
  classId: string | null;
  paymentId: string | null;
  tierId: string | null;
  /** Done by this staff member. */
  userId: string | null;
  /** Done by which kind of actor: staff, members, automatic or MatFlow support (owner only). Null is everyone. */
  by: ActorKind | null;
  /** "YYYY-MM-DD": show activity up to the end of this club day. Null is today. */
  day: string | null;
};

const KEYS: (keyof ActivityFilters)[] = ["types", "memberId", "classId", "paymentId", "tierId", "userId", "by", "day"];

/** "Done by", by kind. The words are the filter's; which rows each holds is decided on the server (lib/activity-feed.ts actorKindWhere). */
export type ActorKind = "staff" | "members" | "automatic" | "support";
export const ACTOR_KINDS: { key: ActorKind; label: string; ownerOnly: boolean }[] = [
  { key: "staff", label: "Staff", ownerOnly: false },
  { key: "members", label: "Members", ownerOnly: false },
  { key: "automatic", label: "Automatic", ownerOnly: false },
  { key: "support", label: "MatFlow support", ownerOnly: true },
];

/** A kind this reader may ask for, or null (everyone). MatFlow support is the owner's alone (D2). */
export function parseActorKind(raw: string | null | undefined, role: ActivityRole): ActorKind | null {
  const kind = ACTOR_KINDS.find((k) => k.key === raw?.trim());
  return kind && (!kind.ownerOnly || role === "owner") ? kind.key : null;
}

type Params = { get(name: string): string | null; toString(): string };

/** A whole, real calendar date ("2026-02-30" is not one). */
function dayKeyOf(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [year, month, day] = raw.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? raw : null;
}

/**
 * The filters the address holds. A value the server would ignore — a day that
 * is not a date, an id that is not an id — is not a filter here either, so a
 * mangled link reads as the unfiltered page it really is.
 */
export function readFilters(params: Params): ActivityFilters {
  const text = (key: keyof ActivityFilters) => params.get(key)?.trim() || null;
  const id = (key: keyof ActivityFilters) => parseIdParam(text(key));
  const by = ACTOR_KINDS.find((k) => k.key === text("by"))?.key ?? null;
  return { types: text("types"), memberId: id("memberId"), classId: id("classId"), paymentId: id("paymentId"), tierId: id("tierId"), userId: id("userId"), by, day: dayKeyOf(text("day")) };
}

/**
 * The query string after a change, "?a=b" or "" — built from the address as
 * it is NOW (pass `window.location.search`), so two changes in quick
 * succession both land. Parameters this page does not own are kept.
 */
export function writeFilters(search: string, patch: Partial<ActivityFilters>): string {
  const params = new URLSearchParams(search);
  for (const key of KEYS) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const out = params.toString();
  return out ? `?${out}` : "";
}

/** Everything a filter change resets: the way back to "what happened in my club today". */
export const NO_FILTERS: ActivityFilters = { types: null, memberId: null, classId: null, paymentId: null, tierId: null, userId: null, by: null, day: null };

/** True when anything narrows the timeline beyond the chosen activity types. */
export function hasSubjectFilter(filters: ActivityFilters): boolean {
  return Boolean(filters.memberId || filters.classId || filters.paymentId || filters.tierId || filters.userId || filters.by);
}

/** The view whose types are exactly these, if any — so a hand-built selection that equals "Money" lights the Money chip. */
export function matchingView(keys: string[], role: ActivityRole): string | null {
  const wanted = [...keys].sort().join();
  // The default view first: for a manager "Club activity" and "Everything" can coincide, and the default is the truer name.
  const ordered = [...ACTIVITY_VIEWS].sort((a, b) => Number(b.key === DEFAULT_VIEW) - Number(a.key === DEFAULT_VIEW));
  return ordered.find((view) => [...view.typeKeys(role)].sort().join() === wanted)?.key ?? null;
}

/** The `types` value for a selection: a view key when it is one, else the list in taxonomy order. */
export function typesValue(keys: string[], role: ActivityRole): string {
  const visible = visibleTypeKeys(role).filter((k) => keys.includes(k));
  return matchingView(visible, role) ?? visible.join(",");
}

/** What the Activity types control says: a view's name, "Everything", one type's name, or a count. */
export function typesLabel(keys: string[], role: ActivityRole): string {
  const view = matchingView(keys, role);
  if (view) return ACTIVITY_VIEWS.find((v) => v.key === view)!.label;
  if (keys.length === 1) return activityType(keys[0])?.label ?? "1 activity type";
  return `${keys.length} activity types`;
}

/** "2026-11-04" one day earlier or later. Pure calendar arithmetic: a day key has no time zone. */
export function shiftDay(dayKey: string, days: number): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** "Today", "Yesterday", or "Tuesday 4 November 2026" — against the CLUB's today, which the server sends. */
export function dayHeading(dayKey: string, todayKey: string): string {
  if (dayKey === todayKey) return "Today";
  if (dayKey === shiftDay(todayKey, -1)) return "Yesterday";
  // Noon UTC names the calendar date in any zone.
  return formatDateFull(`${dayKey}T12:00:00Z`, "UTC");
}

/** The request for one page. `types` is always explicit, so the server never has to guess the viewer's default. */
export function apiQuery(filters: ActivityFilters, opts: { types: string; cursor?: string | null; take?: number; embed?: boolean }): string {
  const params = new URLSearchParams();
  params.set("types", opts.types);
  for (const key of ["memberId", "classId", "paymentId", "tierId", "userId", "by", "day"] as const) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  if (opts.take) params.set("take", String(opts.take));
  if (opts.cursor) params.set("cursor", opts.cursor);
  if (opts.embed) params.set("embed", "1");
  return `/api/activity?${params.toString()}`;
}
