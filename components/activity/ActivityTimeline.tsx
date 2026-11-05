"use client";

/**
 * The Activity timeline — one component, shown in every place a club's history
 * is read (docs/RULES.md "Activity"):
 *
 *   variant="page"      the Activity page: the whole club, with views, filters,
 *                       Jump to date, day headings and (owner) Undo.
 *   variant="embedded"  a record's own History (a member, a class, a payment):
 *                       the newest few rows as cards and a link to the page.
 *
 * It decides no wording, no link and no permission: GET /api/activity sends
 * finished entries for this reader's role (lib/activity-types.ts FeedEntry).
 *
 * The filters live in the address bar and nowhere else. The page reads them
 * from useSearchParams() on every render and changes them with
 * window.history.replaceState, which Next keeps in step with useSearchParams —
 * so a link inside the timeline, Back, a pasted address and a reload all mean
 * the same thing, and nothing re-runs the server page.
 */
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, History, RotateCcw, SlidersHorizontal, X } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils";
import { formatDate, formatDayLabel, formatTime } from "@/lib/date";
import {
  ACTIVITY_TYPES,
  ACTIVITY_VIEWS,
  defaultTypeKeys,
  parseTypesParam,
  readStoredActivityDefault,
  storedDefaultKey,
  type ActivityRole,
  type FeedEntry,
  type StoredActivityDefault,
} from "@/lib/activity-types";
import { NO_FILTERS, apiQuery, dayHeading, hasSubjectFilter, matchingView, readFilters, typesLabel, typesValue, writeFilters, type ActivityFilters } from "@/lib/activity-url";
import { ActivitySentence, ActivityTypeLabel } from "./ActivityRow";
import { ActivityTypesSheet } from "./ActivityTypesSheet";
import { JumpToDate } from "./JumpToDate";
import { MemberSearchPicker } from "./MemberSearchPicker";
import { markUndone, useActivityUndo } from "./ActivityUndo";
import { useActivityFeed } from "./useActivityFeed";

export type StaffOption = { id: string; name: string; role: string };
export type TierOption = { id: string; name: string; isActive: boolean };
export type TimelineScope = { kind: "member" | "class" | "payment"; id: string };

type PageProps = {
  variant: "page";
  role: ActivityRole;
  /** The signed-in person: their saved default view is theirs alone, even on a shared front-desk browser. */
  viewerId: string;
  /** The choices for "Done by" and "Plan". */
  staff?: StaffOption[];
  tiers?: TierOption[];
};
type EmbeddedProps = {
  variant: "embedded";
  role: ActivityRole;
  /** Whose history this is. */
  scope: TimelineScope;
  /** How many rows (default 20). */
  take?: number;
};
export type ActivityTimelineProps = PageProps | EmbeddedProps;

const PAGE_SIZE = 50;
const SCOPE_PARAM: Record<TimelineScope["kind"], "memberId" | "classId" | "paymentId"> = { member: "memberId", class: "classId", payment: "paymentId" };
/** One height with the fields beside it: 36px with a mouse, 44px on a touch screen (UI-RULES §5a). */
const FIELD_BUTTON = "ui-fixed-size ui-field h-9";
const CAPTION = "text-xs font-medium text-tx-3";
/**
 * A pressed chip is filled with the club's accent — which an owner may have set to white. The dark border is what
 * still says "this one" then (UI-RULES §2a); on a dark accent the fill says it.
 */
export const PRESSED = "border-[var(--tx-2)]";

export function ActivityTimeline(props: ActivityTimelineProps) {
  return props.variant === "embedded" ? <EmbeddedTimeline {...props} /> : <PageTimeline {...props} />;
}

export default ActivityTimeline;

// ── A person's saved default view (this device only) ─────────────────────────

