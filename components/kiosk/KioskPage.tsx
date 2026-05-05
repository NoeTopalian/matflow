"use client";

// Kiosk client UI: class-select → name-type → auto-check-in.
//
// Auto-fire rule: when the typed query narrows to exactly 1 match, we wait
// 300 ms (so the rest of the keystroke settles) and POST the check-in.
// If 2+ match, the picker is shown and the staff/member taps to disambiguate.
// After a successful check-in we celebrate for 3s then reset.

import { useEffect, useMemo, useRef, useState } from "react";

type Tenant = {
  name: string;
  primaryColor: string;
  bgColor: string;
  textColor: string;
  logoUrl: string | null;
  fontFamily: string;
};

type ClassRow = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  date: string;
  requiredRank: string | null;
  maxRank: string | null;
};

type MemberRow = {
  kioskMemberToken: string;
  name: string;
  ageGroup: string;
  beltName: string | null;
  beltColor: string | null;
};

type Step = "loading" | "pick-class" | "type-name" | "checking-in" | "success" | "error";

const AUTO_FIRE_DELAY_MS = 300;
const RESET_DELAY_MS = 3000;
const PICKER_IDLE_RESET_MS = 10_000;

export default function KioskPage({ token, tenant }: { token: string; tenant: Tenant }) {
  const [step, setStep] = useState<Step>("loading");
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [classError, setClassError] = useState<string | null>(null);
  const [selectedClass, setSelectedClass] = useState<ClassRow | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<MemberRow[]>([]);
  const [resultMessage, setResultMessage] = useState<string>("");
  const [resultError, setResultError] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Load today's classes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/kiosk/${encodeURIComponent(token)}/classes`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setClassError("Could not load classes. Ask staff for help.");
          setStep("pick-class");
          return;
        }
        setClasses(data.classes ?? []);
        setStep("pick-class");
      } catch {
        if (!cancelled) {
          setClassError("Network error.");
          setStep("pick-class");
        }
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Autofocus the name input when entering type-name step.
  useEffect(() => {
    if (step === "type-name") inputRef.current?.focus();
  }, [step]);

  // Type-ahead lookup.
  useEffect(() => {
    if (step !== "type-name") return;
    if (query.trim().length < 2) {
      setMatches([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/kiosk/${encodeURIComponent(token)}/members?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json();
        if (res.ok) setMatches(data.members ?? []);
      } catch { /* ignore — show no matches */ }
    }, 200);
    return () => clearTimeout(handle);
  }, [query, step, token]);

  // Auto-fire on exactly-one-match after a small debounce.
  const autoFireTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoFireTimer.current) clearTimeout(autoFireTimer.current);
    if (step !== "type-name") return;
    if (matches.length !== 1) return;
    autoFireTimer.current = setTimeout(() => {
      void doCheckin(matches[0]);
    }, AUTO_FIRE_DELAY_MS);
    return () => {
      if (autoFireTimer.current) clearTimeout(autoFireTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, step]);

  // Picker idle-reset: if the user opens the picker and walks away, return
  // to class selection so the next person doesn't pick up someone else's flow.
  useEffect(() => {
    if (step !== "type-name") return;
    const t = setTimeout(() => resetToClassPicker(), PICKER_IDLE_RESET_MS);
    return () => clearTimeout(t);
  }, [step, query]);

  function resetToClassPicker() {
    setSelectedClass(null);
    setQuery("");
    setMatches([]);
    setResultMessage("");
    setResultError("");
    setStep("pick-class");
  }

  async function doCheckin(member: MemberRow) {
    if (!selectedClass) return;
    setStep("checking-in");
    try {
      const res = await fetch(`/api/kiosk/${encodeURIComponent(token)}/checkin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kioskMemberToken: member.kioskMemberToken,
          classInstanceId: selectedClass.id,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setResultMessage(`Welcome, ${member.name.split(" ")[0]}!`);
        setStep("success");
        setTimeout(resetToClassPicker, RESET_DELAY_MS);
      } else {
        setResultError(data?.error ?? "Could not check in.");
        setStep("error");
        setTimeout(resetToClassPicker, RESET_DELAY_MS + 1500);
      }
    } catch {
      setResultError("Network error. Ask staff.");
      setStep("error");
      setTimeout(resetToClassPicker, RESET_DELAY_MS + 1500);
    }
  }

  const headerStyle = useMemo(
    () => ({
      background: tenant.bgColor,
      color: tenant.textColor,
      fontFamily: tenant.fontFamily,
      minHeight: "100vh",
    }),
    [tenant],
  );

  return (
    <div style={headerStyle} className="flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-5 border-b border-white/10">
        {tenant.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={tenant.logoUrl} alt={tenant.name} className="w-10 h-10 rounded-lg object-cover" />
        ) : (
          <div className="w-10 h-10 rounded-lg flex items-center justify-center font-bold" style={{ background: tenant.primaryColor }}>
            {tenant.name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-semibold truncate">{tenant.name}</h1>
          <p className="text-sm opacity-60">Class check-in</p>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-6">
        {step === "loading" && (
          <p className="opacity-70">Loading…</p>
        )}

        {step === "pick-class" && (
          <div className="w-full max-w-md space-y-3">
            <h2 className="text-2xl font-semibold mb-4 text-center">Pick your class</h2>
            {classError && <p className="text-red-400 text-sm text-center">{classError}</p>}
            {classes.length === 0 && !classError && (
              <p className="opacity-60 text-center">No classes scheduled today.</p>
            )}
            {classes.map((cls) => (
              <button
                key={cls.id}
                onClick={() => { setSelectedClass(cls); setStep("type-name"); }}
                className="w-full p-5 rounded-2xl border border-white/15 hover:border-white/40 transition-all text-left active:scale-[0.99]"
                style={{ background: "rgba(255,255,255,0.03)" }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xl font-semibold">{cls.name}</span>
                  <span className="opacity-60 text-sm whitespace-nowrap">{cls.startTime}–{cls.endTime}</span>
                </div>
                {(cls.requiredRank || cls.maxRank) && (
                  <p className="opacity-50 text-xs mt-1">
                    {cls.requiredRank && `${cls.requiredRank} and up`}
                    {cls.requiredRank && cls.maxRank && " · "}
                    {cls.maxRank && `up to ${cls.maxRank}`}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}

        {step === "type-name" && selectedClass && (
          <div className="w-full max-w-md space-y-4">
            <div className="text-center">
              <p className="opacity-60 text-sm">Checking into</p>
              <h2 className="text-xl font-semibold">{selectedClass.name}</h2>
            </div>
            <input
              ref={inputRef}
              type="text"
              autoComplete="off"
              autoCapitalize="words"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type your name…"
              className="w-full px-5 py-4 rounded-2xl text-xl outline-none border-2 transition-colors"
              style={{ background: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.15)", color: tenant.textColor }}
            />

            {query.trim().length >= 2 && matches.length === 0 && (
              <p className="opacity-50 text-center text-sm">No match yet — keep typing.</p>
            )}

            {matches.length > 1 && (
              <div className="space-y-2">
                <p className="opacity-60 text-xs text-center">Tap your name:</p>
                {matches.map((m) => (
                  <button
                    key={m.kioskMemberToken}
                    onClick={() => doCheckin(m)}
                    className="w-full p-4 rounded-xl border border-white/15 hover:border-white/40 text-left flex items-center gap-3"
                    style={{ background: "rgba(255,255,255,0.03)" }}
                  >
                    {m.beltColor && (
                      <span
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ background: m.beltColor, boxShadow: "0 0 0 2px rgba(255,255,255,0.1)" }}
                        aria-label={m.beltName ?? "rank"}
                      />
                    )}
                    <span className="flex-1">{m.name}</span>
                    <span className="opacity-50 text-xs uppercase">{m.ageGroup}</span>
                  </button>
                ))}
              </div>
            )}

            <button
              onClick={resetToClassPicker}
              className="w-full text-sm opacity-50 hover:opacity-80 transition-opacity"
            >
              ← Back to classes
            </button>
          </div>
        )}

        {step === "checking-in" && (
          <p className="text-xl opacity-70">Checking you in…</p>
        )}

        {step === "success" && (
          <div className="text-center">
            <div
              className="w-24 h-24 mx-auto rounded-full flex items-center justify-center mb-4 text-5xl"
              style={{ background: tenant.primaryColor }}
            >
              ✓
            </div>
            <h2 className="text-3xl font-semibold mb-2">{resultMessage}</h2>
            <p className="opacity-60">{selectedClass?.name}</p>
          </div>
        )}

        {step === "error" && (
          <div className="text-center max-w-md">
            <div className="w-20 h-20 mx-auto rounded-full flex items-center justify-center mb-4 text-4xl" style={{ background: "#ef4444" }}>!</div>
            <h2 className="text-xl font-semibold mb-2">Couldn&apos;t check you in</h2>
            <p className="opacity-70">{resultError}</p>
          </div>
        )}
      </div>
    </div>
  );
}
