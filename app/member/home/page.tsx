"use client";

import { useState, useEffect } from "react";
import { QrCode, Clock, Users, MapPin, Megaphone, X, CheckCircle2, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import Image from "next/image";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TodayClass { id: string; name: string; time: string; endTime: string; coach: string; location: string; spots: number | null; capacity: number | null; }
interface AnnouncementLink { label: string; url: string; }
interface Announcement { id: string; title: string; body: string; time: string; pinned: boolean; imageUrl?: string; links?: AnnouncementLink[]; }

// ─── Demo fallback data ────────────────────────────────────────────────────────

const PRIMARY = "#3b82f6";

const DEMO_TODAY_CLASSES: TodayClass[] = [
  { id: "1", name: "Beginner BJJ",  time: "10:00", endTime: "11:00", coach: "Coach Mike",  location: "Mat 1",    spots: 8,  capacity: 20 },
  { id: "2", name: "Open Mat",      time: "12:00", endTime: "14:00", coach: "Coach Sarah", location: "Main Mat", spots: null, capacity: null },
  { id: "3", name: "No-Gi",         time: "18:00", endTime: "19:00", coach: "Coach Mike",  location: "Mat 1",    spots: 5,  capacity: 20 },
  { id: "4", name: "Kids BJJ",      time: "17:00", endTime: "17:45", coach: "Coach Emma",  location: "Mat 2",    spots: 6,  capacity: 12 },
];

const DEMO_ANNOUNCEMENTS: Announcement[] = [
  {
    id: "1",
    title: "Competition this Saturday!",
    body: "Don't forget — UKBJJA Nottingham Open is this Saturday at Harvey Hadden Sports Village. Doors open at 8:30am, first match 9:00am. Good luck to everyone competing — represent Total BJJ with pride! 🏆",
    time: "2h ago",
    pinned: true,
    imageUrl: "https://images.unsplash.com/photo-1555597673-b21d5c935865?w=600&q=80",
    links: [
      { label: "View event details", url: "https://ukbjja.org" },
      { label: "Get directions",     url: "https://maps.google.com" },
    ],
  },
  {
    id: "2",
    title: "New class added — Wrestling Fundamentals",
    body: "We're adding a Wednesday evening Wrestling Fundamentals class starting next week. 19:30–20:30 on Mat 1. No experience needed — great for improving takedowns and top game.",
    time: "1d ago",
    pinned: false,
    links: [{ label: "View full timetable", url: "/member/schedule" }],
  },
  {
    id: "3",
    title: "Gym closed Bank Holiday Monday",
    body: "The gym will be closed on Monday 5th May for the Bank Holiday. Normal classes resume Tuesday. Enjoy the long weekend! 🙌",
    time: "3d ago",
    pinned: false,
  },
];

// ─── Onboarding constants ─────────────────────────────────────────────────────

const ONBOARDING_KEY = "bjj_onboarded";

const BELTS = [
  { label: "White",  color: "#e5e7eb", border: "#9ca3af" },
  { label: "Blue",   color: "#3b82f6", border: "#3b82f6" },
  { label: "Purple", color: "#8b5cf6", border: "#8b5cf6" },
  { label: "Brown",  color: "#92400e", border: "#b45309" },
  { label: "Black",  color: "#18181b", border: "#52525b" },
];

const CLASS_OPTIONS  = ["Beginner BJJ", "No-Gi", "Open Mat", "Kids BJJ", "Intermediate", "Wrestling"];
const HEARD_OPTIONS  = ["Friend / Teammate", "Social media", "Google search", "Coach referral", "Walked past", "Other"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

function today() {
  return new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

// ─── Announcement Card ────────────────────────────────────────────────────────

function AnnouncementCard({ a, primaryColor }: { a: Announcement; primaryColor: string }) {
  const [expanded, setExpanded] = useState(a.pinned); // pinned start expanded
  const hasExtra = a.imageUrl || (a.links && a.links.length > 0);

  return (
    <div
      className="rounded-2xl border overflow-hidden transition-all"
      style={{
        background: a.pinned ? hex(primaryColor, 0.05) : "var(--member-surface)",
        borderColor: a.pinned ? hex(primaryColor, 0.2) : "var(--member-border)",
      }}
    >
      {/* Image (if present and expanded) */}
      {a.imageUrl && expanded && (
        <div className="relative w-full" style={{ height: 160 }}>
          <Image
            src={a.imageUrl}
            alt={a.title}
            fill
            className="object-cover"
            unoptimized
          />
          <div className="absolute inset-0" style={{ background: "linear-gradient(to bottom, transparent 50%, rgba(7,8,10,0.8) 100%)" }} />
        </div>
      )}

      {/* Header row — always visible */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 p-4 text-left"
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {a.pinned && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0" style={{ background: hex(primaryColor, 0.15), color: primaryColor }}>
                PINNED
              </span>
            )}
            <span className="text-white font-semibold text-sm leading-snug">{a.title}</span>
          </div>
          {!expanded && (
            <p className="text-gray-500 text-xs leading-relaxed line-clamp-2">{a.body}</p>
          )}
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 text-gray-600 shrink-0 mt-0.5" />
          : <ChevronDown className="w-4 h-4 text-gray-600 shrink-0 mt-0.5" />
        }
      </button>

      {/* Expanded body */}
      {expanded && (
        <div className="px-4 pb-4 space-y-3">
          <p className="text-gray-300 text-sm leading-relaxed">{a.body}</p>

          {/* Links */}
          {a.links && a.links.length > 0 && (
            <div className="flex flex-col gap-2">
              {a.links.map((link) => {
                const isInternal = link.url.startsWith("/");
                return isInternal ? (
                  <a
                    key={link.url}
                    href={link.url}
                    className="flex items-center gap-2 text-xs font-semibold transition-opacity hover:opacity-70"
                    style={{ color: primaryColor }}
                  >
                    <ExternalLink className="w-3 h-3" />
                    {link.label}
                  </a>
                ) : (
                  <a
                    key={link.url}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-xs font-semibold transition-opacity hover:opacity-70"
                    style={{ color: primaryColor }}
                  >
                    <ExternalLink className="w-3 h-3" />
                    {link.label}
                  </a>
                );
              })}
            </div>
          )}

          <p className="text-gray-600 text-xs">{a.time}</p>
        </div>
      )}

      {/* Collapsed timestamp */}
      {!expanded && (
        <p className="text-gray-700 text-xs px-4 pb-3">{a.time}</p>
      )}
    </div>
  );
}

// ─── Onboarding Modal ─────────────────────────────────────────────────────────

function OnboardingModal({ onDone, primaryColor }: { onDone: () => void; primaryColor: string }) {
  const [step, setStep]       = useState(0);
  const [belt, setBelt]       = useState("");
  const [stripes, setStripes] = useState(0);
  const [classes, setClasses] = useState<string[]>([]);
  const [style, setStyle]     = useState("");
  const [heard, setHeard]     = useState("");
  const [hasKids, setHasKids] = useState<boolean | null>(null);

  const TOTAL = 5;
  const progress = step > 0 && step < 6 ? step / TOTAL : 0;

  function toggleClass(c: string) {
    setClasses((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  }

  function finish() {
    try { localStorage.setItem(ONBOARDING_KEY, "true"); } catch {}
    onDone();
  }

  const canNext = (() => {
    if (step === 1) return belt !== "";
    if (step === 3) return style !== "";
    if (step === 4) return heard !== "";
    return true;
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      style={{ background: "rgba(0,0,0,0.85)", backdropFilter: "blur(6px)", WebkitBackdropFilter: "blur(6px)" }}
    >
      <div
        className="rounded-t-3xl flex flex-col"
        style={{ background: "var(--member-elevated)", borderTop: "1px solid var(--member-elevated-border)", maxHeight: "92vh" }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="w-10 h-1 rounded-full" style={{ background: "var(--member-text-dim)" }} />
        </div>

        {/* Progress bar */}
        {step > 0 && step < 6 && (
          <div className="px-5 pt-3 pb-1 shrink-0">
            <div className="h-0.5 rounded-full overflow-hidden" style={{ background: "var(--member-border)" }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${progress * 100}%`, background: primaryColor }}
              />
            </div>
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-5">

          {/* Step 0 — Welcome */}
          {step === 0 && (
            <div className="flex flex-col items-center text-center pt-2 pb-4">
              <div
                className="w-20 h-20 rounded-3xl flex items-center justify-center text-4xl mb-5"
                style={{ background: hex(primaryColor, 0.1), border: `1px solid ${hex(primaryColor, 0.2)}` }}
              >
                🥋
              </div>
              <h2 className="text-white text-2xl font-bold mb-2">Welcome to the gym!</h2>
              <p className="text-gray-400 text-sm leading-relaxed mb-8 max-w-xs">
                We&apos;re so glad you&apos;re here. Answer a few quick questions so we can personalise your experience on the mat.
              </p>
              <button
                onClick={() => setStep(1)}
                className="w-full py-4 rounded-2xl text-white font-bold text-base active:scale-[0.98] transition-all"
                style={{ background: primaryColor, boxShadow: `0 8px 24px ${hex(primaryColor, 0.35)}` }}
              >
                Let&apos;s Go →
              </button>
              <button onClick={finish} className="mt-3 text-gray-600 text-sm py-2 w-full">Skip for now</button>
            </div>
          )}

          {/* Step 1 — Belt */}
          {step === 1 && (
            <div>
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Question 1 of 5</p>
              <h2 className="text-white text-xl font-bold mb-5">What&apos;s your current belt?</h2>
              <div className="grid grid-cols-5 gap-2 mb-6">
                {BELTS.map((b) => {
                  const sel = belt === b.label;
                  return (
                    <button
                      key={b.label}
                      onClick={() => setBelt(b.label)}
                      className="flex flex-col items-center gap-1.5 p-2 rounded-2xl transition-all"
                      style={{
                        background: sel ? hex(primaryColor, 0.1) : "var(--member-surface)",
                        border: `1.5px solid ${sel ? primaryColor : "var(--member-border)"}`,
                      }}
                    >
                      <div className="w-8 h-3 rounded-sm" style={{ background: b.color, border: `1px solid ${b.border}` }} />
                      <span className="text-[10px] text-gray-400 leading-tight text-center">{b.label}</span>
                    </button>
                  );
                })}
              </div>
              {belt && belt !== "Black" && (
                <>
                  <p className="text-gray-400 text-sm mb-3">How many stripes?</p>
                  <div className="flex gap-2">
                    {[0, 1, 2, 3, 4].map((n) => (
                      <button
                        key={n}
                        onClick={() => setStripes(n)}
                        className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-all"
                        style={{
                          background: stripes === n ? primaryColor : "var(--member-surface)",
                          color: stripes === n ? "#fff" : "var(--member-inactive)",
                          border: `1px solid ${stripes === n ? primaryColor : "var(--member-border)"}`,
                        }}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Step 2 — Classes */}
          {step === 2 && (
            <div>
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Question 2 of 5</p>
              <h2 className="text-white text-xl font-bold mb-2">Which classes do you attend?</h2>
              <p className="text-gray-500 text-sm mb-5">Select all that apply.</p>
              <div className="flex flex-wrap gap-2">
                {CLASS_OPTIONS.map((c) => {
                  const sel = classes.includes(c);
                  return (
                    <button
                      key={c}
                      onClick={() => toggleClass(c)}
                      className="px-3.5 py-2 rounded-full text-sm font-medium transition-all"
                      style={{
                        background: sel ? hex(primaryColor, 0.15) : "var(--member-surface)",
                        color: sel ? primaryColor : "var(--member-text-muted)",
                        border: `1px solid ${sel ? primaryColor : "var(--member-border)"}`,
                      }}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 3 — Gi preference */}
          {step === 3 && (
            <div>
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Question 3 of 5</p>
              <h2 className="text-white text-xl font-bold mb-2">Training preference?</h2>
              <p className="text-gray-500 text-sm mb-5">Do you prefer training with or without a gi?</p>
              <div className="space-y-3">
                {[
                  { value: "Gi",    emoji: "🥋", desc: "Traditional gi (kimono) training" },
                  { value: "No-Gi", emoji: "👕", desc: "Shorts and rash guard training" },
                  { value: "Both",  emoji: "⚖️", desc: "I enjoy both equally" },
                ].map(({ value, emoji, desc }) => {
                  const sel = style === value;
                  return (
                    <button
                      key={value}
                      onClick={() => setStyle(value)}
                      className="w-full flex items-center gap-3 p-4 rounded-2xl transition-all text-left"
                      style={{
                        background: sel ? hex(primaryColor, 0.1) : "var(--member-surface)",
                        border: `1.5px solid ${sel ? primaryColor : "var(--member-border)"}`,
                      }}
                    >
                      <span className="text-2xl shrink-0">{emoji}</span>
                      <div className="flex-1">
                        <p className="text-white font-semibold text-sm">{value}</p>
                        <p className="text-gray-500 text-xs">{desc}</p>
                      </div>
                      {sel && <div className="w-4 h-4 rounded-full shrink-0" style={{ background: primaryColor }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 4 — How heard */}
          {step === 4 && (
            <div>
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Question 4 of 5</p>
              <h2 className="text-white text-xl font-bold mb-2">How did you find us?</h2>
              <p className="text-gray-500 text-sm mb-5">How did you hear about us?</p>
              <div className="flex flex-wrap gap-2">
                {HEARD_OPTIONS.map((opt) => {
                  const sel = heard === opt;
                  return (
                    <button
                      key={opt}
                      onClick={() => setHeard(opt)}
                      className="px-3.5 py-2 rounded-full text-sm font-medium transition-all"
                      style={{
                        background: sel ? hex(primaryColor, 0.15) : "var(--member-surface)",
                        color: sel ? primaryColor : "var(--member-text-muted)",
                        border: `1px solid ${sel ? primaryColor : "var(--member-border)"}`,
                      }}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 5 — Children */}
          {step === 5 && (
            <div>
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Question 5 of 5</p>
              <h2 className="text-white text-xl font-bold mb-2">Do you have children training here?</h2>
              <p className="text-gray-500 text-sm mb-5">We&apos;ll set up a parent account so you can track their progress too.</p>
              <div className="space-y-3">
                {[
                  { value: true,  emoji: "👨‍👧", label: "Yes — I have children at the gym", desc: "You can add child profiles in your account" },
                  { value: false, emoji: "👤",   label: "No — just me",                     desc: "You can always add them later in your profile" },
                ].map(({ value, emoji, label, desc }) => {
                  const sel = hasKids === value;
                  return (
                    <button
                      key={label}
                      onClick={() => setHasKids(value)}
                      className="w-full flex items-center gap-3 p-4 rounded-2xl transition-all text-left"
                      style={{
                        background: sel ? hex(primaryColor, 0.1) : "var(--member-surface)",
                        border: `1.5px solid ${sel ? primaryColor : "var(--member-border)"}`,
                      }}
                    >
                      <span className="text-2xl shrink-0">{emoji}</span>
                      <div className="flex-1">
                        <p className="text-white font-semibold text-sm">{label}</p>
                        <p className="text-gray-500 text-xs">{desc}</p>
                      </div>
                      {sel && <div className="w-4 h-4 rounded-full shrink-0" style={{ background: primaryColor }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Step 6 — Done */}
          {step === 6 && (
            <div className="flex flex-col items-center text-center pt-2 pb-4">
              <div
                className="w-20 h-20 rounded-full flex items-center justify-center text-4xl mb-5"
                style={{ background: hex(primaryColor, 0.1), border: `1px solid ${hex(primaryColor, 0.2)}` }}
              >
                🎉
              </div>
              <h2 className="text-white text-2xl font-bold mb-2">You&apos;re all set!</h2>
              <p className="text-gray-400 text-sm leading-relaxed mb-8 max-w-xs">
                Welcome to the mat, {memberName}. Your profile has been personalised
                {hasKids ? " and your parent account is ready. Add your children in Profile." : ". Time to roll!"}
              </p>
              <button
                onClick={finish}
                className="w-full py-4 rounded-2xl text-white font-bold text-base active:scale-[0.98] transition-all"
                style={{ background: primaryColor, boxShadow: `0 8px 24px ${hex(primaryColor, 0.35)}` }}
              >
                Start Exploring →
              </button>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        {step > 0 && step < 6 && (
          <div
            className="shrink-0 flex gap-3 px-5 pb-6"
            style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <button
              onClick={() => setStep((s) => s - 1)}
              className="px-5 py-3.5 rounded-2xl text-sm font-medium"
              style={{ background: "var(--member-surface)", color: "var(--member-text-muted)" }}
            >
              Back
            </button>
            <button
              onClick={() => setStep((s) => s + 1)}
              disabled={!canNext}
              className="flex-1 py-3.5 rounded-2xl text-white font-semibold text-sm transition-all disabled:opacity-30"
              style={{ background: primaryColor }}
            >
              {step === 5 ? "Finish ✓" : "Next →"}
            </button>
          </div>
        )}

        {/* Done button */}
        {step === 6 && <div style={{ paddingBottom: "env(safe-area-inset-bottom)" }} />}
      </div>
    </div>
  );
}

// ─── Sign-In Sheet ────────────────────────────────────────────────────────────

function SignInSheet({ onClose, primaryColor, classes }: { onClose: () => void; primaryColor: string; classes: TodayClass[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function signIn() {
    if (!selected) return;
    setDone(true);
    setTimeout(onClose, 1800);
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/70 z-40" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 z-50 rounded-t-3xl pb-safe"
        style={{ background: "var(--member-elevated)", borderTop: "1px solid var(--member-elevated-border)" }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 mb-1">
          <div className="w-10 h-1 rounded-full bg-white/15" />
        </div>

        <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
          <h2 className="text-white font-semibold text-base">Sign in to a class</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400"
            style={{ background: "var(--member-border)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {done ? (
          <div className="flex flex-col items-center py-10 px-5">
            <div className="w-14 h-14 rounded-full flex items-center justify-center mb-3" style={{ background: hex(primaryColor, 0.15) }}>
              <CheckCircle2 className="w-7 h-7" style={{ color: primaryColor }} />
            </div>
            <p className="text-white font-semibold">Signed in!</p>
            <p className="text-gray-500 text-sm mt-1">
              {todayClasses.find((c) => c.id === selected)?.name}
            </p>
          </div>
        ) : (
          <div className="px-4 py-3 space-y-2">
            <p className="text-gray-500 text-xs mb-3">Select your class for today:</p>
            {classes.map((cls) => {
              const isSel = selected === cls.id;
              const almostFull = cls.capacity && cls.spots != null && cls.spots <= 3;
              const full = cls.capacity && cls.spots != null && cls.spots <= 0;
              return (
                <button
                  key={cls.id}
                  onClick={() => setSelected(cls.id)}
                  className="w-full rounded-2xl border p-4 flex items-center gap-3 transition-all text-left active:scale-[0.99]"
                  style={{
                    background: isSel ? hex(primaryColor, 0.1) : "var(--member-surface)",
                    borderColor: isSel ? primaryColor : "var(--member-border)",
                  }}
                >
                  <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: primaryColor }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-sm">{cls.name}</p>
                    <p className="text-gray-500 text-xs mt-0.5">{cls.time}–{cls.endTime} · {cls.coach}</p>
                  </div>
                  {cls.spots != null && (
                    <span className="text-xs shrink-0" style={{ color: full ? "#ef4444" : almostFull ? "#f59e0b" : "var(--member-text-muted)" }}>
                      {full ? "Full" : `${cls.spots} left`}
                    </span>
                  )}
                  {isSel && <div className="w-4 h-4 rounded-full shrink-0" style={{ background: primaryColor }} />}
                </button>
              );
            })}

            <button
              onClick={signIn}
              disabled={!selected}
              className="w-full py-3.5 rounded-2xl text-white font-semibold text-sm mt-2 transition-all disabled:opacity-30"
              style={{ background: primaryColor }}
            >
              Confirm Sign In
            </button>
          </div>
        )}
        <div className="h-4" />
      </div>
    </>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayDow() {
  // Returns 1=Mon … 7=Sun (matches ClassSchedule.dayOfWeek)
  const d = new Date().getDay();
  return d === 0 ? 7 : d;
}

export default function MemberHomePage() {
  const [showSignIn, setShowSignIn]         = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [memberName, setMemberName]         = useState("Alex");
  const [todayClasses, setTodayClasses]     = useState<TodayClass[]>(DEMO_TODAY_CLASSES);
  const [announcements, setAnnouncements]   = useState<Announcement[]>(DEMO_ANNOUNCEMENTS);
  const primaryColor = PRIMARY;

  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) setShowOnboarding(true);
    } catch {}

    // Fetch member profile
    fetch("/api/member/me")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.name) setMemberName(data.name.split(" ")[0]);
      })
      .catch(() => {});

    // Fetch schedule and filter to today's classes
    fetch("/api/member/schedule")
      .then((r) => r.ok ? r.json() : null)
      .then((data: Array<{ id: string; name: string; startTime: string; endTime: string; coach: string; location: string; capacity: number | null; dayOfWeek: number }> | null) => {
        if (!Array.isArray(data)) return;
        const dow = todayDow();
        const filtered: TodayClass[] = data
          .filter((c) => c.dayOfWeek === dow)
          .map((c) => ({ id: c.id, name: c.name, time: c.startTime, endTime: c.endTime, coach: c.coach, location: c.location, spots: null, capacity: c.capacity }))
          .sort((a, b) => a.time.localeCompare(b.time));
        if (filtered.length > 0) setTodayClasses(filtered);
      })
      .catch(() => {});

    // Fetch announcements
    fetch("/api/announcements")
      .then((r) => r.ok ? r.json() : null)
      .then((data: Array<{ id: string; title: string; body: string; pinned: boolean; imageUrl?: string | null; createdAt: string }> | null) => {
        if (!Array.isArray(data) || data.length === 0) return;
        const mapped: Announcement[] = data.map((a) => ({
          id: a.id,
          title: a.title,
          body: a.body,
          pinned: a.pinned,
          imageUrl: a.imageUrl ?? undefined,
          time: new Date(a.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
        }));
        setAnnouncements(mapped);
      })
      .catch(() => {});
  }, []);

  const upcomingClasses = todayClasses.filter((c) => {
    const [h, m] = c.time.split(":").map(Number);
    const now = new Date();
    return h > now.getHours() || (h === now.getHours() && m >= now.getMinutes());
  });

  return (
    <>
      {/* Greeting */}
      <div className="px-5 pt-5 pb-5">
        <h1 className="text-white text-2xl font-bold tracking-tight leading-tight">
          {greeting()},<br />
          <span style={{ color: primaryColor }}>{memberName}</span>
        </h1>
        <p className="text-gray-500 text-sm mt-1">{today()}</p>
      </div>

      {/* ── Sign In CTA ── */}
      <div className="px-5 mb-6">
        <button
          onClick={() => setShowSignIn(true)}
          className="w-full py-4 rounded-2xl flex items-center justify-center gap-2.5 font-bold text-white text-base transition-all active:scale-[0.98] shadow-lg"
          style={{
            background: `linear-gradient(135deg, ${primaryColor}, ${hex(primaryColor, 0.7)})`,
            boxShadow: `0 8px 32px ${hex(primaryColor, 0.35)}`,
          }}
        >
          <QrCode className="w-5 h-5" />
          Sign In to Class
        </button>
      </div>

      {/* ── Today's Classes ── */}
      <div className="px-5 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-semibold text-sm">Today&apos;s Classes</h2>
          <span className="text-gray-600 text-xs">{todayClasses.length} classes</span>
        </div>

        <div className="space-y-2">
          {classes.map((cls) => {
            const isPast = (() => {
              const [h] = cls.time.split(":").map(Number);
              return h < new Date().getHours();
            })();
            const almostFull = cls.capacity && cls.spots != null && cls.spots <= 3;
            const full = cls.capacity && cls.spots != null && cls.spots <= 0;

            return (
              <div
                key={cls.id}
                className="rounded-2xl border p-4 flex items-center gap-3"
                style={{
                  background: isPast ? "var(--member-surface)" : "var(--member-surface)",
                  borderColor: isPast ? "var(--member-surface)" : "var(--member-border)",
                  opacity: isPast ? 0.5 : 1,
                }}
              >
                <div className="w-1 self-stretch rounded-full shrink-0" style={{ background: isPast ? "var(--member-text-dim)" : primaryColor }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-semibold text-sm">{cls.name}</span>
                    {full && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400">FULL</span>}
                    {almostFull && !full && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400">ALMOST FULL</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-1 flex-wrap">
                    <span className="flex items-center gap-1 text-gray-500 text-xs">
                      <Clock className="w-3 h-3" />{cls.time}–{cls.endTime}
                    </span>
                    <span className="flex items-center gap-1 text-gray-500 text-xs">
                      <Users className="w-3 h-3" />{cls.coach}
                    </span>
                    <span className="flex items-center gap-1 text-gray-500 text-xs">
                      <MapPin className="w-3 h-3" />{cls.location}
                    </span>
                  </div>
                </div>
                {cls.spots != null && cls.capacity && (
                  <div className="text-right shrink-0">
                    <p className="text-xs font-semibold" style={{ color: full ? "#ef4444" : almostFull ? "#f59e0b" : "var(--member-text-muted)" }}>
                      {full ? "Full" : `${cls.spots}/${cls.capacity}`}
                    </p>
                    <p className="text-gray-700 text-[10px]">spots</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Announcements ── */}
      <div className="px-5 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Megaphone className="w-4 h-4 text-gray-500" />
          <h2 className="text-white font-semibold text-sm">Announcements</h2>
        </div>

        <div className="space-y-3">
          {announcements.map((a) => (
            <AnnouncementCard key={a.id} a={a} primaryColor={primaryColor} />
          ))}
        </div>
      </div>

      {/* Sign-in sheet */}
      {showSignIn && (
        <SignInSheet onClose={() => setShowSignIn(false)} primaryColor={primaryColor} classes={todayClasses} />
      )}

      {/* First-time onboarding questionnaire */}
      {showOnboarding && (
        <OnboardingModal onDone={() => setShowOnboarding(false)} primaryColor={primaryColor} />
      )}
    </>
  );
}
