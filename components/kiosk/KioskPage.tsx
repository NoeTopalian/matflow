"use client";

// Kiosk client UI: class-select → name-type → auto-check-in.
//
// Auto-fire rule: when the typed query narrows to exactly 1 match, we wait
// 300 ms (so the rest of the keystroke settles) and POST the check-in.
// If 2+ match, the picker is shown and the staff/member taps to disambiguate.
// After a successful check-in we celebrate for 3s then reset.

import { useEffect, useMemo, useRef, useState } from "react";
import { WhoIsTrainingPicker, type PickerOption } from "@/components/checkin/WhoIsTrainingPicker";

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

type LinkedKid = {
  kioskMemberToken: string;
  name: string;
  ageGroup: string;
  waiverOk: boolean;
  dateOfBirth: string | null;
};

type MemberRow = {
  kioskMemberToken: string;
  name: string;
  ageGroup: string;
  beltName: string | null;
  beltColor: string | null;
  // F6 — these three are present on responses from the post-2026-05-15
  // members endpoint. Old kiosk pages with cached responses won't have them,
  // so every read uses ?? defaults that preserve the original single-member
  // check-in behaviour.
  waiverOk?: boolean;
  selfTrainable?: boolean;
  linkedKids?: LinkedKid[];
};

// F6 added "pick-attendees" — only entered when the tapped match has one or
// more linked kids, so the parent can pick self/kid combinations before the
// check-in fires.
// F4 added "waiver-gate" — entered when the tapped member has not signed a
// waiver. The kiosk sends an email link, then polls for completion before
// allowing check-in to proceed.
type Step =
  | "loading"
  | "pick-class"
  | "type-name"
  | "pick-attendees"
  | "waiver-gate"
  | "checking-in"
  | "success"
  | "error";

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
  // F6 — when a tapped match has linkedKids, we park the row here and switch
  // into the pick-attendees step. Cleared on success/error/idle-reset.
  const [pendingMatch, setPendingMatch] = useState<MemberRow | null>(null);
  const [waiverGateMember, setWaiverGateMember] = useState<MemberRow | null>(null);
  const [waiverTokenId, setWaiverTokenId] = useState<string | null>(null);
  const [waiverMaskedEmail, setWaiverMaskedEmail] = useState("");
  const [waiverSent, setWaiverSent] = useState(false);
  const [waiverSending, setWaiverSending] = useState(false);
  const [waiverError, setWaiverError] = useState("");
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
  // F6: if the single match has linked kids, route to the picker instead of
  // firing straight away — the parent may be checking in a kid, not themselves.
  const autoFireTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (autoFireTimer.current) clearTimeout(autoFireTimer.current);
    if (step !== "type-name") return;
    if (matches.length !== 1) return;
    autoFireTimer.current = setTimeout(() => {
      void tapMatch(matches[0]);
    }, AUTO_FIRE_DELAY_MS);
    return () => {
      if (autoFireTimer.current) clearTimeout(autoFireTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, step]);

  // F4 — poll kiosk-status every 5 s while in waiver-gate and link has been sent.
  useEffect(() => {
    if (step !== "waiver-gate" || !waiverTokenId || !waiverSent) return;
    const poll = setInterval(async () => {
      try {
        const res = await fetch(`/api/waiver/kiosk-status?tokenId=${encodeURIComponent(waiverTokenId)}`);
        const data = await res.json();
        if (data.signed) {
          clearInterval(poll);
          if (waiverGateMember) void doCheckin(waiverGateMember);
        }
        if (data.expired) {
          clearInterval(poll);
          setWaiverError("The waiver link expired. Ask a staff member.");
        }
      } catch { /* network blip — keep polling */ }
    }, 5000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, waiverTokenId, waiverSent]);

  // Picker idle-reset: if the user opens the picker and walks away, return
  // to class selection so the next person doesn't pick up someone else's flow.
  // F6: the same idle-reset covers the new "pick-attendees" step. A parent
  // who opened the multi-kid picker and walked off should not leave the
  // signed kid tokens sitting on screen.
  // F4: also covers "waiver-gate" so the screen does not sit unattended.
  useEffect(() => {
    if (step !== "type-name" && step !== "pick-attendees" && step !== "waiver-gate") return;
    const t = setTimeout(() => resetToClassPicker(), PICKER_IDLE_RESET_MS);
    return () => clearTimeout(t);
  }, [step, query]);

  function resetToClassPicker() {
    setSelectedClass(null);
    setQuery("");
    setMatches([]);
    setResultMessage("");
    setResultError("");
    setPendingMatch(null);
    setWaiverGateMember(null);
    setWaiverTokenId(null);
    setWaiverMaskedEmail("");
    setWaiverSent(false);
    setWaiverSending(false);
    setWaiverError("");
    setStep("pick-class");
  }

  // F6/F4 — single entry point for "user picked / auto-fired this match".
  // Priority: kids picker first, then waiver gate, then check-in.
  function tapMatch(member: MemberRow) {
    const hasKids = !!member.linkedKids && member.linkedKids.length > 0;
    if (hasKids) {
      setPendingMatch(member);
      setStep("pick-attendees");
      return;
    }
    if (member.waiverOk === false) {
      setWaiverGateMember(member);
      setStep("waiver-gate");
      return;
    }
    void doCheckin(member);
  }

  async function sendWaiverLink(member: MemberRow) {
    setWaiverSending(true);
    setWaiverError("");
    try {
      const res = await fetch("/api/waiver/kiosk-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kioskDeviceToken: token,
          kioskMemberToken: member.kioskMemberToken,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setWaiverMaskedEmail(data.maskedEmail ?? "");
        setWaiverTokenId(data.tokenId ?? null);
        setWaiverSent(true);
      } else {
        setWaiverError(data?.error ?? "Could not send waiver link. Ask staff.");
      }
    } catch {
      setWaiverError("Network error. Ask staff.");
    } finally {
      setWaiverSending(false);
    }
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

  // F6 — fire one checkin POST per selected option, sequentially. Sequential
  // (not Promise.all) so a per-row failure can surface with the right name
  // and we don't blast the rate limiter. Sub-second cost for the typical
  // 1-3 picks per parent.
  async function doMultiCheckin(picks: PickerOption[]) {
    if (!selectedClass || picks.length === 0) return;
    setStep("checking-in");
    const errors: string[] = [];
    const successes: string[] = [];
    for (const pick of picks) {
      try {
        const res = await fetch(`/api/kiosk/${encodeURIComponent(token)}/checkin`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kioskMemberToken: pick.kioskMemberToken,
            classInstanceId: selectedClass.id,
          }),
        });
        const data = await res.json();
        if (res.ok) {
          successes.push(pick.name.split(" ")[0]);
        } else {
          errors.push(`${pick.name}: ${data?.error ?? "could not check in"}`);
        }
      } catch {
        errors.push(`${pick.name}: network error`);
      }
    }
    if (errors.length === 0) {
      setResultMessage(
        successes.length === 1
          ? `Welcome, ${successes[0]}!`
          : `Signed in: ${successes.join(", ")}`,
      );
      setStep("success");
      setTimeout(resetToClassPicker, RESET_DELAY_MS);
    } else {
      // Mixed result: tell the user exactly which ones failed.
      const summary =
        successes.length > 0
          ? `Signed in: ${successes.join(", ")}. Couldn't sign in: ${errors.join("; ")}`
          : errors.join("; ");
      setResultError(summary);
      setStep("error");
      setTimeout(resetToClassPicker, RESET_DELAY_MS + 2000);
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
                    onClick={() => tapMatch(m)}
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

        {step === "pick-attendees" && pendingMatch && selectedClass && (
          <div className="w-full max-w-md space-y-4">
            <div className="text-center">
              <p className="opacity-60 text-sm">Checking into</p>
              <h2 className="text-xl font-semibold">{selectedClass.name}</h2>
            </div>
            <WhoIsTrainingPicker
              primaryColor={tenant.primaryColor}
              options={[
                // Self appears only if the parent has their own membership;
                // a no-membership parent never trains themselves.
                ...(pendingMatch.selfTrainable
                  ? [
                      {
                        kioskMemberToken: pendingMatch.kioskMemberToken,
                        kind: "self" as const,
                        name: pendingMatch.name,
                        ageGroup: pendingMatch.ageGroup,
                        waiverOk: pendingMatch.waiverOk ?? true,
                        dateOfBirth: null,
                      },
                    ]
                  : []),
                ...(pendingMatch.linkedKids ?? []).map((kid) => ({
                  kioskMemberToken: kid.kioskMemberToken,
                  kind: "kid" as const,
                  name: kid.name,
                  ageGroup: kid.ageGroup,
                  waiverOk: kid.waiverOk,
                  dateOfBirth: kid.dateOfBirth,
                })),
              ]}
              onConfirm={(picks) => void doMultiCheckin(picks)}
              onCancel={resetToClassPicker}
            />
          </div>
        )}

        {step === "waiver-gate" && waiverGateMember && (
          <div className="w-full max-w-md text-center space-y-5">
            <div
              className="w-16 h-16 mx-auto rounded-full flex items-center justify-center text-3xl"
              style={{ background: "rgba(255,255,255,0.08)" }}
            >
              ✉
            </div>
            <div>
              <h2 className="text-xl font-semibold mb-1">Waiver required</h2>
              <p className="opacity-70 text-sm">
                {waiverGateMember.name.split(" ")[0]} hasn&apos;t signed the gym waiver yet.
              </p>
            </div>

            {!waiverSent ? (
              <>
                <p className="opacity-60 text-sm">
                  We&apos;ll send a link to their email address. Once they sign on their phone,
                  check-in will continue automatically.
                </p>
                {waiverError && <p className="text-red-400 text-sm">{waiverError}</p>}
                <button
                  onClick={() => void sendWaiverLink(waiverGateMember)}
                  disabled={waiverSending}
                  className="w-full py-4 rounded-2xl font-semibold text-sm transition-opacity disabled:opacity-50"
                  style={{ background: tenant.primaryColor, color: "#fff" }}
                >
                  {waiverSending ? "Sending…" : "Send waiver link"}
                </button>
              </>
            ) : (
              <>
                <p className="opacity-80 text-sm">
                  Link sent to <span className="font-medium">{waiverMaskedEmail}</span>
                </p>
                <p className="opacity-50 text-xs">
                  Ask them to open the email on their phone and sign. This screen will
                  advance automatically once they&apos;re done.
                </p>
                <div className="flex items-center justify-center gap-2 opacity-50">
                  <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: tenant.primaryColor }} />
                  <span className="text-xs">Waiting for signature…</span>
                </div>
                {waiverError && <p className="text-red-400 text-sm">{waiverError}</p>}
              </>
            )}

            <button
              onClick={resetToClassPicker}
              className="text-sm opacity-40 hover:opacity-70 transition-opacity"
            >
              Cancel
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
