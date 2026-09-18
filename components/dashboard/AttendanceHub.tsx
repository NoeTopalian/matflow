"use client";

// Mark Attendance — the one attendance screen (18 Sep 2026).
//
// Noe: "the scan cards should be a section under mark attendance in the admin
// side; it doesn't come up with the option to sign people into classes
// happening at this moment; it's not clear where I can mark attendance
// manually easily as a coach on the app — think primarily about mobile users."
//
// Session first (the one on now is already selected — /api/coach/today orders
// it that way), then two sections of the same screen: Tick names (the
// register plus a search to add anyone) and Scan cards (the camera). Both
// write through the same routes, and both are open to every staff role.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import KioskPanel from "@/components/dashboard/KioskPanel";
import SessionPicker, { pickDefault, type TodaySession } from "@/components/dashboard/SessionPicker";
import RegisterPanel from "@/components/dashboard/RegisterPanel";
import CardScanner from "@/components/dashboard/CardScanner";

type Mode = "tick" | "scan";

export default function AttendanceHub({
  initialMode,
  preselectClassId,
  role,
  primaryColor,
}: {
  initialMode: Mode;
  preselectClassId: string | null;
  role: string;
  primaryColor: string;
}) {
  const [sessions, setSessions] = useState<TodaySession[] | null>(null);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [counts, setCounts] = useState<{ checkedIn: number; expected: number } | null>(null);
  // Bumped on EVERY session tap, including a tap on the session already
  // selected: the scanner's old picker treated that as "a new stack" (camera
  // stopped, seen set and rows cleared), and the register simply reloads.
  // The section is keyed on it, so a tap always remounts.
  const [tapCount, setTapCount] = useState(0);

  const load = useCallback(async () => {
    setError(false);
    try {
      const res = await fetch("/api/coach/today");
      const data = await res.json().catch(() => null);
      // An error object rendered as an empty list is the defect that once
      // crashed this screen; a non-array is a failure, not "no classes".
      if (!res.ok || !Array.isArray(data)) throw new Error("bad");
      const list = data as TodaySession[];
      setSessions(list);
      setSelectedId((current) => (current && list.some((s) => s.id === current) ? current : pickDefault(list, preselectClassId)));
    } catch {
      setSessions(null);
      setError(true);
    }
  }, [preselectClassId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCountChange = useCallback((checkedIn: number, expected: number) => setCounts({ checkedIn, expected }), []);

  const selected = sessions?.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Mark attendance"
        description="Pick the session, then tick names or scan cards. The class on now is already selected."
      />

      <SessionPicker
        sessions={sessions}
        error={error}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setCounts(null);
          setTapCount((n) => n + 1);
        }}
        onRetry={() => void load()}
      />

      {selected && (
        <>
          <div role="tablist" aria-label="How to mark attendance" className="grid grid-cols-2 gap-2">
            <Button
              role="tab"
              aria-selected={mode === "tick"}
              variant={mode === "tick" ? "primary" : "secondary"}
              onClick={() => setMode("tick")}
            >
              Tick names
            </Button>
            <Button
              role="tab"
              aria-selected={mode === "scan"}
              variant={mode === "scan" ? "primary" : "secondary"}
              onClick={() => setMode("scan")}
            >
              Scan cards
            </Button>
          </div>

          <p className="text-sm text-tx-3" aria-live="polite">
            {selected.name} · {selected.startTime}–{selected.endTime}
            {mode === "tick" && counts
              ? ` · ${counts.checkedIn} checked in${counts.expected ? ` of ${counts.expected} expected` : ""}`
              : ""}
          </p>

          {/* Keyed on the session AND the tap: a switch or a re-tap remounts
              the section, so the scanner's seen set, rows and camera reset
              exactly as its old picker reset them, and the register reloads
              from the server. */}
          {mode === "tick" ? (
            <RegisterPanel key={`${selected.id}-${tapCount}`} instance={selected} primaryColor={primaryColor} onCountChange={onCountChange} />
          ) : (
            <CardScanner key={`${selected.id}-${tapCount}`} instance={selected} />
          )}
        </>
      )}

      {/* The owner's kiosk controls, at the bottom: not what a coach with a
          stack of cards is here for. */}
      <div className="pt-2">
        <KioskPanel primaryColor={primaryColor} role={role} variant="compact" />
      </div>
    </div>
  );
}
