"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, User, Mail, Phone, Calendar, Award, Activity,
  Edit2, ChevronDown, Check, X, Shield, Clock, FileText,
  Users, Dumbbell, Save, Loader2, CreditCard, Plus, Receipt,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberDetail {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  membershipType: string | null;
  status: string;
  notes: string | null;
  joinedAt: string;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  medicalConditions: string | null;
  dateOfBirth: string | null;
  waiverAccepted: boolean;
  waiverAcceptedAt: string | null;
  subscriptions: {
    id: string;
    classId: string;
    className: string;
    coachName: string | null;
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
    checkInTime: string;
    method: string;
  }[];
}

export interface RankOption {
  id: string;
  discipline: string;
  name: string;
  color: string;
  order: number;
}

interface Props {
  member: MemberDetail;
  rankOptions: RankOption[];
  primaryColor: string;
  role: string;
}

type ActiveTab = "overview" | "attendance" | "ranks" | "classes" | "notes" | "payments";

type PaymentEntry = {
  id: string;
  type: "subscription" | "purchase";
  description: string;
  amount: number;
  date: string;
  status: "paid" | "pending" | "overdue";
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hex(h: string, a: number) {
  const n = parseInt(h.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function fmtGBP(n: number) {
  return `£${n.toFixed(2)}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
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
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5" style={{ background: "rgba(0,0,0,0.04)" }}>
        <Icon className="w-4 h-4 text-gray-400" />
      </div>
      <div>
        <p className="text-gray-500 text-xs">{label}</p>
        <p className={`text-sm mt-0.5 ${muted ? "text-gray-600" : "text-white"}`}>{value}</p>
      </div>
    </div>
  );
}

function PaymentStatusBadge({ status }: { status: PaymentEntry["status"] }) {
  const map = {
    paid:    { label: "Paid",    cls: "bg-green-500/15 text-green-400" },
    pending: { label: "Pending", cls: "bg-yellow-500/15 text-yellow-400" },
    overdue: { label: "Overdue", cls: "bg-red-500/15 text-red-400" },
  };
  const s = map[status];
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${s.cls}`}>{s.label}</span>;
}

function seedDemoPayments(membershipType: string | null): PaymentEntry[] {
  const subDesc = membershipType ?? "Monthly Membership";
  const subAmt  = membershipType?.toLowerCase().includes("annual") ? 799.99
                : membershipType?.toLowerCase().includes("student") ? 39.99
                : membershipType?.toLowerCase().includes("2x")  ? 49.99
                : membershipType?.toLowerCase().includes("3x")  ? 59.99
                : membershipType?.toLowerCase().includes("family") ? 129.99
                : 79.99;
  const now = new Date();
  const mo = (n: number) => {
    const d = new Date(now); d.setMonth(d.getMonth() - n); return d.toISOString().split("T")[0];
  };
  return [
    { id: "s1", type: "subscription", description: subDesc, amount: subAmt, date: mo(0), status: "paid" },
    { id: "s2", type: "subscription", description: subDesc, amount: subAmt, date: mo(1), status: "paid" },
    { id: "s3", type: "subscription", description: subDesc, amount: subAmt, date: mo(2), status: "paid" },
    { id: "p1", type: "purchase", description: "Drop-In Class",    amount: 14.99, date: mo(0), status: "paid" },
    { id: "p2", type: "purchase", description: "Rashguard — Blue", amount: 34.99, date: mo(1), status: "paid" },
    { id: "p3", type: "purchase", description: "Competition Fee",  amount: 45.00, date: mo(2), status: "paid" },
  ];
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function MemberProfile({ member: initial, rankOptions, primaryColor, role }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [member, setMember] = useState(initial);
  const [tab, setTab] = useState<ActiveTab>("overview");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [notesDraft, setNotesDraft] = useState(initial.notes ?? "");
  const [notesSaving, setNotesSaving] = useState(false);
  const [form, setForm] = useState({
    name: initial.name,
    email: initial.email,
    phone: initial.phone ?? "",
    membershipType: initial.membershipType ?? "",
    status: initial.status,
    dateOfBirth: initial.dateOfBirth ? initial.dateOfBirth.slice(0, 10) : "",
  });

  // Rank promotion state
  const [showRankDrawer, setShowRankDrawer] = useState(false);
  const [rankForm, setRankForm] = useState({ rankSystemId: "", stripes: 0, notes: "" });
  const [promotingSaving, setPromotingSaving] = useState(false);

  // Payments state
  const [payments, setPayments] = useState<PaymentEntry[]>(() => seedDemoPayments(initial.membershipType));
  const [paymentDrawer, setPaymentDrawer] = useState(false);
  const [payForm, setPayForm] = useState<{ type: "subscription" | "purchase"; description: string; amount: string; status: PaymentEntry["status"] }>({
    type: "subscription", description: "", amount: "", status: "paid",
  });

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

  async function patchStatus(newStatus: string) {
    if (newStatus === member.status || !canEdit) return;
    setStatusUpdating(true);
    try {
      const res = await fetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!res.ok) { toast((await res.json()).error ?? "Failed to update status", "error"); return; }
      setMember((m) => ({ ...m, status: newStatus }));
      setForm((f) => ({ ...f, status: newStatus }));
      toast(`Status set to ${newStatus}`, "success");
    } finally { setStatusUpdating(false); }
  }

  async function saveProfile() {
    setSaving(true);
    try {
      const res = await fetch(`/api/members/${member.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: form.name, email: form.email, phone: form.phone || null, membershipType: form.membershipType || null, status: form.status, dateOfBirth: form.dateOfBirth || null }),
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

  function addPayment() {
    if (!payForm.description.trim() || !payForm.amount) return;
    const entry: PaymentEntry = {
      id: `local-${Date.now()}`,
      type: payForm.type,
      description: payForm.description,
      amount: parseFloat(payForm.amount),
      date: new Date().toISOString().split("T")[0],
      status: payForm.status,
    };
    setPayments((p) => [entry, ...p]);
    setPaymentDrawer(false);
    setPayForm({ type: "subscription", description: "", amount: "", status: "paid" });
    toast("Payment recorded", "success");
  }

  const subscriptionPayments = payments.filter((p) => p.type === "subscription");
  const purchasePayments     = payments.filter((p) => p.type === "purchase");

  const inputCls = "w-full bg-white/05 border border-black/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none focus:border-white/30";

  const currentStatus = STATUS_OPTIONS.find((s) => s.value === member.status) ?? STATUS_OPTIONS[0];

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── Header ── */}
      <div className="flex items-start gap-3 mb-6 flex-wrap">
        <button
          onClick={() => router.push("/dashboard/members")}
          className="p-2 rounded-xl text-gray-400 hover:text-white transition-colors shrink-0 mt-0.5"
          style={{ background: "rgba(0,0,0,0.04)" }}
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-white truncate mb-2">{member.name}</h1>

          {/* Status toggle bar */}
          <div
            className="inline-flex items-center gap-0.5 p-0.5 rounded-xl"
            style={{ background: "rgba(0,0,0,0.04)", border: "1px solid rgba(0,0,0,0.08)" }}
          >
            {STATUS_OPTIONS.map((s) => {
              const isActive = member.status === s.value;
              return (
                <button
                  key={s.value}
                  onClick={() => patchStatus(s.value)}
                  disabled={!canEdit || statusUpdating}
                  className="px-3 py-1 rounded-lg text-xs font-semibold transition-all disabled:cursor-not-allowed"
                  style={isActive
                    ? { background: s.bg, color: s.color, boxShadow: `inset 0 0 0 1px ${s.color}40` }
                    : { color: "rgba(0,0,0,0.40)" }
                  }
                >
                  {statusUpdating && isActive ? <Loader2 className="w-3 h-3 animate-spin inline" /> : s.label}
                </button>
              );
            })}
          </div>

          <p className="text-gray-500 text-sm mt-2">
            Member since {new Date(member.joinedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
          </p>
        </div>

        {canEdit && !editing && (
          <button
            onClick={() => setEditing(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-xl border text-gray-400 hover:text-white hover:border-white/20 transition-colors text-sm shrink-0"
            style={{ borderColor: "rgba(255,255,255,0.1)" }}
          >
            <Edit2 className="w-4 h-4" />
            Edit
          </button>
        )}
      </div>

      {/* ── Avatar + stats bar ── */}
      <div
        className="rounded-2xl border p-5 mb-4 flex items-center gap-5"
        style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
      >
        <div
          className="w-14 h-14 rounded-2xl flex items-center justify-center text-xl font-bold shrink-0"
          style={{ background: hex(primaryColor, 0.15), color: primaryColor }}
        >
          {initials(member.name)}
        </div>
        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 gap-4 min-w-0">
          {[
            { label: "Total Classes", value: member.attendances.length },
            { label: "This Month",    value: thisMonthCount },
            { label: "This Week",     value: thisWeekCount },
            { label: "Subscriptions", value: member.subscriptions.length },
          ].map(({ label, value }) => (
            <div key={label}>
              <p className="text-gray-500 text-xs">{label}</p>
              <p className="text-white text-lg font-bold leading-tight">{value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div
        className="flex border-b mb-5 overflow-x-auto scrollbar-hide"
        style={{ borderColor: "rgba(0,0,0,0.10)" }}
      >
        <Tab label="Overview"   active={tab === "overview"}   onClick={() => setTab("overview")} />
        <Tab label="Attendance" active={tab === "attendance"} onClick={() => setTab("attendance")} count={member.attendances.length} />
        <Tab label="Classes"    active={tab === "classes"}    onClick={() => setTab("classes")}    count={member.subscriptions.length} />
        <Tab label="Ranks"      active={tab === "ranks"}      onClick={() => setTab("ranks")}      count={member.ranks.length} />
        <Tab label="Payments"   active={tab === "payments"}   onClick={() => setTab("payments")}   count={payments.length} />
        <Tab label="Notes"      active={tab === "notes"}      onClick={() => setTab("notes")} />
      </div>

      {/* ── Overview ── */}
      {tab === "overview" && (
        <div
          className="rounded-2xl border p-6"
          style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
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
                  <label className="text-gray-400 text-xs mb-1 block">Membership Type</label>
                  <input value={form.membershipType} onChange={(e) => setForm((f) => ({ ...f, membershipType: e.target.value }))} className={inputCls} placeholder="e.g. Monthly, Annual" />
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
                <button onClick={() => { setEditing(false); setForm({ name: member.name, email: member.email, phone: member.phone ?? "", membershipType: member.membershipType ?? "", status: member.status, dateOfBirth: member.dateOfBirth ? member.dateOfBirth.slice(0, 10) : "" }); }} className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-gray-400 border border-black/10">
                  <X className="w-4 h-4" /> Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
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
                <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                  <p className="text-gray-500 text-xs mb-1.5">Notes</p>
                  <p className="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed">{member.notes}</p>
                </div>
              )}

              {/* Health & Waiver */}
              <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
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
                  {(member.emergencyContactName || member.emergencyContactPhone) && (
                    <div>
                      <p className="text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">Emergency Contact</p>
                      <p className="text-sm" style={{ color: "var(--tx-1)" }}>
                        {member.emergencyContactName ?? "—"}
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
                              <span key={c} className="px-2 py-0.5 rounded-full text-xs font-medium border" style={{ background: "rgba(0,0,0,0.04)", borderColor: "rgba(0,0,0,0.10)", color: "var(--tx-2)" }}>{c}</span>
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
              <div className="mt-4 pt-4 border-t" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                <div className="flex items-center gap-2 mb-2">
                  <Users className="w-4 h-4 text-gray-500" />
                  <p className="text-gray-500 text-xs font-medium">Connected Accounts</p>
                </div>
                <p className="text-gray-700 text-xs">No linked accounts — parent/child linking coming soon</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Attendance ── */}
      {tab === "attendance" && (
        <div
          className="rounded-2xl border overflow-hidden"
          style={{ borderColor: "rgba(0,0,0,0.08)" }}
        >
          {member.attendances.length === 0 ? (
            <div className="p-12 text-center">
              <Clock className="w-10 h-10 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 font-medium">No attendance records yet</p>
              <p className="text-gray-600 text-sm mt-1">Check-ins will appear here</p>
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b" style={{ borderColor: "rgba(0,0,0,0.08)", background: "rgba(0,0,0,0.02)" }}>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Class</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium">Date</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium hidden sm:table-cell">Time</th>
                  <th className="text-left px-4 py-3 text-gray-500 text-xs font-medium hidden sm:table-cell">Method</th>
                </tr>
              </thead>
              <tbody>
                {member.attendances.map((a, i) => {
                  const checkInDate = new Date(a.checkInTime);
                  return (
                    <tr key={a.id} className="border-b transition-colors hover:bg-black/2" style={{ borderColor: i === member.attendances.length - 1 ? "transparent" : "rgba(0,0,0,0.03)" }}>
                      <td className="px-4 py-3 text-white text-sm font-medium">{a.className}</td>
                      <td className="px-4 py-3 text-gray-400 text-sm">{new Date(a.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
                      <td className="px-4 py-3 text-gray-400 text-sm hidden sm:table-cell">{checkInDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <span className="text-xs px-2 py-0.5 rounded-full capitalize" style={{ background: "rgba(0,0,0,0.08)", color: "rgba(0,0,0,0.50)" }}>{a.method}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* ── Classes ── */}
      {tab === "classes" && (
        <div className="space-y-2">
          {member.subscriptions.length === 0 ? (
            <div className="rounded-2xl border p-12 text-center" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
              <Dumbbell className="w-10 h-10 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 font-medium">No class subscriptions</p>
              <p className="text-gray-600 text-sm mt-1">Member hasn&apos;t subscribed to any classes yet</p>
            </div>
          ) : (
            member.subscriptions.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 px-4 py-3.5 rounded-2xl border"
                style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}
              >
                <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0" style={{ background: hex(primaryColor, 0.1) }}>
                  <Dumbbell className="w-4 h-4" style={{ color: primaryColor }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm font-semibold">{s.className}</p>
                  {s.coachName && <p className="text-gray-500 text-xs mt-0.5">{s.coachName}</p>}
                </div>
              </div>
            ))
          )}
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
            <div className="rounded-2xl border p-12 text-center" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
              <Award className="w-10 h-10 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 font-medium">No ranks assigned</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {member.ranks.map((r) => (
                <div key={r.id} className="rounded-2xl border p-4 flex items-center gap-4" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
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

          {/* ── Subscriptions section ── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <CreditCard className="w-4 h-4 text-gray-500" />
              <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Subscriptions</p>
              <span className="ml-auto text-gray-600 text-xs">{subscriptionPayments.length} records</span>
            </div>
            {subscriptionPayments.length === 0 ? (
              <div className="rounded-2xl border p-8 text-center" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                <CreditCard className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                <p className="text-gray-600 text-sm">No subscription payments recorded</p>
              </div>
            ) : (
              <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                {subscriptionPayments.map((p, i) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-4 px-4 py-3"
                    style={{ borderBottom: i < subscriptionPayments.length - 1 ? "1px solid rgba(0,0,0,0.03)" : "none", background: "rgba(0,0,0,0.01)" }}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: hex(primaryColor, 0.08) }}>
                      <CreditCard className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{p.description}</p>
                      <p className="text-gray-600 text-xs mt-0.5">{fmtDate(p.date)}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <PaymentStatusBadge status={p.status} />
                      <p className="text-white text-sm font-semibold tabular-nums">{fmtGBP(p.amount)}</p>
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-2.5" style={{ background: "rgba(0,0,0,0.02)", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                  <p className="text-gray-500 text-xs font-medium">Total subscriptions</p>
                  <p className="text-white text-sm font-bold tabular-nums">
                    {fmtGBP(subscriptionPayments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0))}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* ── Purchases section ── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Receipt className="w-4 h-4 text-gray-500" />
              <p className="text-gray-400 text-xs font-semibold uppercase tracking-wider">Purchases</p>
              <span className="ml-auto text-gray-600 text-xs">{purchasePayments.length} records</span>
            </div>
            {purchasePayments.length === 0 ? (
              <div className="rounded-2xl border p-8 text-center" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                <Receipt className="w-8 h-8 text-gray-700 mx-auto mb-2" />
                <p className="text-gray-600 text-sm">No one-off purchases recorded</p>
              </div>
            ) : (
              <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "rgba(0,0,0,0.08)" }}>
                {purchasePayments.map((p, i) => (
                  <div
                    key={p.id}
                    className="flex items-center gap-4 px-4 py-3"
                    style={{ borderBottom: i < purchasePayments.length - 1 ? "1px solid rgba(0,0,0,0.03)" : "none", background: "rgba(0,0,0,0.01)" }}
                  >
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(0,0,0,0.04)" }}>
                      <Receipt className="w-3.5 h-3.5 text-gray-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{p.description}</p>
                      <p className="text-gray-600 text-xs mt-0.5">{fmtDate(p.date)}</p>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      <PaymentStatusBadge status={p.status} />
                      <p className="text-white text-sm font-semibold tabular-nums">{fmtGBP(p.amount)}</p>
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between px-4 py-2.5" style={{ background: "rgba(0,0,0,0.02)", borderTop: "1px solid rgba(0,0,0,0.08)" }}>
                  <p className="text-gray-500 text-xs font-medium">Total purchases</p>
                  <p className="text-white text-sm font-bold tabular-nums">
                    {fmtGBP(purchasePayments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0))}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Notes ── */}
      {tab === "notes" && (
        <div className="rounded-2xl border p-6 space-y-4" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
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
              background: "rgba(0,0,0,0.03)",
              border: "1px solid rgba(0,0,0,0.10)",
              lineHeight: 1.7,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = hex(primaryColor, 0.4); }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "rgba(0,0,0,0.10)"; }}
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
              <h3 className="text-white font-semibold">Assign / Promote Rank</h3>
              <button onClick={() => setShowRankDrawer(false)} className="text-gray-500 hover:text-white"><X className="w-5 h-5" /></button>
            </div>

            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Discipline</label>
              <div className="relative">
                <select
                  value={rankOptions.find((r) => r.id === rankForm.rankSystemId)?.discipline ?? ""}
                  onChange={(e) => { const first = rankOptions.find((r) => r.discipline === e.target.value); setRankForm((f) => ({ ...f, rankSystemId: first?.id ?? "" })); }}
                  className="w-full appearance-none bg-white/05 border border-black/10 rounded-xl px-3 py-2.5 text-white text-sm focus:outline-none"
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
                      <span className="text-white text-sm">{r.name}</span>
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
                    <button key={n} onClick={() => setRankForm((f) => ({ ...f, stripes: n }))} className={`w-9 h-9 rounded-lg text-sm font-medium border transition-colors ${rankForm.stripes === n ? "border-white/30 text-white bg-white/08" : "border-black/10 text-gray-500 hover:text-white"}`}>{n}</button>
                  ))}
                </div>
                <div className="mt-3"><BeltGraphic color={selectedRankOption.color} stripes={rankForm.stripes} /></div>
              </div>
            )}

            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Notes (optional)</label>
              <textarea value={rankForm.notes} onChange={(e) => setRankForm((f) => ({ ...f, notes: e.target.value }))} rows={2} placeholder="e.g. Competition win, grading night…" className="w-full bg-white/05 border border-black/10 rounded-xl px-3 py-2 text-white text-sm focus:outline-none resize-none" />
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
              <h3 className="text-white font-semibold">Record Payment</h3>
              <button onClick={() => setPaymentDrawer(false)} className="text-gray-500 hover:text-white"><X className="w-5 h-5" /></button>
            </div>

            {/* Type toggle */}
            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Type</label>
              <div className="flex gap-1 p-0.5 rounded-xl" style={{ background: "rgba(0,0,0,0.04)" }}>
                {(["subscription", "purchase"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setPayForm((f) => ({ ...f, type: t }))}
                    className="flex-1 py-2 rounded-lg text-xs font-semibold capitalize transition-all"
                    style={{
                      background: payForm.type === t ? hex(primaryColor, 0.15) : "transparent",
                      color: payForm.type === t ? primaryColor : "rgba(255,255,255,0.4)",
                      boxShadow: payForm.type === t ? `inset 0 0 0 1px ${hex(primaryColor, 0.3)}` : "none",
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-gray-400 text-xs mb-1.5 block">Description</label>
              <input
                value={payForm.description}
                onChange={(e) => setPayForm((f) => ({ ...f, description: e.target.value }))}
                className={inputCls}
                placeholder={payForm.type === "subscription" ? "e.g. Monthly Unlimited" : "e.g. Rashguard — Blue"}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
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
              <div>
                <label className="text-gray-400 text-xs mb-1.5 block">Status</label>
                <div className="relative">
                  <select
                    value={payForm.status}
                    onChange={(e) => setPayForm((f) => ({ ...f, status: e.target.value as PaymentEntry["status"] }))}
                    className={inputCls + " appearance-none"}
                  >
                    <option value="paid">Paid</option>
                    <option value="pending">Pending</option>
                    <option value="overdue">Overdue</option>
                  </select>
                  <ChevronDown className="absolute right-3 top-2.5 w-4 h-4 text-gray-400 pointer-events-none" />
                </div>
              </div>
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
