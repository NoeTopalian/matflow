"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, User, Mail, Phone, Calendar, Award, Activity,
  Edit2, ChevronDown, Check, X, Shield, Clock, FileText,
  Users, Dumbbell, Save, Loader2, CreditCard, Plus, Receipt,
  AlertTriangle, FileCheck2, MoreHorizontal, CalendarCheck,
  Link2, MapPin,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import MarkPaidDrawer from "@/components/dashboard/MarkPaidDrawer";
import { RemoveMemberModal } from "@/components/dashboard/RemoveMemberModal";
import { AvatarUploader } from "@/components/ui/AvatarUploader";
import { Avatar } from "@/components/ui/Avatar";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberDetail {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  membershipType: string | null;
  status: string;
  paymentStatus?: string | null;
  notes: string | null;
  // feat/member-profile-pictures Track A: rendered by the header AvatarUploader.
  // Null falls back to deterministic initials. Set by staff or by the member
  // themselves via PUT /api/members/[id]/profile-picture.
  profilePictureUrl: string | null;
  joinedAt: string;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;
  medicalConditions: string | null;
  dateOfBirth: string | null;
  waiverAccepted: boolean;
  waiverAcceptedAt: string | null;
  subscriptions: {
    id: string;
    classId: string;
    className: string;
    coachName: string | null;
    location: string | null;
    createdAt: string;
    schedules: {
      dayOfWeek: number;
      startTime: string;
      endTime: string;
    }[];
  }[];
  ranks: {
    id: string;
    rankSystemId: string;
    discipline: string;
    rankName: string;
    color: string;
    stripes: number;
    achievedAt: string;
  }[];
  attendances: {
    id: string;
    className: string;
    date: string;
    startTime: string;
    endTime: string;
    checkInTime: string;
    method: string;
    coachName: string | null;
    location: string | null;
  }[];
}

export interface RankOption {
  id: string;
  discipline: string;
  name: string;
  color: string;
  order: number;
}

export interface MembershipTierOption {
  id: string;
  name: string;
}

interface Props {
  member: MemberDetail;
  rankOptions: RankOption[];
  tiers?: MembershipTierOption[];
  primaryColor: string;
  role: string;
  tenantSlug: string;
}

type ActiveTab = "overview" | "attendance" | "ranks" | "notes" | "payments" | "photos";

