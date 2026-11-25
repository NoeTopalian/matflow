"use client";

// Mark attendance — the one staff attendance screen.
//
// 18 Sep 2026 (Noe): one screen, session first, then tick names or scan cards.
// 25 Nov 2026 (Noe): the same screen, laid out so a coach knows at once which
// class is being marked: one "Selected class" card with Change class, two
// equal ways to mark (By name, Scan QR), the rest under Session details, and
// the self-service kiosk at the bottom as its own thing.
//
// THE RULE THIS SCREEN EXISTS TO KEEP: the class on the card is the class that
// receives the attendance. The register and the scanner are both keyed on the
// session's id, so choosing another class throws the old one away whole (its
// rows, its search, its feedback, its camera) and a late answer about the old
// class has nowhere to land; each check-in carries the id of the session it
// was made under. The scanner is paused while the picker is open. Nothing
// here ever changes the selected class by itself once the screen is open: not
// the clock, not a reload of the list, not a change of method.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, QrCode, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { ErrorState } from "@/components/ui/ErrorState";
import KioskPanel from "@/components/dashboard/KioskPanel";
import ClassPicker, {
  CAN_CANCEL_SESSION_ROLES,
  SessionCancelControl,
  Tag,
  matLabel,
  pickDefault,
  placePicker,
  sessionLabel,
  type PickerPlacement,
  type TodaySession,
} from "@/components/dashboard/SessionPicker";
import RegisterPanel from "@/components/dashboard/RegisterPanel";
import CardScanner from "@/components/dashboard/CardScanner";
import { formatTimeRange } from "@/lib/class-time";
import { SQUAD_ONLY_LABEL } from "@/lib/class-tier-gate";

type Mode = "tick" | "scan";

const METHODS: Array<{ mode: Mode; label: string; Icon: typeof Users }> = [
  { mode: "tick", label: "By name", Icon: Users },
  { mode: "scan", label: "Scan QR", Icon: QrCode },
];

