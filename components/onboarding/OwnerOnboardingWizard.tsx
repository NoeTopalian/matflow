"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Loader2, ChevronLeft, Upload, Check } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  tenantName: string;
  ownerName: string;
  primaryColor: string;
}

interface ClassDraft {
  id: string;
  name: string;
  coach: string;
  location: string;
  days: number[]; // 0=Mon..6=Sun (UI index; converted to JS dayOfWeek on submit)
  startTime: string;
  endTime: string;
  capacity: string;
}

interface ThemePreset {
  name: string;
  style: string;
  primary: string;
  secondary: string;
  text: string;
  bg: string;
  font: string;
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const SPORTS = [
  { id: "BJJ",       label: "BJJ",       emoji: "🥋" },
  { id: "Boxing",    label: "Boxing",    emoji: "🥊" },
  { id: "MuayThai",  label: "Muay Thai", emoji: "🦵" },
  { id: "MMA",       label: "MMA",       emoji: "⚔️" },
  { id: "Kickboxing",label: "Kickboxing",emoji: "👊" },
  { id: "Wrestling", label: "Wrestling", emoji: "🤼" },
  { id: "Judo",      label: "Judo",      emoji: "🟡" },
  { id: "Karate",    label: "Karate",    emoji: "🎽" },
  { id: "Other",     label: "Other",     emoji: "⭐" },
];

const RANK_PRESETS: Record<string, { name: string; color: string }[]> = {
  BJJ: [
    { name: "White",  color: "#e5e7eb" },
    { name: "Blue",   color: "#3b82f6" },
    { name: "Purple", color: "#8b5cf6" },
    { name: "Brown",  color: "#92400e" },
    { name: "Black",  color: "#111111" },
  ],
  Judo: [
    { name: "White (6th Kyu)",  color: "#e5e7eb" },
    { name: "Yellow (5th Kyu)", color: "#fbbf24" },
    { name: "Orange (4th Kyu)", color: "#f97316" },
    { name: "Green (3rd Kyu)",  color: "#22c55e" },
    { name: "Blue (2nd Kyu)",   color: "#3b82f6" },
    { name: "Brown (1st Kyu)",  color: "#92400e" },
    { name: "Black (1st Dan)",  color: "#111111" },
  ],
  Karate: [
    { name: "White",  color: "#e5e7eb" },
    { name: "Yellow", color: "#fbbf24" },
    { name: "Orange", color: "#f97316" },
    { name: "Green",  color: "#22c55e" },
    { name: "Blue",   color: "#3b82f6" },
    { name: "Purple", color: "#8b5cf6" },
    { name: "Red",    color: "#ef4444" },
    { name: "Brown",  color: "#92400e" },
    { name: "Black",  color: "#111111" },
  ],
  Wrestling: [
    { name: "Novice",       color: "#6b7280" },
    { name: "Intermediate", color: "#3b82f6" },
    { name: "Advanced",     color: "#8b5cf6" },
    { name: "Elite",        color: "#f59e0b" },
  ],
};

const CLASS_TEMPLATES: Record<string, string[]> = {
  BJJ:       ["Beginner BJJ", "Intermediate BJJ", "Advanced BJJ", "No-Gi", "Open Mat", "Kids BJJ", "Competition Prep"],
  Boxing:    ["Beginner Boxing", "Pad Work", "Sparring", "Fitness Boxing", "Kids Boxing"],
  MuayThai:  ["Beginner Muay Thai", "Pad Work", "Sparring", "Clinch Class"],
  MMA:       ["MMA Fundamentals", "Striking", "Grappling", "Sparring"],
  Kickboxing:["Beginner Kickboxing", "Intermediate", "Sparring", "Fitness Kickboxing"],
  Wrestling: ["Wrestling Fundamentals", "Takedowns", "Live Wrestling", "Kids Wrestling"],
  Judo:      ["Beginners Judo", "Intermediate Judo", "Randori", "Kids Judo"],
  Karate:    ["Beginners Karate", "Kata", "Kumite", "Kids Karate"],
  Other:     ["General Class", "Open Mat", "Fundamentals", "Kids Class"],
};

const THEME_PRESETS: ThemePreset[] = [
  { name: "Classic BJJ",    style: "Dark · Pro",       primary: "#3b82f6", secondary: "#1d4ed8", text: "#ffffff", bg: "#111111", font: "'Inter', sans-serif" },
  { name: "Dojo Black",     style: "Dark · Prestige",  primary: "#d97706", secondary: "#92400e", text: "#ffffff", bg: "#0a0a0a", font: "'Montserrat', sans-serif" },
  { name: "Fight Night",    style: "Dark · Energy",    primary: "#ef4444", secondary: "#f97316", text: "#ffffff", bg: "#0d0d0d", font: "'Oswald', sans-serif" },
  { name: "Purple Reign",   style: "Dark · Elite",     primary: "#7c3aed", secondary: "#6d28d9", text: "#ffffff", bg: "#0f0a1a", font: "'Plus Jakarta Sans', sans-serif" },
  { name: "Forest Warrior", style: "Dark · Natural",   primary: "#16a34a", secondary: "#15803d", text: "#ffffff", bg: "#080f0a", font: "'Barlow', sans-serif" },
  { name: "Cyber",          style: "Dark · Tech",      primary: "#06b6d4", secondary: "#0891b2", text: "#ffffff", bg: "#050d12", font: "'Space Grotesk', sans-serif" },
  { name: "Midnight",       style: "Dark · Minimal",   primary: "#6366f1", secondary: "#4f46e5", text: "#ffffff", bg: "#0a0a14", font: "'DM Sans', sans-serif" },
  { name: "Crimson Gi",     style: "Dark · Bold",      primary: "#be123c", secondary: "#9f1239", text: "#ffffff", bg: "#120508", font: "'Rajdhani', sans-serif" },
  { name: "Clean White",    style: "Light · Modern",   primary: "#1d4ed8", secondary: "#3b82f6", text: "#1e293b", bg: "#f8fafc", font: "'Poppins', sans-serif" },
  { name: "Fresh Green",    style: "Light · Wellness", primary: "#16a34a", secondary: "#22c55e", text: "#14532d", bg: "#f0fdf4", font: "'Outfit', sans-serif" },
  { name: "Warm Sand",      style: "Light · Premium",  primary: "#d97706", secondary: "#f59e0b", text: "#451a03", bg: "#fffbeb", font: "'Raleway', sans-serif" },
  { name: "Ocean Breeze",   style: "Light · Clean",    primary: "#0ea5e9", secondary: "#0284c7", text: "#0c4a6e", bg: "#f0f9ff", font: "'Saira', sans-serif" },
];

const DAYS_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// UI day index 0=Mon..6=Sun → JS dayOfWeek (0=Sun..6=Sat)
function uiDayToJs(d: number) { return (d + 1) % 7; }

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function uid() { return Math.random().toString(36).slice(2); }

// ─── Belt strip preview ───────────────────────────────────────────────────────

function BeltStrip({ ranks }: { ranks: { name: string; color: string }[] }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {ranks.map((r) => (
        <div
          key={r.name}
          className="w-6 h-3 rounded-sm shrink-0"
          title={r.name}
          style={{
            background: r.color,
            border: r.color === "#111111" ? "1px solid rgba(255,255,255,0.2)" : "1px solid rgba(0,0,0,0.15)",
          }}
        />
      ))}
    </div>
  );
}

