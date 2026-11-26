"use client";

// Class cover — session cover, staff side (Noe, 26 Nov 2026).
//
// One dated session at a time: the owner or a manager asks for cover (or assigns a coach straight away), a class's
// own linked coach asks for cover on their own session, and any member of staff takes an open request with
// "I'll cover this class". The first valid claim wins and nobody is put on two sessions at once; the server decides
// both (POST /api/coach/instances/[id]/cover). The weekly class, bookings, attendance and class times never change
// here, and nothing is sent by email, push or SMS.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { formatTimeRange } from "@/lib/class-time";
import type { CoverSessionView } from "@/lib/session-coach";

type StaffOption = { id: string; name: string; role: string };
type Board = {
  today: string;
  from: string;
  days: number;
  me: { id: string; role: string };
  sessions: CoverSessionView[];
  openRequests: CoverSessionView[];
  mine: CoverSessionView[];
  staff: StaffOption[];
};

type DialogKind = "request" | "claim" | "assign" | "replace" | "give_up" | "withdraw" | "return" | "reconfirm";
type Pending = { kind: DialogKind; session: CoverSessionView };

/** "19:00–20:30, Mat 2" */
const whenWhere = (s: CoverSessionView) => `${formatTimeRange(s.startTime, s.endTime)}${s.place ? `, ${s.place}` : ""}`;
/** "Thursday 3 December, 19:00–20:30, Mat 2" */
const fullLabel = (s: CoverSessionView) => `${s.dayLabel}, ${whenWhere(s)}`;

const ROLE_LABEL: Record<string, string> = { owner: "owner", manager: "manager", coach: "coach", admin: "admin" };

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEKS_AHEAD = 7; // sessions exist eight weeks ahead (lib/class-instances.ts ROLLING_WINDOW_DAYS)

