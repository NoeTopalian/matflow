"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Users, Clock, MapPin, Check, X, Search,
  ChevronDown, UserPlus, Loader2, RefreshCw,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import type { CheckinClassInstance, CheckinMember } from "@/app/dashboard/checkin/page";
import KioskPanel from "@/components/dashboard/KioskPanel";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog, useConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageHeader } from "@/components/ui/page-header";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  instances: CheckinClassInstance[];
  initialInstanceId: string | null;
  initialMembers: CheckinMember[];
  primaryColor: string;
  role: string;
  activeClassIds: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Token-safe tint, replacing the local `hex()` byte-maths copy (UI-RULES §2).
 * `color-mix` takes the `--hue-*` CSS vars as well as the runtime tenant hex.
 */
function tint(color: string, percent: number) {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`;
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
      className="w-full flex items-center gap-3 px-4 py-3.5 rounded-[var(--r-md)] border transition-all active:scale-[0.98] enabled:hover:border-bd-hover"
      style={{
        background: member.checkedIn ? tint(primaryColor, 8) : "var(--sf-1)",
        borderColor: member.checkedIn ? tint(primaryColor, 30) : "var(--bd-default)",
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
        className="w-8 h-8 rounded-[var(--r-sm)] flex items-center justify-center shrink-0 transition-all"
        style={{
          background: member.checkedIn ? primaryColor : "var(--sf-2)",
          // §2a: text/icons on a tenant-accent fill come from the token, never
          // a hardcoded white — a pale-yellow tenant accent would swallow them.
          color: member.checkedIn ? "var(--tx-on-accent)" : "var(--tx-3)",
        }}
      >
        {toggling ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : member.checkedIn ? (
          <Check className="w-4 h-4" />
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
  activeClassIds,
}: Props) {
  const router = useRouter();
  const [selectedId, setSelectedId] = useState<string | null>(initialInstanceId);
  const [members, setMembers] = useState<CheckinMember[]>(initialMembers);
  const [loadingInstance, setLoadingInstance] = useState(false);
  const [toggling, setToggling] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [walkInMode, setWalkInMode] = useState(false);
  const [showClassPicker, setShowClassPicker] = useState(false);
  const [autoPendingId, setAutoPendingId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const { toast: showToast } = useToast();
  const { ask, dialogProps } = useConfirmDialog();
  const searchRef = useRef<HTMLInputElement>(null);

  async function generateInstances() {
    if (generating || activeClassIds.length === 0) return;
    setGenerating(true);
    try {
      // Audit D4: a non-ok response must fail loudly — previously 403/500s
      // resolved the Promise.all and the page refreshed as if it worked.
      const results = await Promise.all(
        activeClassIds.map((id) =>
          fetch(`/api/classes/${id}/instances`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ weeks: 1 }),
          }),
        ),
      );
      const failed = results.filter((r) => !r.ok).length;
      if (failed > 0) {
        showToast(
          failed === results.length
            ? "Could not generate classes — you may not have permission."
            : `Generated some classes, but ${failed} failed — try again.`,
          "error",
        );
        if (failed === results.length) return;
      }
      router.refresh();
    } catch {
      showToast("Failed to generate classes — please try again", "error");
    } finally {
      setGenerating(false);
    }
  }

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
    // §5.4: removing a check-in still asks first — the question is now the
    // ConfirmDialog primitive rather than the browser's native box.
    if (
      currentlyCheckedIn &&
      !(await ask({
        title: "Remove this check-in?",
        body: "The member will no longer be marked as attending this class.",
        confirmLabel: "Remove check-in",
        destructive: true,
      }))
    ) {
      return;
    }
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
    <>

      <PageHeader title="Mark attendance" description="Mark attendance for today’s classes" />

      {/* Kiosk panel — owner sees full controls; manager/coach see read-only pill */}
      <div className="mb-5">
        <KioskPanel primaryColor={primaryColor} role={role} variant="compact" />
      </div>

      {instances.length === 0 ? (
        <div className="text-center py-20">
          <div
            className="w-16 h-16 rounded-[var(--r-lg)] flex items-center justify-center mx-auto mb-4"
            style={{ background: tint(primaryColor, 10) }}
          >
            <Users className="w-8 h-8" style={{ color: primaryColor }} />
          </div>
          <h3 className="font-semibold text-lg mb-1" style={{ color: "var(--tx-1)" }}>No classes today</h3>
          <p className="text-sm mb-5" style={{ color: "var(--tx-3)" }}>
            No class instances are scheduled for today.
          </p>
          {/* Audit R1: POST /api/classes/[id]/instances is owner|manager —
              don't offer the button to roles it will 403 for. */}
          {activeClassIds.length > 0 && ["owner", "manager"].includes(role) && (
            <Button onClick={generateInstances} loading={generating}>
              {!generating && <RefreshCw className="size-4" />}
              Generate this week&apos;s classes
            </Button>
          )}
        </div>
      ) : (
        /* §4a.2 — the class rail and the roster are a STRUCTURAL split, so they
           divide at `lg:` (a 1280px laptop leaves ~1000px of content box, which
           carries a 320px rail plus a comfortable roster). Below `lg:` the page
           stays the single mobile column it has always been, with the rail's
           class list collapsed behind its summary button. `minmax(0,1fr)` is
           the §4a.2 blowout guard for the roster track. */
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
          {/* ── Left rail: which class, and how it is going ── */}
          <div className="space-y-3 lg:sticky lg:top-0">
            <Card padding="tight" className="space-y-2">
              <p className="hidden lg:block text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--tx-3)" }}>
                Today&apos;s classes
              </p>

              {/* Below `lg:` the rail is a disclosure — the summary shows the
                  selected class and taps open the list. From `lg:` the list is
                  simply always there, so the summary button is redundant. */}
              <button
                onClick={() => setShowClassPicker(!showClassPicker)}
                aria-expanded={showClassPicker}
                className="lg:hidden w-full flex items-center justify-between gap-3 px-3 py-3 rounded-[var(--r-sm)] border transition-colors"
                style={{
                  background: selectedInstance ? tint(selectedInstance.color ?? primaryColor, 7) : "var(--sf-1)",
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
                <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${showClassPicker ? "rotate-180" : ""}`} style={{ color: "var(--tx-3)" }} />
              </button>

              <div className={`space-y-1 ${showClassPicker ? "block" : "hidden lg:block"}`}>
                {instances.map((inst) => {
                  const isSelected = inst.id === selectedId;
                  const dot = inst.color ?? primaryColor;
                  return (
                    <button
                      key={inst.id}
                      onClick={() => selectInstance(inst.id)}
                      aria-current={isSelected ? "true" : undefined}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[var(--r-sm)] border text-left transition-colors hover:bg-sf-2"
                      style={{
                        background: isSelected ? tint(dot, 10) : "transparent",
                        borderColor: isSelected ? tint(dot, 35) : "transparent",
                      }}
                    >
                      <div className="w-2 h-2 rounded-full shrink-0" style={{ background: dot }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium truncate" style={{ color: "var(--tx-1)" }}>{inst.name}</p>
                        <p className="text-xs" style={{ color: "var(--tx-3)" }}>{formatTime(inst.startTime)} – {formatTime(inst.endTime)}</p>
                      </div>
                      {isSelected && <Check className="w-4 h-4 shrink-0" style={{ color: primaryColor }} />}
                    </button>
                  );
                })}
              </div>
            </Card>

            {/* Stats for the selected class */}
            {selectedInstance && (
              <Card padding="tight" className="flex flex-wrap items-center gap-x-4 gap-y-1 lg:block lg:space-y-2">
                <div className="flex items-center gap-2">
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: primaryColor, color: "var(--tx-on-accent)" }}
                  >
                    <Check className="w-3 h-3" />
                  </div>
                  <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{checkedInCount} checked in</span>
                </div>
                <span className="text-sm" style={{ color: "var(--tx-3)" }}>{members.length - checkedInCount} remaining</span>
                {selectedInstance.maxCapacity && (
                  <span className="text-sm" style={{ color: "var(--tx-3)" }}>Cap: {selectedInstance.maxCapacity}</span>
                )}
              </Card>
            )}
          </div>

          {/* ── Right pane: search + roster ── */}
          <div className="min-w-0">
            {/* Search */}
            <div className="relative mb-4">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: "var(--tx-3)" }} />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search members..."
                aria-label="Search members"
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
                  <div
                    className="flex items-center gap-2 px-3 py-2 rounded-[var(--r-sm)] text-xs font-medium mb-1 border"
                    style={{
                      background: tint("var(--hue-warning)", 8),
                      color: "var(--hue-warning)",
                      borderColor: tint("var(--hue-warning)", 25),
                    }}
                  >
                    <UserPlus className="w-3.5 h-3.5 shrink-0" />
                    Walk-in search active — select an existing member above to check them in
                  </div>
                )}

                {/* Walk-in button */}
                <Button
                  variant="secondary"
                  onClick={() => { setWalkInMode(true); setQuery(""); searchRef.current?.focus(); }}
                  className="mt-2 w-full border-dashed bg-transparent"
                  style={
                    walkInMode
                      ? { borderColor: tint("var(--hue-warning)", 45), color: "var(--hue-warning)" }
                      : { color: "var(--tx-3)" }
                  }
                >
                  <UserPlus className="size-4" />
                  {walkInMode ? "Walk-in search active" : "Find walk-in member"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog {...dialogProps} />
    </>
  );
}
