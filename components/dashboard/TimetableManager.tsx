"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import {
  Plus, Calendar, Clock, Users, MapPin, ChevronRight, ChevronLeft,
  X, Trash2, Edit2, RefreshCw, Loader2, Tag,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { ClassRow, CoachUserOption } from "@/app/dashboard/timetable/page";

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
  coachUsers: CoachUserOption[];
  primaryColor: string;
  role: string;
  // Session F: drives the "My classes" filter. When null (e.g. no
  // currentUserId resolvable from session) the toggle is suppressed.
  currentUserId: string | null;
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

function getWeekDates(offset: number): Date[] {
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - ((dow + 6) % 7) + offset * 7);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function fmtWeekLabel(dates: Date[]): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  const start = dates[0].toLocaleDateString("en-GB", opts);
  const end = dates[6].toLocaleDateString("en-GB", opts);
  return `${start} – ${end}`;
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
      <h3 className="font-semibold text-lg mb-1" style={{ color: "var(--tx-1)" }}>No classes yet</h3>
      <p className="text-sm mb-6 max-w-xs" style={{ color: "var(--tx-3)" }}>
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
      style={{ background: "var(--sf-1)", borderColor: hex(color, 0.25) }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
          <div className="min-w-0">
            <h3 className="font-semibold text-sm truncate" style={{ color: "var(--tx-1)" }}>{cls.name}</h3>
            {cls.description && (
              <p className="text-xs mt-0.5 line-clamp-1" style={{ color: "var(--tx-3)" }}>{cls.description}</p>
            )}
          </div>
        </div>
        {canManage && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => onGenerate(cls.id)}
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:text-blue-400 transition-colors"
              style={{ color: "var(--tx-3)" }}
              title="Generate schedule instances"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onEdit(cls)}
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:text-white transition-colors"
              style={{ color: "var(--tx-3)" }}
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => onDelete(cls.id)}
              className="w-7 h-7 rounded-lg flex items-center justify-center hover:text-red-400 transition-colors"
              style={{ color: "var(--tx-3)" }}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* Meta row */}
      <div className="flex flex-wrap gap-2 mb-3">
        <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
          <Clock className="w-3 h-3" />
          {cls.duration} min
        </span>
        {(cls.coachUser?.name ?? cls.coachName) && (
          <span className="text-xs" style={{ color: "var(--tx-3)" }}>· {cls.coachUser?.name ?? cls.coachName}</span>
        )}
        {cls.location && (
          <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
            <MapPin className="w-3 h-3" />
            {cls.location}
          </span>
        )}
        {cls.maxCapacity && (
          <span className="flex items-center gap-1 text-xs" style={{ color: "var(--tx-3)" }}>
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
        {cls.maxRank && (
          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full" style={{ background: hex(cls.maxRank.color ?? primaryColor, 0.15), color: cls.maxRank.color ?? primaryColor }}>
            <Tag className="w-2.5 h-2.5" />
            ≤ {cls.maxRank.name}
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
        <p className="text-xs italic" style={{ color: "var(--tx-4)" }}>No schedule set</p>
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
    if (!val) return;
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
    <div className="p-3 rounded-xl space-y-2.5" style={{ background: "var(--sf-1)" }}>
      <div className="flex items-center gap-2">
        <select
          value={sched.dayOfWeek}
          onChange={(e) => onChange({ ...sched, dayOfWeek: Number(e.target.value) })}
          className="flex-1 bg-transparent text-sm rounded-lg px-2 py-1.5 outline-none"
          style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)", appearance: "auto" }}
        >
          {DAYS_FULL.map((d, i) => (
            <option key={i} value={i} style={{ background: "var(--sf-1)" }}>{d}</option>
          ))}
        </select>
        <button
          onClick={onRemove}
          className="w-7 h-7 rounded-lg flex items-center justify-center hover:text-red-400 shrink-0"
          style={{ color: "var(--tx-3)" }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex-1">
          <label className="text-[10px] block mb-0.5" style={{ color: "var(--tx-3)" }}>Start time</label>
          <input
            type="time"
            value={sched.startTime}
            onChange={(e) => handleStartChange(e.target.value)}
            className="w-full bg-transparent text-sm rounded-lg px-2 py-1.5"
            style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)" }}
          />
        </div>

        {/* Mode toggle */}
        <div className="flex flex-col items-center gap-1 pt-4">
          <button
            onClick={() => setMode((m) => m === "end" ? "duration" : "end")}
            className="text-[10px] px-2 py-1 rounded border transition-colors"
            style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
          >
            {mode === "end" ? "end" : "dur"}
          </button>
        </div>

        {mode === "end" ? (
          <div className="flex-1">
            <label className="text-[10px] block mb-0.5" style={{ color: "var(--tx-3)" }}>End time</label>
            <input
              type="time"
              value={sched.endTime}
              onChange={(e) => onChange({ ...sched, endTime: e.target.value })}
              className="w-full bg-transparent text-sm rounded-lg px-2 py-1.5"
              style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)" }}
            />
          </div>
        ) : (
          <div className="flex-1">
            <label className="text-[10px] block mb-0.5" style={{ color: "var(--tx-3)" }}>Duration (mins)</label>
            <input
              type="number"
              min={15}
              max={480}
              step={15}
              value={Math.max(durationMins, 30)}
              onChange={(e) => handleDurationChange(Number(e.target.value))}
              className="w-full bg-transparent text-sm rounded-lg px-2 py-1.5"
              style={{ color: "var(--tx-1)", border: "1px solid var(--bd-default)" }}
            />
          </div>
        )}
      </div>
      {durationMins > 0 && (
        <p className="text-[10px]" style={{ color: "var(--tx-4)" }}>{durationMins} mins · ends {sched.endTime}</p>
      )}
    </div>
  );
}

