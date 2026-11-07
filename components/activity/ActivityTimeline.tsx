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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, History, RotateCcw, SlidersHorizontal, X } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/Skeleton";
import { Tab, TabList } from "@/components/ui/tabs";
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
import { ACTOR_KINDS, NO_FILTERS, apiQuery, dayHeading, hasSubjectFilter, matchingView, parseActorKind, readFilters, typesLabel, typesValue, writeFilters, type ActivityFilters, type ActorKind } from "@/lib/activity-url";
import { ActivityDescription, ActivityTypeLabel } from "./ActivityRow";
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

const sameKeys = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

function PageTimeline({ role, viewerId, staff = [], tiers = [] }: PageProps) {
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const fromAddress = readFilters(searchParams);
  // MatFlow support is the owner's to ask for (D2): in a manager's address it is not a filter.
  const filters = { ...fromAddress, by: parseActorKind(fromAddress.by, role) };
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
  const atDefaultTypes = sameKeys(keys, defaultKeys);

  const url = mine.ready ? apiQuery(filters, { types: typesValue(keys, role), take: PAGE_SIZE }) : null;
  const feed = useActivityFeed(url);
  const page = feed.page;
  const clock = page?.clock ?? null;
  const entries = useMemo(() => page?.entries ?? [], [page]);

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  /** The name as it was picked, shown until the server's answer names the member itself. Display only: the filter is the id in the address. */
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const change = useCallback((patch: Partial<ActivityFilters>) => {
    setAnnouncement("");
    window.history.replaceState(null, "", `${window.location.pathname}${writeFilters(window.location.search, patch)}${window.location.hash}`);
    // New filters start from the top of the list.
    listRef.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  /** A view key in the address, or nothing at all when it is this person's default anyway. */
  const typesPatch = useCallback((next: string[]) => ({ types: sameKeys(next, defaultKeys) ? null : typesValue(next, role) }), [defaultKeys, role]);

  const undo = useActivityUndo({
    entries,
    timeZone: clock?.timeZone ?? "Europe/London",
    toast,
    onUndone: (ids) => {
      feed.patch((entry) => (ids.includes(entry.id) ? markUndone(entry) : entry));
      feed.refresh();
    },
    onRefused: (id, reason) => feed.patch((entry) => (entry.id === id && entry.undo ? { ...entry, undo: { ok: false as const, reason } } : entry)),
    onUnsure: feed.retry,
  });

  const echo = page?.filters;
  const memberName = filters.memberId ? (echo?.member?.id === filters.memberId ? echo.member.name : picked?.id === filters.memberId ? picked.name : undefined) : undefined;
  const subjectFiltered = hasSubjectFilter(filters);
  /** Activity types chosen one by one in Filters, rather than a tab (and not this person's saved default). */
  const typesNarrowed = !view && !atDefaultTypes;
  /** Anything that narrows the list beyond the tab: what "Clear all" clears. */
  const filtered = subjectFiltered || !!filters.day || typesNarrowed;
  /** "Since here" undoes everything a person did from a row onwards — only honest when the page is hiding nothing. */
  const sinceHereAllowed = view === "all" && !subjectFiltered && !filters.day;
  const owner = role === "owner";
  const busy = feed.phase === "refreshing";
  const tierName = filters.tierId ? (tiers.find((t) => t.id === filters.tierId)?.name ?? "Removed plan") : null;
  const staffName = filters.userId ? (staff.find((s) => s.id === filters.userId)?.name ?? "a removed staff member") : null;
  const kindLabel = filters.by ? (ACTOR_KINDS.find((k) => k.key === filters.by)?.label ?? null) : null;

  /** What the list is, in words: the table's accessible name and the empty state's hint. */
  const summary = [
    typesLabel(keys, role),
    filters.memberId ? (memberName === null ? "Removed member" : (memberName ?? "one member")) : null,
    filters.classId ? (echo?.class?.name ?? (echo?.class ? "Removed class" : "one class")) : null,
    filters.paymentId ? (echo?.payment?.label ? `Payment ${echo.payment.label}` : echo?.payment ? "Removed payment" : "one payment") : null,
    tierName,
    kindLabel ? `done by ${kindLabel === "MatFlow support" ? kindLabel : kindLabel.toLowerCase()}` : null,
    staffName ? `done by ${staffName}` : null,
    filters.day ? `up to ${formatDate(`${filters.day}T12:00:00Z`, "UTC")}` : null,
  ].filter(Boolean) as string[];

  /** The first row the last "Show older" added, until it has been given the focus. */
  const focusAfterOlder = useRef<string | null>(null);
  const loadOlder = async () => {
    const result = await feed.loadOlder();
    if (!result) return;
    // Keyboard and screen-reader users continue from the first new row, not from the button (see the effect below).
    focusAfterOlder.current = result.firstId;
    setAnnouncement(result.added === 0 ? "Nothing older to show" : `${result.added} more loaded`);
  };

  // The first row "Show older" added takes the focus — once it is on the page. Waiting a frame was a guess: on a
  // slow phone the rows were drawn after it, and the focus stayed on a button that was no longer there.
  useEffect(() => {
    const firstId = focusAfterOlder.current;
    if (!firstId) return;
    // The table and the cards are both in the page; one of them is hidden.
    const matches = [...(listRef.current?.querySelectorAll<HTMLElement>(`[data-entry-id="${CSS.escape(firstId)}"]`) ?? [])];
    if (matches.length === 0) return; // not drawn yet: the render that draws it comes back here
    focusAfterOlder.current = null;
    const shown = matches.find((el) => el.offsetParent !== null) ?? matches[0];
    // Its first link when it has one; a row with nothing to follow takes the focus itself.
    (shown.querySelector<HTMLElement>("a") ?? shown).focus();
  }, [entries, announcement]);

  /** Undo, for the owner — or nothing. A row that can't be undone says nothing here; the reason belongs in its details. */
  const undoCell = (entry: FeedEntry) => {
    if (!entry.undo || entry.type === "undo") return null;
    if (entry.undone) return <span className="text-xs text-tx-3">Undone</span>;
    if (!entry.undo.ok) return null;
    return (
      <div className="flex flex-col items-end gap-1">
        <Button variant="secondary" size="compact" onClick={() => undo.askUndo(entry)} aria-label={`Undo: ${entry.plain}`}>
          <RotateCcw className="size-3.5" aria-hidden="true" /> Undo
        </Button>
        {sinceHereAllowed && entry.undo.sinceHere ? (
          <Button variant="ghost" size="compact" onClick={() => undo.askUndoTo(entry)} aria-label={`Since here: undo everything ${entry.undo.sinceHere.name} did since ${entry.plain}`}>
            Since here
          </Button>
        ) : null}
      </div>
    );
  };

  const timeZone = clock?.timeZone;
  // A thin column for when and what kind, a wide one for what happened, and a thin one for Undo.
  const columns: DataTableColumn<FeedEntry>[] = [
    {
      key: "when",
      header: "When",
      headerLabel: "When",
      width: "8.5rem",
      wrap: true,
      valign: "top",
      cell: (e) => (
        <div className="space-y-0.5 py-1">
          <p className="tabular-nums text-tx-1">{formatTime(e.at, timeZone)}</p>
          <ActivityTypeLabel typeKey={e.type} wrap className="text-xs leading-4 text-tx-3" />
        </div>
      ),
    },
    {
      key: "what",
      header: "What happened",
      headerLabel: "What happened",
      wrap: true,
      valign: "top",
      cell: (e) => (
        <div data-entry-id={e.id} tabIndex={-1} className="py-1">
          <ActivityDescription entry={e} />
        </div>
      ),
    },
    ...(owner ? [{ key: "undo", header: "Undo", headerLabel: "Undo", width: "7rem", align: "right" as const, valign: "top" as const, cell: (e: FeedEntry) => <div className="py-1">{undoCell(e)}</div> }] : []),
  ];

  /** How many choices inside Filters are narrowing the list: the number on its button. */
  const inFilters = [filters.tierId, filters.by, filters.userId].filter(Boolean).length + (typesNarrowed ? 1 : 0);
  const chips: { key: string; label: string; clear: Partial<ActivityFilters> }[] = [
    ...(filters.classId ? [{ key: "classId", label: echo?.class?.name ?? (echo?.class ? "Removed class" : "One class"), clear: { classId: null } }] : []),
    ...(filters.paymentId ? [{ key: "paymentId", label: echo?.payment?.label ? `Payment ${echo.payment.label}` : echo?.payment ? "Removed payment" : "One payment", clear: { paymentId: null } }] : []),
    ...(typesNarrowed ? [{ key: "types", label: `Types: ${typesLabel(keys, role)}`, clear: { types: null } }] : []),
    ...(tierName ? [{ key: "tierId", label: `Plan: ${tierName}`, clear: { tierId: null } }] : []),
    ...(kindLabel ? [{ key: "by", label: `Done by: ${kindLabel}`, clear: { by: null } }] : []),
    ...(staffName ? [{ key: "userId", label: `Done by: ${staffName}`, clear: { userId: null } }] : []),
  ];
  // The tab stays; everything that narrows it, the date included, goes.
  const clearAll = () => change({ ...NO_FILTERS, types: typesNarrowed ? null : filters.types });
  // The tab bar has one stop on the keyboard: the shown view, or the first when a hand-picked set matches none.
  const tabStop = Math.max(0, ACTIVITY_VIEWS.findIndex((v) => v.key === view));

  const count = entries.length;
  const nothingRecorded = !subjectFiltered && !filters.day && view === "all";
  const emptyTitle = nothingRecorded ? "Nothing has been recorded yet." : "Nothing matches these filters.";
  const status = feed.phase === "ready" ? announcement || (count === 0 ? emptyTitle : `Showing ${count} ${count === 1 ? "activity" : "activities"}`) : "";

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

      <div className="space-y-3">
        <div data-testid="activity-views">
          <TabList label="Views">
            {ACTIVITY_VIEWS.map((v, index) => (
              <Tab key={v.key} label={v.label} active={view === v.key} tabIndex={index === tabStop ? 0 : -1} onClick={() => change(typesPatch(v.typeKeys(role)))} />
            ))}
          </TabList>
        </div>

        <div className="flex flex-wrap items-center gap-2" data-testid="activity-toolbar">
          <div className="min-w-0 flex-1 basis-full sm:max-w-sm sm:basis-56">
            <MemberSearchPicker
              label="Search members"
              placeholder="Search members…"
              value={filters.memberId ? { id: filters.memberId, name: memberName === undefined ? "…" : memberName } : null}
              onChange={(member) => {
                setPicked(member);
                change({ memberId: member?.id ?? null });
              }}
            />
          </div>
          <JumpToDate dayKey={filters.day} todayKey={clock?.todayKey ?? ""} minDayKey={clock?.minDayKey ?? ""} disabled={!clock} onChange={(day) => change({ day })} />
          <Button type="button" variant="secondary" className={`${FIELD_BUTTON} px-3`} aria-haspopup="dialog" onClick={() => setFiltersOpen(true)} data-testid="filters-button">
            <SlidersHorizontal className="size-4" aria-hidden="true" />
            {inFilters ? `Filters (${inFilters})` : "Filters"}
          </Button>
        </div>

        {chips.length || filtered ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="activity-chips">
            {chips.map((chip) => (
              <Button key={chip.key} type="button" variant="secondary" size="compact" onClick={() => change(chip.clear)} aria-label={`Remove filter: ${chip.label}`}>
                {chip.label}
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            ))}
            {filtered ? (
              <Button type="button" variant="ghost" size="compact" onClick={clearAll}>
                Clear all
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {(clock && browserZone() !== clock.timeZone) || selection.ignored.length || page?.ignoredTypes.length || selection.dropped.length || page?.droppedTypes.length || (clock?.clamped && echo?.dayKey) ? (
        <div className="space-y-1">
          {clock && browserZone() !== clock.timeZone ? <p className="text-xs text-tx-3">Times are shown in club time ({clock.timeZone}).</p> : null}
          {selection.ignored.length || page?.ignoredTypes.length ? <p className="text-xs text-tx-3">This link included activity types that no longer exist.</p> : null}
          {selection.dropped.length || page?.droppedTypes.length ? <p className="text-xs text-tx-3">Some activity types in this link are only visible to the owner.</p> : null}
          {clock?.clamped && echo?.dayKey ? <p className="text-xs text-tx-3">Activity is kept for one year, so there&apos;s nothing to show before {formatDate(`${echo.dayKey}T12:00:00Z`, "UTC")}.</p> : null}
        </div>
      ) : null}

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
          <div
            aria-busy={busy || undefined}
            className={cn("transition-opacity duration-[var(--dur-fast)] ease-[var(--ease-out)] lg:rounded-[var(--r-md)] lg:border lg:border-bd-default lg:bg-sf-1", busy && "opacity-60")}
          >
            <DataTable
              label={`Activity: ${summary.join(", ")}`}
              columns={columns}
              rows={entries}
              rowKey={(e) => e.id}
              loading={feed.phase === "loading"}
              skeletonRows={8}
              cardsBelow="lg"
              sectionOf={clock ? (e) => ({ key: e.dayKey, label: dayHeading(e.dayKey, clock.todayKey) }) : undefined}
              empty={
                <EmptyState
                  title={emptyTitle}
                  hint={nothingRecorded ? undefined : summary.join(" · ")}
                  icon={<History className="size-5" aria-hidden="true" />}
                  action={
                    // One way out: everything, the date and the tab included.
                    !nothingRecorded && (filtered || !atDefaultTypes) ? (
                      <Button type="button" variant="secondary" onClick={() => change(NO_FILTERS)}>
                        Clear filters
                      </Button>
                    ) : undefined
                  }
                />
              }
              renderCard={(e) => {
                const action = owner ? undoCell(e) : null;
                return (
                  <div data-testid="activity-card" data-entry-id={e.id} tabIndex={-1} className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-3">
                    <div className="flex min-w-0 items-center gap-1.5 text-xs text-tx-3">
                      <span className="shrink-0 tabular-nums">{formatTime(e.at, timeZone)}</span>
                      <span aria-hidden="true">·</span>
                      <ActivityTypeLabel typeKey={e.type} className="text-tx-3" />
                    </div>
                    <ActivityDescription entry={e} className="mt-1.5 text-sm leading-6" />
                    {action ? <div className="mt-2 flex justify-end">{action}</div> : null}
                  </div>
                );
              }}
            />
          </div>

          {page && count > 0 ? (
            page.nextCursor ? (
              <div className="flex flex-wrap items-center justify-center gap-3">
                <Button type="button" variant="secondary" loading={feed.older === "loading"} disabled={feed.phase !== "ready" || feed.pending} onClick={() => void loadOlder()}>
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

      {filtersOpen ? (
        <FiltersSheet
          role={role}
          staff={staff}
          tiers={tiers}
          keys={keys}
          tierId={filters.tierId}
          userId={filters.userId}
          by={filters.by}
          defaultKeys={defaultKeys}
          hasSavedDefault={!!mine.saved}
          onClose={() => setFiltersOpen(false)}
          onApply={(next) => change({ ...typesPatch(next.keys), tierId: next.tierId, userId: next.userId, by: next.by })}
          onSaveDefault={(next) => {
            if (!mine.save(next.keys)) {
              toast("Couldn't save on this device.", "error");
              return false;
            }
            toast("Saved. Activity will open like this on this device.", "success");
            // The address no longer needs to say it: this is now what "no types" means here.
            change({ types: null, tierId: next.tierId, userId: next.userId, by: next.by });
            return true;
          }}
          onClearDefault={mine.clear}
        />
      ) : null}

      {undo.dialogs}
    </div>
  );
}

type Staged = { keys: string[]; tierId: string | null; userId: string | null; by: ActorKind | null };

/**
 * Filters: the activity types, Plan and Done by. Staged, like the types sheet: nothing behind the sheet changes
 * until "Show activity", and Escape or the scrim leave the page as it was. Mounted only while open, so it always
 * starts from what the page is showing. "Make this my default" lives in its footer at every width (D8).
 */
function FiltersSheet({
  role,
  staff,
  tiers,
  keys,
  tierId,
  userId,
  by,
  defaultKeys,
  hasSavedDefault,
  onClose,
  onApply,
  onSaveDefault,
  onClearDefault,
}: {
  role: ActivityRole;
  staff: StaffOption[];
  tiers: TierOption[];
  keys: string[];
  tierId: string | null;
  userId: string | null;
  by: ActorKind | null;
  defaultKeys: string[];
  hasSavedDefault: boolean;
  onClose: () => void;
  onApply: (next: Staged) => void;
  /** False when the device would not keep it: the sheet stays open. */
  onSaveDefault: (next: Staged) => boolean;
  onClearDefault: () => void;
}) {
  const [staged, setStaged] = useState<Staged>({ keys, tierId, userId, by });
  const kinds = ACTOR_KINDS.filter((k) => !k.ownerOnly || role === "owner");
  // One staff member narrows within Staff; Members, Automatic and MatFlow support have no staff member to pick.
  const personPicker = staged.by === null || staged.by === "staff";
  const [typesOpen, setTypesOpen] = useState(false);
  const atDefault = sameKeys(staged.keys, defaultKeys);

  return (
    <>
      <Sheet
        open
        onClose={onClose}
        title="Filters"
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {!atDefault ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  if (onSaveDefault(staged)) onClose();
                }}
              >
                Make this my default
              </Button>
            ) : hasSavedDefault ? (
              <Button type="button" variant="ghost" onClick={onClearDefault}>
                Use MatFlow&apos;s default
              </Button>
            ) : (
              <span />
            )}
            <Button
              type="button"
              onClick={() => {
                onApply(staged);
                onClose();
              }}
            >
              Show activity
            </Button>
          </div>
        }
      >
        <div className="grid grid-cols-1 gap-4">
          <div className="flex min-w-0 flex-col gap-1">
            <span className={CAPTION}>Activity types</span>
            <Button type="button" variant="secondary" className={`${FIELD_BUTTON} w-full justify-between bg-sf-1 px-3 font-normal`} aria-haspopup="dialog" aria-label={`Activity types: ${typesLabel(staged.keys, role)}`} onClick={() => setTypesOpen(true)} data-testid="types-trigger">
              <span className="truncate">{typesLabel(staged.keys, role)}</span>
              <ChevronDown className="size-4 shrink-0 text-tx-3" aria-hidden="true" />
            </Button>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className={CAPTION}>Plan</span>
            <Select aria-label="Plan" className="w-full" value={staged.tierId ?? ""} onChange={(event) => setStaged((was) => ({ ...was, tierId: event.target.value || null }))}>
              <option value="">Any plan</option>
              {[...tiers]
                .sort((a, b) => Number(b.isActive) - Number(a.isActive))
                .map((tier) => (
                  <option key={tier.id} value={tier.id}>
                    {tier.isActive ? tier.name : `${tier.name} (inactive)`}
                  </option>
                ))}
              {staged.tierId && !tiers.some((t) => t.id === staged.tierId) ? <option value={staged.tierId}>Removed plan</option> : null}
            </Select>
            {staged.tierId ? <span className="text-xs text-tx-3">Activity that names this plan.</span> : null}
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <span className={CAPTION}>Done by</span>
            <Select
              aria-label="Done by"
              className="w-full"
              value={staged.by ?? ""}
              onChange={(event) => {
                const next = (event.target.value || null) as ActorKind | null;
                setStaged((was) => ({ ...was, by: next, userId: next === null || next === "staff" ? was.userId : null }));
              }}
            >
              <option value="">Everyone</option>
              {kinds.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </Select>
          </div>
          {personPicker ? (
            <div className="flex min-w-0 flex-col gap-1">
              <span className={CAPTION}>Staff member</span>
              <Select aria-label="Staff member" className="w-full" value={staged.userId ?? ""} onChange={(event) => setStaged((was) => ({ ...was, userId: event.target.value || null }))}>
                <option value="">Any staff member</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.role.charAt(0).toUpperCase() + s.role.slice(1)}
                  </option>
                ))}
                {staged.userId && !staff.some((s) => s.id === staged.userId) ? <option value={staged.userId}>Removed staff member</option> : null}
              </Select>
            </div>
          ) : null}
        </div>
      </Sheet>
      <ActivityTypesSheet open={typesOpen} onClose={() => setTypesOpen(false)} role={role} selected={staged.keys} applyLabel="Done" onApply={(next) => setStaged((was) => ({ ...was, keys: next }))} />
    </>
  );
}

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ── A record's own History ───────────────────────────────────────────────────

