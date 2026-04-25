"use client";

import { useState, useCallback } from "react";
import {
  Plus, Calendar, Clock, Users, MapPin, ChevronRight,
  X, Trash2, Edit2, RefreshCw, Loader2, Tag,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { ClassRow } from "@/app/dashboard/timetable/page";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RankOption {
  id: string;
  name: string;
  color: string | null;
  discipline: string;
}

interface Props {
  initialClasses: ClassRow[];
  rankSystems: RankOption[];
  primaryColor: string;
  role: string;
}

interface ScheduleInput {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CLASS_COLORS = [
  "#3b82f6", "#8b5cf6", "#ec4899", "#ef4444",
  "#f97316", "#eab308", "#22c55e", "#14b8a6",
  "#06b6d4", "#6366f1",
];

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onAdd, primaryColor }: { onAdd: () => void; primaryColor: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div
        className="w-16 h-16 rounded-3xl flex items-center justify-center mb-4"
        style={{ background: hex(primaryColor, 0.1) }}
      >
        <Calendar className="w-8 h-8" style={{ color: primaryColor }} />
      </div>
      <h3 className="text-white font-semibold text-lg mb-1">No classes yet</h3>
      <p className="text-gray-500 text-sm mb-6 max-w-xs">
        Add your first class to start building your timetable.
      </p>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold text-white"
        style={{ background: primaryColor }}
      >
        <Plus className="w-4 h-4" />
        Add Class
      </button>
    </div>
  );
}

// ─── Class card ───────────────────────────────────────────────────────────────

function ClassCard({
  cls,
  primaryColor,
  onEdit,
  onDelete,
  onGenerate,
  canManage,
}: {
  cls: ClassRow;
  primaryColor: string;
  onEdit: (c: ClassRow) => void;
  onDelete: (id: string) => void;
  onGenerate: (id: string) => void;
  canManage: boolean;
}) {
  const color = cls.color ?? primaryColor;

  return (
    <div
      className="rounded-2xl border p-4 transition-all"
      style={{ background: "rgba(0,0,0,0.02)", borderColor: hex(color, 0.25) }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
          <div className="min-w-0">
            <h3 className="text-white font-semibold text-sm truncate">{cls.name}</h3>
            {cls.description && (
              <p className="text-gray-500 text-xs mt-0.5 line-clamp-1">{cls.description}</p>
            )}
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onGenerate(cls.id)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-blue-400 transition-colors"
              title="Generate schedule instances"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onEdit(cls)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white transition-colors"
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onDelete(cls.id)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-red-400 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="flex items-center gap-1 text-gray-400 text-xs">
          <Clock className="w-3 h-3" />
          {cls.duration} min
        </span>
        {cls.coachName && (
          <span className="text-gray-400 text-xs">· {cls.coachName}</span>
        )}
        {cls.location && (
          <span className="flex items-center gap-1 text-gray-400 text-xs">
            <MapPin className="w-3 h-3" />
            {cls.location}
          </span>
        )}
        {cls.maxCapacity && (
          <span className="flex items-center gap-1 text-gray-400 text-xs">
            <Users className="w-3 h-3" />
            Max {cls.maxCapacity}
          </span>
        )}
        {cls.requiredRank && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: hex(cls.requiredRank.color ?? primaryColor, 0.15), color: cls.requiredRank.color ?? primaryColor }}>
            <Tag className="w-2.5 h-2.5" />
            {cls.requiredRank.name}+
          </span>
        )}
      </div>

      {/* Schedule chips */}
      {cls.schedules.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {cls.schedules.map((s) => (
            <span
              key={s.id}
              className="text-xs px-2.5 py-1 rounded-lg font-medium"
              style={{ background: hex(color, 0.12), color: color }}
            >
              {DAYS[s.dayOfWeek]} {s.startTime}
            </span>
          ))}
        </div>
      ) : (
        <p className="text-gray-700 text-xs italic">No schedule set</p>
      )}
    </div>
  );
}

// ─── Schedule row input ───────────────────────────────────────────────────────