export default function CoverBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [week, setWeek] = useState(0);
  const [pending, setPending] = useState<Pending | null>(null);
  const [coachId, setCoachId] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  // The last answer about a session, shown beside it: what happened, or why it did not.
  const [notes, setNotes] = useState<Record<string, { tone: "ok" | "error"; text: string; session: CoverSessionView }>>({});

  const load = useCallback(async (offset: number, anchor?: string) => {
    setLoadError(false);
    try {
      const from = anchor ? addDays(anchor, offset * 7) : null;
      const res = await fetch(`/api/coach/cover?days=7${from ? `&from=${from}` : ""}`, { cache: "no-store" });
      const data = (await res.json().catch(() => null)) as Board | null;
      if (!res.ok || !data || !Array.isArray(data.sessions)) throw new Error("bad");
      setBoard(data);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load(0);
  }, [load]);

  const today = board?.today;
  const goWeek = (n: number) => {
    setWeek(n);
    void load(n, today);
  };

  function open(kind: DialogKind, session: CoverSessionView) {
    setDialogError(null);
    setCoachId("");
    setPending({ kind, session });
  }

  async function submit() {
    if (!pending) return;
    const { kind, session } = pending;
    const body = kind === "assign" || kind === "replace" ? { action: kind, coachUserId: coachId } : { action: kind };
    let res: Response;
    try {
      res = await fetch(`/api/coach/instances/${session.id}/cover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      // Nothing reached the server: the dialog stays open with what was chosen, ready to try again.
      setDialogError("Couldn't save — check your connection and try again.");
      return;
    }
    const data = (await res.json().catch(() => null)) as { error?: string; code?: string; cover?: { coverUserName: string | null } | null } | null;
    if (res.status >= 500 || !data) {
      setDialogError("Couldn't save — try again.");
      return;
    }
    setPending(null);
    if (!res.ok) {
      // A refusal is the club's state, not a fault: said beside the session, and the board read again.
      setNotes((n) => ({ ...n, [session.id]: { tone: "error", text: data.error ?? "That couldn't be saved.", session } }));
    } else {
      setNotes((n) => ({ ...n, [session.id]: { tone: "ok", text: SUCCESS[kind](data.cover?.coverUserName ?? null), session } }));
    }
    await load(week, today);
  }

  if (loadError && !board) {
    return (
      <div>
        <PageHeader title="Class cover" />
        <ErrorState message="Couldn't load class cover — tap to retry" onRetry={() => void load(week, today)} />
      </div>
    );
  }
  if (!board) {
    return (
      <div>
        <PageHeader title="Class cover" />
        <p className="text-sm text-tx-3" role="status">Loading class cover…</p>
      </div>
    );
  }

  const om = board.me.role === "owner" || board.me.role === "manager";
  const byDay = new Map<string, CoverSessionView[]>();
  for (const s of board.sessions) byDay.set(s.dayKey, [...(byDay.get(s.dayKey) ?? []), s]);
  const lastDay = addDays(board.from, board.days - 1);
  // An answer about a session that is no longer on screen (taken by someone else, or now in another week) is still
  // said, at the top of Needs cover, naming the session.
  const onScreen = new Set([...board.openRequests, ...board.mine, ...board.sessions].map((s) => s.id));
  const offScreen = Object.entries(notes).filter(([id]) => !onScreen.has(id));
  const rangeLabel = `${shortDay(board.from)} – ${shortDay(lastDay)}`;

  return (
    <div className="space-y-6" data-testid="cover-board">
      <PageHeader
        title="Class cover"
        description={om ? "Ask for cover on one dated session, or choose who covers it." : "Classes that need a coach, and the ones you cover."}
      />

      {loadError ? (
        <ErrorState message="Couldn't refresh class cover — tap to retry" onRetry={() => void load(week, today)} />
      ) : null}

      <section aria-labelledby="cover-open-heading" className="space-y-3" data-testid="cover-open">
        <h2 id="cover-open-heading" className="text-sm font-semibold text-tx-1">Needs cover</h2>
        {offScreen.map(([id, n]) => (
          <div key={id} data-session-id={id} className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4">
            <p className="text-sm font-medium text-tx-1">{n.session.className} · {fullLabel(n.session)}</p>
            <Note note={n} />
          </div>
        ))}
        {board.openRequests.length === 0 ? (
          <p className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4 text-sm text-tx-3">
            No class needs cover. When someone asks for cover on a session, it appears here for every coach.
          </p>
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {board.openRequests.map((s) => (
              <li key={s.id}>
                <SessionCard session={s} meId={board.me.id} note={notes[s.id]} onAction={open} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {board.mine.length > 0 ? (
        <section aria-labelledby="cover-mine-heading" className="space-y-3" data-testid="cover-mine">
          <h2 id="cover-mine-heading" className="text-sm font-semibold text-tx-1">You&rsquo;re covering</h2>
          <ul className="grid gap-3 lg:grid-cols-2">
            {board.mine.map((s) => (
              <li key={s.id}>
                <SessionCard session={s} meId={board.me.id} note={notes[s.id]} onAction={open} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="cover-week-heading" className="space-y-3" data-testid="cover-week">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="cover-week-heading" className="text-sm font-semibold text-tx-1">
            Sessions <span className="font-normal text-tx-3">· {rangeLabel}</span>
          </h2>
          <div className="flex gap-2">
            <Button variant="secondary" size="compact" disabled={week === 0} onClick={() => goWeek(week - 1)}>
              Earlier
            </Button>
            <Button variant="secondary" size="compact" disabled={week >= WEEKS_AHEAD} onClick={() => goWeek(week + 1)}>
              Later
            </Button>
          </div>
        </div>
        {board.sessions.length === 0 ? (
          <p className="rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4 text-sm text-tx-3">
            No sessions on these days. Classes on the timetable appear here with their dates.
          </p>
        ) : (
          [...byDay.entries()].map(([day, list]) => (
            <div key={day} className="rounded-[var(--r-md)] border border-bd-default bg-sf-1" data-day={day}>
              <h3 className="border-b border-bd-default px-4 py-2 text-[13px] font-semibold text-tx-2">{list[0].dayLabel}</h3>
              <ul className="divide-y divide-[var(--bd-default)]">
                {list.map((s) => (
                  <li key={s.id} className="px-4 py-3" data-session-id={s.id}>
                    <SessionRow session={s} meId={board.me.id} note={notes[s.id]} onAction={open} />
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>

      <CoverDialog
        pending={pending}
        staff={board.staff}
        coachId={coachId}
        setCoachId={setCoachId}
        error={dialogError}
        onClose={() => setPending(null)}
        onConfirm={submit}
      />
    </div>
  );
}

const SUCCESS: Record<DialogKind, (coach: string | null) => string> = {
  request: () => "Cover requested. Coaches can see it under Needs cover.",
  claim: () => "You're covering this class.",
  assign: (c) => `Covered by ${c ?? "the coach you chose"}.`,
  replace: (c) => `Covered by ${c ?? "the coach you chose"}.`,
  give_up: () => "You gave up this cover. The request is open again and the owner can see it.",
  withdraw: () => "Cover request withdrawn.",
  return: () => "Back to its regular coach.",
  reconfirm: () => "Reconfirmed. You're covering this class at its new time.",
};

function shortDay(key: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${key}T12:00:00Z`));
}

/** What the session's coach state reads, never by colour alone. */
function StateLine({ s, meId }: { s: CoverSessionView; meId: string }) {
  if (s.state === "covered") {
    return (
      <p className="text-[13px] text-tx-1" data-testid="cover-state">
        {s.coverUserId === meId ? "You're covering this class" : `Covered by ${s.coverUserName ?? "a former staff member"}`}
        {s.needsReconfirm ? <span className="ml-2 font-medium text-[var(--hue-warning-ink)]">Awaiting reconfirmation</span> : null}
      </p>
    );
  }
  if (s.state === "cover_needed") {
    return (
      <p className="text-[13px] text-tx-1" data-testid="cover-state">
        <span className="font-medium">Cover needed</span>
        {s.regularCoachName ? <span className="text-tx-3"> · {s.regularCoachName} away</span> : null}
      </p>
    );
  }
  return (
    <p className="text-[13px] text-tx-3" data-testid="cover-state">
      {s.isCancelled ? "Cancelled" : s.regularCoachName ?? "No coach assigned"}
    </p>
  );
}

function Actions({ s, onAction }: { s: CoverSessionView; onAction: (k: DialogKind, s: CoverSessionView) => void }) {
  const items: Array<[DialogKind, string, boolean, "primary" | "secondary"]> = [
    ["claim", "I'll cover this class", s.can.claim, "primary"],
    ["reconfirm", "Reconfirm", s.can.reconfirm, "primary"],
    ["request", "Request cover", s.can.request, "secondary"],
    ["assign", "Assign", s.can.assign, "secondary"],
    ["replace", "Replace", s.can.replace, "secondary"],
    ["return", "Return to regular coach", s.can.returnToRegular, "secondary"],
    ["withdraw", "Withdraw request", s.can.withdraw, "secondary"],
    ["give_up", "Give up cover", s.can.giveUp, "secondary"],
  ];
  const shown = items.filter(([, , ok]) => ok);
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {shown.map(([kind, label, , variant]) => (
        <Button key={kind} variant={variant} onClick={() => onAction(kind, s)} data-cover-action={kind}>
          {label}
        </Button>
      ))}
    </div>
  );
}

