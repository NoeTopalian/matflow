"use client";

import { useState } from "react";
import { MapPin, Users, Clock, CheckCircle2, XCircle, Loader2, Search } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TodayClass {
  id: string;
  name: string;
  coachName: string | null;
  location: string | null;
  startTime: string;
  endTime: string;
  maxCapacity: number | null;
  enrolled: number;
  color: string | null;
}

interface Props {
  tenantSlug: string;
  tenantName: string;
  primaryColor: string;
  logoUrl: string | null;
  todayClasses: TodayClass[];
}

type Step = "select-class" | "enter-name" | "success" | "error";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const hour = h % 12 || 12;
  return `${hour}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// ─── Class card ───────────────────────────────────────────────────────────────

function ClassCard({
  cls,
  primaryColor,
  onSelect,
}: {
  cls: TodayClass;
  primaryColor: string;
  onSelect: () => void;
}) {
  const color = cls.color ?? primaryColor;
  const isFull = cls.maxCapacity !== null && cls.enrolled >= cls.maxCapacity;

  return (
    <button
      onClick={onSelect}
      disabled={isFull}
      className="w-full text-left rounded-2xl p-4 border transition-all active:scale-[0.98] disabled:opacity-60"
      style={{
        background: hex(color, 0.08),
        borderColor: hex(color, 0.25),
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />
            <h3 className="text-white font-bold text-base truncate">{cls.name}</h3>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1">
            <span className="flex items-center gap-1 text-gray-400 text-sm">
              <Clock className="w-3.5 h-3.5" />
              {formatTime(cls.startTime)} – {formatTime(cls.endTime)}
            </span>
            {cls.coachName && (
              <span className="text-gray-400 text-sm">{cls.coachName}</span>
            )}
            {cls.location && (
              <span className="flex items-center gap-1 text-gray-400 text-sm">
                <MapPin className="w-3.5 h-3.5" />
                {cls.location}
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          {cls.maxCapacity ? (
            <>
              <div className="flex items-center gap-1 text-sm" style={{ color: isFull ? "#ef4444" : color }}>
                <Users className="w-3.5 h-3.5" />
                {cls.enrolled}/{cls.maxCapacity}
              </div>
              {isFull && <p className="text-red-400 text-xs mt-0.5">Full</p>}
            </>
          ) : (
            <div className="flex items-center gap-1 text-gray-500 text-sm">
              <Users className="w-3.5 h-3.5" />
              {cls.enrolled}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function QRCheckinPage({
  tenantSlug,
  tenantName,
  primaryColor,
  logoUrl,
  todayClasses,
}: Props) {
  const [step, setStep] = useState<Step>("select-class");
  const [selectedClass, setSelectedClass] = useState<TodayClass | null>(null);
  const [memberQuery, setMemberQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  async function handleCheckin() {
    if (!selectedClass || !memberQuery.trim()) return;
    setLoading(true);

    try {
      // First look up member by name/email
      const lookup = await fetch(
        `/api/members/lookup?q=${encodeURIComponent(memberQuery.trim())}&tenantSlug=${tenantSlug}`
      );
      const members = await lookup.json();

      if (!members || members.length === 0) {
        setErrorMsg("Member not found. Ask staff to check you in.");
        setStep("error");
        return;
      }

      // Use first match — server returns {token, name} now (id replaced by HMAC token)
      const member = members[0];
      if (!member?.token) {
        setErrorMsg("Member not found. Ask staff to check you in.");
        setStep("error");
        return;
      }

      const res = await fetch("/api/checkin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classInstanceId: selectedClass.id,
          token: member.token,
          checkInMethod: "qr",
          tenantSlug,
        }),
      });

      if (res.status === 409) {
        // Already checked in — still show success
        setStep("success");
        return;
      }
      if (!res.ok) {
        const err = await res.json();
        setErrorMsg(err.error ?? "Check-in failed. Please ask staff for help.");
        setStep("error");
        return;
      }
      setStep("success");
    } catch {
      setErrorMsg("Network error. Please ask staff for help.");
      setStep("error");
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setStep("select-class");
    setSelectedClass(null);
    setMemberQuery("");
    setErrorMsg("");
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: "#0a0b0e" }}
    >
      {/* Header */}
      <div
        className="px-5 pt-safe-top pb-4 flex items-center gap-3 border-b border-white/5"
        style={{
          paddingTop: "max(env(safe-area-inset-top), 20px)",
          background: "rgba(10,11,14,0.95)",
        }}
      >
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt={tenantName} className="h-8 w-auto object-contain" />
        ) : (
          <div
            className="w-9 h-9 rounded-xl flex items-center justify-center text-white font-bold text-sm"
            style={{ background: primaryColor }}
          >
            {tenantName.charAt(0).toUpperCase()}
          </div>
        )}
        <div>
          <p className="text-white font-semibold text-sm">{tenantName}</p>
          <p className="text-gray-500 text-xs">Class Check-In</p>
        </div>
      </div>

      <div className="flex-1 px-5 py-6 max-w-lg mx-auto w-full">
        {/* Step: Select class */}
        {step === "select-class" && (
          <>
            <h1 className="text-white text-xl font-bold mb-1">Today&apos;s Classes</h1>
            <p className="text-gray-500 text-sm mb-5">Select the class you&apos;re attending</p>

            {todayClasses.length === 0 ? (
              <div className="text-center py-16">
                <p className="text-gray-600 text-base">No classes scheduled today</p>
                <p className="text-gray-700 text-sm mt-1">Check the timetable for upcoming sessions</p>
              </div>
            ) : (
              <div className="space-y-3">
                {todayClasses.map((cls) => (
                  <ClassCard
                    key={cls.id}
                    cls={cls}
                    primaryColor={primaryColor}
                    onSelect={() => {
                      setSelectedClass(cls);
                      setStep("enter-name");
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {/* Step: Enter name */}
        {step === "enter-name" && selectedClass && (
          <>
            <button
              onClick={() => setStep("select-class")}
              className="text-gray-500 text-sm mb-5 flex items-center gap-1 hover:text-gray-300"
            >
              ← Back
            </button>

            <div
              className="rounded-2xl p-4 mb-6 border"
              style={{ background: hex(selectedClass.color ?? primaryColor, 0.08), borderColor: hex(selectedClass.color ?? primaryColor, 0.2) }}
            >
              <p className="text-white font-bold text-base">{selectedClass.name}</p>
              <p className="text-gray-400 text-sm mt-0.5">
                {formatTime(selectedClass.startTime)} · {selectedClass.coachName ?? ""}
              </p>
            </div>

            <h2 className="text-white text-lg font-bold mb-1">Enter your name</h2>
            <p className="text-gray-500 text-sm mb-4">Type your full name or email to check in</p>

            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
              <input
                type="text"
                value={memberQuery}
                onChange={(e) => setMemberQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCheckin()}
                placeholder="Full name or email..."
                className="w-full bg-white/5 border border-white/10 rounded-2xl pl-10 pr-4 py-3.5 text-white text-base placeholder-gray-600 focus:outline-none focus:border-white/25 transition-colors"
                autoFocus
              />
            </div>

            <button
              onClick={handleCheckin}
              disabled={!memberQuery.trim() || loading}
              className="w-full py-4 rounded-2xl text-white font-bold text-base flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-50"
              style={{ background: primaryColor }}
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                "Check In"
              )}
            </button>
          </>
        )}

        {/* Step: Success */}
        {step === "success" && selectedClass && (
          <div className="flex flex-col items-center justify-center text-center py-12">
            <div
              className="w-20 h-20 rounded-full flex items-center justify-center mb-5"
              style={{ background: hex(primaryColor, 0.12) }}
            >
              <CheckCircle2 className="w-10 h-10" style={{ color: primaryColor }} />
            </div>
            <h2 className="text-white text-2xl font-bold mb-1">Checked In!</h2>
            <p className="text-gray-400 text-base mb-1">{selectedClass.name}</p>
            <p className="text-gray-500 text-sm">
              {formatTime(selectedClass.startTime)} · {selectedClass.coachName ?? tenantName}
            </p>
            <button
              onClick={reset}
              className="mt-8 px-8 py-3 rounded-2xl text-white font-semibold"
              style={{ background: primaryColor }}
            >
              Done
            </button>
          </div>
        )}

        {/* Step: Error */}
        {step === "error" && (
          <div className="flex flex-col items-center justify-center text-center py-12">
            <div className="w-20 h-20 rounded-full flex items-center justify-center mb-5" style={{ background: "rgba(239,68,68,0.1)" }}>
              <XCircle className="w-10 h-10 text-red-400" />
            </div>
            <h2 className="text-white text-xl font-bold mb-2">Check-In Failed</h2>
            <p className="text-gray-400 text-sm max-w-xs">{errorMsg}</p>
            <button
              onClick={reset}
              className="mt-6 px-8 py-3 rounded-2xl border border-white/10 text-gray-300 font-medium text-sm hover:text-white transition-colors"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
