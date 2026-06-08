"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  Users, Clock, MapPin, Check, X, Search,
  ChevronDown, UserPlus, Loader2,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { CheckinClassInstance, CheckinMember } from "@/app/dashboard/checkin/page";
import KioskPanel from "@/components/dashboard/KioskPanel";
import { Avatar } from "@/components/ui/Avatar";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  instances: CheckinClassInstance[];
  initialInstanceId: string | null;
  initialMembers: CheckinMember[];
  primaryColor: string;
  role: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function BeltDot({ color }: { color: string | null }) {
  if (!color) return null;
  const isDark = color === "#111111";
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full shrink-0"
      style={{ background: color, border: isDark ? "1px solid var(--bd-active)" : undefined }}
    />
  );
}

// ─── Member row ───────────────────────────────────────────────────────────────

function MemberRow({
  member,
  primaryColor,
  onToggle,
  toggling,
  autoPending,
}: {
  member: CheckinMember;
  primaryColor: string;
  onToggle: (id: string, current: boolean) => void;
  toggling: boolean;
  autoPending: boolean;
}) {
  return (
    <button
      onClick={() => onToggle(member.id, member.checkedIn)}
      disabled={toggling}
      className="w-full flex items-center gap-3 px-4 py-3.5 rounded-2xl border transition-all active:scale-[0.98]"
      style={{
        background: member.checkedIn ? hex(primaryColor, 0.08) : "var(--sf-1)",
        borderColor: member.checkedIn ? hex(primaryColor, 0.3) : "var(--bd-default)",
        outline: autoPending ? `2px dashed ${primaryColor}` : undefined,
        outlineOffset: autoPending ? 2 : undefined,
      }}
    >
      {/* feat/member-profile-pictures Track A Phase A5: register-row avatar.
          When the row is checked-in, draw a ring in the gym's primary colour
          so the at-a-glance state cue is preserved. */}
      <Avatar
        pictureUrl={member.profilePictureUrl}
        name={member.name}
        colorSeed={member.id}
        size="md"
        ring={member.checkedIn}
      />

      {/* Info */}
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>{member.name}</p>
          {member.rankName && (
            <div className="flex items-center gap-1">
              <BeltDot color={member.rankColor} />
              <span className="text-xs hidden sm:inline" style={{ color: "var(--tx-3)" }}>{member.rankName}</span>
            </div>
          )}
        </div>
        {member.membershipType && (
          <p className="text-xs truncate" style={{ color: "var(--tx-3)" }}>{member.membershipType}</p>
        )}
      </div>

      {/* Check indicator */}
      <div
        className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 transition-all"
        style={{
          background: member.checkedIn ? primaryColor : "var(--sf-2)",
        }}
      >
        {toggling ? (
          <Loader2 className="w-4 h-4 text-white animate-spin" />
        ) : member.checkedIn ? (
          <Check className="w-4 h-4 text-white" />
        ) : (
          <X className="w-3.5 h-3.5" style={{ color: "var(--tx-3)" }} />
        )}
      </div>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AdminCheckin({
  instances,
  initialInstanceId,
  initialMembers,
  primaryColor,
  role,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(initialInstanceId);
  const [members, setMembers] = useState<CheckinMember[]>(initialMembers);
  const [loadingInstance, setLoadingInstance] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [walkInMode, setWalkInMode] = useState(false);
  const [showClassPicker, setShowClassPicker] = useState(false);
  const [autoPendingId, setAutoPendingId] = useState<string | null>(null);
  const { toast: showToast } = useToast();
  const searchRef = useRef<HTMLInputElement>(null);

  const selectedInstance = instances.find((i) => i.id === selectedId);
  const checkedInCount = members.filter((m) => m.checkedIn).length;

  const filtered = useMemo(() => {
    if (!query.trim()) return members;
    const q = query.toLowerCase();
    return members.filter((m) => m.name.toLowerCase().includes(q));
  }, [members, query]);

  // Smart auto-select: when the search query uniquely matches a single
  // not-yet-checked-in member, auto-fire toggleCheckin after a short
  // debounce. Gives staff a 600 ms window to keep typing if they meant
  // someone else (the dashed outline on the candidate row signals the
  // pending action; backspace cancels it).
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || walkInMode || !selectedId) {
      setAutoPendingId(null);
      return;
    }
    const candidates = members.filter((m) => !m.checkedIn && m.name.toLowerCase().includes(q));
    if (candidates.length !== 1) {
      setAutoPendingId(null);
      return;
    }
    const winner = candidates[0];
    setAutoPendingId(winner.id);
    const t = setTimeout(() => {
      setAutoPendingId(null);
      // Re-check freshness against latest state at fire-time: skip if the
      // member was already checked in by another path while debounce was
      // pending.
      if (members.find((m) => m.id === winner.id)?.checkedIn) return;
      void (async () => {
        await toggleCheckin(winner.id, false);
        setQuery("");
        showToast(`Checked in: ${winner.name}`, "success");
      })();
    }, 600);
    return () => clearTimeout(t);
    // toggleCheckin / showToast are stable enough — re-creating the effect
    // on every member array change is intentional so freshness is honoured.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, members, walkInMode, selectedId]);

  async function loadMembers(instanceId: string) {
    setLoadingInstance(true);
    try {
      const res = await fetch(`/api/checkin/members?instanceId=${instanceId}`);
      const data = await res.json();
      setMembers(data);
    } catch {
      showToast("Failed to load members", "error");
    } finally {
      setLoadingInstance(false);
    }
  }

  async function selectInstance(id: string) {
    setSelectedId(id);
    setShowClassPicker(false);
    setQuery("");
    await loadMembers(id);
  }

  async function toggleCheckin(memberId: string, currentlyCheckedIn: boolean) {
    if (!selectedId) return;
    if (currentlyCheckedIn && !confirm("Remove this member's check-in for this class?")) return;
    setToggling(memberId);

    try {
      if (currentlyCheckedIn) {
        const res = await fetch(
          `/api/checkin?classInstanceId=${selectedId}&memberId=${memberId}`,
          { method: "DELETE" }
        );
        if (!res.ok) throw new Error("Failed");
        setMembers((prev) =>
          prev.map((m) => (m.id === memberId ? { ...m, checkedIn: false } : m))
        );
      } else {
        const res = await fetch("/api/checkin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            classInstanceId: selectedId,
            memberId,
            checkInMethod: "admin",
          }),
        });
        if (res.status === 409) {
          // Already checked in — update UI
          setMembers((prev) =>
            prev.map((m) => (m.id === memberId ? { ...m, checkedIn: true } : m))
          );
          return;
        }
        if (!res.ok) throw new Error("Failed");
        setMembers((prev) =>
          prev.map((m) => (m.id === memberId ? { ...m, checkedIn: true } : m))
        );
      }
    } catch {
      showToast("Check-in failed", "error");
    } finally {
      setToggling(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">

      {/* Header */}
      <div className="mb-5">
        <h1 className="text-2xl font-bold" style={{ color: "var(--tx-1)" }}>Mark Attendance</h1>
        <p className="text-sm mt-0.5" style={{ color: "var(--tx-3)" }}>Mark attendance for today&apos;s classes</p>
      </div>

      {/* Kiosk panel — owner sees full controls; manager/coach see read-only pill */}
      <div className="mb-5">
        <KioskPanel primaryColor={primaryColor} role={role} variant="compact" />
      </div>

      {instances.length === 0 ? (
        <div className="text-center py-20">
          <div
            className="w-16 h-16 rounded-3xl flex items-center justify-center mx-auto mb-4"
            style={{ background: hex(primaryColor, 0.1) }}
          >
            <Users className="w-8 h-8" style={{ color: primaryColor }} />
          </div>
          <h3 className="font-semibold text-lg mb-1" style={{ color: "var(--tx-1)" }}>No classes today</h3>
          <p className="text-sm" style={{ color: "var(--tx-3)" }}>
            No class instances are scheduled for today. Generate them from the Timetable page.
          </p>
        </div>
      ) : (
        <>
          {/* Class picker */}
          <div className="mb-4">
            <button
              onClick={() => setShowClassPicker(!showClassPicker)}
              className="w-full flex items-center justify-between px-4 py-3.5 rounded-2xl border transition-all"
              style={{
                background: selectedInstance ? hex(selectedInstance.color ?? primaryColor, 0.07) : "var(--sf-1)",
                borderColor: "var(--bd-default)",
              }}
            >
              {selectedInstance ? (
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: selectedInstance.color ?? primaryColor }} />
                  <div className="text-left min-w-0">
                    <p className="font-semibold text-sm truncate" style={{ color: "var(--tx-1)" }}>{selectedInstance.name}</p>
                    <div className="flex items-center gap-3 text-xs" style={{ color: "var(--tx-3)" }}>
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{formatTime(selectedInstance.startTime)}</span>
                      {selectedInstance.location && <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{selectedInstance.location}</span>}
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm" style={{ color: "var(--tx-3)" }}>Select a class</p>
              )}
              <ChevronDown className={`w-4 h-4 transition-transform ${showClassPicker ? "rotate-180" : ""}`} style={{ color: "var(--tx-3)" }} />
            </button>

            {showClassPicker && (
              <div className="mt-2 rounded-2xl border overflow-hidden" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}>
                {instances.map((inst, idx) => (
                  <button
                    key={inst.id}
                    onClick={() => selectInstance(inst.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/5"
                    style={{
                      borderBottom: idx === instances.length - 1 ? "none" : "1px solid var(--bd-default)",
                    }}
                  >
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: inst.color ?? primaryColor }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{inst.name}</p>
                      <p className="text-xs" style={{ color: "var(--tx-3)" }}>{formatTime(inst.startTime)} – {formatTime(inst.endTime)}</p>
                    </div>
                    {inst.id === selectedId && <Check className="w-4 h-4 shrink-0" style={{ color: primaryColor }} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Stats bar */}
          {selectedInstance && (
            <div
              className="flex items-center gap-4 px-4 py-2.5 rounded-xl mb-4"
              style={{ background: "var(--sf-1)" }}
            >
              <div className="flex items-center gap-2">
                <div className="w-5 h-5 rounded-full flex items-center justify-center" style={{ background: primaryColor }}>
                  <Check className="w-3 h-3 text-white" />
                </div>
                <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{checkedInCount} checked in</span>
              </div>
              <span style={{ color: "var(--tx-4)" }}>·</span>
              <span className="text-sm" style={{ color: "var(--tx-3)" }}>{members.length - checkedInCount} remaining</span>
              {selectedInstance.maxCapacity && (
                <>
                  <span style={{ color: "var(--tx-4)" }}>·</span>
                  <span className="text-sm" style={{ color: "var(--tx-3)" }}>Cap: {selectedInstance.maxCapacity}</span>
                </>
              )}
            </div>
          )}

          {/* Search */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "var(--tx-3)" }} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search members..."
              className="w-full border rounded-xl pl-9 pr-3 py-2.5 text-sm focus:outline-none transition-colors"
              style={{
                background: "var(--sf-1)",
                borderColor: "var(--bd-default)",
                color: "var(--tx-1)",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
            />
          </div>

          {/* Members list */}
          {loadingInstance ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: primaryColor }} />
            </div>
          ) : (
            <div className="space-y-2">
              {/* Checked in first, then unchecked */}
              {[...filtered.filter((m) => m.checkedIn), ...filtered.filter((m) => !m.checkedIn)].map((member) => (
                <MemberRow
                  key={member.id}
                  member={member}
                  primaryColor={primaryColor}
                  onToggle={toggleCheckin}
                  toggling={toggling === member.id}
                  autoPending={autoPendingId === member.id}
                />
              ))}

              {filtered.length === 0 && (
                <div className="text-center py-10">
                  <p className="text-sm" style={{ color: "var(--tx-3)" }}>No members found</p>
                </div>
              )}

              {/* Walk-in banner */}
              {walkInMode && query.trim() && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl text-xs font-medium mb-1" style={{ background: "rgba(245,158,11,0.08)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.2)" }}>
                  <UserPlus className="w-3.5 h-3.5 shrink-0" />
                  Walk-in search active - select an existing member above to check them in
                </div>
              )}

              {/* Walk-in button */}
              <button
                onClick={() => { setWalkInMode(true); setQuery(""); searchRef.current?.focus(); }}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl border border-dashed text-sm transition-colors mt-2"
                style={{
                  borderColor: walkInMode ? "rgba(245,158,11,0.4)" : "var(--bd-default)",
                  color: walkInMode ? "#f59e0b" : "var(--tx-3)",
                }}
              >
                <UserPlus className="w-4 h-4" />
                {walkInMode ? "Walk-In Search Active" : "Find Walk-In Member"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
