"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft, Users, Clock, MapPin, ShieldCheck, ShieldAlert, Loader2, Check,
  CalendarCheck, AlertCircle, Heart, AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";

type CoachClass = {
  id: string;
  classId: string;
  name: string;
  coachName: string | null;
  location: string | null;
  color: string | null;
  startTime: string;
  endTime: string;
  maxCapacity: number | null;
  attendedCount: number;
  waitlistCount: number;
};

type RegisterMember = {
  memberId: string;
  name: string;
  email: string;
  status: string;
  accountType: string;
  membershipType: string | null;
  waiverAccepted: boolean;
  rank: { name: string; color: string | null; discipline: string; stripes: number } | null;
  attended: boolean;
  attendedAt: string | null;
  attendedMethod: string | null;
  lastVisitAt: string | null;
  medicalConditions: string | null;
};

type RegisterResponse = {
  instance: {
    id: string;
    name: string;
    location: string | null;
    coachName: string | null;
    color: string | null;
    maxCapacity: number | null;
    date: string;
    startTime: string;
    endTime: string;
  };
  expected: RegisterMember[];
  waitlist: { memberId: string; name: string; position: number; status: string }[];
  showMedical: boolean;
};

/**
 * Token-safe tint (UI-RULES §2). `color-mix` accepts the `--hue-*` CSS vars as
 * well as the runtime tenant/rank hexes, so one helper covers both and no
 * inline alpha-maths copy is needed.
 */
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

