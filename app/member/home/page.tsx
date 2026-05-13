"use client";

import React, { useState, useEffect, useRef } from "react";
import { QrCode, Clock, Users, MapPin, Megaphone, X, CheckCircle2, ExternalLink, ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import Image from "next/image";
import SignaturePad, { type SignaturePadHandle } from "@/components/ui/SignaturePad";
import AnnouncementModal from "@/components/member/AnnouncementModal";
import { linkify } from "@/lib/linkify";
import { useSwipeToDismiss } from "@/lib/useSwipeToDismiss";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TodayClass { id: string; name: string; time: string; endTime: string; coach: string; location: string; spots: number | null; capacity: number | null; classInstanceId?: string | null; }
interface AnnouncementLink { label: string; url: string; }
interface Announcement { id: string; title: string; body: string; time: string; pinned: boolean; imageUrl?: string; links?: AnnouncementLink[]; unseen?: boolean; }

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

function AnnouncementCard({ a, primaryColor, onOpenModal }: { a: Announcement; primaryColor: string; onOpenModal: (a: Announcement, el: HTMLElement) => void }) {
  const [expanded, setExpanded] = useState(a.pinned); // pinned start expanded
  const cardRef = useRef<HTMLButtonElement>(null);

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
        ref={cardRef}
        onClick={() => {
          if (cardRef.current) onOpenModal(a, cardRef.current);
        }}
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
          <p className="text-gray-300 text-sm leading-relaxed">{linkify(a.body)}</p>

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

const MEDICAL_OPTIONS = [
  "Asthma", "Heart condition", "High blood pressure", "Diabetes",
  "Epilepsy", "Joint / ligament injuries", "Back / spine condition",
  "Pregnancy", "Recent surgery", "None of the above",
];

function OnboardingModal({ onDone, primaryColor, memberName }: { onDone: () => void; primaryColor: string; memberName: string }) {
  const [step, setStep]       = useState(0);
  const [belt, setBelt]       = useState("");
  const [stripes, setStripes] = useState(0);
  const [classes, setClasses] = useState<string[]>([]);
  const [style, setStyle]     = useState("");
  const [heard, setHeard]     = useState("");
  // Session E follow-up: parent-only onboarding fork. When true, skip the
  // training-self steps (belt / classes / style / heard) and jump straight to
  // the kids step. Driven by the picker on step 0; persists into finish()
  // where we PATCH accountType="parent" instead of "adult".
  const [parentOnly, setParentOnly] = useState(false);
  // Step 5: parent adds 0..N kid Members inline. Empty array == "no kids".
  // `hasKids` is derived (kids.length > 0) — drives both the legacy
  // hasKidsHint flag on the parent record and the success-message copy below.
  const [kids, setKids] = useState<Array<{ name: string; dateOfBirth: string }>>([]);
  const hasKids = kids.length > 0;

  // Step 6 — health & emergency
  const [emergencyName, setEmergencyName]   = useState("");
  const [emergencyPhone, setEmergencyPhone] = useState("");
  const [emergencyRelation, setEmergencyRelation] = useState("");
  const [medicalConds, setMedicalConds]     = useState<string[]>([]);
  const [dateOfBirth, setDateOfBirth]       = useState("");
  const [preferNoDob, setPreferNoDob]       = useState(false);

  // Step 7 — waiver
  const [waiverChecked, setWaiverChecked] = useState(false);
  const [waiverName, setWaiverName]       = useState("");
  const [signatureEmpty, setSignatureEmpty] = useState(true);
  const signaturePadRef = useRef<SignaturePadHandle>(null);
  const [finishing, setFinishing]         = useState(false);
  const [submitError, setSubmitError]     = useState<string | null>(null);
  const [waiverTitle, setWaiverTitle]     = useState("Liability Waiver & Assumption of Risk");
  const [waiverBody, setWaiverBody]       = useState("");
  const [waiverLoadError, setWaiverLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (step === 7 && !waiverBody) {
      setWaiverLoadError(null);
      fetch("/api/waiver")
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.title) setWaiverTitle(data.title);
          if (data?.content) setWaiverBody(data.content);
        })
        .catch((e) => setWaiverLoadError(e instanceof Error ? e.message : "Couldn't load waiver — using default text"));
    }
  }, [step, waiverBody]);

  const TOTAL = 7;
  // Parent-only users visit just Steps 5, 6, 7 — compute progress against
  // those three steps so the bar reads monotonically instead of jumping
  // from 0% to 71% on the first answer.
  const progress = step > 0 && step < 8
    ? (parentOnly ? Math.max(0, step - 4) / 3 : step / TOTAL)
    : 0;

  function toggleClass(c: string) {
    setClasses((prev) => prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]);
  }

  function toggleMedical(opt: string) {
    setMedicalConds((prev) => {
      if (opt === "None of the above") return prev.includes(opt) ? [] : ["None of the above"];
      const without = prev.filter((x) => x !== "None of the above");
      return without.includes(opt) ? without.filter((x) => x !== opt) : [...without, opt];
    });
  }

  async function finish() {
    setFinishing(true);
    setSubmitError(null);
    try { localStorage.setItem(ONBOARDING_KEY, "true"); } catch {}

    // Submit the rest of onboarding (without waiverAccepted — the dedicated
    // /api/waiver/sign endpoint handles waiver flipping).
    const meRes = await fetch("/api/member/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        onboardingCompleted: true,
        // Parent-only users skip the belt step entirely; do not write a
        // stale empty-string belt or 0 stripes onto their profile —
        // those fields belong to a training member, not a guardian.
        ...(parentOnly ? { accountType: "parent" } : { belt, stripes }),
        emergencyContactName: emergencyName || undefined,
        emergencyContactPhone: emergencyPhone || undefined,
        emergencyContactRelation: emergencyRelation || undefined,
        medicalConditions: medicalConds,
        dateOfBirth: (!preferNoDob && dateOfBirth) ? dateOfBirth : undefined,
        // Sprint 3 K: persist the step-5 answer so the gym can follow up.
        // Now derived from the parent-managed kids[] state instead of a
        // standalone yes/no toggle.
        hasKidsHint: hasKids ? true : undefined,
      }),
    });
    if (!meRes.ok) {
      setFinishing(false);
      setSubmitError("Couldn't save your details. Tap to retry.");
      return;
    }

    // Create each kid Member. Server enforces parent-not-nested + max-10 cap.
    // If one kid POST fails we stop and surface — onboarding can be retried
    // (the meRes PATCH is idempotent on the same fields), so the user doesn't
    // get half-stored state.
    for (const kid of kids) {
      const trimmed = kid.name.trim();
      if (!trimmed) continue;
      const kidRes = await fetch("/api/member/children", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          dateOfBirth: kid.dateOfBirth || undefined,
          accountType: "kids",
        }),
      });
      if (!kidRes.ok) {
        setFinishing(false);
        setSubmitError(`Couldn't save child profile (${trimmed}). Tap to retry.`);
        return;
      }
    }

    // Submit the drawn signature alongside the typed name.
    const signatureDataUrl = signaturePadRef.current?.getDataUrl();
    if (waiverChecked && waiverName.trim().length > 0 && signatureDataUrl) {
      const sigRes = await fetch("/api/waiver/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signatureDataUrl,
          signerName: waiverName.trim(),
          agreedTo: true,
        }),
      });
      if (!sigRes.ok) {
        setFinishing(false);
        setSubmitError("Couldn't save your signature. Tap to retry.");
        return;
      }
    }

    setFinishing(false);
    setStep(8);
  }

  const canNext = (() => {
    if (step === 1) return belt !== "";
    if (step === 3) return style !== "";
    if (step === 4) return heard !== "";
    // Step 5 — kids are optional, but every visible kid card must have a name
    // before continuing (avoids silently dropping a half-filled row).
    if (step === 5) return kids.every((k) => k.name.trim().length > 0);
    if (step === 6) return emergencyName.trim().length > 0 && emergencyPhone.trim().length > 0 && emergencyRelation.trim().length > 0;
    if (step === 7) return waiverChecked && waiverName.trim().length > 0 && !signatureEmpty;
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
        {step > 0 && step < 8 && (
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

          {/* Step 0 — Welcome + training-vs-parent fork.
              Picking "I train" runs the full 7-step flow.
              Picking "Manage my child" jumps to Step 5 (kids) and skips
              Steps 1-4 (belt / classes / style / heard). The user still
              hits Steps 6-7 (emergency + waiver) because they have
              on-premises liability when collecting / spectating. */}
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
                What brings you here? We&apos;ll personalise the rest of the questions based on this.
              </p>
              <button
                data-testid="onboarding-i-train"
                onClick={() => { setParentOnly(false); setStep(1); }}
                className="w-full py-4 rounded-2xl text-white font-bold text-base active:scale-[0.98] transition-all mb-3"
                style={{ background: primaryColor, boxShadow: `0 8px 24px ${hex(primaryColor, 0.35)}` }}
              >
                I train at this gym →
              </button>
              <button
                data-testid="onboarding-i-parent"
                onClick={() => { setParentOnly(true); setStep(5); }}
                className="w-full py-4 rounded-2xl font-semibold text-base active:scale-[0.98] transition-all"
                style={{
                  background: "var(--member-surface)",
                  border: `1.5px solid ${hex(primaryColor, 0.3)}`,
                  color: primaryColor,
                }}
              >
                I&apos;m here to manage my child →
              </button>
              <button onClick={onDone} className="mt-3 text-gray-600 text-sm py-2 w-full">Skip for now</button>
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

          {/* Step 5 — Children (inline add). Server caps at 10 kids per parent. */}
          {step === 5 && (
            <div>
              <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Question 5 of 5</p>
              <h2 className="text-white text-xl font-bold mb-2">Any children training here?</h2>
              <p className="text-gray-500 text-sm mb-5">
                Add their names and you&apos;ll be able to sign them into class and see their belt progress from your account. Skip if not applicable.
              </p>
              <div className="space-y-3">
                {kids.map((kid, idx) => (
                  <div
                    key={idx}
                    className="rounded-2xl p-3"
                    style={{ background: "var(--member-surface)", border: "1px solid var(--member-border)" }}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-lg">👶</span>
                      <input
                        autoFocus={idx === kids.length - 1 && !kid.name}
                        value={kid.name}
                        onChange={(e) =>
                          setKids((arr) => arr.map((k, i) => (i === idx ? { ...k, name: e.target.value } : k)))
                        }
                        placeholder="Child's name"
                        className="flex-1 rounded-lg px-2 py-2 text-white text-sm outline-none border placeholder-gray-600"
                        style={{ background: "var(--member-elevated)", borderColor: "var(--member-border)" }}
                      />
                      <button
                        type="button"
                        onClick={() => setKids((arr) => arr.filter((_, i) => i !== idx))}
                        aria-label={`Remove ${kid.name || "child"}`}
                        className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 shrink-0"
                        style={{ background: "var(--member-border)" }}
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                    <label className="text-gray-500 text-[10px] uppercase tracking-wider block mb-1">Date of birth (optional)</label>
                    <input
                      type="date"
                      value={kid.dateOfBirth}
                      onChange={(e) =>
                        setKids((arr) => arr.map((k, i) => (i === idx ? { ...k, dateOfBirth: e.target.value } : k)))
                      }
                      className="w-full rounded-lg px-2 py-2 text-white text-sm outline-none border"
                      style={{ background: "var(--member-elevated)", borderColor: "var(--member-border)" }}
                    />
                  </div>
                ))}

                <button
                  type="button"
                  onClick={() => kids.length < 10 && setKids((arr) => [...arr, { name: "", dateOfBirth: "" }])}
                  disabled={kids.length >= 10}
                  className="w-full p-4 rounded-2xl text-sm font-medium transition-all disabled:opacity-30"
                  style={{
                    background: "var(--member-surface)",
                    border: `1.5px dashed ${primaryColor}`,
                    color: primaryColor,
                  }}
                >
                  {kids.length === 0 ? "+ Add a child" : kids.length >= 10 ? "Max 10 children" : "+ Add another child"}
                </button>

                {kids.length === 0 && (
                  <p className="text-gray-600 text-xs text-center pt-1">
                    You can also add children later from your profile.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Step 6 — Health & Emergency Contact */}
          {step === 6 && (
            <div className="space-y-5">
              <div>
                <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Step 6 of 7</p>
                <h2 className="text-white text-xl font-bold mb-1">Health & Emergency Contact</h2>
                <p className="text-gray-500 text-sm">This information is kept confidential and used only in emergencies.</p>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-gray-500 text-xs font-medium block mb-1.5">Date of birth</label>
                  {preferNoDob ? (
                    <p className="text-gray-500 text-sm">Not provided</p>
                  ) : (
                    <input
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      className="w-full rounded-xl px-3 py-2.5 text-sm outline-none border"
                      style={{ background: "var(--member-surface)", borderColor: "var(--member-border)", color: "white" }}
                    />
                  )}
                  <button
                    onClick={() => { setPreferNoDob((v) => !v); setDateOfBirth(""); }}
                    className="mt-1.5 text-xs"
                    style={{ color: "var(--member-text-muted)" }}
                  >
                    {preferNoDob ? "Enter date of birth" : "Prefer not to say"}
                  </button>
                </div>

                <div>
                  <label className="text-gray-500 text-xs font-medium block mb-1.5">Emergency contact name *</label>
                  <input
                    value={emergencyName}
                    onChange={(e) => setEmergencyName(e.target.value)}
                    placeholder="e.g. Jane Smith"
                    className="w-full rounded-xl px-3 py-2.5 text-white text-sm outline-none border placeholder-gray-600"
                    style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
                  />
                </div>

                <div>
                  <label className="text-gray-500 text-xs font-medium block mb-1.5">Emergency contact phone *</label>
                  <input
                    type="tel"
                    value={emergencyPhone}
                    onChange={(e) => setEmergencyPhone(e.target.value)}
                    placeholder="+44 7700 000000"
                    className="w-full rounded-xl px-3 py-2.5 text-white text-sm outline-none border placeholder-gray-600"
                    style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
                  />
                </div>

                <div>
                  <label className="text-gray-500 text-xs font-medium block mb-1.5">Emergency contact relation *</label>
                  <input
                    value={emergencyRelation}
                    onChange={(e) => setEmergencyRelation(e.target.value)}
                    placeholder="Parent, partner, friend..."
                    className="w-full rounded-xl px-3 py-2.5 text-white text-sm outline-none border placeholder-gray-600"
                    style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
                  />
                </div>

                <div>
                  <label className="text-gray-500 text-xs font-medium block mb-2">Medical conditions (select all that apply)</label>
                  <div className="flex flex-wrap gap-2">
                    {MEDICAL_OPTIONS.map((opt) => {
                      const sel = medicalConds.includes(opt);
                      return (
                        <button
                          key={opt}
                          onClick={() => toggleMedical(opt)}
                          className="px-3 py-1.5 rounded-full text-xs font-medium transition-all border"
                          style={{
                            background: sel ? hex(primaryColor, 0.15) : "var(--member-surface)",
                            borderColor: sel ? primaryColor : "var(--member-border)",
                            color: sel ? primaryColor : "var(--member-text-muted)",
                          }}
                        >
                          {opt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 7 — Liability Waiver */}
          {step === 7 && (
            <div className="space-y-4">
              <div>
                <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-1">Step 7 of 7</p>
                <h2 className="text-white text-xl font-bold mb-1">Liability Waiver</h2>
                <p className="text-gray-500 text-sm">Please read and sign to complete your registration.</p>
              </div>

              {waiverLoadError && (
                <p className="text-amber-400 text-xs px-1">{waiverLoadError}</p>
              )}

              <div
                className="rounded-2xl border p-4 h-52 overflow-y-auto text-xs leading-relaxed space-y-2"
                style={{ background: "var(--member-surface)", borderColor: "var(--member-border)", color: "var(--member-text-muted)" }}
              >
                <p className="font-semibold text-white">{waiverTitle}</p>
                {(waiverBody || "I acknowledge that martial arts and combat sports involve physical contact, which carries an inherent risk of injury. By signing this waiver, I voluntarily accept all risks associated with training and participation at this facility.\n\nI agree to follow all gym rules, coach instructions, and safety guidelines at all times. I confirm that I am physically fit to participate and have disclosed any known medical conditions or injuries that may affect my training.\n\nI release the gym, its owners, coaches, staff, and affiliates from any liability for injury, loss, or damage arising from my participation, except in cases of gross negligence or wilful misconduct.\n\nThis waiver applies to all activities on the premises including classes, open mat sessions, and any gym-organised events.\n\nI confirm I have read this waiver, understand its contents, and agree to be bound by its terms.")
                  .split("\n\n").map((para, i) => <p key={i}>{para}</p>)}
              </div>

              <label className="flex items-start gap-3 cursor-pointer">
                <div
                  className="w-5 h-5 rounded flex items-center justify-center shrink-0 mt-0.5 border transition-all"
                  style={{ background: waiverChecked ? primaryColor : "transparent", borderColor: waiverChecked ? primaryColor : "var(--member-border)" }}
                  onClick={() => setWaiverChecked((v) => !v)}
                >
                  {waiverChecked && <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none"><path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                </div>
                <span className="text-gray-400 text-sm leading-tight">I have read and agree to the liability waiver above</span>
              </label>

              <div>
                <label className="text-gray-500 text-xs font-medium block mb-1.5">Type your full name to sign *</label>
                <input
                  value={waiverName}
                  onChange={(e) => setWaiverName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full rounded-xl px-3 py-2.5 text-white text-sm outline-none border placeholder-gray-600"
                  style={{ background: "var(--member-surface)", borderColor: "var(--member-border)" }}
                />
              </div>

              <div>
                <label className="text-gray-500 text-xs font-medium block mb-1.5">Draw your signature *</label>
                <SignaturePad
                  ref={signaturePadRef}
                  onChange={(empty) => setSignatureEmpty(empty)}
                  height={160}
                />
              </div>
            </div>
          )}

          {/* Step 8 — Done */}
          {step === 8 && (
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
                {hasKids
                  ? `. ${kids.length} child profile${kids.length === 1 ? "" : "s"} added — you can sign them into class from this app.`
                  : ". Time to roll!"}
              </p>
              <button
                onClick={onDone}
                className="w-full py-4 rounded-2xl text-white font-bold text-base active:scale-[0.98] transition-all"
                style={{ background: primaryColor, boxShadow: `0 8px 24px ${hex(primaryColor, 0.35)}` }}
              >
                Start Exploring →
              </button>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        {step > 0 && step < 8 && (
          <div
            className="shrink-0 flex gap-3 px-5 pb-6"
            style={{ paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
          >
            <button
              onClick={() =>
                setStep((s) =>
                  // Parent-only mode skips Steps 1-4 entirely, so Back from
                  // Step 5 should land on Step 0 (the welcome fork) and not
                  // try to render Step 4. Training mode keeps the linear
                  // one-step-back behaviour.
                  parentOnly && s === 5 ? 0 : s - 1
                )
              }
              className="px-5 py-3.5 rounded-2xl text-sm font-medium"
              style={{ background: "var(--member-surface)", color: "var(--member-text-muted)" }}
            >
              Back
            </button>
            {step === 7 ? (
              <div className="flex-1 flex flex-col gap-2">
                {submitError && (
                  <button
                    onClick={() => { setSubmitError(null); finish(); }}
                    className="w-full py-2 px-3 rounded-xl text-xs font-medium text-center transition-colors"
                    style={{ background: "rgba(239,68,68,0.12)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" }}
                  >
                    {submitError}
                  </button>
                )}
                <button
                  onClick={finish}
                  disabled={!canNext || finishing}
                  className="w-full py-3.5 rounded-2xl text-white font-semibold text-sm transition-all disabled:opacity-30 flex items-center justify-center gap-2"
                  style={{ background: primaryColor }}
                >
                  {finishing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Finish ✓"}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={!canNext}
                className="flex-1 py-3.5 rounded-2xl text-white font-semibold text-sm transition-all disabled:opacity-30"
                style={{ background: primaryColor }}
              >
                Next →
              </button>
            )}
          </div>
        )}

        {/* Done button */}
        {step === 8 && <div style={{ paddingBottom: "env(safe-area-inset-bottom)" }} />}
      </div>
    </div>
  );
}

// ─── Sign-In Sheet ────────────────────────────────────────────────────────────

function SignInSheet({
  onClose,
  primaryColor,
  classes,
  kids,
  memberName,
}: {
  onClose: () => void;
  primaryColor: string;
  classes: TodayClass[];
  kids: Array<{ id: string; name: string }>;
  memberName: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  // Session E (kids): which family member is signing in. null === parent.
  const [signingInAs, setSigningInAs] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { handleProps, sheetStyle } = useSwipeToDismiss(onClose);

  async function signIn() {
    if (!selected) return;
    const cls = classes.find((c) => c.id === selected);
    if (!cls) return;

    if (cls.classInstanceId) {
      setLoading(true);
      setError(null);
      try {
        const payload: { classInstanceId: string; checkInMethod: "self"; onBehalfOfMemberId?: string } = {
          classInstanceId: cls.classInstanceId,
          checkInMethod: "self",
        };
        // If a kid is picked, send onBehalfOfMemberId. Server verifies the
        // parent-of-kid relationship + tenant — we never trust this client-side.
        if (signingInAs) payload.onBehalfOfMemberId = signingInAs;
        const res = await fetch("/api/checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok && res.status !== 409) {
          setError(data.error ?? "Sign-in failed. Please try again.");
          setLoading(false);
          return;
        }
      } catch {
        setError("Could not connect. Please try again.");
        setLoading(false);
        return;
      }
      setLoading(false);
    }

    setDone(true);
    setTimeout(onClose, 1800);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col justify-end"
      style={{ paddingBottom: "var(--member-nav-clearance)" }}
    >
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden="true" />
      <div
        className="relative rounded-t-3xl"
        style={{
          background: "var(--member-elevated)",
          borderTop: "1px solid var(--member-elevated-border)",
          maxHeight: "calc(100dvh - var(--member-nav-clearance))",
          ...sheetStyle,
        }}
      >
        {/* Handle — swipe down to dismiss */}
        <div className="flex justify-center pt-3 pb-2" {...handleProps}>
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
            <p className="text-white font-semibold">
              {signingInAs ? `${kids.find((k) => k.id === signingInAs)?.name ?? "Child"} signed in!` : "Signed in!"}
            </p>
            <p className="text-gray-500 text-sm mt-1">
              {classes.find((c: TodayClass) => c.id === selected)?.name}
            </p>
          </div>
        ) : (
          <div className="px-4 py-3 space-y-2">
            {/* Kid picker — only renders when the parent has at least 1 kid.
                Single-row of name pills, no extra cognitive load when not used. */}
            {kids.length > 0 && (
              <div className="mb-3">
                <p className="text-gray-500 text-xs mb-2">Who&apos;s signing in?</p>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => setSigningInAs(null)}
                    className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                    style={{
                      background: signingInAs === null ? hex(primaryColor, 0.15) : "var(--member-surface)",
                      color: signingInAs === null ? primaryColor : "var(--member-text-muted)",
                      border: `1px solid ${signingInAs === null ? primaryColor : "var(--member-border)"}`,
                    }}
                  >
                    {memberName || "Me"}
                  </button>
                  {kids.map((k) => {
                    const sel = signingInAs === k.id;
                    return (
                      <button
                        key={k.id}
                        onClick={() => setSigningInAs(k.id)}
                        className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
                        style={{
                          background: sel ? hex(primaryColor, 0.15) : "var(--member-surface)",
                          color: sel ? primaryColor : "var(--member-text-muted)",
                          border: `1px solid ${sel ? primaryColor : "var(--member-border)"}`,
                        }}
                      >
                        {k.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

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

            {error && (
              <p className="text-red-400 text-xs text-center mt-1 mb-1">{error}</p>
            )}
            <button
              onClick={signIn}
              disabled={!selected || loading}
              className="w-full py-3.5 rounded-2xl text-white font-semibold text-sm mt-2 transition-all disabled:opacity-30 flex items-center justify-center gap-2"
              style={{ background: primaryColor }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Confirm Sign In"}
            </button>
          </div>
        )}
        <div className="h-4" />
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

function todayDow() {
  // Returns 0=Sun, 1=Mon … 6=Sat (matches DB convention: admin stores 0-6 via TimetableManager)
  return new Date().getDay();
}

export default function MemberHomePage() {
  const [showSignIn, setShowSignIn]         = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [memberName, setMemberName]         = useState("Alex");
  const [todayClasses, setTodayClasses]     = useState<TodayClass[]>(DEMO_TODAY_CLASSES);
  const [announcements, setAnnouncements]   = useState<Announcement[]>(DEMO_ANNOUNCEMENTS);
  const [primaryColor, setPrimaryColor]     = useState(PRIMARY);
  const [nextClass, setNextClass]           = useState<{ id: string; name: string; coach: string | null; location: string | null; date: string; startTime: string; endTime: string } | null>(null);
  const [loadError, setLoadError]           = useState<string | null>(null);
  const [openedAnnouncement, setOpenedAnnouncement] = useState<Announcement | null>(null);
  const announcementTriggerRef = useRef<HTMLElement | null>(null);
  // Session E (kids): drives the "Who's signing in?" picker inside SignInSheet.
  const [kidsRoster, setKidsRoster] = useState<Array<{
    id: string;
    name: string;
    belt: { name: string; color: string; stripes: number } | null;
    totalClasses: number;
    dateOfBirth: string | null;
  }>>([]);
  // US-2: parent-mode dashboard. When accountType==="parent" we surface a
  // dedicated "Your kids" feed above the personal "Next class" hero so a
  // guardian with no attendance themselves sees their family first.
  const [accountType, setAccountType] = useState<string | null>(null);

  function loadPageData() {
    setLoadError(null);

    // Fetch member profile
    fetch("/api/member/me")
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.name) setMemberName(data.name.split(" ")[0]);
        if (data?.primaryColor) setPrimaryColor(data.primaryColor);
        if (data?.onboardingCompleted) setShowOnboarding(false);
        if (data?.nextClass) setNextClass(data.nextClass);
        if (typeof data?.accountType === "string") setAccountType(data.accountType);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"));

    // Fetch schedule and filter to today's classes; include date so API returns classInstanceId
    const dateStr = new Date().toISOString().split("T")[0];
    fetch(`/api/member/schedule?date=${dateStr}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: Array<{ id: string; name: string; startTime: string; endTime: string; coach: string; location: string; capacity: number | null; dayOfWeek: number; classInstanceId?: string | null }> | null) => {
        if (!Array.isArray(data)) return;
        const dow = todayDow();
        const filtered: TodayClass[] = data
          .filter((c) => c.dayOfWeek === dow)
          .map((c) => ({ id: c.id, name: c.name, time: c.startTime, endTime: c.endTime, coach: c.coach, location: c.location, spots: null, capacity: c.capacity, classInstanceId: c.classInstanceId ?? null }))
          .sort((a, b) => a.time.localeCompare(b.time));
        if (filtered.length > 0) setTodayClasses(filtered);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"));

    // Fetch kids for both the SignInSheet picker AND the parent-mode dashboard
    // feed. Captures the richer shape (belt + totalClasses + DOB) so the
    // /member/home kids feed can render without an extra round-trip per kid.
    fetch("/api/member/me/children")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Array<{
        id: string;
        name: string;
        belt: { name: string; color: string; stripes: number } | null;
        totalClasses: number;
        dateOfBirth: string | null;
      }> | null) => {
        if (Array.isArray(data)) {
          setKidsRoster(
            data.map((k) => ({
              id: k.id,
              name: k.name,
              belt: k.belt ?? null,
              totalClasses: k.totalClasses ?? 0,
              dateOfBirth: k.dateOfBirth ?? null,
            })),
          );
        }
      })
      .catch(() => {});

    // Fetch announcements
    fetch("/api/announcements")
      .then((r) => {
        if (!r.ok) throw new Error("Announcements fetch failed");
        return r.json();
      })
      .then((data: { announcements: Array<{ id: string; title: string; body: string; pinned: boolean; imageUrl?: string | null; createdAt: string; unseen?: boolean }> } | null) => {
        if (!data || !Array.isArray(data.announcements) || data.announcements.length === 0) return;
        const mapped: Announcement[] = data.announcements.map((a) => ({
          id: a.id,
          title: a.title,
          body: a.body,
          pinned: a.pinned,
          imageUrl: a.imageUrl ?? undefined,
          time: new Date(a.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
          unseen: a.unseen ?? false,
        }));
        setAnnouncements(mapped);
        // Auto-open the first unseen announcement
        const firstUnseen = mapped.find((a) => a.unseen);
        if (firstUnseen) {
          setOpenedAnnouncement(firstUnseen);
        }
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Couldn't load — tap to retry"));
  }

  useEffect(() => {
    try {
      if (!localStorage.getItem(ONBOARDING_KEY)) setShowOnboarding(true);
    } catch {}

    loadPageData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upcomingClasses = todayClasses.filter((c) => {
    const [h, m] = c.time.split(":").map(Number);
    const now = new Date();
    return h > now.getHours() || (h === now.getHours() && m >= now.getMinutes());
  });

  return (
    <>
      {/* Load error banner */}
      {loadError && (
        <div className="mx-5 mt-4 px-4 py-3 rounded-2xl flex items-center justify-between gap-3" style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}>
          <p className="text-red-400 text-sm flex-1">{loadError}</p>
          <button
            onClick={loadPageData}
            className="text-xs font-semibold px-3 py-1.5 rounded-xl shrink-0"
            style={{ background: "rgba(239,68,68,0.15)", color: "#f87171" }}
          >
            Retry
          </button>
        </div>
      )}

      {/* Greeting */}
      <div className="px-5 pt-5 pb-5">
        <h1 className="text-white text-2xl font-bold tracking-tight leading-tight">
          {greeting()},<br />
          <span style={{ color: primaryColor }}>{memberName}</span>
        </h1>
        <p className="text-gray-500 text-sm mt-1">{today()}</p>
      </div>

      {/* ── US-2: parent-mode kids feed ──
          Renders only when the signed-in member has accountType="parent" AND
          has at least one kid. Acts as the dashboard's primary surface for
          guardians who never train themselves — each kid card routes to the
          rich /member/family/[id] detail page (US-4 stats + waiver + photos). */}
      {accountType === "parent" && kidsRoster.length > 0 && (
        <div className="px-5 mb-5">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-white text-sm font-bold">Your kids</h2>
            <a
              href="/member/profile"
              className="text-xs"
              style={{ color: primaryColor }}
            >
              Manage →
            </a>
          </div>
          <div className="space-y-2">
            {kidsRoster.map((k) => (
              <a
                key={k.id}
                href={`/member/family/${k.id}`}
                className="block rounded-2xl border p-4 transition-all active:scale-[0.99]"
                style={{ background: hex(primaryColor, 0.06), borderColor: hex(primaryColor, 0.2) }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-11 h-11 rounded-2xl flex items-center justify-center text-white text-sm font-bold shrink-0"
                    style={{ background: `linear-gradient(135deg, ${primaryColor}, ${hex(primaryColor, 0.6)})` }}
                  >
                    {k.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold text-sm truncate">{k.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      {k.belt ? (
                        <>
                          <div className="w-4 h-1.5 rounded-sm" style={{ background: k.belt.color }} />
                          <span className="text-gray-400 text-xs">
                            {k.belt.name} · {k.belt.stripes} stripe{k.belt.stripes !== 1 ? "s" : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-gray-500 text-xs">No belt yet</span>
                      )}
                      <span className="text-gray-500 text-xs">· {k.totalClasses} class{k.totalClasses !== 1 ? "es" : ""}</span>
                    </div>
                  </div>
                  <ExternalLink className="w-3.5 h-3.5 text-gray-500 shrink-0" />
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* ── Sprint 4-A US-401: Next class hero card ──
          For parent-mode users this still shows the gym's next class so they
          know when to bring their child in, but the kids feed above takes
          visual priority. */}
      <div className="px-5 mb-5">
        {nextClass ? (
          <a
            href="/member/schedule"
            className="block rounded-2xl border p-4 transition-all active:scale-[0.99]"
            style={{ background: hex(primaryColor, 0.08), borderColor: hex(primaryColor, 0.25) }}
          >
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: primaryColor }}>Next class</p>
              <ExternalLink className="w-3.5 h-3.5" style={{ color: primaryColor }} />
            </div>
            <p className="text-white font-bold text-base">{nextClass.name}</p>
            <div className="flex items-center gap-3 mt-1.5 flex-wrap">
              <span className="flex items-center gap-1 text-gray-400 text-xs">
                <Clock className="w-3 h-3" />
                {(() => {
                  const d = new Date(nextClass.date);
                  const today = new Date();
                  const isToday = d.toDateString() === today.toDateString();
                  const tomorrow = new Date(today);
                  tomorrow.setDate(today.getDate() + 1);
                  const isTomorrow = d.toDateString() === tomorrow.toDateString();
                  const dayLabel = isToday ? "Today" : isTomorrow ? "Tomorrow" : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
                  return `${dayLabel} · ${nextClass.startTime}–${nextClass.endTime}`;
                })()}
              </span>
              {nextClass.coach && (
                <span className="flex items-center gap-1 text-gray-400 text-xs">
                  <Users className="w-3 h-3" />{nextClass.coach}
                </span>
              )}
              {nextClass.location && (
                <span className="flex items-center gap-1 text-gray-400 text-xs">
                  <MapPin className="w-3 h-3" />{nextClass.location}
                </span>
              )}
            </div>
          </a>
        ) : (
          <a
            href="/member/schedule"
            className="block rounded-2xl border p-4 text-center"
            style={{ borderColor: "var(--member-border)", background: "var(--member-surface)" }}
          >
            <p className="text-gray-400 text-sm">No classes coming up — tap to view the timetable</p>
          </a>
        )}
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
          {todayClasses.map((cls) => {
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
            <AnnouncementCard
              key={a.id}
              a={a}
              primaryColor={primaryColor}
              onOpenModal={(ann, el) => {
                announcementTriggerRef.current = el;
                setOpenedAnnouncement(ann);
              }}
            />
          ))}
        </div>
      </div>

      {/* Sign-in sheet */}
      {showSignIn && (
        <SignInSheet onClose={() => setShowSignIn(false)} primaryColor={primaryColor} classes={todayClasses} kids={kidsRoster} memberName={memberName} />
      )}

      {/* First-time onboarding questionnaire */}
      {showOnboarding && (
        <OnboardingModal onDone={() => setShowOnboarding(false)} primaryColor={primaryColor} memberName={memberName} />
      )}

      {/* Announcement detail modal */}
      <AnnouncementModal
        announcement={openedAnnouncement}
        onClose={() => {
          setOpenedAnnouncement(null);
          fetch("/api/member/me/mark-announcements-seen", { method: "POST" }).catch((e) => {
            console.error("[mark-announcements-seen]", e);
          });
        }}
        triggerRef={announcementTriggerRef as React.RefObject<HTMLElement>}
      />
    </>
  );
}
