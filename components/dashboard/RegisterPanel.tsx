"use client";

// The "Tick names" section of Mark Attendance: the register for one session.
//
// Built from the two screens it replaces (18 Sep 2026). The list is the
// register route's roster — everyone booked on the class plus everyone with a
// check-in for this session, walk-ins tagged — as Today's Register showed it.
// The "Add someone" search over every active member, with its unique-match
// auto-mark, is what the old Mark Attendance offered. Both write through the
// same engine: POST /api/checkin to mark, DELETE /api/checkin to un-mark
// (which restores a redeemed pack credit and writes an audit row).
//
// WIRED, NOT COSMETIC: after every write the register is RELOADED from the
// server. A row's tick is the database's answer, never a local guess — so a
// write that did not land cannot be shown as one that did, and a walk-in who
// is un-ticked disappears because the server no longer lists them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, AlertTriangle, CalendarCheck, Check, Heart, Loader2, Search, ShieldAlert, ShieldCheck,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/Toast";
import { describeApiError } from "@/lib/api-field-errors";
import type { TodaySession } from "@/components/dashboard/SessionPicker";

type RegisterMember = {
  memberId: string;
  name: string;
  accountType: string;
  waiverAccepted: boolean;
  rank: { name: string; color: string | null; discipline: string; stripes: number } | null;
  attended: boolean;
  attendedMethod: string | null;
  /** On the register because they have a check-in, not a booking. */
  walkIn?: boolean;
  lastVisitAt: string | null;
  medicalConditions: string | null;
};

type RegisterResponse = {
  expected: RegisterMember[];
  waitlist: { memberId: string; name: string; position: number; status: string }[];
};

type Candidate = { id: string; name: string };

/** Token-safe tint (UI-RULES §2). */
function tint(color: string, percent: number) {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
}