function Note({ note }: { note?: { tone: "ok" | "error"; text: string } }) {
  if (!note) return null;
  return (
    <p
      role={note.tone === "error" ? "alert" : "status"}
      className={note.tone === "error" ? "text-[13px] text-[var(--hue-danger-ink)]" : "text-[13px] text-[var(--hue-success-ink)]"}
      data-testid="cover-note"
    >
      {note.text}
    </p>
  );
}

function SessionCard({ session: s, meId, note, onAction }: { session: CoverSessionView; meId: string; note?: { tone: "ok" | "error"; text: string }; onAction: (k: DialogKind, s: CoverSessionView) => void }) {
  return (
    <article className="space-y-2 rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4" data-session-id={s.id} aria-label={`${s.className}, ${fullLabel(s)}`}>
      <h3 className="break-words text-[15px] font-semibold text-tx-1">{s.className}</h3>
      <p className="text-sm text-tx-2">
        {s.dayLabel}
        <br />
        {whenWhere(s)}
      </p>
      <StateLine s={s} meId={meId} />
      <Actions s={s} onAction={onAction} />
      <Note note={note} />
    </article>
  );
}

function SessionRow({ session: s, meId, note, onAction }: { session: CoverSessionView; meId: string; note?: { tone: "ok" | "error"; text: string }; onAction: (k: DialogKind, s: CoverSessionView) => void }) {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <p className={`break-words text-sm font-medium text-tx-1 ${s.isCancelled ? "line-through" : ""}`}>
          <span className="tabular-nums">{formatTimeRange(s.startTime, s.endTime)}</span> · {s.className}
          {s.place ? <span className="font-normal text-tx-3"> · {s.place}</span> : null}
        </p>
        <StateLine s={s} meId={meId} />
        <Note note={note} />
      </div>
      <Actions s={s} onAction={onAction} />
    </div>
  );
}