const storeListeners = new Set<() => void>();
const subscribeToStore = (onChange: () => void) => {
  storeListeners.add(onChange);
  return () => storeListeners.delete(onChange);
};
/** "" when nothing is stored or storage is unavailable; null on the server and during hydration ("not read yet"). */
function readStore(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function useSavedDefault(viewerId: string, role: ActivityRole) {
  const key = storedDefaultKey(viewerId);
  const raw = useSyncExternalStore(
    subscribeToStore,
    () => readStore(key),
    () => null,
  );
  const saved = useMemo(() => (raw ? readStoredActivityDefault(raw, role) : null), [raw, role]);
  const save = useCallback(
    (keys: string[]): boolean => {
      const view = matchingView(keys, role);
      const value: StoredActivityDefault = { v: 1, ...(view ? { view } : { shown: keys }), known: ACTIVITY_TYPES.map((t) => t.key) };
      try {
        window.localStorage.setItem(key, JSON.stringify(value));
      } catch {
        return false;
      }
      storeListeners.forEach((notify) => notify());
      return true;
    },
    [key, role],
  );
  const clear = useCallback(() => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Nothing was stored if storage is unavailable.
    }
    storeListeners.forEach((notify) => notify());
  }, [key]);
  return { ready: raw !== null, saved, save, clear };
}

// ── The page ─────────────────────────────────────────────────────────────────