function timeToMins(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}
function addMins(t: string, mins: number) {
  const total = timeToMins(t) + mins;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function ScheduleRow({
  sched,
  onChange,
  onRemove,
}: {
  sched: ScheduleInput;
  onChange: (s: ScheduleInput) => void;
  onRemove: () => void;
}) {
  const [mode, setMode] = useState<"end" | "duration">("end");
  const durationMins = timeToMins(sched.endTime) - timeToMins(sched.startTime);

  function handleStartChange(val: string) {
    if (mode === "duration") {
      onChange({ ...sched, startTime: val, endTime: addMins(val, Math.max(durationMins, 30)) });
    } else {
      onChange({ ...sched, startTime: val });
    }
  }
  function handleDurationChange(mins: number) {
    onChange({ ...sched, endTime: addMins(sched.startTime, mins) });
  }

  return (
    <div className="p-3 rounded-xl space-y-2.5" style={{ background: "rgba(0,0,0,0.02)" }}>
      <div className="flex items-center gap-2">
        <select
          value={sched.dayOfWeek}
          onChange={(e) => onChange({ ...sched, dayOfWeek: Number(e.target.value) })}
          className="flex-1 bg-transparent text-white text-sm border border-black/10 rounded-lg px-2 py-1.5 outline-none"
          style={{ appearance: "auto" }}
        >
          {DAYS_FULL.map((d, i) => (
            <option key={i} value={i} style={{ background: "var(--sf-1)" }}>{d}</option>
          ))}
        </select>
        <button onClick={onRemove} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-600 hover:text-red-400 shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="text-gray-600 text-[10px] block mb-0.5">Start time</label>
          <input type="time" value={sched.startTime} onChange={(e) => handleStartChange(e.target.value)}
            className="w-full bg-transparent text-white text-sm border border-black/10 rounded-lg px-2 py-1.5" />
        </div>

        {/* Mode toggle */}
        <div className="flex flex-col items-center gap-1 pt-4">
          <button
            onClick={() => setMode((m) => m === "end" ? "duration" : "end")}
            className="text-[10px] px-2 py-1 rounded border transition-colors"
            style={{ borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.4)" }}
          >
            {mode === "end" ? "end" : "dur"}
          </button>
        </div>

        {mode === "end" ? (
          <div className="flex-1">
            <label className="text-gray-600 text-[10px] block mb-0.5">End time</label>
            <input type="time" value={sched.endTime} onChange={(e) => onChange({ ...sched, endTime: e.target.value })}
              className="w-full bg-transparent text-white text-sm border border-black/10 rounded-lg px-2 py-1.5" />
          </div>
        ) : (
          <div className="flex-1">
            <label className="text-gray-600 text-[10px] block mb-0.5">Duration (mins)</label>
            <input type="number" min={15} max={480} step={15} value={Math.max(durationMins, 30)}
              onChange={(e) => handleDurationChange(Number(e.target.value))}
              className="w-full bg-transparent text-white text-sm border border-black/10 rounded-lg px-2 py-1.5" />
          </div>
        )}
      </div>
      {durationMins > 0 && (
        <p className="text-gray-700 text-[10px]">{durationMins} mins · ends {sched.endTime}</p>
      )}
    </div>
  );
}

// ─── Class form (add / edit) ──────────────────────────────────────────────────

function ClassForm({
  initial,
  rankSystems,
  primaryColor,
  onSave,
  onCancel,
  saving,
}: {
  initial: Partial<ClassRow> | null;
  rankSystems: RankOption[];
  primaryColor: string;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [coachName, setCoachName] = useState(initial?.coachName ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [duration, setDuration] = useState(String(initial?.duration ?? 60));
  const [maxCapacity, setMaxCapacity] = useState(String(initial?.maxCapacity ?? ""));
  const [description, setDescription] = useState(initial?.description ?? "");
  const [requiredRankId, setRequiredRankId] = useState(initial?.requiredRankId ?? "");
  const [color, setColor] = useState(initial?.color ?? CLASS_COLORS[0]);
  const [schedules, setSchedules] = useState<ScheduleInput[]>(
    initial?.schedules?.map((s) => ({ dayOfWeek: s.dayOfWeek, startTime: s.startTime, endTime: s.endTime })) ?? []
  );

  function addSchedule() {
    setSchedules((prev) => [...prev, { dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }]);
  }

  function updateSchedule(i: number, s: ScheduleInput) {
    setSchedules((prev) => prev.map((x, idx) => (idx === i ? s : x)));
  }

  function removeSchedule(i: number) {
    setSchedules((prev) => prev.filter((_, idx) => idx !== i));
  }

  function submit() {
    if (!name.trim()) return;
    onSave({
      name: name.trim(),
      coachName: coachName.trim() || null,
      location: location.trim() || null,
      duration: parseInt(duration) || 60,
      maxCapacity: maxCapacity ? parseInt(maxCapacity) : null,
      description: description.trim() || null,
      requiredRankId: requiredRankId || null,
      color,
      schedules,
    });
  }

  const inputCls = "w-full bg-transparent border border-black/10 rounded-xl px-3 py-2.5 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-white/30 transition-colors";

  return (
    <div className="space-y-4">
      {/* Name */}
      <div>
        <label className="text-gray-400 text-xs font-medium block mb-1.5">Class Name *</label>
        <input
          className={inputCls}
          placeholder="e.g. Beginner BJJ"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {/* Coach + Location */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-gray-400 text-xs font-medium block mb-1.5">Coach / Instructor</label>
          <input
            className={inputCls}
            placeholder="Coach Mike"
            value={coachName}
            onChange={(e) => setCoachName(e.target.value)}
          />
        </div>
        <div>
          <label className="text-gray-400 text-xs font-medium block mb-1.5">Location</label>
          <input
            className={inputCls}
            placeholder="Mat 1"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
      </div>

      {/* Duration + Capacity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-gray-400 text-xs font-medium block mb-1.5">Duration (mins)</label>
          <input
            type="number"
            className={inputCls}
            placeholder="60"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            min={1}
            max={480}
          />
        </div>
        <div>
          <label className="text-gray-400 text-xs font-medium block mb-1.5">Max Capacity</label>
          <input
            type="number"
            className={inputCls}
            placeholder="Unlimited"
            value={maxCapacity}
            onChange={(e) => setMaxCapacity(e.target.value)}
            min={1}
          />
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="text-gray-400 text-xs font-medium block mb-1.5">Description</label>
        <textarea
          className={inputCls + " resize-none"}
          placeholder="Optional class description..."
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      {/* Required Rank */}
      {rankSystems.length > 0 && (
        <div>
          <label className="text-gray-400 text-xs font-medium block mb-1.5">Required Rank (min)</label>
          <select
            className={inputCls}
            value={requiredRankId}
            onChange={(e) => setRequiredRankId(e.target.value)}
            style={{ appearance: "auto" }}
          >
            <option value="" style={{ background: "var(--sf-1)" }}>No requirement</option>
            {rankSystems.map((r) => (
              <option key={r.id} value={r.id} style={{ background: "var(--sf-1)" }}>
                {r.discipline} — {r.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Color */}
      <div>
        <label className="text-gray-400 text-xs font-medium block mb-1.5">Colour</label>
        <div className="flex gap-2 flex-wrap">
          {CLASS_COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className="w-7 h-7 rounded-full transition-all"
              style={{
                background: c,
                boxShadow: color === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : "none",
              }}
            />
          ))}
        </div>
      </div>

      {/* Schedules */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-gray-400 text-xs font-medium">Recurring Schedule</label>
          <button
            onClick={addSchedule}
            className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg"
            style={{ background: hex(primaryColor, 0.15), color: primaryColor }}
          >
            <Plus className="w-3 h-3" />
            Add Day
          </button>
        </div>
        {schedules.length === 0 ? (
          <p className="text-gray-700 text-xs italic">No schedule — add recurring days above</p>
        ) : (
          <div className="space-y-2">
            {schedules.map((s, i) => (
              <ScheduleRow
                key={i}
                sched={s}
                onChange={(u) => updateSchedule(i, u)}
                onRemove={() => removeSchedule(i)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={onCancel}
          className="flex-1 py-2.5 rounded-xl border border-black/10 text-gray-400 text-sm font-medium hover:text-white transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={!name.trim() || saving}
          className="flex-1 py-2.5 rounded-xl text-white text-sm font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-50"
          style={{ background: primaryColor }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {initial?.id ? "Save Changes" : "Create Class"}
        </button>
      </div>
    </div>
  );
}

// ─── Slide-over drawer ────────────────────────────────────────────────────────

function Drawer({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div
        className="fixed top-0 right-0 h-full w-full max-w-md z-50 flex flex-col overflow-hidden"
        style={{ background: "var(--sf-0)", borderLeft: "1px solid rgba(0,0,0,0.08)" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/8">
          <h2 className="text-white font-semibold text-base">{title}</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400" style={{ background: "rgba(0,0,0,0.08)" }}>
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TimetableManager({ initialClasses, rankSystems, primaryColor, role }: Props) {
  const [classes, setClasses] = useState<ClassRow[]>(initialClasses);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ClassRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const { toast: showToast } = useToast();

  const canManage = ["owner", "manager"].includes(role);

  // Group by day
  const byDay = Array.from({ length: 7 }, (_, i) =>
    classes
      .filter((c) => c.schedules.some((s) => s.dayOfWeek === i))
      .sort((a, b) => {
        const at = a.schedules.find((s) => s.dayOfWeek === i)?.startTime ?? "";
        const bt = b.schedules.find((s) => s.dayOfWeek === i)?.startTime ?? "";
        return at.localeCompare(bt);
      })
  );

  function openAdd() {
    setEditTarget(null);
    setDrawerOpen(true);
  }

  function openEdit(cls: ClassRow) {
    setEditTarget(cls);
    setDrawerOpen(true);
  }

  async function handleSave(data: Record<string, unknown>) {
    setSaving(true);
    try {
      if (editTarget) {
        const res = await fetch(`/api/classes/${editTarget.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error("Failed");
        const updated = await res.json();
        setClasses((prev) =>
          prev.map((c) =>
            c.id === editTarget.id
              ? { ...c, ...updated, schedules: updated.schedules ?? c.schedules }
              : c
          )
        );
        showToast("Class updated", "success");
      } else {
        const res = await fetch("/api/classes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        if (!res.ok) throw new Error("Failed");
        const created = await res.json();
        setClasses((prev) => [...prev, created]);
        showToast("Class created", "success");
      }
      setDrawerOpen(false);
    } catch {
      showToast("Something went wrong", "error");
    } finally {
      setSaving(false);
    }
  }

  const handleDelete = useCallback(
    async (id: string) => {
      if (!confirm("Archive this class? It won't appear in the timetable.")) return;
      try {
        const res = await fetch(`/api/classes/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error("Failed");
        setClasses((prev) => prev.filter((c) => c.id !== id));
        showToast("Class archived", "success");
      } catch {
        showToast("Could not delete class", "error");
      }
    },
    [showToast]
  );

  const handleGenerate = useCallback(
    async (id: string) => {
      setGenerating(id);
      try {
        const res = await fetch(`/api/classes/${id}/instances`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ weeks: 4 }),
        });
        const data = await res.json();
        showToast(`Generated ${data.created} class instances`, "success");
      } catch {
        showToast("Failed to generate instances", "error");
      } finally {
        setGenerating(null);
      }
    },
    [showToast]
  );

  return (
    <div className="max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Timetable</h1>
          <p className="text-gray-500 text-sm mt-0.5">{classes.length} class{classes.length !== 1 ? "es" : ""} · Manage your schedule</p>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  const res = await fetch("/api/instances/generate", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ weeks: 4 }),
                  });
                  const d = await res.json();
                  showToast(`Generated ${d.created} instances for next 4 weeks`, "success");
                } catch {
                  showToast("Failed to generate", "error");
                }
              }}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-black/10 text-gray-300 text-sm font-medium hover:text-white transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Generate 4 Weeks
            </button>
            <button
              onClick={openAdd}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm font-semibold"
              style={{ background: primaryColor }}
            >
              <Plus className="w-4 h-4" />
              Add Class
            </button>
          </div>
        )}
      </div>

      {classes.length === 0 ? (
        <EmptyState onAdd={openAdd} primaryColor={primaryColor} />
      ) : (
        <div className="space-y-6">
          {/* Weekly view */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {DAYS_FULL.slice(1).concat(DAYS_FULL[0]).map((day, rawIdx) => {
              const dow = rawIdx === 6 ? 0 : rawIdx + 1; // Mon=1…Sun=0
              const dayClasses = byDay[dow];
              if (dayClasses.length === 0) return null;
              return (
                <div key={day} className="rounded-2xl border border-black/8 p-3" style={{ background: "rgba(255,255,255,0.015)" }}>
                  <p className="text-gray-500 text-xs font-semibold uppercase tracking-wider mb-2">{day}</p>
                  <div className="space-y-1.5">
                    {dayClasses.map((cls) => {
                      const sched = cls.schedules.find((s) => s.dayOfWeek === dow);
                      const color = cls.color ?? primaryColor;
                      return (
                        <button
                          key={cls.id}
                          onClick={() => canManage && openEdit(cls)}
                          className="w-full text-left rounded-xl px-3 py-2 flex items-center gap-2 transition-all hover:brightness-110"
                          style={{ background: hex(color, 0.12), border: `1px solid ${hex(color, 0.2)}` }}
                        >
                          <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
                          <div className="min-w-0 flex-1">
                            <p className="text-white text-xs font-semibold truncate">{cls.name}</p>
                            <p className="text-gray-500 text-[10px]">{sched?.startTime} · {cls.duration}min</p>
                          </div>
                          {canManage && <ChevronRight className="w-3 h-3 text-gray-700 shrink-0" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* All classes list */}
          <div>
            <h2 className="text-white font-semibold text-sm mb-3">All Classes</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {classes.map((cls) => (
                <ClassCard
                  key={cls.id}
                  cls={cls}
                  primaryColor={primaryColor}
                  onEdit={openEdit}
                  onDelete={handleDelete}
                  onGenerate={handleGenerate}
                  canManage={canManage}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Drawer */}
      <Drawer
        open={drawerOpen}
        title={editTarget ? "Edit Class" : "New Class"}
        onClose={() => setDrawerOpen(false)}
      >
        <ClassForm
          initial={editTarget}
          rankSystems={rankSystems}
          primaryColor={primaryColor}
          onSave={handleSave}
          onCancel={() => setDrawerOpen(false)}
          saving={saving}
        />
      </Drawer>
    </div>
  );
}