type PaymentEntry = {
  id: string;
  amountPence: number;
  currency: string;
  status: string;
  description: string | null;
  paidAt: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// feat/member-profile-pictures Track A Phase A1: canonical helper now lives
// in lib/initials.ts (used by Avatar + AvatarUploader). Local function removed.


function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function daysSince(iso?: string | null) {
  if (!iso) return null;
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatScheduleSummary(schedules: MemberDetail["subscriptions"][number]["schedules"]) {
  if (schedules.length === 0) return "No active schedule";
  return schedules.map((s) => `${DAY_LABELS[s.dayOfWeek] ?? "Day"} ${s.startTime}-${s.endTime}`).join(", ");
}

function paymentMeta(status?: string | null) {
  const s = (status ?? "paid").toLowerCase();
  if (s === "paid") return { label: "Paid", color: "#22c55e", bg: "rgba(34,197,94,0.12)", Icon: Check };
  if (s === "overdue") return { label: "Overdue", color: "#f97316", bg: "rgba(249,115,22,0.14)", Icon: AlertTriangle };
  if (s === "pending") return { label: "Pending", color: "#38bdf8", bg: "rgba(56,189,248,0.13)", Icon: CreditCard };
  if (s === "paused") return { label: "Paused", color: "#a78bfa", bg: "rgba(167,139,250,0.13)", Icon: Clock };
  if (s === "free") return { label: "Free", color: "#94a3b8", bg: "rgba(148,163,184,0.12)", Icon: CreditCard };
  if (s === "cancelled") return { label: "Cancelled", color: "#ef4444", bg: "rgba(239,68,68,0.13)", Icon: AlertTriangle };
  return { label: s.charAt(0).toUpperCase() + s.slice(1), color: "#94a3b8", bg: "rgba(148,163,184,0.12)", Icon: CreditCard };
}

function ProfileChip({
  children,
  color,
  bg,
  icon: Icon,
}: {
  children: React.ReactNode;
  color: string;
  bg: string;
  icon?: React.ElementType;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold" style={{ color, background: bg }}>
      {Icon && <Icon className="w-3 h-3" />}
      {children}
    </span>
  );
}

function BeltGraphic({ color, stripes }: { color: string; stripes: number }) {
  return (
    <div className="relative h-5 rounded flex items-center px-1 gap-0.5" style={{ background: color, width: 80, minWidth: 80 }}>
      <div className="absolute left-0 top-0 bottom-0 w-3 rounded-l" style={{ background: "rgba(0,0,0,0.3)" }} />
      {Array.from({ length: stripes }).map((_, i) => (
        <div key={i} className="w-2 h-3 rounded-sm" style={{ background: "white", opacity: 0.9, marginLeft: i === 0 ? 14 : 2 }} />
      ))}
    </div>
  );
}

const STATUS_OPTIONS: { value: string; label: string; color: string; bg: string }[] = [
  { value: "active",    label: "Active",    color: "#4ade80", bg: "rgba(74,222,128,0.12)"  },
  { value: "inactive",  label: "Inactive",  color: "#facc15", bg: "rgba(250,204,21,0.12)"  },
  { value: "taster",    label: "Taster",    color: "#60a5fa", bg: "rgba(96,165,250,0.12)"  },
  { value: "cancelled", label: "Cancelled", color: "#f87171", bg: "rgba(248,113,113,0.12)" },
];

function Tab({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
        active ? "border-white" : "border-transparent hover:border-white/20"
      }`}
      style={{ color: active ? "var(--tx-1)" : "var(--tx-3)" }}
    >
      {label}{count !== undefined ? ` (${count})` : ""}
    </button>
  );
}

function InfoRow({ icon: Icon, label, value, muted }: { icon: React.ElementType; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: "var(--sf-1)" }}>
        <Icon className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
      </div>
      <div>
        <p className="text-xs" style={{ color: "var(--tx-3)" }}>{label}</p>
        <p className="text-sm mt-0.5" style={{ color: muted ? "var(--tx-3)" : "var(--tx-1)" }}>{value}</p>
      </div>
    </div>
  );
}

function PaymentStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  const cls =
    s === "succeeded" || s === "paid"
      ? "bg-green-500/15 text-green-400"
      : s === "pending"
      ? "bg-yellow-500/15 text-yellow-400"
      : s === "refunded"
      ? "bg-blue-500/15 text-blue-400"
      : s === "disputed"
      ? "bg-purple-500/15 text-purple-400"
      : "bg-red-500/15 text-red-400";
  const label = s === "succeeded" ? "Paid" : s.charAt(0).toUpperCase() + s.slice(1);
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${cls}`}>{label}</span>;
}


// ─── Main component ───────────────────────────────────────────────────────────

export default function MemberProfile({ member: initial, rankOptions, tiers = [], primaryColor, role, tenantSlug }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [member, setMember] = useState(initial);
  const [tab, setTab] = useState<ActiveTab>("overview");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notesDraft, setNotesDraft] = useState(initial.notes ?? "");
  const [notesSaving, setNotesSaving] = useState(false);
  const [form, setForm] = useState({
    name: initial.name,
    email: initial.email,
    phone: initial.phone ?? "",
    emergencyContactName: initial.emergencyContactName ?? "",
    emergencyContactPhone: initial.emergencyContactPhone ?? "",
    emergencyContactRelation: initial.emergencyContactRelation ?? "",
    membershipType: initial.membershipType ?? "",
    status: initial.status,
    dateOfBirth: initial.dateOfBirth ? initial.dateOfBirth.slice(0, 10) : "",
  });

  // Rank promotion state
  const [showRankDrawer, setShowRankDrawer] = useState(false);
  const [rankForm, setRankForm] = useState({ rankSystemId: "", stripes: 0, notes: "", photoUrl: "" as string });
  const [promotingSaving, setPromotingSaving] = useState(false);

  // Payments state
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [paymentDrawer, setPaymentDrawer] = useState(false);
  // Lane 1 iter-1 V-03 fix: synchronous in-flight guard for addPayment().
  // useState is batched and can let a second click race past the disabled
  // attribute; a ref flips immediately in the same JS tick.
  const addingPaymentRef = useRef(false);
  const [payForm, setPayForm] = useState<{ description: string; amount: string }>({
    description: "", amount: "",
  });

  // More actions menu
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  // F5 deletion gateway — opens the 3-strategy modal when a parent member is
  // about to be removed. The modal handles the probe + picker + execution.
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  async function copyWaiverLink() {
    const url = new URL("/login", window.location.origin);
    url.searchParams.set("club", tenantSlug);
    url.searchParams.set("email", member.email);
    url.searchParams.set("next", "/member/home");
    try {
      await navigator.clipboard.writeText(url.toString());
      toast("Waiver link copied", "success");
    } catch {
      toast("Could not copy link", "error");
    }
  }

  function openWaiverPage() {
    router.push(`/dashboard/members/${member.id}/waiver`);
  }

  useEffect(() => {
    fetch(`/api/members/${initial.id}/payments`)
      .then((r) => r.ok ? r.json() : { payments: [] })
      .then((data) => setPayments(Array.isArray(data?.payments) ? data.payments : []))
      .catch(() => {});
  }, [initial.id]);

  useEffect(() => {
    if (!showActionsMenu) return;
    function handleClick(e: MouseEvent) {
      if (actionsMenuRef.current && !actionsMenuRef.current.contains(e.target as Node)) {
        setShowActionsMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showActionsMenu]);

  const canEdit    = ["owner", "manager", "admin"].includes(role);
  const canPromote = ["owner", "manager", "coach"].includes(role);
  const disciplines = Array.from(new Set(rankOptions.map((r) => r.discipline)));
  const selectedRankOption = rankOptions.find((r) => r.id === rankForm.rankSystemId);
  const disciplineRanks = rankOptions.filter((r) => {
    const disc = rankOptions.find((o) => o.id === rankForm.rankSystemId)?.discipline;
    return r.discipline === disc;
  });

  const now = new Date();
  const thisMonthCount = member.attendances.filter((a) => {
    const d = new Date(a.checkInTime);
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }).length;
  const thisWeekCount = member.attendances.filter((a) => {
    const d = new Date(a.checkInTime);
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - now.getDay());
    return d >= weekStart;
  }).length;

  async function saveProfile() {
    setSaving(true);
    try {
      const res = await fetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone || null,
          emergencyContactName: form.emergencyContactName || null,
          emergencyContactPhone: form.emergencyContactPhone || null,
          emergencyContactRelation: form.emergencyContactRelation || null,
          membershipType: form.membershipType || null,
          status: form.status,
          dateOfBirth: form.dateOfBirth || null,
        }),
      });
      if (!res.ok) { toast((await res.json()).error ?? "Failed to save", "error"); return; }
      setMember((m) => ({ ...m, ...form }));
      setEditing(false);
      toast("Profile updated", "success");
    } finally { setSaving(false); }
  }

  async function saveNotes() {
    setNotesSaving(true);
    try {
      const res = await fetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: notesDraft || null }),
      });
      if (!res.ok) { toast("Failed to save notes", "error"); return; }
      setMember((m) => ({ ...m, notes: notesDraft || null }));
      toast("Notes saved", "success");
    } finally { setNotesSaving(false); }
  }

  async function assignRank() {
    if (!rankForm.rankSystemId) { toast("Select a rank", "error"); return; }
    setPromotingSaving(true);
    try {
      const res = await fetch(`/api/members/${member.id}/rank`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(rankForm),
      });
      if (!res.ok) { toast((await res.json()).error ?? "Failed to assign rank", "error"); return; }
      const newRank = await res.json();
      setMember((m) => ({
        ...m,
        ranks: [
          { id: newRank.id, rankSystemId: newRank.rankSystemId, discipline: newRank.rankSystem.discipline, rankName: newRank.rankSystem.name, color: newRank.rankSystem.color, stripes: newRank.stripes, achievedAt: newRank.achievedAt },
          ...m.ranks.filter((r) => r.discipline !== newRank.rankSystem.discipline),
        ],
      }));
      setShowRankDrawer(false);
      setRankForm({ rankSystemId: "", stripes: 0, notes: "", photoUrl: "" });
      toast("Rank assigned", "success");
    } finally { setPromotingSaving(false); }
  }

  // Lane 1 iter-1 V-03 [Critical] fix: addPayment used to close the drawer
  // and reset the form BEFORE the POST resolved, and had no double-fire guard.
  // Rapid double-click queued two POSTs because React state updates batch
  // across microtasks. The fix:
  //   1. `addingPaymentRef` is a synchronous in-flight guard that escapes the
  //      batching window — set true at the top of the function before any
  //      await; checked on entry. Two clicks within one tick now collapse.
  //   2. The drawer + form reset only fires AFTER the POST succeeds (or on
  //      explicit user dismiss via the X button) so the failure path keeps
  //      the user's input intact for a retry.
  //   3. tempId uses crypto.randomUUID() so two payments submitted within the
  //      same Date.now() millisecond don't collide on the optimistic-entry id.
  async function addPayment() {
    if (!payForm.description.trim() || !payForm.amount) return;
    if (addingPaymentRef.current) return;
    addingPaymentRef.current = true;
    const tempId = `local-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    // Snapshot the form values so the POST body and the optimistic entry stay
    // in lockstep even if the user types again before the POST resolves.
    const snapshot = { description: payForm.description, amount: payForm.amount };
    const amountPence = Math.round(parseFloat(snapshot.amount) * 100);
    const tempEntry: PaymentEntry = {
      id: tempId,
      amountPence,
      currency: "GBP",
      status: "succeeded",
      description: snapshot.description,
      paidAt: new Date().toISOString(),
    };
    setPayments((p) => [tempEntry, ...p]);
    try {
      const res = await fetch("/api/payments/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: member.id,
          amountPence,
          method: "manual",
          notes: snapshot.description,
        }),
      });
      if (!res.ok) {
        setPayments((p) => p.filter((e) => e.id !== tempId));
        toast((await res.json()).error ?? "Failed to record payment", "error");
        return;
      }
      const saved = await res.json();
      setPayments((p) => p.map((e) => e.id === tempId ? saved : e));
      // Only after a successful save do we close + clear — keeps the form
      // recoverable if the POST fails.
      setPaymentDrawer(false);
      setPayForm({ description: "", amount: "" });
      toast("Payment recorded", "success");
    } catch {
      setPayments((p) => p.filter((e) => e.id !== tempId));
      toast("Failed to record payment", "error");
    } finally {
      addingPaymentRef.current = false;
    }
  }

  // Input classes: bg-white/5 → var(--sf-1), border-white/10 → var(--bd-default),
  // focus:border-white/30 → handled via onFocus/onBlur handlers below.
  const inputCls = "w-full rounded-xl px-3 py-2 text-sm focus:outline-none";
  const inputStyle = { background: "var(--sf-1)", border: "1px solid var(--bd-default)", color: "var(--tx-1)" };
  const inputFocusHandlers = {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-active)";
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-default)";
    },
  };

  const currentStatus = STATUS_OPTIONS.find((s) => s.value === member.status) ?? STATUS_OPTIONS[0];
  const currentRank = member.ranks[0] ?? null;
  const payment = paymentMeta(member.paymentStatus);
  const PaymentIcon = payment.Icon;
  const lastAttendance = member.attendances[0] ?? null;
  const lastVisitDays = daysSince(lastAttendance?.checkInTime);
  const hasAttention = !member.waiverAccepted || !member.phone || member.paymentStatus === "overdue";

  return (
    <div className="max-w-7xl mx-auto">
      {/* ── Header ── */}
      {/*
        Below sm (640px) the header stacks: back+avatar+name+chips on top, then actions.
        From sm upward it returns to a single inline row. This prevents the name column
        being crushed to ~50px on iPad/narrow-laptop viewports where the actions group
        and avatar otherwise consume all the horizontal space.
      */}
      <div className="flex flex-col sm:flex-row sm:items-start gap-4 mb-6">
        <button
          onClick={() => router.push("/dashboard/members")}
          className="p-2.5 rounded-xl transition-colors shrink-0 mt-1 hover:text-white"
          style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)", color: "var(--tx-3)" }}
          aria-label="Back to members"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        {/* feat/member-profile-pictures Track A Phase A4: header avatar slot.
            - Staff with canEdit can change/remove via AvatarUploader.
            - Read-only staff (coach) just see the picture or initials.
            - Picture falls back to deterministic initials seeded by member.id. */}
        <div className="shrink-0">
          {canEdit ? (
            <AvatarUploader
              memberId={member.id}
              name={member.name}
              pictureUrl={member.profilePictureUrl}
              colorSeed={member.id}
              size="lg"
              onChange={(url) => setMember((m) => ({ ...m, profilePictureUrl: url }))}
              onError={(msg) => toast(msg, "error")}
              changeLabel={member.profilePictureUrl ? "Change member's picture" : "Set member's picture"}
            />
          ) : (
            <Avatar
              name={member.name}
              pictureUrl={member.profilePictureUrl}
              colorSeed={member.id}
              size="lg"
              ring
            />
          )}
        </div>

        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h1 className="text-2xl font-bold mr-1 truncate min-w-0 max-w-full" style={{ color: "var(--tx-1)" }}>{member.name}</h1>
            {currentRank && (
              <ProfileChip color="#fff" bg={hex(currentRank.color, 0.95)} icon={Award}>
                {currentRank.rankName}
                {currentRank.stripes > 0 && (
                  <span className="inline-flex gap-0.5 ml-0.5">
                    {Array.from({ length: currentRank.stripes }).map((_, i) => (
                      <span key={i} className="w-1.5 h-1.5 rounded-full bg-current opacity-75" />
                    ))}
                  </span>
                )}
              </ProfileChip>
            )}
            {member.membershipType && (
              <ProfileChip color="#93c5fd" bg="rgba(59,130,246,0.13)" icon={Shield}>
                {member.membershipType}
              </ProfileChip>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 mb-3">
            <ProfileChip color={currentStatus.color} bg={currentStatus.bg} icon={Activity}>
              {currentStatus.label}
            </ProfileChip>
            <ProfileChip color={payment.color} bg={payment.bg} icon={PaymentIcon}>
              Payment {payment.label}
            </ProfileChip>
            {member.waiverAccepted ? (
              <ProfileChip color="#22c55e" bg="rgba(34,197,94,0.12)" icon={FileCheck2}>
                Waiver signed
              </ProfileChip>
            ) : (
              <button type="button" onClick={openWaiverPage} className="transition-opacity hover:opacity-80">
                <ProfileChip color="#f59e0b" bg="rgba(245,158,11,0.15)" icon={FileCheck2}>
                  Waiver missing
                </ProfileChip>
              </button>
            )}
            {!member.phone && (
              <ProfileChip color="#f59e0b" bg="rgba(245,158,11,0.15)" icon={Phone}>
                No phone
              </ProfileChip>
            )}
          </div>

          <p className="text-sm" style={{ color: "var(--tx-3)" }}>
            Member since {new Date(member.joinedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
            {hasAttention && <span className="text-amber-300 ml-2">· Action needed</span>}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
          {canEdit && (
            <MarkPaidDrawer
              memberId={member.id}
              memberName={member.name}
              primaryColor={primaryColor}
            />
          )}
          {canEdit && !editing && (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-xl border hover:text-white hover:border-white/20 transition-colors text-sm"
              style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)", color: "var(--tx-3)" }}
            >
              <Edit2 className="w-4 h-4" />
              Edit
            </button>
          )}
          <div className="relative" ref={actionsMenuRef}>
            <button
              onClick={() => setShowActionsMenu((v) => !v)}
              className="p-2 rounded-xl border hover:text-white hover:border-white/20 transition-colors"
              style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)", color: "var(--tx-3)" }}
              type="button"
              aria-label="More actions"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {showActionsMenu && (
              <div
                className="absolute right-0 top-full mt-1 w-44 rounded-xl border py-1 z-40"
                style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}
              >
                <button
                  onClick={async () => {
                    setShowActionsMenu(false);
                    const res = await fetch(`/api/members/${member.id}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ status: "inactive" }),
                    });
                    if (res.ok) {
                      setMember((m) => ({ ...m, status: "inactive" }));
                      toast("Member marked as inactive", "success");
                    } else {
                      toast("Failed to update status", "error");
                    }
                  }}
                  className="w-full text-left px-4 py-2 text-sm hover:text-white hover:bg-white/5 transition-colors"
                  style={{ color: "var(--tx-2)" }}
                >
                  Mark as inactive
                </button>
                <button
                  onClick={() => {
                    setShowActionsMenu(false);
                    copyWaiverLink();
                  }}
                  disabled={member.waiverAccepted}
                  className="w-full text-left px-4 py-2 text-sm hover:text-white hover:bg-white/5 transition-colors disabled:cursor-not-allowed"
                  style={{ color: member.waiverAccepted ? "var(--tx-4)" : "var(--tx-2)" }}
                >
                  Copy waiver link
                </button>
                {!member.waiverAccepted && ["owner", "manager", "admin", "coach"].includes(role) && (
                  <a
                    href={`/dashboard/members/${member.id}/waiver`}
                    onClick={() => setShowActionsMenu(false)}
                    className="w-full text-left block px-4 py-2 text-sm hover:text-white hover:bg-white/5 transition-colors"
                    style={{ color: "var(--tx-2)" }}
                  >
                    Open waiver on this device
                  </a>
                )}
                {/* F5 — deletion gateway. Owner-only at the API layer; surface
                    the menu entry to owner only too so the role-mismatch
                    case can't even be tried. */}
                {role === "owner" && (
                  <>
                    <div className="my-1 h-px" style={{ background: "var(--bd-default)" }} />
                    <button
                      onClick={() => {
                        setShowActionsMenu(false);
                        setShowRemoveModal(true);
                      }}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-rose-500/10 transition-colors"
                      style={{ color: "#f87171" }}
                    >
                      Remove member…
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Owner attention strip ── */}
      {/* Progressive breakpoints: 2 cols on phone, 3 on tablet, 5 only at xl
          (≥1280px) where each tile gets ≥200px and labels like "MEMBERSHIP"
          fit without truncating to "M…". */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
        {[
          {
            label: "Waiver",
            value: member.waiverAccepted ? "Signed" : "Missing",
            color: member.waiverAccepted ? "#22c55e" : "#f59e0b",
            bg: member.waiverAccepted ? "rgba(34,197,94,0.10)" : "rgba(245,158,11,0.12)",
            Icon: FileCheck2,
          },
          {
            label: "Payment",
            value: payment.label,
            color: payment.color,
            bg: payment.bg,
            Icon: PaymentIcon,
          },
          {
            label: "Last Visit",
            value: lastAttendance
              ? lastVisitDays === 0
                ? "Today"
                : `${lastVisitDays}d ago`
              : "Never",
            color: lastAttendance ? primaryColor : "#94a3b8",
            bg: lastAttendance ? hex(primaryColor, 0.12) : "rgba(148,163,184,0.10)",
            Icon: CalendarCheck,
          },
          {
            label: "Joined",
            value: fmtDate(member.joinedAt),
            color: "#93c5fd",
            bg: "rgba(59,130,246,0.10)",
            Icon: Calendar,
          },
          {
            label: "Membership",
            value: member.membershipType ?? "Not set",
            color: member.membershipType ? "#a78bfa" : "#f59e0b",
            bg: member.membershipType ? "rgba(167,139,250,0.10)" : "rgba(245,158,11,0.12)",
            Icon: Shield,
          },
        ].map(({ label, value, color, bg, Icon }) => {
          const isMissingWaiverTile = label === "Waiver" && !member.waiverAccepted;
          const tileContent = (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--tx-4)" }}>{label}</p>
                <p className="text-sm font-semibold mt-1 truncate" style={{ color }}>{value}</p>
              </div>
              <Icon className="w-4 h-4 shrink-0" style={{ color }} />
            </div>
          );
          return isMissingWaiverTile ? (
            <button
              key={label}
              type="button"
              onClick={openWaiverPage}
              className="rounded-2xl border p-4 text-left transition-opacity hover:opacity-85"
              style={{ background: bg, borderColor: "var(--bd-default)" }}
            >
              {tileContent}
            </button>
          ) : (
            <div key={label} className="rounded-2xl border p-4" style={{ background: bg, borderColor: "var(--bd-default)" }}>
              {tileContent}
            </div>
          );
        })}
      </div>

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-3 mb-5">
        {[
          { label: "Total Visits", value: member.attendances.length, sub: "All-time check-ins", color: primaryColor, Icon: Activity },
          { label: "This Month", value: thisMonthCount, sub: "Current month", color: "#22c55e", Icon: CalendarCheck },
          { label: "This Week", value: thisWeekCount, sub: "Current week", color: "#38bdf8", Icon: Clock },
          { label: "Streak", value: lastVisitDays === null ? 0 : lastVisitDays <= 7 ? 1 : 0, sub: "Attendance signal", color: "#f59e0b", Icon: Award },
          { label: "Subscriptions", value: member.subscriptions.length, sub: "Class follows", color: "#a78bfa", Icon: Dumbbell },
        ].map(({ label, value, sub, color, Icon }) => (
          <div key={label} className="rounded-2xl border p-4" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-2xl font-bold tabular-nums" style={{ color: "var(--tx-1)" }}>{value}</p>
                <p className="text-xs font-semibold mt-1" style={{ color: "var(--tx-2)" }}>{label}</p>
                <p className="text-[11px] mt-0.5" style={{ color: "var(--tx-4)" }}>{sub}</p>
              </div>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(color, 0.15), color }}>
                <Icon className="w-4 h-4" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Tabs ── */}
      <div
        className="flex border-b mb-5 overflow-x-auto scrollbar-hide"
        style={{ borderColor: "var(--bd-default)" }}
      >
        <Tab label="Overview" active={tab === "overview"} onClick={() => setTab("overview")} />
        <Tab label="Attendance" active={tab === "attendance"} onClick={() => setTab("attendance")} count={member.attendances.length} />
        <Tab label="Payments" active={tab === "payments"} onClick={() => setTab("payments")} count={payments.length} />
        <Tab label="Ranks" active={tab === "ranks"} onClick={() => setTab("ranks")} count={member.ranks.length} />
        <Tab label="Internal Notes" active={tab === "notes"} onClick={() => setTab("notes")} />
        <Tab label="Photos" active={tab === "photos"} onClick={() => setTab("photos")} />
      </div>

      {/* ── Overview ── */}
      {tab === "overview" && (
        <div
          className="rounded-2xl border p-6"
          style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
        >
          {editing ? (
            <div className="space-y-4">
              <h2 className="font-semibold" style={{ color: "var(--tx-1)" }}>Edit Profile</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Full Name</label>
                  <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} style={inputStyle} {...inputFocusHandlers} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Email</label>
                  <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={inputCls} style={inputStyle} {...inputFocusHandlers} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Phone</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className={inputCls} style={inputStyle} placeholder="Optional" {...inputFocusHandlers} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Emergency Contact Name</label>
                  <input value={form.emergencyContactName} onChange={(e) => setForm((f) => ({ ...f, emergencyContactName: e.target.value }))} className={inputCls} style={inputStyle} placeholder="Required before waiver" {...inputFocusHandlers} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Emergency Contact Phone</label>
                  <input type="tel" value={form.emergencyContactPhone} onChange={(e) => setForm((f) => ({ ...f, emergencyContactPhone: e.target.value }))} className={inputCls} style={inputStyle} placeholder="Required before waiver" {...inputFocusHandlers} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Emergency Contact Relation</label>
                  <input value={form.emergencyContactRelation} onChange={(e) => setForm((f) => ({ ...f, emergencyContactRelation: e.target.value }))} className={inputCls} style={inputStyle} placeholder="Parent, partner, friend" {...inputFocusHandlers} />
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Membership Type</label>
                  {tiers.length > 0 ? (
                    <div className="relative">
                      <select
                        value={form.membershipType}
                        onChange={(e) => setForm((f) => ({ ...f, membershipType: e.target.value }))}
                        className={inputCls + " appearance-none"}
                        style={inputStyle}
                        {...inputFocusHandlers}
                      >
                        <option value="">— None —</option>
                        {/* Legacy value: if current value doesn't match any tier name, show it */}
                        {form.membershipType &&
                          !tiers.some((t) => t.name === form.membershipType) && (
                            <option value={form.membershipType}>
                              {form.membershipType} (legacy)
                            </option>
                          )}
                        {tiers.map((t) => (
                          <option key={t.id} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 pointer-events-none" style={{ color: "var(--tx-3)" }} />
                    </div>
                  ) : (
                    <input
                      value={form.membershipType}
                      onChange={(e) => setForm((f) => ({ ...f, membershipType: e.target.value }))}
                      className={inputCls}
                      style={inputStyle}
                      placeholder="e.g. Monthly, Annual"
                      {...inputFocusHandlers}
                    />
                  )}
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Status</label>
                  <div className="relative">
                    <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={inputCls + " appearance-none"} style={inputStyle} {...inputFocusHandlers}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="taster">Taster</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 pointer-events-none" style={{ color: "var(--tx-3)" }} />
                  </div>
                </div>
                <div>
                  <label className="text-xs mb-1 block" style={{ color: "var(--tx-3)" }}>Date of Birth</label>
                  <input type="date" value={form.dateOfBirth} onChange={(e) => setForm((f) => ({ ...f, dateOfBirth: e.target.value }))} className={inputCls} style={inputStyle} {...inputFocusHandlers} />
                </div>
              </div>
              <div className="flex gap-3 pt-1">
                <button onClick={saveProfile} disabled={saving} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60" style={{ background: primaryColor }}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {saving ? "Saving…" : "Save"}
                </button>
                <button onClick={() => { setEditing(false); setForm({ name: member.name, email: member.email, phone: member.phone ?? "", emergencyContactName: member.emergencyContactName ?? "", emergencyContactPhone: member.emergencyContactPhone ?? "", emergencyContactRelation: member.emergencyContactRelation ?? "", membershipType: member.membershipType ?? "", status: member.status, dateOfBirth: member.dateOfBirth ? member.dateOfBirth.slice(0, 10) : "" }); }} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm border" style={{ borderColor: "var(--bd-default)", color: "var(--tx-3)" }}>
                  <X className="w-4 h-4" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-5">
                <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
                  <div className="flex items-center justify-between gap-3 mb-5">
                    <div>
                      <h2 className="font-semibold" style={{ color: "var(--tx-1)" }}>Contact and Safety</h2>
                      <p className="text-xs mt-1" style={{ color: "var(--tx-4)" }}>Core member details, emergency information, and training notes.</p>
                    </div>
                    {!member.phone && (
                      <span className="px-2 py-1 rounded-full text-[11px] font-semibold bg-amber-500/15 text-amber-300">
                        Phone missing
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <InfoRow icon={User} label="Name" value={member.name} />
                    <InfoRow icon={Mail} label="Email" value={member.email} />
                    <InfoRow icon={Phone} label="Phone" value={member.phone ?? "Not provided"} muted={!member.phone} />
                    <InfoRow icon={Shield} label="Membership" value={member.membershipType ?? "Not set"} muted={!member.membershipType} />
                    <InfoRow icon={Calendar} label="Joined" value={new Date(member.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} />
                    <InfoRow icon={Activity} label="Status" value={currentStatus.label} />
                  </div>

                  <div className="mt-5 pt-5 border-t grid grid-cols-1 md:grid-cols-2 gap-4" style={{ borderColor: "var(--bd-default)" }}>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2" style={{ color: "var(--tx-4)" }}>Emergency Contact</p>
                      <p className="text-sm" style={{ color: member.emergencyContactName || member.emergencyContactPhone || member.emergencyContactRelation ? "var(--tx-1)" : "var(--tx-4)" }}>
                        {member.emergencyContactName || member.emergencyContactPhone || member.emergencyContactRelation
                          ? `${member.emergencyContactName ?? "Unnamed"}${member.emergencyContactRelation ? ` · ${member.emergencyContactRelation}` : ""}${member.emergencyContactPhone ? ` · ${member.emergencyContactPhone}` : ""}`
                          : "Not provided"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2" style={{ color: "var(--tx-4)" }}>Medical Notes</p>
                      <p className="text-sm" style={{ color: member.medicalConditions ? "var(--tx-1)" : "var(--tx-4)" }}>
                        {member.medicalConditions || "None recorded"}
                      </p>
                    </div>
                  </div>

                  {member.notes && (
                    <div className="mt-5 pt-5 border-t" style={{ borderColor: "var(--bd-default)" }}>
                      {/* feat/member-tickable-notes Phase 3: rename "Owner Notes" → "Internal Notes" to
                          separate the staff journal (private, never shown to the member) from the new
                          member-facing tickable notes that live on the action list. */}
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2" style={{ color: "var(--tx-4)" }}>Internal Notes</p>
                      <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: "var(--tx-2)" }}>{member.notes}</p>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
                    <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--tx-1)" }}>Membership and Billing</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs" style={{ color: "var(--tx-4)" }}>Plan</span>
                        <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{member.membershipType ?? "Not set"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs" style={{ color: "var(--tx-4)" }}>Payment</span>
                        <ProfileChip color={payment.color} bg={payment.bg} icon={PaymentIcon}>{payment.label}</ProfileChip>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs" style={{ color: "var(--tx-4)" }}>Subscriptions</span>
                        <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{member.subscriptions.length}</span>
                      </div>
                    </div>
                  </div>

                  <div
                    className={`rounded-2xl border p-5 ${!member.waiverAccepted ? "cursor-pointer transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400" : ""}`}
                    onClick={!member.waiverAccepted ? openWaiverPage : undefined}
                    role={!member.waiverAccepted ? "button" : undefined}
                    tabIndex={!member.waiverAccepted ? 0 : undefined}
                    onKeyDown={!member.waiverAccepted ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWaiverPage(); } } : undefined}
                    aria-label={!member.waiverAccepted ? "Open waiver collection page for this member" : undefined}
                    style={{ background: member.waiverAccepted ? "rgba(34,197,94,0.045)" : "rgba(245,158,11,0.06)", borderColor: member.waiverAccepted ? "rgba(34,197,94,0.18)" : "rgba(245,158,11,0.24)" }}
                  >
                    <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--tx-1)" }}>Waiver and Compliance</h3>
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: member.waiverAccepted ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.15)", color: member.waiverAccepted ? "#22c55e" : "#f59e0b" }}>
                        <FileCheck2 className="w-4 h-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold" style={{ color: member.waiverAccepted ? "#22c55e" : "#f59e0b" }}>
                          {member.waiverAccepted ? "Waiver signed" : "Liability waiver missing"}
                        </p>
                        <p className="text-xs mt-1" style={{ color: "var(--tx-4)" }}>
                          {member.waiverAcceptedAt ? fmtDate(member.waiverAcceptedAt) : "This member should complete the waiver before training."}
                        </p>
                      </div>
                      {!member.waiverAccepted && (
                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); copyWaiverLink(); }}
                            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors shrink-0"
                            style={{ background: "rgba(245,158,11,0.14)", color: "#f59e0b", border: "1px solid rgba(245,158,11,0.24)" }}
                          >
                            <Link2 className="w-3.5 h-3.5" />
                            Copy waiver link
                          </button>
                          {["owner", "manager", "admin", "coach"].includes(role) && (
                            <a
                              href={`/dashboard/members/${member.id}/waiver`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-colors shrink-0"
                              style={{ background: "rgba(99,102,241,0.14)", color: "#818cf8", border: "1px solid rgba(99,102,241,0.24)" }}
                            >
                              <FileCheck2 className="w-3.5 h-3.5" />
                              Open waiver on this device
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
                    <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--tx-1)" }}>Recent Activity</h3>
                    <div className="space-y-3">
                      <div className="flex items-start gap-3">
                        <CalendarCheck className="w-4 h-4 mt-0.5" style={{ color: primaryColor }} />
                        <div>
                          <p className="text-sm" style={{ color: "var(--tx-1)" }}>{lastAttendance ? lastAttendance.className : "No visits yet"}</p>
                          <p className="text-xs" style={{ color: "var(--tx-4)" }}>{lastAttendance ? `Last check-in ${fmtDate(lastAttendance.checkInTime)}` : "Attendance will appear after first check-in."}</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-3">
                        <Award className="w-4 h-4 mt-0.5" style={{ color: currentRank?.color ?? primaryColor }} />
                        <div>
                          <p className="text-sm" style={{ color: "var(--tx-1)" }}>{currentRank ? currentRank.rankName : "No rank assigned"}</p>
                          <p className="text-xs" style={{ color: "var(--tx-4)" }}>{currentRank ? `Updated ${fmtDate(currentRank.achievedAt)}` : "Assign a rank from the Ranks tab."}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="hidden">
              <h2 className="font-semibold mb-4" style={{ color: "var(--tx-1)" }}>Contact &amp; Membership</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <InfoRow icon={User}     label="Name"       value={member.name} />
                <InfoRow icon={Mail}     label="Email"      value={member.email} />
                <InfoRow icon={Phone}    label="Phone"      value={member.phone ?? "Not provided"} muted={!member.phone} />
                <InfoRow icon={Shield}   label="Membership" value={member.membershipType ?? "Not set"} muted={!member.membershipType} />
                <InfoRow icon={Calendar} label="Joined"     value={new Date(member.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} />
                <InfoRow icon={Activity} label="Status"     value={currentStatus.label} />
              </div>

              {/* Quick internal-notes preview */}
              {member.notes && (
                <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--bd-default)" }}>
                  <p className="text-xs mb-1.5" style={{ color: "var(--tx-3)" }}>Internal Notes</p>
                  <p className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: "var(--tx-2)" }}>{member.notes}</p>
                </div>
              )}

              {/* Health & Waiver */}
              <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--bd-default)" }}>
                <p className="text-xs font-medium mb-3" style={{ color: "var(--tx-3)" }}>Health &amp; Waiver</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {member.dateOfBirth && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--tx-3)" }}>Date of Birth</p>
                      <p className="text-sm" style={{ color: "var(--tx-1)" }}>
                        {new Date(member.dateOfBirth).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
                      </p>
                    </div>
                  )}
                  {(member.emergencyContactName || member.emergencyContactPhone || member.emergencyContactRelation) && (
                    <div>
                      <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--tx-3)" }}>Emergency Contact</p>
                      <p className="text-sm" style={{ color: "var(--tx-1)" }}>
                        {member.emergencyContactName ?? "—"}
                        {member.emergencyContactRelation ? ` · ${member.emergencyContactRelation}` : ""}
                        {member.emergencyContactPhone ? ` · ${member.emergencyContactPhone}` : ""}
                      </p>
                    </div>
                  )}
                  {member.medicalConditions && (() => {
                    try {
                      const conds: string[] = JSON.parse(member.medicalConditions);
                      if (conds.length > 0) return (
                        <div className="sm:col-span-2">
                          <p className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "var(--tx-3)" }}>Medical Conditions</p>
                          <div className="flex flex-wrap gap-1.5">
                            {conds.map((c) => (
                              <span key={c} className="px-2 py-0.5 rounded-full text-xs font-medium border" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)", color: "var(--tx-2)" }}>{c}</span>
                            ))}
                          </div>
                        </div>
                      );
                    } catch { return null; }
                  })()}
                  <div>
                    <p className="text-[10px] uppercase tracking-wider mb-0.5" style={{ color: "var(--tx-3)" }}>Liability Waiver</p>
                    {member.waiverAccepted ? (
                      <div className="flex items-center gap-1.5">
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: "rgba(16,185,129,0.12)", color: "#10b981" }}>
                          <Check className="w-2.5 h-2.5" /> Signed
                        </span>
                        {member.waiverAcceptedAt && (
                          <span className="text-xs" style={{ color: "var(--tx-3)" }}>
                            {new Date(member.waiverAcceptedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold w-fit" style={{ background: "rgba(239,68,68,0.10)", color: "#ef4444" }}>
                        Not signed
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Connected accounts placeholder */}
              <div className="mt-4 pt-4 border-t" style={{ borderColor: "var(--bd-default)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
                  <p className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>Connected Accounts</p>
                </div>
                <p className="text-xs" style={{ color: "var(--tx-4)" }}>No linked accounts — parent/child linking coming soon</p>
              </div>
            </div>
            </div>
          )}
        </div>
      )}

      {/* ── Attendance ── */}
      {tab === "attendance" && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
          <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "var(--bd-default)" }}>
            {member.attendances.length === 0 ? (
              <div className="p-12 text-center">
                <Clock className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--tx-3)" }} />
                <p className="font-medium" style={{ color: "var(--tx-3)" }}>No attendance records yet</p>
                <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>Check-ins will appear here</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className="border-b" style={{ borderColor: "var(--bd-default)", background: "var(--sf-2)" }}>
                      <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: "var(--tx-3)" }}>Class</th>
                      <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: "var(--tx-3)" }}>Session</th>
                      <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: "var(--tx-3)" }}>Checked in</th>
                      <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: "var(--tx-3)" }}>Coach / Location</th>
                      <th className="text-left px-4 py-3 text-xs font-medium" style={{ color: "var(--tx-3)" }}>Method</th>
                    </tr>
                  </thead>
                  <tbody>
                    {member.attendances.map((a, i) => {
                      const checkInDate = new Date(a.checkInTime);
                      return (
                        <tr key={a.id} className="border-b transition-colors hover:bg-white/5" style={{ borderColor: i === member.attendances.length - 1 ? "transparent" : "var(--bd-default)" }}>
                          <td className="px-4 py-3 text-sm font-medium" style={{ color: "var(--tx-1)" }}>{a.className}</td>
                          <td className="px-4 py-3 text-sm" style={{ color: "var(--tx-3)" }}>
                            <div>{new Date(a.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>
                            <div className="text-xs" style={{ color: "var(--tx-3)" }}>{a.startTime}-{a.endTime}</div>
                          </td>
                          <td className="px-4 py-3 text-sm" style={{ color: "var(--tx-3)" }}>{checkInDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</td>
                          <td className="px-4 py-3 text-sm" style={{ color: "var(--tx-3)" }}>
                            <div>{a.coachName ?? "No coach set"}</div>
                            <div className="text-xs" style={{ color: "var(--tx-3)" }}>{a.location ?? "No location set"}</div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs px-2 py-0.5 rounded-full capitalize" style={{ background: "var(--sf-2)", color: "var(--tx-2)" }}>{a.method}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <aside className="rounded-2xl border p-4 h-fit" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>Subscribed Classes</h3>
                <p className="text-xs mt-0.5" style={{ color: "var(--tx-4)" }}>{member.subscriptions.length} class follows</p>
              </div>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(primaryColor, 0.12), color: primaryColor }}>
                <Dumbbell className="w-4 h-4" />
              </div>
            </div>
            {member.subscriptions.length === 0 ? (
              <div className="py-8 text-center">
                <Dumbbell className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--tx-3)" }} />
                <p className="text-sm font-medium" style={{ color: "var(--tx-3)" }}>No class subscriptions yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {member.subscriptions.map((s) => (
                  <div key={s.id} className="rounded-xl border p-3" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
                    <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>{s.className}</p>
                    <div className="mt-1.5 space-y-1 text-xs" style={{ color: "var(--tx-4)" }}>
                      {s.coachName && <p className="flex items-center gap-1.5"><Users className="w-3 h-3" />{s.coachName}</p>}
                      {s.location && <p className="flex items-center gap-1.5"><MapPin className="w-3 h-3" />{s.location}</p>}
                      <p className="flex items-start gap-1.5"><Clock className="w-3 h-3 mt-0.5 shrink-0" /><span>{formatScheduleSummary(s.schedules)}</span></p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}

      {/* ── Ranks ── */}
      {tab === "ranks" && (
        <div className="space-y-4">
          {canPromote && (
            <div className="flex justify-end">
              <button
                onClick={() => setShowRankDrawer(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: primaryColor }}
              >
                <Award className="w-4 h-4" />
                Assign / Promote
              </button>
            </div>
          )}
          {member.ranks.length === 0 ? (
            <div className="rounded-2xl border p-12 text-center" style={{ borderColor: "var(--bd-default)" }}>
              <Award className="w-10 h-10 mx-auto mb-3" style={{ color: "var(--tx-3)" }} />
              <p className="font-medium" style={{ color: "var(--tx-3)" }}>No ranks assigned</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {member.ranks.map((r) => (
                <div key={r.id} className="rounded-2xl border p-4 flex items-center gap-4" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
                  <BeltGraphic color={r.color} stripes={r.stripes} />
                  <div>
                    <p className="font-medium text-sm" style={{ color: "var(--tx-1)" }}>{r.rankName}</p>
                    <p className="text-xs" style={{ color: "var(--tx-3)" }}>{r.discipline} · {r.stripes} stripe{r.stripes !== 1 ? "s" : ""}</p>
                    <p className="text-[10px] mt-0.5" style={{ color: "var(--tx-3)" }}>Since {new Date(r.achievedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Payments ── */}
      {tab === "payments" && (
        <div className="space-y-6">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <div>
              <p className="font-semibold" style={{ color: "var(--tx-1)" }}>Payment History</p>
              <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>All recorded transactions for this member</p>
            </div>
            {canEdit && (
              <button
                onClick={() => setPaymentDrawer(true)}
                className="flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium text-white"
                style={{ background: primaryColor }}
              >
                <Plus className="w-4 h-4" />
                Record
              </button>
            )}
          </div>

          {/* ── Combined payments list ── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Receipt className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--tx-3)" }}>Transactions</p>
              <span className="ml-auto text-xs" style={{ color: "var(--tx-3)" }}>{payments.length} records</span>
            </div>
            {payments.length === 0 ? (
              <div className="rounded-2xl border p-8 text-center" style={{ borderColor: "var(--bd-default)" }}>
                <CreditCard className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--tx-4)" }} />
                <p className="text-sm" style={{ color: "var(--tx-3)" }}>No payments recorded yet</p>
              </div>
            ) : (
              <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "var(--bd-default)" }}>
                {payments.map((p, i) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-4 px-4 py-3"
                    style={{ borderBottom: i < payments.length - 1 ? "1px solid var(--bd-default)" : "none", background: "var(--sf-1)" }}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: hex(primaryColor, 0.08) }}>
                      <CreditCard className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: "var(--tx-1)" }}>{p.description ?? "Payment"}</p>
                      <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>{p.paidAt ? fmtDate(p.paidAt) : "—"}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <PaymentStatusBadge status={p.status} />
                      <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>
                        {p.currency === "GBP" ? "£" : p.currency}{(p.amountPence / 100).toFixed(2)}
                      </p>
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-2.5" style={{ background: "var(--sf-2)", borderTop: "1px solid var(--bd-default)" }}>
                  <p className="text-xs font-medium" style={{ color: "var(--tx-3)" }}>Total recorded</p>
                  <p className="text-sm font-bold tabular-nums" style={{ color: "var(--tx-1)" }}>
                    {(() => {
                      const total = payments
                        .filter((p) => p.status === "succeeded" || p.status === "paid")
                        .reduce((s, p) => s + p.amountPence, 0);
                      return `£${(total / 100).toFixed(2)}`;
                    })()}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Internal Notes ── */}
      {tab === "notes" && (
        <div className="rounded-2xl border p-6 space-y-4" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4" style={{ color: "var(--tx-3)" }} />
            {/* feat/member-tickable-notes Phase 3: "Account Notes" → "Internal Notes".
                Member-facing notes that the member ticks live on the new action list
                (app/member/actions); this column is the staff journal that the
                member never sees. */}
            <h2 className="font-semibold" style={{ color: "var(--tx-1)" }}>Internal Notes</h2>
          </div>
          <p className="text-xs" style={{ color: "var(--tx-3)" }}>Private to staff. The member never sees this. Use for injuries, payment issues, attitude flags, anything internal. For things the member should actually do, send them an action from the dashboard To-Do list.</p>
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            rows={8}
            placeholder="Add internal notes about this member…"
            disabled={!canEdit}
            className="w-full resize-none rounded-xl px-4 py-3 text-sm outline-none transition-all placeholder:text-[var(--tx-3)]"
            style={{
              background: "var(--sf-1)",
              border: "1px solid var(--bd-default)",
              color: "var(--tx-1)",
              lineHeight: 1.7,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = hex(primaryColor, 0.4); }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
          />
          {canEdit && (
            <button
              onClick={saveNotes}
              disabled={notesSaving || notesDraft === (member.notes ?? "")}
              className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-40 transition-opacity"
              style={{ background: primaryColor }}
            >
              {notesSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {notesSaving ? "Saving…" : "Save Notes"}
            </button>
          )}
        </div>
      )}

      {/* ── Photos ── */}
      {tab === "photos" && (<PhotosTabPanel memberId={member.id} />)}

      {/* ── Rank drawer ── */}
      {showRankDrawer && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowRankDrawer(false)} />
          <div className="relative w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border p-6 space-y-4" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold" style={{ color: "var(--tx-1)" }}>Assign / Promote Rank</h3>
              <button onClick={() => setShowRankDrawer(false)} className="hover:text-white transition-colors" style={{ color: "var(--tx-3)" }}><X className="w-5 h-5" /></button>
            </div>

            <div>
              <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>Discipline</label>
              <div className="relative">
                <select
                  value={rankOptions.find((r) => r.id === rankForm.rankSystemId)?.discipline ?? ""}
                  onChange={(e) => { const first = rankOptions.find((r) => r.discipline === e.target.value); setRankForm((f) => ({ ...f, rankSystemId: first?.id ?? "" })); }}
                  className="w-full appearance-none rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                  style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)", color: "var(--tx-1)" }}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
                >
                  <option value="">Select discipline…</option>
                  {disciplines.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <ChevronDown className="absolute right-3 top-3 w-4 h-4 pointer-events-none" style={{ color: "var(--tx-3)" }} />
              </div>
            </div>

            {rankForm.rankSystemId && (
              <div>
                <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>Rank</label>
                <div className="grid grid-cols-1 gap-2">
                  {disciplineRanks.map((r) => (
                    <button key={r.id} onClick={() => setRankForm((f) => ({ ...f, rankSystemId: r.id }))} className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-colors ${rankForm.rankSystemId === r.id ? "border-white/30 bg-white/5" : "border-white/10 hover:border-white/20"}`}>
                      <BeltGraphic color={r.color} stripes={0} />
                      <span className="text-sm" style={{ color: "var(--tx-1)" }}>{r.name}</span>
                      {rankForm.rankSystemId === r.id && <Check className="w-4 h-4 ml-auto" style={{ color: primaryColor }} />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {selectedRankOption && (
              <div>
                <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>Stripes (0–4)</label>
                <div className="flex gap-2">
                  {[0,1,2,3,4].map((n) => (
                    <button key={n} onClick={() => setRankForm((f) => ({ ...f, stripes: n }))} className={`w-9 h-9 rounded-lg text-sm font-medium border transition-colors ${rankForm.stripes === n ? "border-white/30 bg-white/10" : "border-white/10"}`} style={{ color: rankForm.stripes === n ? "var(--tx-1)" : "var(--tx-3)" }}>{n}</button>
                  ))}
                </div>
                <div className="mt-3"><BeltGraphic color={selectedRankOption.color} stripes={rankForm.stripes} /></div>
              </div>
            )}

            <div className="mt-3">
              <label className="text-xs uppercase tracking-wider block mb-1" style={{ color: "var(--tx-3)" }}>
                Promotion photo (optional)
              </label>
              <input
                type="file"
                accept="image/*"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  const fd = new FormData();
                  fd.append("file", f);
                  const up = await fetch("/api/upload", { method: "POST", body: fd });
                  if (up.ok) {
                    const data = await up.json() as { url: string };
                    setRankForm((s) => ({ ...s, photoUrl: data.url }));
                  } else {
                    const r = new FileReader();
                    r.onload = () => setRankForm((s) => ({ ...s, photoUrl: String(r.result) }));
                    r.readAsDataURL(f);
                  }
                }}
                className="text-xs"
                style={{ color: "var(--tx-2)" }}
              />
              {rankForm.photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={rankForm.photoUrl} alt="Preview" className="mt-2 w-20 h-20 rounded-lg object-cover" />
              )}
            </div>

            <div>
              <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>Notes (optional)</label>
              <textarea
                value={rankForm.notes}
                onChange={(e) => setRankForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                placeholder="e.g. Competition win, grading night…"
                className="w-full rounded-xl px-3 py-2 text-sm focus:outline-none resize-none"
                style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)", color: "var(--tx-1)" }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
              />
            </div>

            <button onClick={assignRank} disabled={promotingSaving || !rankForm.rankSystemId} className="w-full py-3 rounded-xl font-semibold text-white text-sm disabled:opacity-50" style={{ background: primaryColor }}>
              {promotingSaving ? "Saving…" : "Confirm Promotion"}
            </button>
          </div>
        </div>
      )}

      {/* ── Add payment drawer ── */}
      {paymentDrawer && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setPaymentDrawer(false)} />
          <div className="relative w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border p-6 space-y-4" style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold" style={{ color: "var(--tx-1)" }}>Record Payment</h3>
              <button onClick={() => setPaymentDrawer(false)} className="hover:text-white transition-colors" style={{ color: "var(--tx-3)" }}><X className="w-5 h-5" /></button>
            </div>

            <div>
              <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>Description / Notes</label>
              <input
                value={payForm.description}
                onChange={(e) => setPayForm((f) => ({ ...f, description: e.target.value }))}
                className={inputCls}
                style={inputStyle}
                placeholder="e.g. Monthly membership, cash"
                {...inputFocusHandlers}
              />
            </div>

            <div>
              <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>Amount (£)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={payForm.amount}
                onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))}
                className={inputCls}
                style={inputStyle}
                placeholder="0.00"
                {...inputFocusHandlers}
              />
            </div>

            <button
              onClick={addPayment}
              disabled={!payForm.description.trim() || !payForm.amount}
              className="w-full py-3 rounded-xl font-semibold text-white text-sm disabled:opacity-40"
              style={{ background: primaryColor }}
            >
              Record Payment
            </button>
          </div>
        </div>
      )}

      {/* F5 — three-strategy deletion gateway modal */}
      <RemoveMemberModal
        memberId={member.id}
        memberName={member.name}
        open={showRemoveModal}
        onClose={() => setShowRemoveModal(false)}
        primaryColor={primaryColor}
      />
    </div>
  );
}

// ─── Photos tab (US-5 staff-side viewer) ─────────────────────────────────────

function PhotosTabPanel({ memberId }: { memberId: string }) {
  const [photos, setPhotos] = useState<Array<{ id: string; url: string; caption: string | null; kind: string; uploadedAt: string }>>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetch(`/api/members/${memberId}/photos`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (Array.isArray(data)) setPhotos(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [memberId]);
  if (loading) {
    return <p className="text-sm py-8 text-center" style={{ color: "var(--tx-3)" }}>Loading photos…</p>;
  }
  if (photos.length === 0) {
    return <p className="text-sm py-8 text-center" style={{ color: "var(--tx-3)" }}>No photos uploaded for this member yet.</p>;
  }
  return (
    <div className="grid grid-cols-3 gap-2 p-2">
      {photos.map((p) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img key={p.id} src={p.url} alt={p.caption ?? "Photo"} className="aspect-square object-cover rounded-md" />
      ))}
    </div>
  );
}