function relativeDate(iso: string | null) {
  if (!iso) return "Never";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const METHOD_LABEL: Record<string, string> = { admin: "Admin", qr: "QR", kiosk: "Kiosk", self: "Self", auto: "Auto" };

export default function RegisterPanel({
  instance,
  primaryColor,
  onCountChange,
}: {
  instance: TodaySession;
  primaryColor: string;
  onCountChange: (checkedIn: number, expected: number) => void;
}) {
  const [register, setRegister] = useState<RegisterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [candidatesError, setCandidatesError] = useState(false);
  const [query, setQuery] = useState("");
  const [autoPendingId, setAutoPendingId] = useState<string | null>(null);
  const { toast: showToast } = useToast();
  const { ask, dialogProps } = useConfirmDialog();
  const searchRef = useRef<HTMLInputElement>(null);

  const loadRegister = useCallback(async () => {
    try {
      const res = await fetch(`/api/coach/instances/${instance.id}/register`);
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !Array.isArray(data.expected)) {
        setError(describeApiError(data));
        setRegister(null);
        return;
      }
      setRegister(data as RegisterResponse);
    } catch {
      setError("Couldn't load the register — check your signal and try again.");
      setRegister(null);
    } finally {
      setLoading(false);
    }
  }, [instance.id]);

  const loadCandidates = useCallback(async () => {
    setCandidatesError(false);
    try {
      // The route is cursor-paginated ({ members, nextCursor }); follow the
      // cursor so a club past one page can still find everyone. Bounded so a
      // pathological tenant cannot spin here forever.
      const MAX_PAGES = 6; // 6 × 500 = 3,000 members
      const collected: Candidate[] = [];
      let cursor: string | null = null;
      for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
        const res: Response = await fetch(
          `/api/checkin/members?instanceId=${instance.id}&take=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        );
        const data: unknown = await res.json().catch(() => null);
        const list = Array.isArray(data)
          ? data
          : data && typeof data === "object" && Array.isArray((data as { members?: unknown }).members)
            ? (data as { members: unknown[] }).members
            : null;
        if (!res.ok || !list) throw new Error("bad");
        collected.push(...(list as Array<{ id: string; name: string }>).map((m) => ({ id: m.id, name: m.name })));
        const next = data && typeof data === "object" ? (data as { nextCursor?: unknown }).nextCursor : null;
        cursor = typeof next === "string" && next ? next : null;
        if (!cursor) break;
      }
      setCandidates(collected);
    } catch {
      setCandidates(null);
      setCandidatesError(true);
    }
  }, [instance.id]);

  useEffect(() => {
    void loadRegister();
    void loadCandidates();
  }, [loadRegister, loadCandidates]);

  const attended = useMemo(() => register?.expected.filter((m) => m.attended) ?? [], [register]);
  const attendedIds = useMemo(() => new Set(attended.map((m) => m.memberId)), [attended]);

  useEffect(() => {
    if (register) onCountChange(attended.length, register.expected.length);
  }, [register, attended.length, onCountChange]);

  // When nobody is booked, the search IS the register: focus it so the coach
  // can type a name at once.
  useEffect(() => {
    if (register && register.expected.length === 0) searchRef.current?.focus();
  }, [register]);

  async function mark(memberId: string) {
    setMarking(memberId);
    setError(null);
    try {
      const res = await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classInstanceId: instance.id, memberId, checkInMethod: "admin" }),
      });
      // 409 "Already checked in" is the truth, not a failure: the reload shows it.
      if (!res.ok && res.status !== 409) {
        const body = await res.json().catch(() => null);
        setError(describeApiError(body));
        return;
      }
      await loadRegister();
    } catch {
      setError("Couldn't reach MatFlow — check your signal and try again.");
    } finally {
      setMarking(null);
    }
  }

  async function unmark(memberId: string, name: string) {
    // The name goes in the BODY, which wraps. In the title it did not: a long
    // name made the sheet wider than a 390 px phone and the confirm button sat
    // off-screen — found by attendance-hub.spec.ts case 3 on 18 Sep 2026.
    const confirmed = await ask({
      title: "Remove this check-in?",
      body: `${name} will no longer be marked as attending this session. A class-pack credit they used is given back.`,
      confirmLabel: "Remove check-in",
      destructive: true,
    });
    if (!confirmed) return;
    setMarking(memberId);
    setError(null);
    try {
      const res = await fetch(`/api/checkin?classInstanceId=${instance.id}&memberId=${memberId}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(describeApiError(body));
        return;
      }
      await loadRegister();
    } catch {
      setError("Couldn't reach MatFlow — check your signal and try again.");
    } finally {
      setMarking(null);
    }
  }

  const searchable = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !candidates) return [];
    return candidates.filter((m) => !attendedIds.has(m.id) && m.name.toLowerCase().includes(q)).slice(0, 12);
  }, [query, candidates, attendedIds]);

  // Unique-match auto-mark, carried over from the old Mark Attendance: when the
  // query uniquely names one not-yet-marked member, mark them after 600 ms —
  // a window to keep typing if someone else was meant. The dashed outline on
  // the candidate signals the pending action; backspace cancels it.
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || !candidates) {
      setAutoPendingId(null);
      return;
    }
    const matches = candidates.filter((m) => !attendedIds.has(m.id) && m.name.toLowerCase().includes(q));
    if (matches.length !== 1) {
      setAutoPendingId(null);
      return;
    }
    const winner = matches[0];
    setAutoPendingId(winner.id);
    const t = setTimeout(() => {
      setAutoPendingId(null);
      void (async () => {
        await mark(winner.id);
        setQuery("");
        showToast(`Marked in: ${winner.name}`, "success");
      })();
    }, 600);
    return () => clearTimeout(t);
    // mark/showToast are stable enough; re-running on candidate/attended
    // changes is intentional so freshness is honoured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, candidates, attendedIds]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-tx-3">
        <Loader2 className="size-4 animate-spin" /> Loading the register…
      </div>
    );
  }

  const expected = register?.expected ?? [];

  return (
    <div className="space-y-3">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-[var(--r-md)] border px-3 py-2"
          style={{ borderColor: tint("var(--hue-danger)", 25), background: tint("var(--hue-danger)", 6), color: "var(--hue-danger)" }}
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <p className="text-xs">{error}</p>
        </div>
      )}

      {register && expected.length === 0 ? (
        <Card padding="none">
          <p className="p-5 text-center text-sm text-tx-3">
            No bookings for this session — search a name below to mark them in.
          </p>
        </Card>
      ) : (
        <ul className="space-y-2" aria-label="Register">
          {expected.map((m) => {
            const busy = marking === m.memberId;
            return (
              <li
                key={m.memberId}
                className="flex min-h-14 items-center gap-3 rounded-[var(--r-md)] border p-3"
                style={{
                  background: m.attended ? tint("var(--hue-success)", 8) : "var(--sf-1)",
                  borderColor: m.attended ? tint("var(--hue-success)", 30) : "var(--bd-default)",
                }}
              >
                <button
                  onClick={() => (m.attended ? void unmark(m.memberId, m.name) : void mark(m.memberId))}
                  disabled={busy}
                  className="ui-fixed-size flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--r-md)] border transition-colors disabled:opacity-50"
                  style={{
                    background: m.attended ? "var(--hue-success)" : "transparent",
                    borderColor: m.attended ? "var(--hue-success)" : "var(--bd-default)",
                    color: "var(--tx-on-accent)",
                  }}
                  aria-label={m.attended ? `Mark ${m.name} absent` : `Mark ${m.name} attended`}
                  aria-pressed={m.attended}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" style={{ color: m.attended ? "var(--tx-on-accent)" : "var(--tx-3)" }} />
                  ) : m.attended ? (
                    <Check className="size-5" />
                  ) : null}
                </button>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-tx-1">{m.name}</p>
                    {m.rank && (
                      <span
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold"
                        style={{ background: m.rank.color ? tint(m.rank.color, 15) : "var(--sf-2)", color: m.rank.color ?? "var(--tx-2)" }}
                      >
                        {m.rank.name}{m.rank.stripes > 0 ? ` ·${m.rank.stripes}` : ""}
                      </span>
                    )}
                    {m.accountType !== "adult" && (
                      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: tint("var(--hue-info)", 12), color: "var(--hue-info)" }}>
                        {m.accountType.toUpperCase()}
                      </span>
                    )}
                    {m.walkIn && (
                      // Not booked, but here: scanned in, marked from the search,
                      // or added this morning. Told apart from a no-show by this
                      // tag, not by their absence.
                      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-bold" style={{ background: "var(--sf-2)", color: "var(--tx-2)" }}>
                        WALK-IN
                      </span>
                    )}
                    {m.attended && m.attendedMethod && (
                      <span className="text-[10px] font-medium text-tx-3">{METHOD_LABEL[m.attendedMethod] ?? m.attendedMethod}</span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-tx-3">
                    <span className="flex items-center gap-1">
                      {m.waiverAccepted
                        ? <><ShieldCheck className="size-3" style={{ color: "var(--hue-success)" }} /> Waiver</>
                        : <><ShieldAlert className="size-3" style={{ color: "var(--hue-warning)" }} /> No waiver</>}
                    </span>
                    <span className="flex items-center gap-1">
                      <CalendarCheck className="size-3" /> Last seen {relativeDate(m.lastVisitAt)}
                    </span>
                    {m.medicalConditions && (
                      <span className="flex items-center gap-1" style={{ color: "var(--hue-danger)" }}>
                        <Heart className="size-3" /> Medical
                      </span>
                    )}
                  </div>
                  {m.medicalConditions && (
                    <p className="mt-1 text-[11px] italic" style={{ color: "var(--hue-danger)" }}>
                      <AlertTriangle className="mr-1 inline size-3" />
                      {m.medicalConditions}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Add someone who is not booked. */}
      <div className="space-y-2 pt-1">
        <label htmlFor="register-search" className="block text-sm font-medium text-tx-2">
          Add someone
        </label>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-tx-3" />
          <input
            id="register-search"
            ref={searchRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search members..."
            aria-label="Search members"
            autoComplete="off"
            className="w-full rounded-xl border py-2.5 pl-9 pr-3 text-sm transition-colors focus:outline-none"
            style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
          />
        </div>
        {candidatesError && (
          <p role="alert" className="text-xs" style={{ color: "var(--hue-danger)" }}>
            Couldn&rsquo;t load the member list — the register above still works.{" "}
            <button type="button" className="underline" onClick={() => void loadCandidates()}>Try again</button>
          </p>
        )}
        {query.trim() && candidates && (
          <ul className="space-y-1" aria-label="Members matching your search">
            {searchable.length === 0 && (
              <li className="px-1 py-2 text-sm text-tx-3">No one matches — check the spelling.</li>
            )}
            {searchable.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  onClick={() => void mark(m.id)}
                  disabled={marking === m.id}
                  className="flex min-h-11 w-full items-center justify-between gap-3 rounded-[var(--r-md)] border px-3 py-2 text-left text-sm transition-colors hover:bg-sf-2 disabled:opacity-50"
                  style={{
                    borderColor: "var(--bd-default)",
                    background: "var(--sf-1)",
                    outline: autoPendingId === m.id ? `2px dashed ${primaryColor}` : undefined,
                    outlineOffset: autoPendingId === m.id ? 2 : undefined,
                  }}
                >
                  <span className="truncate text-tx-1">{m.name}</span>
                  <span className="shrink-0 text-xs text-tx-3">{marking === m.id ? "Marking…" : "Mark in"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {register && register.waitlist.length > 0 && (
        <Card padding="tight" style={{ background: tint("var(--hue-warning)", 6), borderColor: tint("var(--hue-warning)", 25) }}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--hue-warning)" }}>
            Waitlist ({register.waitlist.length})
          </p>
          <ul className="space-y-1">
            {register.waitlist.map((w) => (
              <li key={w.memberId} className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0 truncate text-tx-2">{w.position}. {w.name}</span>
                <span className="shrink-0 text-[11px] text-tx-3">{w.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ConfirmDialog {...dialogProps} />
    </div>
  );
}