export default function CoachRegister({ primaryColor }: { primaryColor: string }) {
  const [classes, setClasses] = useState<CoachClass[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [register, setRegister] = useState<RegisterResponse | null>(null);
  const [loadingClasses, setLoadingClasses] = useState(true);
  const [loadingRegister, setLoadingRegister] = useState(false);
  const [marking, setMarking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadClasses() {
    setLoadingClasses(true);
    try {
      const res = await fetch("/api/coach/today");
      const data = await res.json();
      setClasses(Array.isArray(data) ? data : []);
    } catch {
      setClasses([]);
    } finally {
      setLoadingClasses(false);
    }
  }

  async function loadRegister(instanceId: string) {
    setLoadingRegister(true);
    setError(null);
    try {
      const res = await fetch(`/api/coach/instances/${instanceId}/register`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't load register");
        setRegister(null);
      } else {
        setRegister(data);
      }
    } finally {
      setLoadingRegister(false);
    }
  }

  async function toggleAttendance(memberId: string, currentlyAttended: boolean) {
    if (!selectedId) return;
    setMarking(memberId);
    setError(null);
    try {
      const res = await fetch(`/api/coach/instances/${selectedId}/attendance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memberId, attended: !currentlyAttended }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? "Failed to update");
      } else {
        setRegister((prev) => prev ? {
          ...prev,
          expected: prev.expected.map((m) =>
            m.memberId === memberId
              ? { ...m, attended: !currentlyAttended, attendedAt: !currentlyAttended ? new Date().toISOString() : null, attendedMethod: !currentlyAttended ? "admin" : null }
              : m
          ),
        } : prev);
      }
    } finally {
      setMarking(null);
    }
  }

  useEffect(() => { loadClasses(); }, []);
  useEffect(() => { if (selectedId) loadRegister(selectedId); else setRegister(null); }, [selectedId]);

  // Register view
  if (selectedId && register) {
    const cls = register.instance;
    const attended = register.expected.filter((m) => m.attended).length;
    const hasWaitlist = register.waitlist.length > 0;
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="compact"
          onClick={() => { setSelectedId(null); setRegister(null); loadClasses(); }}
        >
          <ArrowLeft className="size-4" /> Back to today&apos;s classes
        </Button>

        <Card>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-1">
                {cls.color && <span className="w-3 h-3 rounded-full" style={{ background: cls.color }} />}
                <h1 className="text-lg font-semibold" style={{ color: "var(--tx-1)" }}>{cls.name}</h1>
              </div>
              <div className="flex items-center gap-3 text-xs flex-wrap" style={{ color: "var(--tx-3)" }}>
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {cls.startTime}–{cls.endTime}</span>
                {cls.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {cls.location}</span>}
                {cls.coachName && <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {cls.coachName}</span>}
              </div>
            </div>
            <div className="text-right">
              <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--tx-1)" }}>
                {attended} / {register.expected.length}
              </p>
              <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>attended</p>
            </div>
          </div>
        </Card>

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 px-3 py-2 rounded-[var(--r-md)] border"
            style={{
              borderColor: tint("var(--hue-danger)", 25),
              background: tint("var(--hue-danger)", 6),
              color: "var(--hue-danger)",
            }}
          >
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p className="text-xs">{error}</p>
          </div>
        )}

        {/* §4a.2: the roster and the waitlist are a STRUCTURAL split, so they
            divide at `lg:` — and only when there is actually a waitlist to
            show, otherwise the roster keeps the full content box. */}
        <div className={hasWaitlist ? "grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start" : undefined}>
          {register.expected.length === 0 ? (
            <Card padding="none">
              <p className="p-8 text-center text-sm" style={{ color: "var(--tx-3)" }}>
                No members have subscribed to this class yet.
              </p>
            </Card>
          ) : (
            <ul className="space-y-2">
              {register.expected.map((m) => {
                const isMarking = marking === m.memberId;
                return (
                  <li
                    key={m.memberId}
                    className="rounded-[var(--r-md)] border p-3 flex items-center gap-3"
                    style={{
                      background: m.attended ? tint("var(--hue-success)", 8) : "var(--sf-1)",
                      borderColor: m.attended ? tint("var(--hue-success)", 30) : "var(--bd-default)",
                    }}
                  >
                    <button
                      onClick={() => toggleAttendance(m.memberId, m.attended)}
                      disabled={isMarking}
                      className="shrink-0 w-9 h-9 rounded-[var(--r-md)] flex items-center justify-center border transition-colors disabled:opacity-50"
                      style={{
                        background: m.attended ? "var(--hue-success)" : "transparent",
                        borderColor: m.attended ? "var(--hue-success)" : "var(--bd-default)",
                        color: "var(--tx-on-accent)",
                      }}
                      aria-label={m.attended ? `Mark ${m.name} absent` : `Mark ${m.name} attended`}
                    >
                      {isMarking ? <Loader2 className="w-4 h-4 animate-spin" style={{ color: m.attended ? "var(--tx-on-accent)" : "var(--tx-3)" }} /> : m.attended ? <Check className="w-5 h-5" /> : null}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>{m.name}</p>
                        {m.rank && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold"
                            style={{ background: m.rank.color ? tint(m.rank.color, 15) : "var(--sf-2)", color: m.rank.color ?? "var(--tx-2)" }}
                          >
                            {m.rank.name}{m.rank.stripes > 0 ? ` ·${m.rank.stripes}` : ""}
                          </span>
                        )}
                        {m.accountType !== "adult" && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold" style={{ background: tint("var(--hue-info)", 12), color: "var(--hue-info)" }}>
                            {m.accountType.toUpperCase()}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[11px] flex-wrap" style={{ color: "var(--tx-3)" }}>
                        <span className="flex items-center gap-1">
                          {m.waiverAccepted
                            ? <><ShieldCheck className="w-3 h-3" style={{ color: "var(--hue-success)" }} /> Waiver</>
                            : <><ShieldAlert className="w-3 h-3" style={{ color: "var(--hue-warning)" }} /> No waiver</>}
                        </span>
                        <span className="flex items-center gap-1">
                          <CalendarCheck className="w-3 h-3" /> Last seen {relativeDate(m.lastVisitAt)}
                        </span>
                        {m.medicalConditions && (
                          <span className="flex items-center gap-1" style={{ color: "var(--hue-danger)" }}>
                            <Heart className="w-3 h-3" /> Medical
                          </span>
                        )}
                      </div>
                      {/* §4a.5 fix: this note was a pale-pink literal that all
                          but vanished against the white staff card. */}
                      {m.medicalConditions && (
                        <p className="text-[11px] mt-1 italic" style={{ color: "var(--hue-danger)" }}>
                          <AlertTriangle className="w-3 h-3 inline mr-1" />
                          {m.medicalConditions}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {hasWaitlist && (
            <Card
              padding="tight"
              className="lg:sticky lg:top-0"
              style={{ background: tint("var(--hue-warning)", 6), borderColor: tint("var(--hue-warning)", 25) }}
            >
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--hue-warning)" }}>
                Waitlist ({register.waitlist.length})
              </p>
              <ul className="space-y-1">
                {register.waitlist.map((w) => (
                  <li key={w.memberId} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate" style={{ color: "var(--tx-2)" }}>{w.position}. {w.name}</span>
                    <span className="text-[11px] shrink-0" style={{ color: "var(--tx-3)" }}>{w.status}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    );
  }

  // List view
  return (
    <>
      <PageHeader
        title="Today's classes"
        description="Tap a class to open the register and mark attendance."
      />

      {loadingClasses || loadingRegister ? (
        <div className="flex items-center gap-2 py-6" style={{ color: "var(--tx-3)" }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading…</span>
        </div>
      ) : !classes || classes.length === 0 ? (
        <Card padding="none">
          <p className="p-8 text-center text-sm" style={{ color: "var(--tx-3)" }}>
            No classes today. Check back tomorrow, or open the timetable to schedule one.
          </p>
        </Card>
      ) : (
        // §4a.2: the class list widens rather than splitting — two columns of
        // the same card from `xl:`, one column on a laptop content box.
        <ul className="grid gap-2 xl:grid-cols-2">
          {classes.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setSelectedId(c.id)}
                className="w-full h-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4 flex items-center gap-3 text-left transition-colors hover:bg-sf-2 hover:border-bd-hover"
              >
                <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: c.color ?? primaryColor }} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{c.name}</p>
                  <div className="flex items-center gap-3 mt-1 text-xs flex-wrap" style={{ color: "var(--tx-3)" }}>
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {c.startTime}–{c.endTime}</span>
                    {c.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" /> {c.location}</span>}
                    {c.coachName && <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {c.coachName}</span>}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold tabular-nums" style={{ color: "var(--tx-1)" }}>
                    {c.attendedCount}{c.maxCapacity ? ` / ${c.maxCapacity}` : ""}
                  </p>
                  <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>checked in{c.waitlistCount > 0 ? ` · ${c.waitlistCount} waiting` : ""}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