function PageTimeline({ role, viewerId, staff = [], tiers = [] }: PageProps) {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const filters = readFilters(searchParams);
  const mine = useSavedDefault(viewerId, role);

  // What is being shown: the address says, else this person's saved default, else the product's.
  const selection = useMemo(() => {
    if (filters.types) return parseTypesParam(filters.types, role);
    if (mine.saved) return { view: mine.saved.view, keys: mine.saved.keys, ignored: [], dropped: [] };
    return parseTypesParam(null, role);
  }, [filters.types, mine.saved, role]);
  const keys = selection.keys;
  const view = matchingView(keys, role);
  const defaultKeys = mine.saved?.keys ?? defaultTypeKeys(role);
  const atDefaultTypes = [...keys].sort().join() === [...defaultKeys].sort().join();

  const url = mine.ready ? apiQuery(filters, { types: typesValue(keys, role), take: PAGE_SIZE }) : null;
  const feed = useActivityFeed(url);
  const page = feed.page;
  const clock = page?.clock ?? null;
  const entries = useMemo(() => page?.entries ?? [], [page]);

  const [typesOpen, setTypesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [whyNot, setWhyNot] = useState<FeedEntry | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const change = useCallback((patch: Partial<ActivityFilters>) => {
    setAnnouncement("");
    window.history.replaceState(null, "", `${window.location.pathname}${writeFilters(window.location.search, patch)}${window.location.hash}`);
    // New filters start from the top of the list.
    listRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  /** A view key in the address, or nothing at all when it is this person's default anyway. */
  const showTypes = useCallback(
    (next: string[]) => {
      const isDefault = [...next].sort().join() === [...defaultKeys].sort().join();
      change({ types: isDefault ? null : typesValue(next, role) });
    },
    [change, defaultKeys, role],
  );

  const undo = useActivityUndo({
    entries,
    timeZone: clock?.timeZone ?? "Europe/London",
    toast,
    onUndone: (ids) => {
      feed.patch((entry) => (ids.includes(entry.id) ? markUndone(entry) : entry));
      feed.refresh();
    },
    onUnsure: feed.retry,
  });

  const echo = page?.filters;
  const memberName = filters.memberId ? (echo?.member?.id === filters.memberId ? echo.member.name : undefined) : undefined;
  const subjectFiltered = hasSubjectFilter(filters);
  const nothingFiltered = !subjectFiltered && !filters.day && atDefaultTypes;
  /** "Since here" undoes everything a person did from a row onwards — only honest when the page is hiding nothing. */
  const sinceHereAllowed = view === "all" && !subjectFiltered && !filters.day;
  const owner = role === "owner";
  const busy = feed.phase === "refreshing";

  const summary = [
    typesLabel(keys, role),
    filters.memberId ? (memberName === null ? "Removed member" : (memberName ?? "one member")) : null,
    filters.classId ? (echo?.class?.name ?? (echo?.class ? "Removed class" : "one class")) : null,
    filters.paymentId ? (echo?.payment?.label ? `Payment ${echo.payment.label}` : echo?.payment ? "Removed payment" : "one payment") : null,
    filters.tierId ? (tiers.find((t) => t.id === filters.tierId)?.name ?? "Removed plan") : null,
    filters.userId ? `done by ${staff.find((s) => s.id === filters.userId)?.name ?? "a removed staff member"}` : null,
    filters.day ? `up to ${formatDate(`${filters.day}T12:00:00Z`, "UTC")}` : null,
  ].filter(Boolean) as string[];

  const copyLink = async () => {
    // The types are written out, so the link opens the same way for someone with a different saved default.
    const link = `${window.location.origin}${window.location.pathname}${writeFilters(window.location.search, { types: typesValue(keys, role) })}`;
    try {
      await navigator.clipboard.writeText(link);
      toast("Link copied.", "success");
    } catch {
      toast("Couldn't copy. Press and hold the address bar instead.", "error");
    }
  };

  const loadOlder = async () => {
    const result = await feed.loadOlder();
    if (!result) return;
    setAnnouncement(result.added === 0 ? "Nothing older to show" : `${result.added} more loaded`);
    // Keyboard and screen-reader users continue from the first new row, not from the button.
    const firstId = result.firstId;
    if (firstId) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(firstId)}"] a`)?.focus());
  };

  const undoCell = (entry: FeedEntry, card: boolean) => {
    if (!entry.undo || entry.type === "undo") return null;
    if (entry.undone) return <span className="text-xs text-tx-3">Undone</span>;
    if (entry.undo.ok) {
      return (
        <div className={cn("flex items-center gap-1.5", !card && "justify-end")}>
          <Button variant="secondary" size="compact" onClick={() => undo.askUndo(entry)} aria-label={`Undo: ${entry.plain}`}>
            <RotateCcw className="size-3.5" aria-hidden="true" /> Undo
          </Button>
          {sinceHereAllowed && entry.undo.sinceHere ? (
            <Button variant="ghost" size="compact" onClick={() => undo.askUndoTo(entry)} aria-label={`Undo everything ${entry.undo.sinceHere.name} did since: ${entry.plain}`}>
              Since here
            </Button>
          ) : null}
        </div>
      );
    }
    // On a phone the reason is simply written out; in the table it is one keyboard-reachable press away.
    return card ? (
      <p className="text-xs text-tx-3">Can&apos;t undo: {entry.undo.reason}</p>
    ) : (
      <Button variant="ghost" size="compact" onClick={() => setWhyNot(entry)} aria-label={`Why this can't be undone: ${entry.plain}`}>
        Can&apos;t undo
      </Button>
    );
  };

  const timeZone = clock?.timeZone;
  const columns: DataTableColumn<FeedEntry>[] = [
    { key: "when", header: "When", headerLabel: "When", width: "4.5rem", cell: (e) => <span className="tabular-nums text-tx-2">{formatTime(e.at, timeZone)}</span> },
    { key: "type", header: "Type", headerLabel: "Type", width: "11rem", cell: (e) => <ActivityTypeLabel typeKey={e.type} /> },
    {
      key: "what",
      header: "What happened",
      headerLabel: "What happened",
      wrap: true,
      cell: (e) => (
        <div data-entry-id={e.id}>
          <ActivitySentence entry={e} />
        </div>
      ),
    },
    ...(owner ? [{ key: "undo", header: "Undo", headerLabel: "Undo", width: "13rem", align: "right" as const, cell: (e: FeedEntry) => undoCell(e, false) }] : []),
  ];

  const typesTrigger = (
    <label className="flex min-w-0 flex-col gap-1">
      <span className={CAPTION}>Activity types</span>
      <Button type="button" variant="secondary" className={`${FIELD_BUTTON} w-full justify-between bg-sf-1 px-3 font-normal`} aria-haspopup="dialog" onClick={() => setTypesOpen(true)} data-testid="types-trigger">
        <span className="truncate">{typesLabel(keys, role)}</span>
        <ChevronDown className="size-4 shrink-0 text-tx-3" aria-hidden="true" />
      </Button>
    </label>
  );

  const fields = (
    <>
      {typesTrigger}
      <div className="flex min-w-0 flex-col gap-1">
        <span className={CAPTION}>Member</span>
        <MemberSearchPicker value={filters.memberId ? { id: filters.memberId, name: memberName === undefined ? "…" : memberName } : null} onChange={(member) => change({ memberId: member?.id ?? null })} />
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className={CAPTION}>Plan</span>
        <Select aria-label="Plan" className="w-full" value={filters.tierId ?? ""} onChange={(event) => change({ tierId: event.target.value || null })}>
          <option value="">Any plan</option>
          {[...tiers]
            .sort((a, b) => Number(b.isActive) - Number(a.isActive))
            .map((tier) => (
              <option key={tier.id} value={tier.id}>
                {tier.isActive ? tier.name : `${tier.name} (inactive)`}
              </option>
            ))}
          {filters.tierId && !tiers.some((t) => t.id === filters.tierId) ? <option value={filters.tierId}>Removed plan</option> : null}
        </Select>
        {/* Always rendered, so choosing a plan never changes the card's height. */}
        <span className="min-h-4 text-xs text-tx-3">{filters.tierId ? "Activity that names this plan." : ""}</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <span className={CAPTION}>Done by</span>
        <Select aria-label="Done by" className="w-full" value={filters.userId ?? ""} onChange={(event) => change({ userId: event.target.value || null })}>
          <option value="">Anyone</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.role}
            </option>
          ))}
          {filters.userId && !staff.some((s) => s.id === filters.userId) ? <option value={filters.userId}>Removed staff member</option> : null}
        </Select>
      </div>
    </>
  );

  const narrowed = [filters.memberId, filters.tierId, filters.userId].filter(Boolean).length + (atDefaultTypes ? 0 : 1);
  const chips: { key: keyof ActivityFilters; label: string; phoneOnly: boolean }[] = [
    ...(filters.classId ? [{ key: "classId" as const, label: echo?.class?.name ?? (echo?.class ? "Removed class" : "One class"), phoneOnly: false }] : []),
    ...(filters.paymentId ? [{ key: "paymentId" as const, label: echo?.payment?.label ? `Payment ${echo.payment.label}` : echo?.payment ? "Removed payment" : "One payment", phoneOnly: false }] : []),
    ...(filters.memberId ? [{ key: "memberId" as const, label: memberName === null ? "Removed member" : (memberName ?? "One member"), phoneOnly: true }] : []),
    ...(filters.tierId ? [{ key: "tierId" as const, label: tiers.find((t) => t.id === filters.tierId)?.name ?? "Removed plan", phoneOnly: true }] : []),
    ...(filters.userId ? [{ key: "userId" as const, label: `Done by ${staff.find((s) => s.id === filters.userId)?.name ?? "a removed staff member"}`, phoneOnly: true }] : []),
  ];

  const count = entries.length;
  const status = feed.phase === "ready" ? announcement || (count === 0 ? "Nothing to show" : `Showing ${count} ${count === 1 ? "activity" : "activities"}`) : "";

  return (
    <div className="space-y-4">
      <PageHeader
        title={memberName ? `Activity for ${memberName}` : "Activity"}
        description="What's happened in your club, newest first. Select a name, class or payment to open it. Kept for one year."
        action={
          memberName && filters.memberId ? (
            <Link href={`/dashboard/members/${encodeURIComponent(filters.memberId)}`} className={buttonVariants({ variant: "secondary" })}>
              Open profile
            </Link>
          ) : undefined
        }
      />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Views" data-testid="activity-views">
        {ACTIVITY_VIEWS.map((v) => (
          <Button key={v.key} type="button" size="compact" variant={view === v.key ? "primary" : "secondary"} className={view === v.key ? PRESSED : undefined} aria-pressed={view === v.key} onClick={() => showTypes(v.typeKeys(role))}>
            {v.label}
          </Button>
        ))}
      </div>

      <Card padding="tight" data-testid="activity-filters" className="space-y-3">
        <div className="hidden grid-cols-1 gap-3 sm:grid sm:grid-cols-2 lg:grid-cols-4">{fields}</div>
        <div className="flex flex-wrap items-center gap-3">
          <JumpToDate dayKey={filters.day} todayKey={clock?.todayKey ?? ""} minDayKey={clock?.minDayKey ?? ""} disabled={!clock} onChange={(day) => change({ day })} />
          <Button type="button" variant="secondary" className={`${FIELD_BUTTON} px-3 sm:hidden`} onClick={() => setFiltersOpen(true)} data-testid="filters-button">
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {narrowed ? `Filters (${narrowed})` : "Filters"}
          </Button>
          <Button type="button" variant="ghost" className={`${FIELD_BUTTON} px-3`} onClick={() => void copyLink()}>
            Copy link
          </Button>
          {/* The slot is always there, so the row does not shuffle when a default is saved or dropped. */}
          <span className={cn("flex items-center gap-1", atDefaultTypes && !mine.saved && "invisible")}>
            {!atDefaultTypes ? (
              <Button
                type="button"
                variant="ghost"
                className={`${FIELD_BUTTON} px-3`}
                onClick={() => {
                  if (mine.save(keys)) {
                    toast("Saved. Activity will open like this on this device.", "success");
                    // The address no longer needs to say it: this is now what "no types" means here.
                    change({ types: null });
                  } else toast("Couldn't save on this device.", "error");
                }}
              >
                Make this my default
              </Button>
            ) : (
              <Button type="button" variant="ghost" className={`${FIELD_BUTTON} px-3`} tabIndex={mine.saved ? 0 : -1} aria-hidden={mine.saved ? undefined : true} onClick={() => mine.clear()}>
                Use MatFlow&apos;s default
              </Button>
            )}
          </span>
          <Button type="button" variant="ghost" className={`${FIELD_BUTTON} ml-auto px-3`} disabled={nothingFiltered} onClick={() => change(NO_FILTERS)}>
            Reset filters
          </Button>
        </div>
      </Card>

      {chips.length ? (
        <div className="flex flex-wrap gap-2" data-testid="activity-chips">
          {chips.map((chip) => (
            <Button key={chip.key} type="button" variant="secondary" size="compact" className={chip.phoneOnly ? "sm:hidden" : undefined} onClick={() => change({ [chip.key]: null })} aria-label={`Remove filter: ${chip.label}`}>
              {chip.label}
              <X className="size-3.5" aria-hidden="true" />
            </Button>
          ))}
        </div>
      ) : null}

      <div className="space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-tx-2" aria-live="polite" data-testid="activity-summary">
          <span>{summary.join(" · ")}</span>
          {view !== "all" ? (
            <Button type="button" variant="ghost" size="compact" onClick={() => change({ types: "all" })}>
              Show everything
            </Button>
          ) : null}
        </p>
        {clock && browserZone() !== clock.timeZone ? <p className="text-xs text-tx-3">Times are shown in club time ({clock.timeZone}).</p> : null}
        {page?.ignoredTypes.length ? <p className="text-xs text-tx-3">This link included activity types that no longer exist.</p> : null}
        {page?.droppedTypes.length ? <p className="text-xs text-tx-3">Some activity types in this link are only visible to the owner.</p> : null}
        {clock?.clamped && echo?.dayKey ? <p className="text-xs text-tx-3">Activity is kept for one year, so there&apos;s nothing to show before {formatDate(`${echo.dayKey}T12:00:00Z`, "UTC")}.</p> : null}
        {owner ? (
          <p className="text-xs text-tx-3">Undo puts the recorded details back as they were. Linked records (bookings, rank history, Stripe, emails) are not changed; where a change can&apos;t be put back safely the row says why.</p>
        ) : null}
      </div>

      <p className="sr-only" role="status" data-testid="activity-status">
        {status}
      </p>

      {feed.phase === "error" && feed.error ? (
        <ErrorState message={feed.error.message} reference={feed.error.reference} onRetry={feed.retry} />
      ) : (
        <div ref={listRef} className="space-y-3">
          {page && !page.enriched ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[var(--r-md)] border border-bd-default bg-sf-2 px-3 py-2 text-sm text-tx-2" role="status">
              <span>Names couldn&apos;t be loaded, so this is the plain log.</span>
              <Button type="button" variant="ghost" size="compact" onClick={feed.retry}>
                Try again
              </Button>
            </div>
          ) : null}
          <div aria-busy={busy || undefined} className={cn("transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-out)]", busy && "opacity-60")}>
            <DataTable
              label={`Activity: ${summary.join(", ")}`}
              columns={columns}
              rows={entries}
              rowKey={(e) => e.id}
              loading={feed.phase === "loading"}
              skeletonRows={8}
              sectionOf={clock ? (e) => ({ key: e.dayKey, label: dayHeading(e.dayKey, clock.todayKey) }) : undefined}
              empty={
                !subjectFiltered && !filters.day && view === "all" ? (
                  <EmptyState title="Nothing has been recorded yet." icon={<History className="size-5" aria-hidden="true" />} />
                ) : (
                  <EmptyState
                    title="Nothing matches these filters."
                    hint={summary.join(" · ")}
                    icon={<History className="size-5" aria-hidden="true" />}
                    action={
                      <div className="flex flex-wrap justify-center gap-2">
                        {/* Keeps the date: "everything up to that day" is still a useful question. */}
                        <Button type="button" variant="secondary" onClick={() => change({ ...NO_FILTERS, day: filters.day, types: "all" })}>
                          Show everything
                        </Button>
                        <Button type="button" variant="ghost" disabled={nothingFiltered} onClick={() => change(NO_FILTERS)}>
                          Reset filters
                        </Button>
                      </div>
                    }
                  />
                )
              }
              renderCard={(e) => (
                <div data-testid="activity-card" data-entry-id={e.id} className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3">
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <ActivityTypeLabel typeKey={e.type} />
                    <span className="shrink-0 tabular-nums text-tx-3">{formatTime(e.at, timeZone)}</span>
                  </div>
                  <ActivitySentence entry={e} className="mt-1 text-sm leading-6" />
                  {owner && undoCell(e, true) ? <div className="mt-2 flex justify-end">{undoCell(e, true)}</div> : null}
                </div>
              )}
            />
          </div>

          {page && count > 0 ? (
            page.nextCursor ? (
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button type="button" variant="secondary" loading={feed.older === "loading"} disabled={feed.phase !== "ready"} onClick={() => void loadOlder()}>
                  Show older
                </Button>
                {feed.older === "error" ? (
                  <span className="flex items-center gap-2 text-sm text-tx-2" role="alert">
                    Couldn&apos;t load older activity
                    <Button type="button" variant="ghost" size="compact" onClick={() => void loadOlder()}>
                      Try again
                    </Button>
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-center text-xs text-tx-3">That&apos;s everything. Activity is kept for one year.</p>
            )
          ) : null}
        </div>
      )}

      <ActivityTypesSheet open={typesOpen} onClose={() => setTypesOpen(false)} role={role} selected={keys} onApply={showTypes} />

      <Sheet
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title="Filters"
        footer={
          <>
            <Button type="button" variant="ghost" disabled={nothingFiltered} onClick={() => change(NO_FILTERS)}>
              Reset filters
            </Button>
            <Button type="button" onClick={() => setFiltersOpen(false)}>
              Show activity
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-3">{fields}</div>
      </Sheet>

      <Dialog open={!!whyNot} onClose={() => setWhyNot(null)} title="Why this can't be undone" description={whyNot?.plain}>
        <p className="text-sm text-tx-1">{refusalOf(whyNot)}</p>
      </Dialog>

      {undo.dialogs}
    </div>
  );
}

/** Why a row cannot be undone, in the server's words; empty when it can be, or when no row is chosen. */
function refusalOf(entry: FeedEntry | null): string {
  const undo = entry?.undo;
  if (!undo || undo.ok) return "";
  return undo.reason;
}

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ── A record's own History ───────────────────────────────────────────────────

function EmbeddedTimeline({ scope, take = 20 }: EmbeddedProps) {
  // Always everything this reader may see (the server knows their role), never their saved default, never the address bar.
  const param = SCOPE_PARAM[scope.kind];
  const feed = useActivityFeed(apiQuery({ ...NO_FILTERS, [param]: scope.id }, { types: "all", take, embed: true }));
  const page = feed.page;

  if (feed.phase === "error" && feed.error) return <ErrorState message={feed.error.message} reference={feed.error.reference} onRetry={feed.retry} />;
  if (feed.phase === "loading" || !page) {
    return (
      <div className="space-y-2" aria-busy="true" data-testid="activity-embedded-loading">
        {[0, 1, 2].map((i) => (
          <div key={i} className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

  const timeZone = page.clock.timeZone;
  return (
    <div className="space-y-2" data-testid="activity-embedded">
      {page.entries.length === 0 ? (
        <p className="text-sm text-tx-3">Nothing has been recorded yet.</p>
      ) : (
        <>
          {!page.enriched ? <p className="text-xs text-tx-3">Names couldn&apos;t be loaded, so this is the plain log.</p> : null}
          <ul className="space-y-2">
            {page.entries.map((e) => (
              <li key={e.id} data-testid="activity-card" data-entry-id={e.id} className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <ActivityTypeLabel typeKey={e.type} />
                  <span className="shrink-0 tabular-nums text-tx-3">
                    {formatDayLabel(e.at, timeZone)}, {formatTime(e.at, timeZone)}
                  </span>
                </div>
                <ActivitySentence entry={e} className="mt-1 text-sm leading-6" />
              </li>
            ))}
          </ul>
        </>
      )}
      <Link href={`/dashboard/activity?${param}=${encodeURIComponent(scope.id)}&types=all`} className="inline text-sm font-medium text-tx-1 underline decoration-[color:var(--bd-active)] underline-offset-2 hover:decoration-[color:var(--tx-1)]">
        See all activity
      </Link>
    </div>
  );
}