function CoverDialog({
  pending,
  staff,
  coachId,
  setCoachId,
  error,
  onClose,
  onConfirm,
}: {
  pending: Pending | null;
  staff: StaffOption[];
  coachId: string;
  setCoachId: (id: string) => void;
  error: string | null;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const s = pending?.session;
  const kind = pending?.kind;
  const copy = s && kind ? dialogCopy(kind, s) : { title: "", description: "", confirm: "Confirm", destructive: false };
  const choosing = kind === "assign" || kind === "replace";
  const choices = staff.filter((u) => u.id !== s?.coverUserId);
  return (
    <ConfirmDialog
      open={!!pending}
      onClose={onClose}
      onConfirm={onConfirm}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirm}
      destructive={copy.destructive}
      confirmDisabled={choosing && !coachId}
    >
      {choosing ? (
        <div className="mt-4 space-y-1.5">
          <label htmlFor="cover-coach" className="block text-[13px] font-medium text-tx-2">
            Coach
          </label>
          <Select id="cover-coach" aria-label="Coach" className="w-full" value={coachId} onChange={(e) => setCoachId(e.target.value)}>
            <option value="">Choose a member of staff</option>
            {choices.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({ROLE_LABEL[u.role] ?? u.role})
              </option>
            ))}
          </Select>
          <p className="text-[12px] text-tx-3">Anyone on the club&rsquo;s staff can cover. Someone already teaching at this time is refused.</p>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-[var(--hue-danger-ink)]" data-testid="cover-dialog-error">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

function dialogCopy(kind: DialogKind, s: CoverSessionView): { title: string; description: string; confirm: string; destructive: boolean } {
  const label = fullLabel(s);
  switch (kind) {
    case "request":
      return {
        title: `Request cover for ${label}?`,
        description: `This ${s.weekday} only. ${s.className} keeps ${s.regularCoachName ? `${s.regularCoachName} as its coach` : "its regular coach"} every other week.`,
        confirm: "Request cover",
        destructive: false,
      };
    case "claim":
      return {
        title: `Cover ${s.className} on ${label}?`,
        description: "You'll be this session's coach straight away. Only this date changes.",
        confirm: "I'll cover this class",
        destructive: false,
      };
    case "assign":
      return { title: `Assign a coach for ${s.className}`, description: `${label}. This ${s.weekday} only.`, confirm: "Assign", destructive: false };
    case "replace":
      return {
        title: `Replace ${s.coverUserName ?? "the covering coach"}`,
        description: `${s.className}, ${label}. ${s.coverUserName ?? "The covering coach"} will no longer cover it.`,
        confirm: "Replace",
        destructive: false,
      };
    case "give_up":
      return {
        title: "Give up cover?",
        description: `This reopens the request for ${s.className} on ${label}. The owner and managers will see that it needs cover again.`,
        confirm: "Give up cover",
        destructive: true,
      };
    case "withdraw":
      return {
        title: "Withdraw the cover request?",
        description: `${s.className} on ${label} will show ${s.regularCoachName ?? "no coach"} again${s.coverUserName ? `, and ${s.coverUserName} will no longer cover it` : ""}.`,
        confirm: "Withdraw request",
        destructive: true,
      };
    case "return":
      return {
        title: `Return to ${s.regularCoachName ?? "the regular coach"}?`,
        description: `${s.className} on ${label} goes back to its regular coach${s.coverUserName ? `, and ${s.coverUserName} will no longer cover it` : ""}.`,
        confirm: "Return to regular coach",
        destructive: false,
      };
    case "reconfirm":
      return {
        title: `Reconfirm ${s.className}?`,
        description: `The session's time changed after you took it. It is now ${label}. Until you reconfirm, it shows as awaiting reconfirmation.`,
        confirm: "Reconfirm",
        destructive: false,
      };
  }
}