// ─── Mini gym preview ─────────────────────────────────────────────────────────

function GymPreview({ gymName, color }: { gymName: string; color: string }) {
  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{ background: "#1a1a1a", borderColor: "rgba(255,255,255,0.08)", width: 200 }}
    >
      <div className="px-3 py-2.5 border-b border-white/5 flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold shrink-0"
          style={{ background: color }}
        >
          {gymName.charAt(0).toUpperCase()}
        </div>
        <span className="text-white text-xs font-semibold truncate">{gymName || "Your Gym"}</span>
      </div>
      <div className="px-3 py-2 space-y-1.5">
        {["Dashboard", "Members", "Timetable"].map((item, i) => (
          <div
            key={item}
            className="flex items-center gap-2 px-2 py-1 rounded-lg text-xs"
            style={{
              background: i === 0 ? hex(color, 0.12) : "transparent",
              color: i === 0 ? color : "rgba(255,255,255,0.35)",
            }}
          >
            <div className="w-3 h-3 rounded-sm" style={{ background: i === 0 ? hex(color, 0.4) : "rgba(255,255,255,0.1)" }} />
            {item}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Class form ───────────────────────────────────────────────────────────────

function ClassForm({
  cls,
  onChange,
  onRemove,
  primaryColor,
}: {
  cls: ClassDraft;
  onChange: (updated: ClassDraft) => void;
  onRemove: () => void;
  primaryColor: string;
}) {
  function toggleDay(d: number) {
    const days = cls.days.includes(d) ? cls.days.filter((x) => x !== d) : [...cls.days, d];
    onChange({ ...cls, days });
  }

  return (
    <div
      className="rounded-2xl border p-4 space-y-3"
      style={{ background: "rgba(255,255,255,0.03)", borderColor: "rgba(255,255,255,0.07)" }}
    >
      <div className="flex items-center justify-between">
        <input
          value={cls.name}
          onChange={(e) => onChange({ ...cls, name: e.target.value })}
          placeholder="Class name"
          className="bg-transparent text-white text-sm font-semibold outline-none flex-1 placeholder-gray-600"
        />
        <button onClick={onRemove} className="text-gray-600 hover:text-gray-400 ml-2">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input
          value={cls.coach}
          onChange={(e) => onChange({ ...cls, coach: e.target.value })}
          placeholder="Coach (optional)"
          className="bg-white/5 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-white/6"
        />
        <input
          value={cls.location}
          onChange={(e) => onChange({ ...cls, location: e.target.value })}
          placeholder="Location (optional)"
          className="bg-white/5 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 outline-none border border-white/6"
        />
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {DAYS_LABELS.map((label, i) => {
          const sel = cls.days.includes(i);
          return (
            <button
              key={label}
              onClick={() => toggleDay(i)}
              className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
              style={{
                background: sel ? primaryColor : "rgba(255,255,255,0.06)",
                color: sel ? "#fff" : "rgba(255,255,255,0.4)",
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="flex gap-2 items-center">
        <input
          type="time"
          value={cls.startTime}
          onChange={(e) => onChange({ ...cls, startTime: e.target.value })}
          className="bg-white/5 rounded-xl px-3 py-2 text-sm text-white outline-none border border-white/6 flex-1"
        />
        <span className="text-gray-600 text-xs">to</span>
        <input
          type="time"
          value={cls.endTime}
          onChange={(e) => onChange({ ...cls, endTime: e.target.value })}
          className="bg-white/5 rounded-xl px-3 py-2 text-sm text-white outline-none border border-white/6 flex-1"
        />
        <input
          type="number"
          value={cls.capacity}
          onChange={(e) => onChange({ ...cls, capacity: e.target.value })}
          placeholder="Cap"
          min={1}
          className="bg-white/5 rounded-xl px-3 py-2 text-sm text-white outline-none border border-white/6 w-16 placeholder-gray-600"
        />
      </div>
    </div>
  );
}

// ─── Wizard ───────────────────────────────────────────────────────────────────

export default function OwnerOnboardingWizard({ tenantName, ownerName, primaryColor: initColor }: Props) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);

  // Step 1
  const [gymName, setGymName] = useState(tenantName);

  // Step 2
  const [sports, setSports] = useState<string[]>([]);

  // Step 3
  const [selectedPresets, setSelectedPresets] = useState<string[]>([]);

  // Step 4
  const [classes, setClasses] = useState<ClassDraft[]>([]);

  // Step 5
  const [theme, setTheme] = useState<ThemePreset | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState(initColor);

  // Step 6 — questionnaire
  const [gymSize, setGymSize] = useState("");
  const [goals, setGoals] = useState<string[]>([]);
  const [referral, setReferral] = useState("");

  // Completion
  const [summary, setSummary] = useState({ ranks: 0, classes: 0, theme: "" });

  const TOTAL_STEPS = 6;
  const progress = step <= TOTAL_STEPS ? (step - 1) / TOTAL_STEPS : 1;

  function toggleSport(id: string) {
    setSports((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]);
  }

  function togglePreset(id: string) {
    setSelectedPresets((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]);
  }

  function addClassFromTemplate(name: string) {
    setClasses((prev) => [...prev, {
      id: uid(), name, coach: "", location: "", days: [], startTime: "18:00", endTime: "19:00", capacity: "",
    }]);
  }

  function addBlankClass() {
    setClasses((prev) => [...prev, {
      id: uid(), name: "", coach: "", location: "", days: [], startTime: "18:00", endTime: "19:00", capacity: "",
    }]);
  }

  function updateClass(id: string, updated: ClassDraft) {
    setClasses((prev) => prev.map((c) => (c.id === id ? updated : c)));
  }

  function removeClass(id: string) {
    setClasses((prev) => prev.filter((c) => c.id !== id));
  }

  function handleLogoFile(file: File) {
    setLogoFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setLogoPreview(e.target?.result as string);
    reader.readAsDataURL(file);
  }

  async function goNext() {
    setLoading(true);
    try {
      if (step === 1) {
        if (gymName.trim()) {
          await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: gymName.trim() }),
          });
        }
      } else if (step === 3) {
        let totalRanks = 0;
        for (const presetName of selectedPresets) {
          const preset = RANK_PRESETS[presetName];
          if (!preset) continue;
          for (let i = 0; i < preset.length; i++) {
            const res = await fetch("/api/ranks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                discipline: presetName,
                name: preset[i].name,
                order: i,
                color: preset[i].color,
                stripes: presetName === "BJJ" ? 4 : 0,
              }),
            });
            if (res.ok || res.status === 409) totalRanks++;
          }
        }
        setSummary((s) => ({ ...s, ranks: totalRanks }));
      } else if (step === 4) {
        let totalClasses = 0;
        for (const cls of classes) {
          if (!cls.name.trim() || cls.days.length === 0 || !cls.startTime || !cls.endTime) continue;
          const [sh, sm] = cls.startTime.split(":").map(Number);
          const [eh, em] = cls.endTime.split(":").map(Number);
          const duration = Math.max((eh * 60 + em) - (sh * 60 + sm), 30);
          const schedules = cls.days.map((d) => ({
            dayOfWeek: uiDayToJs(d),
            startTime: cls.startTime,
            endTime: cls.endTime,
          }));
          const res = await fetch("/api/classes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: cls.name,
              coachName: cls.coach || undefined,
              location: cls.location || undefined,
              duration,
              maxCapacity: cls.capacity ? parseInt(cls.capacity) : undefined,
              schedules,
            }),
          });
          if (res.ok) totalClasses++;
        }
        if (totalClasses > 0) {
          await fetch("/api/instances/generate", { method: "POST" }).catch(() => {});
        }
        setSummary((s) => ({ ...s, classes: totalClasses }));
      } else if (step === 5) {
        const body: Record<string, unknown> = {};
        if (theme) {
          body.primaryColor = theme.primary;
          body.secondaryColor = theme.secondary;
          body.textColor = theme.text;
          body.bgColor = theme.bg;
          body.fontFamily = theme.font;
          setPrimaryColor(theme.primary);
          setSummary((s) => ({ ...s, theme: theme.name }));
        }
        if (logoFile) {
          const fd = new FormData();
          fd.append("file", logoFile);
          const uploadRes = await fetch("/api/upload", { method: "POST", body: fd });
          if (uploadRes.ok) {
            const data = await uploadRes.json() as { url?: string };
            if (data.url) body.logoUrl = data.url;
          }
        }
        if (Object.keys(body).length > 0) {
          await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        }
        await fetch("/api/settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ onboardingCompleted: true }),
        });
        setStep(6);
        setLoading(false);
        return;
      }
      setStep((s) => s + 1);
    } catch {
      setStep((s) => s + 1);
    } finally {
      setLoading(false);
    }
  }

  async function skip() {
    if (step === 5) {
      setLoading(true);
      await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onboardingCompleted: true }),
      }).catch(() => {});
      setLoading(false);
      setStep(6);
      return;
    }
    setStep((s) => s + 1);
  }

  const canNext = (() => {
    if (step === 1) return gymName.trim().length > 0;
    if (step === 2) return sports.length > 0;
    return true;
  })();

  const suggestedTemplates = [...new Set(sports.flatMap((s) => CLASS_TEMPLATES[s] ?? []))].slice(0, 8);
  const relevantPresets = Object.keys(RANK_PRESETS).filter((key) => {
    if (sports.includes(key)) return true;
    if (key === "BJJ" && sports.includes("MMA")) return true;
    if (key === "Wrestling" && sports.includes("MMA")) return true;
    return false;
  });

  return (
    <div className="w-full max-w-lg mx-auto px-4 py-8 min-h-screen flex flex-col">

      {/* Progress bar */}
      <div className="fixed top-0 left-0 right-0 h-[3px] z-50" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div
          className="h-full transition-all duration-500"
          style={{ width: `${progress * 100}%`, background: primaryColor }}
        />
      </div>

      {step < 6 && (
        <div className="flex items-center justify-between mb-8 pt-4">
          <div className="flex items-center gap-3">
            {step > 1 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="w-8 h-8 rounded-xl flex items-center justify-center transition-all hover:bg-white/8"
                style={{ color: "rgba(255,255,255,0.4)" }}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            )}
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: "rgba(255,255,255,0.3)" }}>
                Step {step} of {TOTAL_STEPS}
              </p>
            </div>
          </div>
          {step >= 3 && step <= 5 && (
            <button
              onClick={skip}
              className="text-xs font-medium"
              style={{ color: "rgba(255,255,255,0.3)" }}
            >
              Skip
            </button>
          )}
        </div>
      )}

      {/* ── Step 1: Gym Identity ── */}
      {step === 1 && (
        <div className="flex-1 flex flex-col">
          <div className="mb-8">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center text-2xl mb-5"
              style={{ background: hex(primaryColor, 0.12), border: `1px solid ${hex(primaryColor, 0.2)}` }}
            >
              🏋️
            </div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: primaryColor }}>Welcome, {ownerName.split(" ")[0]}</p>
            <h1 className="text-white text-2xl font-bold tracking-tight mb-2">Set up your gym</h1>
            <p className="text-gray-500 text-sm leading-relaxed">
              Let&apos;s get your gym ready in just a few steps. Start with the basics.
            </p>
          </div>

          <div className="space-y-4 flex-1">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Gym Name</label>
              <input
                value={gymName}
                onChange={(e) => setGymName(e.target.value)}
                placeholder="e.g. Total BJJ"
                className="w-full bg-white/5 border border-white/8 rounded-2xl px-4 py-3.5 text-white text-base outline-none focus:border-white/20 transition-all"
              />
            </div>
          </div>

          <button
            onClick={goNext}
            disabled={!canNext || loading}
            className="mt-8 w-full py-4 rounded-2xl text-white font-bold text-base transition-all disabled:opacity-30 flex items-center justify-center gap-2"
            style={{ background: primaryColor, boxShadow: `0 8px 24px ${hex(primaryColor, 0.3)}` }}
          >
            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "Continue →"}
          </button>
        </div>
      )}

      {/* ── Step 2: Discipline ── */}
      {step === 2 && (
        <div className="flex-1 flex flex-col">
          <div className="mb-6">
            <h1 className="text-white text-2xl font-bold tracking-tight mb-2">What do you teach?</h1>
            <p className="text-gray-500 text-sm">Select all that apply. This helps us set up your rank system and class templates.</p>
          </div>

          <div className="grid grid-cols-3 gap-2.5 flex-1 content-start">
            {SPORTS.map((sport) => {
              const sel = sports.includes(sport.id);
              return (
                <button
                  key={sport.id}
                  onClick={() => toggleSport(sport.id)}
                  className="flex flex-col items-center gap-2 py-4 px-2 rounded-2xl border transition-all active:scale-[0.97]"
                  style={{
                    background: sel ? hex(primaryColor, 0.12) : "rgba(255,255,255,0.03)",
                    borderColor: sel ? hex(primaryColor, 0.4) : "rgba(255,255,255,0.07)",
                  }}
                >
                  <span className="text-2xl">{sport.emoji}</span>
                  <span className="text-xs font-semibold" style={{ color: sel ? primaryColor : "rgba(255,255,255,0.5)" }}>
                    {sport.label}
                  </span>
                  {sel && (
                    <div className="w-4 h-4 rounded-full flex items-center justify-center" style={{ background: primaryColor }}>
                      <Check className="w-2.5 h-2.5 text-white" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <button
            onClick={goNext}
            disabled={!canNext || loading}
            className="mt-6 w-full py-4 rounded-2xl text-white font-bold text-base transition-all disabled:opacity-30"
            style={{ background: primaryColor }}
          >
            Continue →
          </button>
        </div>
      )}

      {/* ── Step 3: Rank System ── */}
      {step === 3 && (
        <div className="flex-1 flex flex-col">
          <div className="mb-6">
            <h1 className="text-white text-2xl font-bold tracking-tight mb-2">Set up your ranks</h1>
            <p className="text-gray-500 text-sm">Select the rank systems to add. You can customise them in Settings later.</p>
          </div>

          <div className="space-y-3 flex-1">
            {(relevantPresets.length > 0 ? relevantPresets : Object.keys(RANK_PRESETS)).map((presetName) => {
              const ranks = RANK_PRESETS[presetName];
              const sel = selectedPresets.includes(presetName);
              return (
                <button
                  key={presetName}
                  onClick={() => togglePreset(presetName)}
                  className="w-full text-left rounded-2xl border p-4 transition-all"
                  style={{
                    background: sel ? hex(primaryColor, 0.08) : "rgba(255,255,255,0.03)",
                    borderColor: sel ? hex(primaryColor, 0.35) : "rgba(255,255,255,0.07)",
                  }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-white font-semibold text-sm">{presetName} Belt System</span>
                    <div
                      className="w-5 h-5 rounded-full border flex items-center justify-center transition-all"
                      style={{
                        background: sel ? primaryColor : "transparent",
                        borderColor: sel ? primaryColor : "rgba(255,255,255,0.2)",
                      }}
                    >
                      {sel && <Check className="w-3 h-3 text-white" />}
                    </div>
                  </div>
                  <BeltStrip ranks={ranks} />
                  <p className="text-gray-600 text-xs mt-2">{ranks.length} ranks</p>
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={skip}
              className="flex-1 py-3.5 rounded-2xl text-sm font-semibold transition-all"
              style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)" }}
            >
              Skip for now
            </button>
            <button
              onClick={goNext}
              disabled={loading}
              className="flex-1 py-3.5 rounded-2xl text-white font-bold text-sm transition-all disabled:opacity-30 flex items-center justify-center gap-2"
              style={{ background: primaryColor }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : (selectedPresets.length > 0 ? `Add ${selectedPresets.length} system${selectedPresets.length > 1 ? "s" : ""} →` : "Continue →")}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 4: Timetable ── */}
      {step === 4 && (
        <div className="flex-1 flex flex-col">
          <div className="mb-5">
            <h1 className="text-white text-2xl font-bold tracking-tight mb-2">Add your classes</h1>
            <p className="text-gray-500 text-sm">Set up your weekly timetable. You can add more from the Timetable page later.</p>
          </div>

          {suggestedTemplates.length > 0 && classes.length === 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-600 mb-2">Quick add</p>
              <div className="flex flex-wrap gap-2">
                {suggestedTemplates.map((t) => (
                  <button
                    key={t}
                    onClick={() => addClassFromTemplate(t)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all border"
                    style={{
                      background: hex(primaryColor, 0.08),
                      borderColor: hex(primaryColor, 0.2),
                      color: primaryColor,
                    }}
                  >
                    <Plus className="w-3 h-3" />
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3 flex-1 overflow-y-auto">
            {classes.map((cls) => (
              <ClassForm
                key={cls.id}
                cls={cls}
                onChange={(updated) => updateClass(cls.id, updated)}
                onRemove={() => removeClass(cls.id)}
                primaryColor={primaryColor}
              />
            ))}
            <button
              onClick={addBlankClass}
              className="w-full py-3 rounded-2xl border border-dashed text-sm font-medium flex items-center justify-center gap-2 transition-all"
              style={{ borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.3)" }}
            >
              <Plus className="w-4 h-4" />
              Add a class
            </button>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={skip}
              className="flex-1 py-3.5 rounded-2xl text-sm font-semibold"
              style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)" }}
            >
              Skip for now
            </button>
            <button
              onClick={goNext}
              disabled={loading}
              className="flex-1 py-3.5 rounded-2xl text-white font-bold text-sm disabled:opacity-30 flex items-center justify-center gap-2"
              style={{ background: primaryColor }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : (classes.length > 0 ? `Save ${classes.length} class${classes.length > 1 ? "es" : ""} →` : "Continue →")}
            </button>
          </div>
        </div>
      )}

      {/* ── Step 5: Branding ── */}
      {step === 5 && (
        <div className="flex-1 flex flex-col">
          <div className="mb-5">
            <h1 className="text-white text-2xl font-bold tracking-tight mb-2">Make it yours</h1>
            <p className="text-gray-500 text-sm">Pick a colour theme and upload your logo. Your members will see this throughout the app.</p>
          </div>

          <div className="flex gap-6 items-start mb-6">
            <div className="flex-1">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-600 mb-3">Choose a theme</p>
              <div className="grid grid-cols-2 gap-2">
                {THEME_PRESETS.map((preset) => {
                  const sel = theme?.name === preset.name;
                  return (
                    <button
                      key={preset.name}
                      onClick={() => setTheme(preset)}
                      className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border transition-all text-left"
                      style={{
                        background: sel ? hex(primaryColor, 0.1) : "rgba(255,255,255,0.03)",
                        borderColor: sel ? primaryColor : "rgba(255,255,255,0.07)",
                      }}
                    >
                      <div className="w-6 h-6 rounded-lg shrink-0" style={{ background: preset.primary }} />
                      <div className="min-w-0">
                        <p className="text-white text-xs font-semibold truncate leading-tight">{preset.name}</p>
                        <p className="text-gray-600 text-[10px] leading-tight truncate">{preset.style}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="shrink-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-gray-600 mb-3">Preview</p>
              <GymPreview gymName={gymName} color={theme?.primary ?? primaryColor} />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-600 mb-3">Logo (optional)</p>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => { if (e.target.files?.[0]) handleLogoFile(e.target.files[0]); }} />
            <button
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-3 px-4 py-3 rounded-2xl border transition-all w-full"
              style={{ borderColor: "rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)" }}
            >
              {logoPreview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={logoPreview} alt="Logo" className="w-8 h-8 rounded-lg object-cover" />
              ) : (
                <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "rgba(255,255,255,0.07)" }}>
                  <Upload className="w-4 h-4 text-gray-500" />
                </div>
              )}
              <span className="text-sm" style={{ color: logoFile ? "white" : "rgba(255,255,255,0.3)" }}>
                {logoFile ? logoFile.name : "Upload logo"}
              </span>
            </button>
          </div>

          <div className="mt-6 flex gap-3">
            <button
              onClick={skip}
              className="flex-1 py-3.5 rounded-2xl text-sm font-semibold"
              style={{ background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.5)" }}
            >
              Skip
            </button>
            <button
              onClick={goNext}
              disabled={loading}
              className="flex-1 py-3.5 rounded-2xl text-white font-bold text-sm disabled:opacity-30 flex items-center justify-center gap-2"
              style={{ background: theme?.primary ?? primaryColor }}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Finish setup →"}
            </button>
          </div>
        </div>
      )}

      {/* ── Completion ── */}
      {step === 6 && (
        <div className="flex-1 flex flex-col items-center justify-center text-center pb-8">
          <div
            className="w-20 h-20 rounded-3xl flex items-center justify-center text-4xl mb-6"
            style={{ background: hex(primaryColor, 0.12), border: `1px solid ${hex(primaryColor, 0.2)}` }}
          >
            🎉
          </div>
          <h1 className="text-white text-2xl font-bold tracking-tight mb-2">Your gym is ready!</h1>
          <p className="text-gray-500 text-sm leading-relaxed mb-8 max-w-xs">
            Everything is set up and waiting for you. Head to your dashboard to start managing your gym.
          </p>

          <div className="flex flex-wrap gap-2 justify-center mb-10">
            {summary.ranks > 0 && (
              <span className="px-3 py-1.5 rounded-full text-xs font-semibold" style={{ background: hex(primaryColor, 0.12), color: primaryColor }}>
                ✓ {summary.ranks} ranks set up
              </span>
            )}
            {summary.classes > 0 && (
              <span className="px-3 py-1.5 rounded-full text-xs font-semibold" style={{ background: hex(primaryColor, 0.12), color: primaryColor }}>
                ✓ {summary.classes} class{summary.classes > 1 ? "es" : ""} added
              </span>
            )}
            {summary.theme && (
              <span className="px-3 py-1.5 rounded-full text-xs font-semibold" style={{ background: hex(primaryColor, 0.12), color: primaryColor }}>
                ✓ {summary.theme} theme
              </span>
            )}
            {summary.ranks === 0 && summary.classes === 0 && !summary.theme && (
              <span className="px-3 py-1.5 rounded-full text-xs font-semibold" style={{ background: hex(primaryColor, 0.12), color: primaryColor }}>
                ✓ Account ready
              </span>
            )}
          </div>

          <button
            onClick={() => router.push("/dashboard")}
            className="w-full py-4 rounded-2xl text-white font-bold text-base transition-all active:scale-[0.98]"
            style={{ background: primaryColor, boxShadow: `0 8px 24px ${hex(primaryColor, 0.3)}` }}
          >
            Go to Dashboard →
          </button>
        </div>
      )}
    </div>
  );
}