// ─── Class form (add / edit) ──────────────────────────────────────────────────

function ClassForm({
  initial,
  rankSystems,
  coachUsers,
  primaryColor,
  onSave,
  onCancel,
  saving,
}: {
  initial: Partial<ClassRow> | null;
  rankSystems: RankOption[];
  coachUsers: CoachUserOption[];
  primaryColor: string;
  onSave: (data: Record<string, unknown>) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const { toast: showToast } = useToast();
  const [name, setName] = useState(initial?.name ?? "");
  const [coachName, setCoachName] = useState(initial?.coachName ?? "");
  const [coachUserId, setCoachUserId] = useState(initial?.coachUserId ?? "");
  const [location, setLocation] = useState(initial?.location ?? "");
  const [duration, setDuration] = useState(String(initial?.duration ?? 60));
  const [maxCapacity, setMaxCapacity] = useState(String(initial?.maxCapacity ?? ""));
  const [description, setDescription] = useState(initial?.description ?? "");
  const [requiredRankId, setRequiredRankId] = useState(initial?.requiredRankId ?? "");
  const [maxRankId, setMaxRankId] = useState(initial?.maxRankId ?? "");
  // Task 12: per-class roster (mutually exclusive with rank gates).
  // useRoster=true switches the form into "comp class" mode: rank pickers hide,
  // member checkbox list appears. Server enforces mutual exclusion in PATCH too.
  const [useRoster, setUseRoster] = useState<boolean>(
    Boolean(initial?.roster && initial.roster.length > 0),
  );
  const [rosterMemberIds, setRosterMemberIds] = useState<string[]>(
    initial?.roster?.map((r: { memberId: string }) => r.memberId) ?? [],
  );
  const [availableMembers, setAvailableMembers] = useState<Array<{ id: string; name: string; email: string }>>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberSearch, setMemberSearch] = useState("");
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
    const invalidSchedule = schedules.find((s) => !s.startTime || !s.endTime);
    if (invalidSchedule) {
      showToast("Start and end time are required for all schedule entries", "error");
      return;
    }
    onSave({
      name: name.trim(),
      // When a User is selected, that's authoritative; coachName is the legacy
      // free-text fallback for clubs that haven't put their coaches in Users yet.
      coachName: coachName.trim() || null,
      coachUserId: coachUserId || null,
      location: location.trim() || null,
      duration: parseInt(duration) || 60,
      maxCapacity: maxCapacity ? parseInt(maxCapacity) : null,
      description: description.trim() || null,
      requiredRankId: useRoster ? null : (requiredRankId || null),
      maxRankId: useRoster ? null : (maxRankId || null),
      // Task 12: roster array is sent when in comp-class mode. Server clears
      // requiredRankId/maxRankId on the row to enforce mutual exclusion.
      roster: useRoster ? rosterMemberIds.map((id) => ({ memberId: id })) : undefined,
      color,
      schedules,
    });
  }

  async function openRosterPicker() {
    setUseRoster(true);
    // Wipe rank gates client-side so the form reflects the mutual-exclusion contract.
    setRequiredRankId("");
    setMaxRankId("");
    if (availableMembers.length === 0 && !membersLoading) {
      setMembersLoading(true);
      try {
        const res = await fetch("/api/members?take=200");
        if (res.ok) {
          const data = await res.json();
          const list = Array.isArray(data) ? data : data.members ?? [];
          setAvailableMembers(
            list.map((m: { id: string; name: string; email: string }) => ({ id: m.id, name: m.name, email: m.email })),
          );
        }
      } catch {
        // Silent — owner sees an empty list with a hint to refresh.
      } finally {
        setMembersLoading(false);
      }
    }
  }

  function closeRosterPicker() {
    setUseRoster(false);
    setRosterMemberIds([]);
  }

  function toggleRosterMember(id: string) {
    setRosterMemberIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  // Base input classes — border and focus handled via inline style + onFocus/onBlur
  const inputCls = "w-full bg-transparent rounded-xl px-3 py-2.5 text-sm outline-none placeholder:text-[var(--tx-3)] transition-colors";
  const inputStyle = { color: "var(--tx-1)", border: "1px solid var(--bd-default)" };
  const focusHandlers = {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-active)";
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-default)";
    },
  };

  return (
    <div className="space-y-4">
      {/* Name */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Class Name *</label>
        <input
          className={inputCls}
          style={inputStyle}
          placeholder="e.g. Beginner BJJ"
          value={name}
          onChange={(e) => setName(e.target.value)}
          {...focusHandlers}
        />
      </div>

      {/* Coach + Location */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Coach</label>
          {coachUsers.length > 0 ? (
            <select
              className={inputCls}
              style={{ ...inputStyle, appearance: "auto" }}
              value={coachUserId}
              onChange={(e) => setCoachUserId(e.target.value)}
              {...focusHandlers}
            >
              <option value="" style={{ background: "var(--sf-1)" }}>
                Free-text (use coach name below)
              </option>
              {coachUsers.map((u) => (
                <option key={u.id} value={u.id} style={{ background: "var(--sf-1)" }}>
                  {u.name} ({u.role})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs py-2.5" style={{ color: "var(--tx-3)" }}>No staff users yet — using free-text coach name below.</p>
          )}
          <input
            className={inputCls + " mt-2"}
            style={inputStyle}
            placeholder={coachUserId ? "Override (optional)" : "Coach Mike"}
            value={coachName}
            onChange={(e) => setCoachName(e.target.value)}
            {...focusHandlers}
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Location</label>
          <input
            className={inputCls}
            style={inputStyle}
            placeholder="Mat 1"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            {...focusHandlers}
          />
        </div>
      </div>

      {/* Duration + Capacity */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Duration (mins)</label>
          <input
            type="number"
            className={inputCls}
            style={inputStyle}
            placeholder="60"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            min={1}
            max={480}
            {...focusHandlers}
          />
        </div>
        <div>
          <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Max Capacity</label>
          <input
            type="number"
            className={inputCls}
            style={inputStyle}
            placeholder="Unlimited"
            value={maxCapacity}
            onChange={(e) => setMaxCapacity(e.target.value)}
            min={1}
            {...focusHandlers}
          />
        </div>
      </div>

      {/* Description */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Description</label>
        <textarea
          className={inputCls + " resize-none"}
          style={inputStyle}
          placeholder="Optional class description..."
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          {...focusHandlers}
        />
      </div>

      {/* Required + Max Rank — hidden when roster mode is on (mutually exclusive) */}
      {rankSystems.length > 0 && !useRoster && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Required Rank (min)</label>
            <select
              className={inputCls}
              style={{ ...inputStyle, appearance: "auto" }}
              value={requiredRankId}
              onChange={(e) => setRequiredRankId(e.target.value)}
              {...focusHandlers}
            >
              <option value="" style={{ background: "var(--sf-1)" }}>No requirement</option>
              {rankSystems.map((r) => (
                <option key={r.id} value={r.id} style={{ background: "var(--sf-1)" }}>
                  {r.discipline} — {r.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Max Rank (cap)</label>
            <select
              className={inputCls}
              style={{ ...inputStyle, appearance: "auto" }}
              value={maxRankId}
              onChange={(e) => setMaxRankId(e.target.value)}
              {...focusHandlers}
            >
              <option value="" style={{ background: "var(--sf-1)" }}>No cap</option>
              {rankSystems.map((r) => (
                <option key={r.id} value={r.id} style={{ background: "var(--sf-1)" }}>
                  {r.discipline} — {r.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Task 12: Comp-class roster picker (mutually exclusive with rank gates). */}
      {!useRoster && (
        <button
          type="button"
          onClick={openRosterPicker}
          className="text-xs hover:text-white/80 underline underline-offset-2 transition-colors"
          style={{ color: "var(--tx-3)" }}
        >
          + Select specific people (comp class)
        </button>
      )}
      {useRoster && (
        <div className="rounded-xl border p-3 space-y-2" style={{ borderColor: "var(--bd-default)" }}>
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>Comp class roster</label>
            <button
              type="button"
              onClick={closeRosterPicker}
              className="text-xs hover:text-white/80 underline underline-offset-2 transition-colors"
              style={{ color: "var(--tx-3)" }}
            >
              Switch back to rank gate
            </button>
          </div>
          <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>
            Only the members ticked below can attend or check in. Rank requirements are ignored when roster is set.
          </p>
          <input
            className={inputCls}
            style={inputStyle}
            placeholder="Search by name or email"
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            {...focusHandlers}
          />
          <div className="max-h-48 overflow-y-auto space-y-1">
            {membersLoading && <p className="text-xs" style={{ color: "var(--tx-3)" }}>Loading members…</p>}
            {!membersLoading && availableMembers.length === 0 && (
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>No members available. Add members first.</p>
            )}
            {availableMembers
              .filter((m) => {
                const q = memberSearch.trim().toLowerCase();
                if (!q) return true;
                return m.name.toLowerCase().includes(q) || m.email.toLowerCase().includes(q);
              })
              .map((m) => {
                const checked = rosterMemberIds.includes(m.id);
                return (
                  <label key={m.id} className="flex items-center gap-2 text-xs cursor-pointer hover:bg-white/5 rounded px-2 py-1" style={{ color: "var(--tx-2)" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRosterMember(m.id)}
                      className="accent-white"
                    />
                    <span>{m.name}</span>
                    <span style={{ color: "var(--tx-3)" }}>{m.email}</span>
                  </label>
                );
              })}
          </div>
          <p className="text-[11px]" style={{ color: "var(--tx-3)" }}>{rosterMemberIds.length} selected</p>
        </div>
      )}

      {/* Color */}
      <div>
        <label className="text-xs font-medium block mb-1.5" style={{ color: "var(--tx-3)" }}>Colour</label>
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
          <label className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>Recurring Schedule</label>
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
          <p className="text-xs italic" style={{ color: "var(--tx-4)" }}>No schedule — add recurring days above</p>
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
          className="flex-1 py-2.5 rounded-xl border text-sm font-medium hover:text-white transition-colors"
          style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
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
        style={{ background: "var(--sf-0)", borderLeft: "1px solid var(--bd-default)" }}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--bd-default)" }}>
          <h2 className="font-semibold text-base" style={{ color: "var(--tx-1)" }}>{title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-colors hover:text-white"
            style={{ background: "var(--sf-2)", color: "var(--tx-3)" }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TimetableManager({ initialClasses, rankSystems, coachUsers, primaryColor, role, currentUserId }: Props) {
  const searchParams = useSearchParams();
  const openedFromQuery = useRef(false);
  const [classes, setClasses] = useState<ClassRow[]>(initialClasses);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ClassRow | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const { toast: showToast } = useToast();

  const canManage = ["owner", "manager"].includes(role);

  // Session F: "My classes" filter. Default ON for coaches (the role most
  // likely to want it on every load), OFF for owner/manager. Persists per-
  // browser via localStorage so the choice survives reloads.
  const MY_CLASSES_KEY = "timetable.myClassesOnly";
  const [myClassesOnly, setMyClassesOnly] = useState<boolean>(role === "coach");
  // Hydrate from localStorage on mount (avoid SSR mismatch by reading inside effect)
  useEffect(() => {
    try {
      const stored = localStorage.getItem(MY_CLASSES_KEY);
      if (stored === "true") setMyClassesOnly(true);
      else if (stored === "false") setMyClassesOnly(false);
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(MY_CLASSES_KEY, String(myClassesOnly)); } catch {}
  }, [myClassesOnly]);

  // Hide the toggle entirely if the current user owns zero classes — there's
  // nothing to filter to. Owners with no coachUserId assignments also don't
  // see the toggle, which keeps the header clean for non-coach owners.
  const ownedCount = currentUserId
    ? classes.filter((c) => c.coachUserId === currentUserId).length
    : 0;
  const showMyToggle = currentUserId !== null && ownedCount > 0;

  const visibleClasses =
    myClassesOnly && showMyToggle
      ? classes.filter((c) => c.coachUserId === currentUserId)
      : classes;

  // Group by day — driven by `visibleClasses` so the weekly grid filters too
  const byDay = Array.from({ length: 7 }, (_, i) =>
    visibleClasses
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

  useEffect(() => {
    if (!canManage || openedFromQuery.current) return;
    if (searchParams.get("new") === "class") {
      openedFromQuery.current = true;
      setEditTarget(null);
      setDrawerOpen(true);
    }
  }, [canManage, searchParams]);

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
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "Failed");
        }
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
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          throw new Error(body?.error ?? "Failed");
        }
        const created = await res.json();
        setClasses((prev) => [...prev, created]);
        showToast("Class created", "success");
      }
      setDrawerOpen(false);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Something went wrong", "error");
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
          <h1 className="text-2xl font-bold" style={{ color: "var(--tx-1)" }}>Timetable</h1>
          <p className="text-sm mt-0.5" style={{ color: "var(--tx-3)" }}>
            {myClassesOnly && showMyToggle
              ? `${visibleClasses.length} of ${classes.length} class${classes.length !== 1 ? "es" : ""} (mine)`
              : `${classes.length} class${classes.length !== 1 ? "es" : ""}`}{" "}
            · Manage your schedule
          </p>
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
              className="flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-medium hover:text-white transition-colors"
              style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
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

      {/* My-classes filter toggle. Shown only when the current user owns ≥1 class;
          coaches default to ON, owner/manager to OFF (override persisted in localStorage). */}
      {showMyToggle && (
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={() => setMyClassesOnly(false)}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
            style={{
              background: !myClassesOnly ? hex(primaryColor, 0.15) : "var(--sf-1)",
              color: !myClassesOnly ? primaryColor : "var(--tx-3)",
              border: `1px solid ${!myClassesOnly ? primaryColor : "var(--bd-default)"}`,
            }}
          >
            All classes ({classes.length})
          </button>
          <button
            onClick={() => setMyClassesOnly(true)}
            className="px-3 py-1.5 rounded-full text-xs font-medium transition-all"
            style={{
              background: myClassesOnly ? hex(primaryColor, 0.15) : "var(--sf-1)",
              color: myClassesOnly ? primaryColor : "var(--tx-3)",
              border: `1px solid ${myClassesOnly ? primaryColor : "var(--bd-default)"}`,
            }}
          >
            My classes ({ownedCount})
          </button>
        </div>
      )}

      {classes.length === 0 ? (
        <EmptyState onAdd={openAdd} primaryColor={primaryColor} />
      ) : (
        <div className="space-y-6">
          {/* Weekly view */}
          {(() => {
            const weekDates = getWeekDates(weekOffset);
            const todayMidnight = new Date();
            todayMidnight.setHours(0, 0, 0, 0);
            return (
              <>
                {/* Week navigation */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => setWeekOffset((w) => w - 1)}
                      className="w-8 h-8 rounded-lg flex items-center justify-center hover:text-white hover:bg-white/5 transition-colors"
                      style={{ color: "var(--tx-3)" }}
                      aria-label="Previous week"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <span className="text-sm font-medium px-1 min-w-[180px] text-center" style={{ color: "var(--tx-2)" }}>
                      {fmtWeekLabel(weekDates)}
                    </span>
                    <button
                      onClick={() => setWeekOffset((w) => w + 1)}
                      className="w-8 h-8 rounded-lg flex items-center justify-center hover:text-white hover:bg-white/5 transition-colors"
                      style={{ color: "var(--tx-3)" }}
                      aria-label="Next week"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  {weekOffset !== 0 && (
                    <button
                      onClick={() => setWeekOffset(0)}
                      className="text-xs px-3 py-1 rounded-lg border hover:text-white hover:border-white/20 transition-colors"
                      style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}
                    >
                      Today
                    </button>
                  )}
                </div>

                {/* 7-column scrollable grid */}
                <div className="overflow-x-auto -mx-1 px-1">
                  {/* Each cell needs ≥130px to fit names like "Fundamentals BJJ" / "Advanced BJJ"
                      on a single line. 7 × 140 = 980px min-width, so the grid scrolls
                      horizontally on viewports below ~1050px instead of cramming words mid-break. */}
                  <div className="grid grid-cols-7 min-w-[980px] gap-2">
                    {weekDates.map((date, rawIdx) => {
                      const dow = rawIdx === 6 ? 0 : rawIdx + 1;
                      const dayClasses = byDay[dow];
                      const isToday = date.getTime() === todayMidnight.getTime();
                      return (
                        <div
                          key={rawIdx}
                          className="rounded-2xl border p-2 flex flex-col"
                          style={{
                            background: isToday ? hex(primaryColor, 0.04) : "var(--sf-1)",
                            borderColor: isToday ? hex(primaryColor, 0.3) : "var(--bd-default)",
                          }}
                        >
                          {/* Day header */}
                          <div className="text-center mb-2">
                            <p
                              className="text-[10px] font-semibold uppercase tracking-wider mb-1"
                              style={{ color: isToday ? primaryColor : "var(--tx-3)" }}
                            >
                              {DAYS[dow]}
                            </p>
                            <div
                              className="w-7 h-7 rounded-full flex items-center justify-center mx-auto text-sm font-bold"
                              style={
                                isToday
                                  ? { background: primaryColor, color: "#fff" }
                                  : { color: "var(--tx-2)" }
                              }
                            >
                              {date.getDate()}
                            </div>
                          </div>

                          {/* Classes */}
                          <div className="space-y-1.5 flex-1">
                            {dayClasses.length === 0 ? (
                              <p className="text-center text-[11px] py-4" style={{ color: "var(--tx-4)" }}>—</p>
                            ) : (
                              dayClasses.map((cls) => {
                                const sched = cls.schedules.find((s) => s.dayOfWeek === dow);
                                const color = cls.color ?? primaryColor;
                                return (
                                  <button
                                    key={cls.id}
                                    onClick={() => canManage && openEdit(cls)}
                                    className="w-full text-left rounded-xl px-2 py-1.5 flex items-start gap-1.5 transition-all hover:brightness-110"
                                    style={{ background: hex(color, 0.12), border: `1px solid ${hex(color, 0.2)}` }}
                                  >
                                    <div className="w-1.5 h-1.5 rounded-full shrink-0 mt-1" style={{ background: color }} />
                                    <div className="min-w-0 flex-1">
                                      {/* break-words (not truncate) so class names like "Fundamentals BJJ"
                                          wrap to two lines on narrow viewports instead of cutting off ("Fun…"). */}
                                      <p className="text-[11px] font-semibold leading-tight break-words" style={{ color: "var(--tx-1)" }}>{cls.name}</p>
                                      <p className="text-[10px] mt-0.5" style={{ color: "var(--tx-3)" }}>{sched?.startTime} · {cls.duration}m</p>
                                    </div>
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            );
          })()}

          {/* All classes list */}
          <div>
            <h2 className="font-semibold text-sm mb-3" style={{ color: "var(--tx-1)" }}>
              {myClassesOnly && showMyToggle ? "My Classes" : "All Classes"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {visibleClasses.map((cls) => (
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
          coachUsers={coachUsers}
          primaryColor={primaryColor}
          onSave={handleSave}
          onCancel={() => setDrawerOpen(false)}
          saving={saving}
        />
      </Drawer>
    </div>
  );
}
