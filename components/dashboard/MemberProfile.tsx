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

type ActiveTab = "overview" | "attendance" | "ranks" | "notes" | "payments";

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

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}


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
        active ? "border-white text-white" : "border-transparent text-gray-500 hover:text-gray-300"
      }`}
    >
      {label}{count !== undefined ? ` (${count})` : ""}
    </button>
  );
}

function InfoRow({ icon: Icon, label, value, muted }: { icon: React.ElementType; label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: "rgba(255,255,255,0.04)" }}>
        <Icon className="w-4 h-4 text-gray-400" />
      </div>
      <div>
        <p className="text-gray-500 text-xs">{label}</p>
        <p className={`text-sm mt-0.5 ${muted ? "text-gray-600" : "text-white"}`}>{value}</p>
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
  const [rankForm, setRankForm] = useState({ rankSystemId: "", stripes: 0, notes: "" });
  const [promotingSaving, setPromotingSaving] = useState(false);

  // Payments state
  const [payments, setPayments] = useState<PaymentEntry[]>([]);
  const [paymentDrawer, setPaymentDrawer] = useState(false);
  const [payForm, setPayForm] = useState<{ description: string; amount: string }>({
    description: "", amount: "",
  });

  // More actions menu
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

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
      setRankForm({ rankSystemId: "", stripes: 0, notes: "" });
      toast("Rank assigned", "success");
    } finally { setPromotingSaving(false); }
  }

  async function addPayment() {
    if (!payForm.description.trim() || !payForm.amount) return;
    const tempId = `local-${Date.now()}`;
    const tempEntry: PaymentEntry = {
      id: tempId,
      amountPence: Math.round(parseFloat(payForm.amount) * 100),
      currency: "GBP",
      status: "succeeded",
      description: payForm.description,
      paidAt: new Date().toISOString(),
    };
    setPayments((p) => [tempEntry, ...p]);
    setPaymentDrawer(false);
    setPayForm({ description: "", amount: "" });
    try {
      const res = await fetch("/api/payments/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId: member.id,
          amountPence: Math.round(parseFloat(payForm.amount) * 100),
          method: "manual",
          notes: payForm.description,
        }),
      });
      if (!res.ok) {
        setPayments((p) => p.filter((e) => e.id !== tempId));
        toast((await res.json()).error ?? "Failed to record payment", "error");
        return;
      }
      const saved = await res.json();
      setPayments((p) => p.map((e) => e.id === tempId ? saved : e));
      toast("Payment recorded", "success");
    } catch {
      setPayments((p) => p.filter((e) => e.id !== tempId));
      toast("Failed to record payment", "error");
    }
  }

  const inputCls = "w-full bg-white/05 border border-black/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-white/30";

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
          className="p-2.5 rounded-xl text-gray-400 hover:text-white transition-colors shrink-0 mt-1"
          style={{ background: "rgba(255,255,255,0.035)", border: "1px solid var(--bd-default)" }}
          aria-label="Back to members"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center text-xl font-bold shrink-0"
          style={{ background: hex(primaryColor, 0.17), color: primaryColor, boxShadow: `0 18px 40px ${hex(primaryColor, 0.12)}` }}
        >
          {initials(member.name)}
        </div>

        <div className="flex-1 min-w-0 pt-0.5">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h1 className="text-2xl font-bold text-white mr-1 break-words min-w-0">{member.name}</h1>
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

          <p className="text-gray-500 text-sm">
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
              className="flex items-center gap-2 px-3 py-2 rounded-xl border text-gray-400 hover:text-white hover:border-white/20 transition-colors text-sm"
              style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.025)" }}
            >
              <Edit2 className="w-4 h-4" />
              Edit
            </button>
          )}
          <div className="relative" ref={actionsMenuRef}>
            <button
              onClick={() => setShowActionsMenu((v) => !v)}
              className="p-2 rounded-xl border text-gray-400 hover:text-white hover:border-white/20 transition-colors"
              style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.025)" }}
              type="button"
              aria-label="More actions"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
            {showActionsMenu && (
              <div
                className="absolute right-0 top-full mt-1 w-44 rounded-xl border py-1 z-20"
                style={{ background: "var(--sf-0)", borderColor: "rgba(255,255,255,0.1)" }}
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
                  className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-white/05 transition-colors"
                >
                  Mark as inactive
                </button>
                <button
                  onClick={() => {
                    setShowActionsMenu(false);
                    copyWaiverLink();
                  }}
                  disabled={member.waiverAccepted}
                  className="w-full text-left px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-white/05 transition-colors disabled:text-gray-600 disabled:cursor-not-allowed"
                >
                  Copy waiver link
                </button>
                {!member.waiverAccepted && ["owner", "manager", "admin", "coach"].includes(role) && (
                  <a
                    href={`/dashboard/members/${member.id}/waiver`}
                    onClick={() => setShowActionsMenu(false)}
                    className="w-full text-left block px-4 py-2 text-sm text-gray-300 hover:text-white hover:bg-white/05 transition-colors"
                  >
                    Open waiver on this device
                  </a>
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
          <div key={label} className="rounded-2xl border p-4" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
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
        style={{ borderColor: "rgba(255,255,255,0.1)" }}
      >
        <Tab label="Overview" active={tab === "overview"} onClick={() => setTab("overview")} />
        <Tab label="Attendance" active={tab === "attendance"} onClick={() => setTab("attendance")} count={member.attendances.length} />
        <Tab label="Payments" active={tab === "payments"} onClick={() => setTab("payments")} count={payments.length} />
        <Tab label="Ranks" active={tab === "ranks"} onClick={() => setTab("ranks")} count={member.ranks.length} />
        <Tab label="Notes" active={tab === "notes"} onClick={() => setTab("notes")} />
      </div>

      {/* ── Overview ── */}
      {tab === "overview" && (
        <div
          className="rounded-2xl border p-6"
          style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}
        >
          {editing ? (
            <div className="space-y-4">
              <h2 className="text-white font-semibold">Edit Profile</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Full Name</label>
                  <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Email</label>
                  <input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} className={inputCls} />
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Phone</label>
                  <input type="tel" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} className={inputCls} placeholder="Optional" />
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Emergency Contact Name</label>
                  <input value={form.emergencyContactName} onChange={(e) => setForm((f) => ({ ...f, emergencyContactName: e.target.value }))} className={inputCls} placeholder="Required before waiver" />
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Emergency Contact Phone</label>
                  <input type="tel" value={form.emergencyContactPhone} onChange={(e) => setForm((f) => ({ ...f, emergencyContactPhone: e.target.value }))} className={inputCls} placeholder="Required before waiver" />
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Emergency Contact Relation</label>
                  <input value={form.emergencyContactRelation} onChange={(e) => setForm((f) => ({ ...f, emergencyContactRelation: e.target.value }))} className={inputCls} placeholder="Parent, partner, friend" />
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Membership Type</label>
                  {tiers.length > 0 ? (
                    <div className="relative">
                      <select
                        value={form.membershipType}
                        onChange={(e) => setForm((f) => ({ ...f, membershipType: e.target.value }))}
                        className={inputCls + " appearance-none"}
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
                      <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
                    </div>
                  ) : (
                    <input
                      value={form.membershipType}
                      onChange={(e) => setForm((f) => ({ ...f, membershipType: e.target.value }))}
                      className={inputCls}
                      placeholder="e.g. Monthly, Annual"
                    />
                  )}
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Status</label>
                  <div className="relative">
                    <select value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))} className={inputCls + " appearance-none"}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                      <option value="cancelled">Cancelled</option>
                      <option value="taster">Taster</option>
                    </select>
                    <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
                  </div>
                </div>
                <div>
                  <label className="text-gray-400 text-xs mb-1 block">Date of Birth</label>
                  <input type="date" value={form.dateOfBirth} onChange={(e) => setForm((f) => ({ ...f, dateOfBirth: e.target.value }))} className={inputCls} />
                </div>
              </div>
              <div className="flex gap-3 pt-1">
                <button onClick={saveProfile} disabled={saving} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-white disabled:opacity-60" style={{ background: primaryColor }}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  {saving ? "Saving…" : "Save"}
                </button>
                <button onClick={() => { setEditing(false); setForm({ name: member.name, email: member.email, phone: member.phone ?? "", emergencyContactName: member.emergencyContactName ?? "", emergencyContactPhone: member.emergencyContactPhone ?? "", emergencyContactRelation: member.emergencyContactRelation ?? "", membershipType: member.membershipType ?? "", status: member.status, dateOfBirth: member.dateOfBirth ? member.dateOfBirth.slice(0, 10) : "" }); }} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-gray-400 border border-black/10">
                  <X className="w-4 h-4" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-5">
                <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
                  <div className="flex items-center justify-between gap-3 mb-5">
                    <div>
                      <h2 className="text-white font-semibold">Contact and Safety</h2>
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
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2" style={{ color: "var(--tx-4)" }}>Owner Notes</p>
                      <p className="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed">{member.notes}</p>
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
                    <h3 className="text-white text-sm font-semibold mb-4">Membership and Billing</h3>
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
                    <h3 className="text-white text-sm font-semibold mb-3">Waiver and Compliance</h3>
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

                  <div className="rounded-2xl border p-5" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
                    <h3 className="text-white text-sm font-semibold mb-4">Recent Activity</h3>
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
              <h2 className="text-white font-semibold mb-4">Contact & Membership</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <InfoRow icon={User}     label="Name"       value={member.name} />
                <InfoRow icon={Mail}     label="Email"      value={member.email} />
                <InfoRow icon={Phone}    label="Phone"      value={member.phone ?? "Not provided"} muted={!member.phone} />
                <InfoRow icon={Shield}   label="Membership" value={member.membershipType ?? "Not set"} muted={!member.membershipType} />
                <InfoRow icon={Calendar} label="Joined"     value={new Date(member.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} />
                <InfoRow icon={Activity} label="Status"     value={currentStatus.label} />
              </div>

              {/* Quick notes preview */}
              {member.notes && (
                <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                  <p className="text-gray-500 text-xs mb-1.5">Notes</p>
                  <p className="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed">{member.notes}</p>
                </div>
              )}

              {/* Health & Waiver */}
              <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <p className="text-gray-500 text-xs font-medium mb-3">Health & Waiver</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {member.dateOfBirth && (
                    <div>
                      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Date of Birth</p>
                      <p className="text-sm" style={{ color: "var(--tx-1)" }}>
                        {new Date(member.dateOfBirth).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}
                      </p>
                    </div>
                  )}
                  {(member.emergencyContactName || member.emergencyContactPhone || member.emergencyContactRelation) && (
                    <div>
                      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Emergency Contact</p>
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
                          <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-1.5">Medical Conditions</p>
                          <div className="flex flex-wrap gap-1.5">
                            {conds.map((c) => (
                              <span key={c} className="px-2 py-0.5 rounded-full text-xs font-medium border" style={{ background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.1)", color: "var(--tx-2)" }}>{c}</span>
                            ))}
                          </div>
                        </div>
                      );
                    } catch { return null; }
                  })()}
                  <div>
                    <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Liability Waiver</p>
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
              <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-gray-500" />
                  <p className="text-gray-500 text-xs font-medium">Connected Accounts</p>
                </div>
                <p className="text-gray-700 text-xs">No linked accounts — parent/child linking coming soon</p>
              </div>
            </div>
            </div>
          )}
        </div>
      )}

      {/* ── Attendance ── */}
      {tab === "attendance" && (
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4">
          <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
            {member.attendances.length === 0 ? (
              <div className="p-12 text-center">
                <Clock className="w-10 h-10 text-gray-600 mx-auto mb-3" />
                <p className="text-gray-400 font-medium">No attendance records yet</p>
                <p className="text-gray-600 text-sm mt-1">Check-ins will appear here</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr className="border-b" style={{ borderColor: "rgba(255,255,255,0.08)", background: "rgba(255,255,255,0.025)" }}>
                      <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Class</th>
                      <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Session</th>
                      <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Checked in</th>
                      <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Coach / Location</th>
                      <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Method</th>
                    </tr>
                  </thead>
                  <tbody>
                    {member.attendances.map((a, i) => {
                      const checkInDate = new Date(a.checkInTime);
                      return (
                        <tr key={a.id} className="border-b transition-colors hover:bg-black/2" style={{ borderColor: i === member.attendances.length - 1 ? "transparent" : "rgba(255,255,255,0.03)" }}>
                          <td className="px-4 py-3 text-white text-sm font-medium">{a.className}</td>
                          <td className="px-4 py-3 text-gray-400 text-sm">
                            <div>{new Date(a.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</div>
                            <div className="text-xs text-gray-600">{a.startTime}-{a.endTime}</div>
                          </td>
                          <td className="px-4 py-3 text-gray-400 text-sm">{checkInDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</td>
                          <td className="px-4 py-3 text-gray-400 text-sm">
                            <div>{a.coachName ?? "No coach set"}</div>
                            <div className="text-xs text-gray-600">{a.location ?? "No location set"}</div>
                          </td>
                          <td className="px-4 py-3">
                            <span className="text-xs px-2 py-0.5 rounded-full capitalize" style={{ background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.5)" }}>{a.method}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <aside className="rounded-2xl border p-4 h-fit" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="text-white text-sm font-semibold">Subscribed Classes</h3>
                <p className="text-xs mt-0.5" style={{ color: "var(--tx-4)" }}>{member.subscriptions.length} class follows</p>
              </div>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(primaryColor, 0.12), color: primaryColor }}>
                <Dumbbell className="w-4 h-4" />
              </div>
            </div>
            {member.subscriptions.length === 0 ? (
              <div className="py-8 text-center">
                <Dumbbell className="w-8 h-8 text-gray-600 mx-auto mb-2" />
                <p className="text-gray-400 text-sm font-medium">No class subscriptions yet</p>
              </div>
            ) : (
              <div className="space-y-2">
                {member.subscriptions.map((s) => (
                  <div key={s.id} className="rounded-xl border p-3" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}>
                    <p className="text-white text-sm font-semibold truncate">{s.className}</p>
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
            <div className="rounded-2xl border p-12 text-center" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <Award className="w-10 h-10 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 font-medium">No ranks assigned</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {member.ranks.map((r) => (
                <div key={r.id} className="rounded-2xl border p-4 flex items-center gap-4" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}>
                  <BeltGraphic color={r.color} stripes={r.stripes} />
                  <div>
                    <p className="text-white font-medium text-sm">{r.rankName}</p>
                    <p className="text-gray-500 text-xs">{r.discipline} · {r.stripes} stripe{r.stripes !== 1 ? "s" : ""}</p>
                    <p className="text-gray-600 text-[10px] mt-0.5">Since {new Date(r.achievedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</p>
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
              <p className="text-white font-semibold">Payment History</p>
              <p className="text-gray-500 text-xs mt-0.5">All recorded transactions for this member</p>
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
              <Receipt className="w-4 h-4 text-gray-500" />
              <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Transactions</p>
              <span className="ml-auto text-gray-600 text-xs">{payments.length} records</span>
            </div>
            {payments.length === 0 ? (
              <div className="rounded-2xl border p-8 text-center" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                <CreditCard className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                <p className="text-gray-600 text-sm">No payments recorded yet</p>
              </div>
            ) : (
              <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                {payments.map((p, i) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-4 px-4 py-3"
                    style={{ borderBottom: i < payments.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none", background: "rgba(255,255,255,0.015)" }}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: hex(primaryColor, 0.08) }}>
                      <CreditCard className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{p.description ?? "Payment"}</p>
                      <p className="text-gray-600 text-xs mt-0.5">{p.paidAt ? fmtDate(p.paidAt) : "—"}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <PaymentStatusBadge status={p.status} />
                      <p className="text-white text-sm font-semibold tabular-nums">
                        {p.currency === "GBP" ? "£" : p.currency}{(p.amountPence / 100).toFixed(2)}
                      </p>
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-2.5" style={{ background: "rgba(255,255,255,0.025)", borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <p className="text-gray-500 text-xs font-medium">Total recorded</p>
                  <p className="text-white text-sm font-bold tabular-nums">
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

      {/* ── Notes ── */}
      {tab === "notes" && (
        <div className="rounded-2xl border p-6 space-y-4" style={{ background: "rgba(255,255,255,0.025)", borderColor: "rgba(255,255,255,0.08)" }}>
          <div className="flex items-center gap-2 mb-1">
            <FileText className="w-4 h-4 text-gray-400" />
            <h2 className="text-white font-semibold">Account Notes</h2>
          </div>
          <p className="text-gray-500 text-xs">Private notes visible to staff only. Use for injuries, payment issues, goals, anything relevant.</p>
          <textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            rows={8}
            placeholder="Add notes about this member…"
            disabled={!canEdit}
            className="w-full resize-none rounded-xl px-4 py-3 text-sm text-white placeholder-gray-600 outline-none transition-all"
            style={{
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.1)",
              lineHeight: 1.7,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = hex(primaryColor, 0.4); }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)"; }}
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

      {/* ── Rank drawer ── */}
      {showRankDrawer && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowRankDrawer(false)} />
          <div className="relative w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border p-6 space-y-4" style={{ background: "var(--sf-0)", borderColor: "rgba(255,255,255,0.1)" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold" style={{ color: "var(--tx-1)" }}>Assign / Promote Rank</h3>
              <button onClick={() => setShowRankDrawer(false)} className="text-gray-500 hover:text-white"><X className="w-5 h-5" /></button>
            </div>

            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Discipline</label>
              <div className="relative">
                <select
                  value={rankOptions.find((r) => r.id === rankForm.rankSystemId)?.discipline ?? ""}
                  onChange={(e) => { const first = rankOptions.find((r) => r.discipline === e.target.value); setRankForm((f) => ({ ...f, rankSystemId: first?.id ?? "" })); }}
                  className="w-full appearance-none bg-white/05 border border-black/10 rounded-xl px-3 py-2.5 text-sm focus:outline-none" style={{ color: "var(--tx-1)" }}
                >
                  <option value="">Select discipline…</option>
                  {disciplines.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <ChevronDown className="absolute right-3 top-3 w-4 h-4 text-gray-400 pointer-events-none" />
              </div>
            </div>

            {rankForm.rankSystemId && (
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block">Rank</label>
                <div className="grid grid-cols-1 gap-2">
                  {disciplineRanks.map((r) => (
                    <button key={r.id} onClick={() => setRankForm((f) => ({ ...f, rankSystemId: r.id }))} className={`flex items-center gap-3 p-3 rounded-xl border text-left transition-colors ${rankForm.rankSystemId === r.id ? "border-white/30 bg-white/05" : "border-white/08 hover:border-black/12"}`}>
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
                <label className="text-gray-400 text-xs mb-1.5 block">Stripes (0–4)</label>
                <div className="flex gap-2">
                  {[0,1,2,3,4].map((n) => (
                    <button key={n} onClick={() => setRankForm((f) => ({ ...f, stripes: n }))} className={`w-9 h-9 rounded-lg text-sm font-medium border transition-colors ${rankForm.stripes === n ? "border-white/30 bg-white/08" : "border-black/10 text-gray-500"}`} style={{ color: rankForm.stripes === n ? "var(--tx-1)" : undefined }}>{n}</button>
                  ))}
                </div>
                <div className="mt-3"><BeltGraphic color={selectedRankOption.color} stripes={rankForm.stripes} /></div>
              </div>
            )}

            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Notes (optional)</label>
              <textarea value={rankForm.notes} onChange={(e) => setRankForm((f) => ({ ...f, notes: e.target.value }))} rows={2} placeholder="e.g. Competition win, grading night…" className="w-full bg-white/05 border border-black/10 rounded-xl px-3 py-2 text-sm focus:outline-none resize-none" style={{ color: "var(--tx-1)" }} />
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
          <div className="relative w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border p-6 space-y-4" style={{ background: "var(--sf-0)", borderColor: "rgba(255,255,255,0.1)" }}>
            <div className="flex items-center justify-between">
              <h3 className="font-semibold" style={{ color: "var(--tx-1)" }}>Record Payment</h3>
              <button onClick={() => setPaymentDrawer(false)} className="text-gray-500 hover:text-white"><X className="w-5 h-5" /></button>
            </div>

            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Description / Notes</label>
              <input
                value={payForm.description}
                onChange={(e) => setPayForm((f) => ({ ...f, description: e.target.value }))}
                className={inputCls}
                placeholder="e.g. Monthly membership, cash"
              />
            </div>

            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Amount (£)</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={payForm.amount}
                onChange={(e) => setPayForm((f) => ({ ...f, amount: e.target.value }))}
                className={inputCls}
                placeholder="0.00"
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
    </div>
  );
}