const NOTHING_HERE: Record<TimelineScope["kind"], string> = {
  member: "Nothing recorded for this member yet.",
  class: "Nothing recorded for this class yet.",
  payment: "Nothing recorded for this payment yet.",
};

function EmbeddedTimeline({ scope, take = 20 }: EmbeddedProps) {
  // Always everything this reader may see (the server knows their role), never their saved default, never the address bar.
  const param = SCOPE_PARAM[scope.kind];
  const feed = useActivityFeed(apiQuery({ ...NO_FILTERS, [param]: scope.id }, { types: "all", take, embed: true }));
  const page = feed.page;

  if (feed.phase === "error" && feed.error) return <ErrorState message={feed.error.message} reference={feed.error.reference} onRetry={feed.retry} />;
  if (feed.phase !== "ready" || !page) {
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
        <p className="text-sm text-tx-3">{NOTHING_HERE[scope.kind]}</p>
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
                <ActivityDescription entry={e} className="mt-1 text-sm leading-6" />
              </li>
            ))}
          </ul>
        </>
      )}
      <Link href={`/dashboard/activity?${param}=${encodeURIComponent(scope.id)}&types=all`} className="inline-flex items-center text-sm font-medium text-tx-1 underline decoration-[color:var(--bd-active)] underline-offset-2 hover:decoration-[color:var(--tx-1)]">
        See all activity
      </Link>
    </div>
  );
}