export default function AttendanceHub({
  initialMode,
  preselectClassId,
  role,
  primaryColor,
  timeZone,
}: {
  initialMode: Mode;
  preselectClassId: string | null;
  role: string;
  primaryColor: string;
  /** The club's time zone: the day the list is for, and the picker's date, are the club's. */
  timeZone: string;
}) {
  const [sessions, setSessions] = useState<TodaySession[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [counts, setCounts] = useState<{ checkedIn: number; expected: number; capacity: number | null } | null>(null);
  // Bumped when the selected session itself changes state (cancelled or
  // restored), so its register or scanner starts again from the server.
  const [revision, setRevision] = useState(0);
  const [placement, setPlacement] = useState<PickerPlacement | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsSlot, setDetailsSlot] = useState<HTMLElement | null>(null);
  const [kioskOpen, setKioskOpen] = useState(false);
  // The club's date the list was read for, and whether that is no longer today.
  const [loadedDay, setLoadedDay] = useState<{ key: string; label: string } | null>(null);
  const [stale, setStale] = useState(false);
  const changeRef = useRef<HTMLButtonElement | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const load = useCallback(async () => {
    setError(false);
    const day = clubDay(timeZone);
    try {
      const res = await fetch("/api/coach/today");
      const data = await res.json().catch(() => null);
      // An error object rendered as an empty list is the defect that once
      // crashed this screen; a non-array is a failure, not "no classes".
      if (!res.ok || !Array.isArray(data)) throw new Error("bad");
      const list = data as TodaySession[];
      setSessions(list);
      // The class already on screen stays, whatever the list now says is "on
      // now": only the first load, or a session that no longer exists, chooses.
      setSelectedId((current) => (current && list.some((s) => s.id === current) ? current : pickDefault(list, preselectClassId)));
      setLoadedDay(day);
      setStale(false);
    } catch {
      setSessions(null);
      setError(true);
      // The picker goes with the list: a failed re-read must not leave it to reopen by itself, or the scanner paused.
      setPlacement(null);
    }
  }, [preselectClassId, timeZone]);

  useEffect(() => {
    void load();
  }, [load]);

  // A tab left open overnight must not mark into yesterday's class. When the
  // page is looked at again, the club's date is worked out again; if the day
  // has moved on, the controls give way to a notice and a Reload. The class is
  // never switched by itself.
  useEffect(() => {
    if (!loadedDay) return;
    const check = () => {
      if (document.visibilityState === "hidden") return;
      if (clubDay(timeZone).key !== loadedDay.key) {
        setStale(true);
        setPlacement(null);
      }
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [loadedDay, timeZone]);

  const onCountChange = useCallback((c: { checkedIn: number; expected: number; capacity: number | null } | null) => setCounts(c), []);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;
  // The server's count rides on the session it chose (worked out on the club's
  // clock, with the pick); the local count is the fallback.
  const serverOnNow = sessions?.find((s) => typeof s.onNowCount === "number")?.onNowCount;
  const onNow = serverOnNow ?? sessions?.filter((s) => !s.isCancelled && s.status === "ongoing").length ?? 0;
  const canCancel = (CAN_CANCEL_SESSION_ROLES as readonly string[]).includes(role);
  const pickerOpen = placement !== null;

  function openPicker() {
    const button = changeRef.current;
    if (!button) return;
    // Focus comes to the button first: that puts the phone's keyboard away
    // before the sheet is placed (the search field may have had it), and it is
    // where focus returns when the picker closes.
    button.focus({ preventScroll: true });
    const r = button.getBoundingClientRect();
    setPlacement(placePicker({ top: r.top, bottom: r.bottom, left: r.left }, { width: window.innerWidth, height: window.innerHeight }));
  }

  function changeMode(m: Mode) {
    if (m === mode) return;
    setMode(m);
    setCounts(null);
  }

  function choose(id: string) {
    setPlacement(null);
    if (id === selectedId) return;
    // One switch: the old class's count goes with it, and the keyed section
    // below is rebuilt for the new id. The method stays as it was.
    setSelectedId(id);
    setCounts(null);
  }

  const mat = selected ? matLabel(selected) : null;
  const showDetails = detailsOpen || !!selected?.isCancelled;

  return (
    <div className="space-y-4">
      <PageHeader title="Mark attendance" />

      {error ? (
        <ErrorState message="Couldn't load today's classes — tap to retry" onRetry={() => void load()} />
      ) : sessions === null ? (
        <p className="text-sm text-tx-3" role="status">Loading today&rsquo;s classes…</p>
      ) : stale && loadedDay ? (
        <div role="alert" className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-5" data-testid="stale-day">
          <p className="text-sm text-tx-1">This list is from {loadedDay.label}. Reload to see today&rsquo;s classes.</p>
          <Button className="mt-3" variant="secondary" onClick={() => void load()}>Reload</Button>
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-5" data-testid="no-classes-today">
          <h2 className="text-sm font-semibold text-tx-1">No classes today</h2>
          <p className="mt-1 text-sm text-tx-3">Add a class on the timetable and it appears here straight away.</p>
        </div>
      ) : (
        <>
          {/* A. The class being marked. */}
          <section aria-label="Selected class" className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4" data-testid="selected-class">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
              <div className="min-w-0 flex-1 basis-56">
                <p className="flex flex-wrap items-center gap-2 text-xs font-medium uppercase tracking-wide text-tx-3">
                  Selected class
                  {selected && <span className="text-tx-2" data-testid="selected-class-label"><Tag>{sessionLabel(selected)}</Tag></span>}
                  {selected?.isMine && <span className="text-tx-2"><Tag>Yours</Tag></span>}
                  {selected?.rosterOnly && <span className="text-tx-2"><Tag>{SQUAD_ONLY_LABEL}</Tag></span>}
                </p>
                {selected ? (
                  <>
                    <h2 className={`mt-1 break-words text-lg font-semibold leading-snug text-tx-1 ${selected.isCancelled ? "line-through" : ""}`} data-testid="selected-class-name">
                      {selected.name}
                    </h2>
                    <p className="mt-0.5 text-sm text-tx-2" data-testid="selected-class-when">
                      {formatTimeRange(selected.startTime, selected.endTime)}
                      {mat ? ` · ${mat}` : ""}
                    </p>
                  </>
                ) : (
                  <>
                    <h2 className="mt-1 text-lg font-semibold leading-snug text-tx-1">No class selected</h2>
                    <p className="mt-0.5 text-sm text-tx-2">Every class today is cancelled.</p>
                  </>
                )}
              </div>
              <div className="flex shrink-0 flex-col items-start gap-1.5 sm:items-end">
                <Button
                  ref={changeRef}
                  variant="secondary"
                  aria-haspopup="dialog"
                  aria-expanded={pickerOpen}
                  onClick={openPicker}
                >
                  Change class
                </Button>
                {onNow > 1 && (
                  <p className="text-[13px] text-tx-2" data-testid="classes-on-now">{onNow} classes on now</p>
                )}
              </div>
            </div>
          </section>

          {selected && (
            <>
              {/* B. Two ways to mark, side by side. Which is active is said by
                  `aria-selected` and shown by the tick, not by colour alone;
                  the other stays an ordinary, available button. */}
              <div role="tablist" aria-label="How to mark attendance" className="grid grid-cols-2 gap-2">
                {METHODS.map(({ mode: m, label, Icon }) => {
                  const active = mode === m;
                  return (
                    <Button
                      key={m}
                      role="tab"
                      aria-selected={active}
                      variant={active ? "primary" : "secondary"}
                      className="min-h-12 text-[15px]"
                      // Changing method writes nothing: it only swaps the section below
                      // (and clears the count, which the register gives again when it is back).
                      onClick={() => changeMode(m)}
                    >
                      <Icon className="size-4" aria-hidden="true" />
                      {label}
                      {active && <Check className="size-4" aria-hidden="true" />}
                    </Button>
                  );
                })}
              </div>

              {/* Keyed on the session id (and its revision): another class is
                  another component, so nothing of the last one survives into it. */}
              {mode === "tick" ? (
                <div className="space-y-3">
                  <RegisterPanel
                    key={`${selected.id}-${revision}`}
                    instance={selected}
                    primaryColor={primaryColor}
                    onCountChange={onCountChange}
                    detailsSlot={detailsSlot}
                  />
                  <p className="text-sm text-tx-3" aria-live="polite" data-testid="checked-in-count">
                    {counts
                      ? `${counts.checkedIn} checked in${counts.expected ? ` of ${counts.expected} expected` : ""}${counts.capacity ? ` · capacity ${counts.capacity}${counts.checkedIn > counts.capacity ? " (over)" : ""}` : ""}`
                      : ""}
                  </p>
                </div>
              ) : (
                <CardScanner
                  key={`${selected.id}-${revision}`}
                  instance={selected}
                  paused={pickerOpen}
                  onUseName={() => changeMode("tick")}
                />
              )}

              {/* C. Everything that is not routine check-in. */}
              <section className="rounded-[var(--r-md)] border border-bd-default bg-sf-1" data-testid="session-details">
                <h2>
                  {selected.isCancelled ? (
                    // A cancelled session's details (and its Restore) stay open: no toggle that would do nothing.
                    <span className="flex min-h-12 items-center px-4 py-3 text-sm font-medium text-tx-1">Session details</span>
                  ) : (
                    <Button
                      variant="ghost"
                      aria-expanded={showDetails}
                      aria-controls="session-details-panel"
                      onClick={() => setDetailsOpen((o) => !o)}
                      className="h-auto min-h-12 w-full justify-between px-4 py-3 text-left text-tx-1"
                    >
                      Session details
                      <span aria-hidden="true" className="font-normal text-tx-3">{showDetails ? "Hide" : "Show"}</span>
                    </Button>
                  )}
                </h2>
                {/* Mounted while closed, so the register can place its lines in it. */}
                <div id="session-details-panel" hidden={!showDetails} className="space-y-3 border-t border-bd-default px-4 py-3">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-tx-3">Coach</dt>
                    <dd className="break-words text-tx-1">{selected.coachName?.trim() || "No coach assigned"}</dd>
                    {selected.maxCapacity ? (
                      <>
                        <dt className="text-tx-3">Capacity</dt>
                        <dd className="text-tx-1">{selected.maxCapacity}</dd>
                      </>
                    ) : null}
                  </dl>
                  <div ref={setDetailsSlot} className="space-y-2" />
                  {canCancel && (
                    // Owner and manager only, the roles the route admits; kept
                    // apart from routine check-in, behind its own confirmation.
                    <div className="border-t border-bd-default pt-3">
                      <SessionCancelControl
                        key={selected.id}
                        session={selected}
                        onChanged={async () => {
                          const changedId = selected.id;
                          await load();
                          // Only the session the change was made to starts again; if the coach has
                          // moved to another class meanwhile, that one is left as it is.
                          if (selectedIdRef.current !== changedId) return;
                          setCounts(null);
                          setRevision((n) => n + 1);
                        }}
                      />
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          <ClassPicker
            placement={placement}
            sessions={sessions}
            selectedId={selectedId}
            dateLabel={loadedDay?.label ?? ""}
            onSelect={choose}
            onClose={() => setPlacement(null)}
          />
        </>
      )}

      {/* The kiosk is members checking themselves in, not a third way for a
          coach to mark a class: last on the page, behind its own action. Who
          may manage it is KioskPanel's rule (the owner), unchanged. */}
      <section className="space-y-3 pt-2" aria-labelledby="kiosk-heading" data-testid="kiosk-section">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 id="kiosk-heading" className="text-sm font-semibold text-tx-1">Self-service kiosk</h2>
            <p className="text-sm text-tx-3">Let members check themselves in</p>
          </div>
          {role === "owner" && (
            <Button variant="secondary" aria-expanded={kioskOpen} aria-controls="kiosk-panel" onClick={() => setKioskOpen((o) => !o)}>
              {kioskOpen ? "Hide kiosk" : "Open kiosk"}
            </Button>
          )}
        </div>
        {/* A member of staff who is not the owner sees the kiosk's state and no
            control, as before. */}
        {(role !== "owner" || kioskOpen) && (
          <div id="kiosk-panel">
            <KioskPanel primaryColor={primaryColor} role={role} variant="compact" />
          </div>
        )}
      </section>
    </div>
  );
}

/** The club's date now, as a key to compare and as the label the picker shows. */
function clubDay(timeZone: string): { key: string; label: string } {
  const now = new Date();
  return {
    key: new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(now),
    label: new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone }).format(now),
  };
}
