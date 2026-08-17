"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, User, Mail, Phone, Calendar, Award, Activity,
  Edit2, ChevronDown, Check, X, Shield, Clock, FileText,
  Users, Dumbbell, Save, Loader2, CreditCard, Plus, Receipt,
  AlertTriangle, FileCheck2, MoreHorizontal, CalendarCheck,
  Link2, MapPin, Camera, Trash2,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import MarkPaidDrawer from "@/components/dashboard/MarkPaidDrawer";
import { RemoveMemberModal } from "@/components/dashboard/RemoveMemberModal";
import AdhocChargeDrawer from "@/components/dashboard/AdhocChargeDrawer";
import { AvatarUploader } from "@/components/ui/AvatarUploader";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { Sheet } from "@/components/ui/sheet";
import { StatusPill } from "@/components/ui/StatusPill";
import { toBlobProxyUrl } from "@/lib/blob-url";
import { hex, readableOn } from "@/lib/color";

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
  // Drives kid-specific UI (kids are passwordless — no login invite).
  accountType?: string;
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
  /** Derived server-side from the Stripe ids — "card" or "manual". */
  method?: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

// UI-RULES §2: the inline hex()/alpha copy that used to live here is deleted —
// `lib/color.ts` is the single source for colour maths.

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

/**
 * Tab rail button. The active state used to be `border-b-2 border-white`,
 * which paints white-on-white and therefore nothing at all on the light staff
 * shell (UI-RULES §4a.5). It is now the tenant accent underline — the one
 * place colour is allowed to appear (§1.5.3) — set through the runtime CSS
 * variable so it stays correct under any tenant palette (§2a).
 */
function Tab({ label, active, onClick, count }: { label: string; active: boolean; onClick: () => void; count?: number }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`shrink-0 border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors ${
        active
          ? "text-tx-1"
          : "border-transparent text-tx-3 hover:border-bd-hover hover:text-tx-2"
      }`}
      style={active ? { borderColor: "var(--color-primary)" } : undefined}
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

/**
 * Payments table columns (UI-RULES §1.5.4 dense spec via the DataTable
 * primitive). `method` is derived server-side from the row's Stripe ids —
 * there is no method column on Payment, and inventing one would be fabricated
 * data (§7). Defined at module scope so the array identity is stable and the
 * table's sort memo is not invalidated on every parent render.
 */
const paymentColumns: DataTableColumn<PaymentEntry>[] = [
  {
    key: "date",
    header: "Date",
    width: "9rem",
    sortValue: (p) => (p.paidAt ? new Date(p.paidAt) : null),
    cell: (p) => (
      <span className="whitespace-nowrap" style={{ color: "var(--tx-2)" }}>
        {p.paidAt ? fmtDate(p.paidAt) : "—"}
      </span>
    ),
  },
  {
    key: "description",
    header: "Description",
    sortValue: (p) => p.description ?? "",
    cell: (p) => <span className="block truncate font-medium">{p.description ?? "Payment"}</span>,
  },
  {
    key: "method",
    header: "Method",
    width: "7rem",
    sortValue: (p) => p.method ?? "",
    cell: (p) => (
      <span className="capitalize" style={{ color: "var(--tx-3)" }}>
        {p.method === "card" ? "Card" : p.method === "manual" ? "Manual" : "—"}
      </span>
    ),
  },
  {
    key: "status",
    header: "Status",
    width: "7rem",
    sortValue: (p) => p.status,
    cell: (p) => <PaymentStatusBadge status={p.status} />,
  },
  {
    key: "amount",
    header: "Amount",
    align: "right",
    width: "7rem",
    sortValue: (p) => p.amountPence,
    cell: (p) => (
      <span className="font-semibold tabular-nums whitespace-nowrap">
        {p.currency === "GBP" ? "£" : p.currency}{(p.amountPence / 100).toFixed(2)}
      </span>
    ),
  },
];


// ─── Main component ───────────────────────────────────────────────────────────

export default function MemberProfile({ member: initial, rankOptions, tiers = [], primaryColor, role }: Props) {
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

  // Ad-hoc charge drawer
  const [showChargeDrawer, setShowChargeDrawer] = useState(false);

  // More actions menu
  const [showActionsMenu, setShowActionsMenu] = useState(false);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  // F5 deletion gateway — opens the 3-strategy modal when a parent member is
  // about to be removed. The modal handles the probe + picker + execution.
  const [showRemoveModal, setShowRemoveModal] = useState(false);

  // Public, no-login waiver share: mint a /waiver/open?token=… link via the
  // API, render a QR for it, and show a share modal. Replaces the old behaviour
  // that copied a /login URL (which forced the member to sign in first).
  const [waiverShare, setWaiverShare] = useState<{ url: string; qr: string } | null>(null);
  const [waiverShareLoading, setWaiverShareLoading] = useState(false);

  async function openWaiverShare() {
    setWaiverShareLoading(true);
    try {
      const res = await fetch(`/api/members/${member.id}/waiver-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data?.error ?? "Could not create waiver link", "error");
        return;
      }
      let qr = "";
      try {
        const QRCode = (await import("qrcode")).default;
        qr = await QRCode.toDataURL(data.url, { width: 240, margin: 1 });
      } catch {
        /* QR is best-effort — the copyable URL still works */
      }
      setWaiverShare({ url: data.url, qr });
    } catch {
      toast("Could not create waiver link", "error");
    } finally {
      setWaiverShareLoading(false);
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
  // Payment recording + waiver links hit owner/manager-only APIs
  // (POST /api/payments/manual, POST /api/members/[id]/waiver-link) — offering
  // them to `admin` produced silent 403s (audit R2–R4).
  const canRecordPayment = ["owner", "manager"].includes(role);
  const canShareWaiver   = ["owner", "manager"].includes(role);

  // Audit N1: honour deep links like ?tab=payments (the /dashboard/payments
  // row action) — previously the param was silently discarded.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t && ["overview", "attendance", "ranks", "notes", "payments", "photos"].includes(t)) {
      setTab(t as ActiveTab);
    }
  }, []);
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

  // Input classes are fully token-driven: surface from --sf-1, border from
  // --bd-default, and the focus border swaps to --bd-active via the handlers
  // below. No white-alpha anywhere — it is invisible on the light shell (§4a.5).
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
    <>
      {/* ── Header ── */}
      {/*
        One identity block (back + avatar + name + every status chip) on the
        left, the action cluster on the right. The chips used to sit on two
        separate rows below the name, which left a dead ~800px gap beside a
        short name at 1440px; inlining them with the name fills the row and
        makes the split at `lg:` a real two-column header rather than a
        stretched phone layout (UI-RULES §4a.2).
      */}
      <header className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3 sm:gap-4">
          <Button
            variant="secondary"
            onClick={() => router.push("/dashboard/members")}
            className="mt-1 size-9 shrink-0 px-0"
            aria-label="Back to members"
          >
            <ArrowLeft className="size-5" />
          </Button>

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

          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <h1 className="mr-1 min-w-0 max-w-full truncate text-2xl font-bold" style={{ color: "var(--tx-1)" }}>{member.name}</h1>
              {currentRank && (
                <StatusPill
                  icon={Award}
                  color={readableOn(currentRank.color)}
                  bg={hex(currentRank.color, 0.95)}
                  label={
                    <>
                      {currentRank.rankName}
                      {currentRank.stripes > 0 && (
                        <span className="ml-0.5 inline-flex gap-0.5">
                          {Array.from({ length: currentRank.stripes }).map((_, i) => (
                            <span key={i} className="h-1.5 w-1.5 rounded-full bg-current opacity-75" />
                          ))}
                        </span>
                      )}
                    </>
                  }
                />
              )}
              {member.membershipType && (
                <StatusPill icon={Shield} color="#2563eb" bg="rgba(37,99,235,0.10)" label={member.membershipType} />
              )}
              <StatusPill icon={Activity} color={currentStatus.color} bg={currentStatus.bg} label={currentStatus.label} />
              <StatusPill icon={PaymentIcon} color={payment.color} bg={payment.bg} label={`Payment ${payment.label}`} />
              {member.waiverAccepted ? (
                <StatusPill icon={FileCheck2} color="#15803d" bg="rgba(21,128,61,0.10)" label="Waiver signed" />
              ) : (
                <button type="button" onClick={openWaiverPage} className="rounded-full transition-opacity hover:opacity-80">
                  <StatusPill icon={FileCheck2} color="#b45309" bg="rgba(180,83,9,0.12)" label="Waiver missing" />
                </button>
              )}
              {!member.phone && (
                <StatusPill icon={Phone} color="#b45309" bg="rgba(180,83,9,0.12)" label="No phone" />
              )}
            </div>

            <p className="mt-2 text-sm" style={{ color: "var(--tx-3)" }}>
              Member since {new Date(member.joinedAt).toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
              {hasAttention && <span className="ml-2" style={{ color: "#b45309" }}>· Action needed</span>}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">
          {canRecordPayment && (
            <MarkPaidDrawer
              memberId={member.id}
              memberName={member.name}
              primaryColor={primaryColor}
            />
          )}
          {canEdit && !editing && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Edit2 className="size-4" />
              Edit
            </Button>
          )}
          <div className="relative" ref={actionsMenuRef}>
            <Button
              variant="secondary"
              onClick={() => setShowActionsMenu((v) => !v)}
              className="size-9 px-0"
              aria-label="More actions"
              aria-expanded={showActionsMenu}
            >
              <MoreHorizontal className="size-4" />
            </Button>
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
                  className="w-full text-left px-4 py-2 text-sm hover:bg-sf-2 hover:text-tx-1 transition-colors"
                  style={{ color: "var(--tx-2)" }}
                >
                  Mark as inactive
                </button>
                {canShareWaiver && (
                  <button
                    onClick={() => {
                      setShowActionsMenu(false);
                      openWaiverShare();
                    }}
                    disabled={member.waiverAccepted || waiverShareLoading}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-sf-2 hover:text-tx-1 transition-colors disabled:cursor-not-allowed"
                    style={{ color: member.waiverAccepted ? "var(--tx-4)" : "var(--tx-2)" }}
                  >
                    {waiverShareLoading ? "Generating…" : "Share waiver link"}
                  </button>
                )}
                {role === "owner" && (
                  <a
                    href={`/dashboard/members/${member.id}/dsar`}
                    onClick={() => setShowActionsMenu(false)}
                    className="w-full text-left block px-4 py-2 text-sm hover:bg-sf-2 hover:text-tx-1 transition-colors"
                    style={{ color: "var(--tx-2)" }}
                  >
                    Data &amp; privacy (DSAR)
                  </a>
                )}
                {member.accountType !== "kids" && (
                  <button
                    onClick={async () => {
                      setShowActionsMenu(false);
                      const res = await fetch(`/api/members/bulk-invite`, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ memberIds: [member.id] }),
                      });
                      const data = await res.json().catch(() => ({}));
                      if (res.ok && data.invited > 0) {
                        toast("Login invite sent — valid for 7 days", "success");
                      } else if (res.ok) {
                        toast(data.message ?? "Member already has login access (or no email on file)", "error");
                      } else {
                        toast(data.error ?? "Could not send invite", "error");
                      }
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-sf-2 hover:text-tx-1 transition-colors"
                    style={{ color: "var(--tx-2)" }}
                  >
                    Send login invite
                  </button>
                )}
                {!member.waiverAccepted && ["owner", "manager", "admin", "coach"].includes(role) && (
                  <a
                    href={`/dashboard/members/${member.id}/waiver`}
                    onClick={() => setShowActionsMenu(false)}
                    className="w-full text-left block px-4 py-2 text-sm hover:bg-sf-2 hover:text-tx-1 transition-colors"
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
                      className="w-full px-4 py-2 text-left text-sm transition-colors hover:bg-sf-2"
                      style={{ color: "var(--hue-danger)" }}
                    >
                      Remove member…
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ── Stats row ── */}
      {/*
        Was TWO five-tile rows (an "attention strip" stacked on a stats row),
        which ate ~200px of vertical space before the tabs and repeated what
        the header already said. The attention items — waiver and payment
        status — are now chips beside the name, leaving one honest row of
        counts. Five wide at `lg:` matches the Members list so the two
        accounts surfaces share a rhythm (§4a.2).
      */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {[
          { label: "Total visits", value: member.attendances.length, sub: "All-time check-ins", Icon: Activity },
          { label: "This month", value: thisMonthCount, sub: "Current month", Icon: CalendarCheck },
          { label: "This week", value: thisWeekCount, sub: "Current week", Icon: Clock },
          {
            label: "Last visit",
            value: lastAttendance ? (lastVisitDays === 0 ? "Today" : `${lastVisitDays}d ago`) : "Never",
            sub: lastAttendance ? fmtDate(lastAttendance.checkInTime) : "No check-ins yet",
            Icon: CalendarCheck,
          },
          { label: "Subscriptions", value: member.subscriptions.length, sub: "Class follows", Icon: Dumbbell },
        ].map(({ label, value, sub, Icon }) => (
          <Card key={label} padding="tight">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xl font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>{value}</p>
                <p className="mt-1 truncate text-[13px] font-medium" style={{ color: "var(--tx-2)" }}>{label}</p>
                <p className="mt-0.5 truncate text-[11px]" style={{ color: "var(--tx-4)" }}>{sub}</p>
              </div>
              <Icon className="size-4 shrink-0" style={{ color: hex(primaryColor, 0.7) }} />
            </div>
          </Card>
        ))}
      </div>

      {/* ── Tabs ── */}
      {/*
        Sticky rail (§4a.7): `sticky top-0` resolves against the dashboard
        layout's scrolling <main>, so tab context survives a long attendance
        or payments list. The horizontal scroller is released at `lg:` where
        all six tabs fit — tabs must never depend on a hidden scrollbar at
        desktop widths.
      */}
      <div
        className="sticky top-0 z-20 mb-5 flex overflow-x-auto border-b border-bd-default bg-[var(--sf-bg)] scrollbar-hide lg:overflow-x-visible"
        role="tablist"
        aria-label="Member sections"
      >
        <Tab label="Overview" active={tab === "overview"} onClick={() => setTab("overview")} />
        <Tab label="Attendance" active={tab === "attendance"} onClick={() => setTab("attendance")} count={member.attendances.length} />
        <Tab label="Payments" active={tab === "payments"} onClick={() => setTab("payments")} count={payments.length} />
        <Tab label="Ranks" active={tab === "ranks"} onClick={() => setTab("ranks")} count={member.ranks.length} />
        <Tab label="Internal Notes" active={tab === "notes"} onClick={() => setTab("notes")} />
        <Tab label="Photos" active={tab === "photos"} onClick={() => setTab("photos")} />
      </div>

      {/* ── Overview ── */}
      {/*
        The read view no longer sits inside an outer white panel. Two white
        Cards nested in a third white Card is the white-in-white the audit
        called out; the Cards now sit directly on `--sf-bg` so their hairline
        borders actually read (§5).
      */}
      {tab === "overview" && (
        editing ? (
          <Card>
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
                <Button onClick={saveProfile} loading={saving}>
                  {!saving && <Check className="size-4" />}
                  {saving ? "Saving…" : "Save"}
                </Button>
                <Button variant="secondary" onClick={() => { setEditing(false); setForm({ name: member.name, email: member.email, phone: member.phone ?? "", emergencyContactName: member.emergencyContactName ?? "", emergencyContactPhone: member.emergencyContactPhone ?? "", emergencyContactRelation: member.emergencyContactRelation ?? "", membershipType: member.membershipType ?? "", status: member.status, dateOfBirth: member.dateOfBirth ? member.dateOfBirth.slice(0, 10) : "" }); }}>
                  <X className="size-4" /> Cancel
                </Button>
              </div>
            </div>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* §4a.2: the split is STRUCTURAL, so it fires at `lg:` (1024) —
                gated at `xl:` it never opened on a 1366px laptop. The flexible
                track carries minmax(0,…) as the blowout guard. */}
            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                <Card>
                  <div className="flex items-center justify-between gap-3 mb-5">
                    <div>
                      <h2 className="font-semibold" style={{ color: "var(--tx-1)" }}>Contact and Safety</h2>
                      <p className="text-xs mt-1" style={{ color: "var(--tx-4)" }}>Core member details, emergency information, and training notes.</p>
                    </div>
                    {!member.phone && (
                      <StatusPill label="Phone missing" color="#b45309" bg="rgba(180,83,9,0.12)" />
                    )}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <InfoRow icon={User} label="Name" value={member.name} />
                    <InfoRow icon={Mail} label="Email" value={member.email} />
                    <InfoRow icon={Phone} label="Phone" value={member.phone ?? "Not provided"} muted={!member.phone} />
                    <InfoRow icon={Shield} label="Membership" value={member.membershipType ?? "Not set"} muted={!member.membershipType} />
                    <InfoRow icon={Calendar} label="Joined" value={new Date(member.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} />
                    <InfoRow icon={Activity} label="Status" value={currentStatus.label} />
                    {member.dateOfBirth && (
                      <InfoRow icon={Calendar} label="Date of Birth" value={new Date(member.dateOfBirth).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })} />
                    )}
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
                </Card>

                <div className="space-y-4">
                  <Card>
                    <h3 className="text-sm font-semibold mb-4" style={{ color: "var(--tx-1)" }}>Membership and Billing</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs" style={{ color: "var(--tx-4)" }}>Plan</span>
                        <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{member.membershipType ?? "Not set"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs" style={{ color: "var(--tx-4)" }}>Payment</span>
                        <StatusPill icon={PaymentIcon} color={payment.color} bg={payment.bg} label={payment.label} />
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs" style={{ color: "var(--tx-4)" }}>Subscriptions</span>
                        <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>{member.subscriptions.length}</span>
                      </div>
                    </div>
                    {role === "owner" && (
                      // §5a: content-width, not stretched edge to edge. The
                      // full-width treatment belongs to the mobile bottom-sheet
                      // footer, which the Sheet primitive owns.
                      <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--bd-default)" }}>
                        <Button variant="secondary" onClick={() => setShowChargeDrawer(true)}>
                          <CreditCard className="size-4" />
                          Ad-hoc charge
                        </Button>
                      </div>
                    )}
                  </Card>

                  <Card
                    padding="card"
                    className={!member.waiverAccepted ? "cursor-pointer transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" : undefined}
                    onClick={!member.waiverAccepted ? openWaiverPage : undefined}
                    role={!member.waiverAccepted ? "button" : undefined}
                    tabIndex={!member.waiverAccepted ? 0 : undefined}
                    onKeyDown={!member.waiverAccepted ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openWaiverPage(); } } : undefined}
                    aria-label={!member.waiverAccepted ? "Open waiver collection page for this member" : undefined}
                    style={{ background: member.waiverAccepted ? "rgba(21,128,61,0.05)" : "rgba(180,83,9,0.06)", borderColor: member.waiverAccepted ? "rgba(21,128,61,0.20)" : "rgba(180,83,9,0.24)" }}
                  >
                    <h3 className="text-sm font-semibold mb-3" style={{ color: "var(--tx-1)" }}>Waiver and Compliance</h3>
                    <div className="flex flex-col gap-3">
                      <div className="flex items-start gap-3">
                        <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0" style={{ background: member.waiverAccepted ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.15)", color: member.waiverAccepted ? "#22c55e" : "#f59e0b" }}>
                          <FileCheck2 className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate" style={{ color: member.waiverAccepted ? "#22c55e" : "#f59e0b" }}>
                            {member.waiverAccepted ? "Waiver signed" : "Liability waiver missing"}
                          </p>
                          <p className="text-xs mt-1" style={{ color: "var(--tx-4)" }}>
                            {member.waiverAcceptedAt ? fmtDate(member.waiverAcceptedAt) : "This member should complete the waiver before training."}
                          </p>
                        </div>
                      </div>
                      {!member.waiverAccepted && (
                        <div className="flex flex-wrap gap-2">
                          {canShareWaiver && (
                            <Button
                              variant="secondary"
                              size="compact"
                              onClick={(e) => { e.stopPropagation(); openWaiverShare(); }}
                              loading={waiverShareLoading}
                            >
                              {!waiverShareLoading && <Link2 className="size-3.5" />}
                              {waiverShareLoading ? "Generating…" : "Share waiver link"}
                            </Button>
                          )}
                          {["owner", "manager", "admin", "coach"].includes(role) && (
                            <a
                              href={`/dashboard/members/${member.id}/waiver`}
                              onClick={(e) => e.stopPropagation()}
                              className="ui-fixed-size inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--r-md)] border border-bd-default bg-sf-2 px-3 text-[13px] font-medium text-tx-1 transition-colors hover:border-bd-hover"
                            >
                              <FileCheck2 className="size-3.5" />
                              Open waiver on this device
                            </a>
                          )}
                        </div>
                      )}
                    </div>
                  </Card>

                  <Card>
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
                  </Card>
                </div>
            </div>
          </div>
        )
      )}

      {/* ── Attendance ── */}
      {tab === "attendance" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="rounded-[var(--r-md)] border overflow-hidden" style={{ borderColor: "var(--bd-default)" }}>
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
                        <tr key={a.id} className="border-b transition-colors hover:bg-sf-2" style={{ borderColor: i === member.attendances.length - 1 ? "transparent" : "var(--bd-default)" }}>
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
          {/* The action used to float alone on its own right-aligned row above
              the grid, which read as an orphaned button. It now anchors a
              proper tab-level header, matching the Payments tab. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold" style={{ color: "var(--tx-1)" }}>Ranks</p>
              <p className="mt-0.5 text-xs" style={{ color: "var(--tx-3)" }}>Current grade in each discipline this member trains.</p>
            </div>
            {canPromote && (
              <Button onClick={() => setShowRankDrawer(true)}>
                <Award className="size-4" />
                Assign / Promote
              </Button>
            )}
          </div>
          {member.ranks.length === 0 ? (
            <Card padding="none">
              <EmptyState
                title="No ranks assigned"
                hint={canPromote ? "Use Assign / Promote to record this member's first grade." : undefined}
                icon={<Award className="size-8" aria-hidden="true" />}
              />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {member.ranks.map((r) => (
                <Card key={r.id} padding="tight" className="flex items-center gap-4">
                  <BeltGraphic color={r.color} stripes={r.stripes} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium" style={{ color: "var(--tx-1)" }}>{r.rankName}</p>
                    <p className="text-xs" style={{ color: "var(--tx-3)" }}>{r.discipline} · {r.stripes} stripe{r.stripes !== 1 ? "s" : ""}</p>
                    <p className="mt-0.5 text-[11px]" style={{ color: "var(--tx-4)" }}>Since {new Date(r.achievedAt).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</p>
                  </div>
                </Card>
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
            {canRecordPayment && (
              <Button onClick={() => setPaymentDrawer(true)}>
                <Plus className="size-4" />
                Record
              </Button>
            )}
          </div>

          {/* ── Transactions (DataTable — §1.5.4 dense spec) ── */}
          <div>
            <div className="mb-3 flex items-center gap-2">
              <Receipt className="size-4" style={{ color: "var(--tx-3)" }} />
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--tx-3)" }}>Transactions</p>
              <span className="ml-auto text-xs" style={{ color: "var(--tx-3)" }}>{payments.length} records</span>
            </div>
            <Card padding="none" className="overflow-hidden">
              <DataTable
                label="Payments for this member"
                rows={payments}
                rowKey={(p) => p.id}
                columns={paymentColumns}
                empty={
                  <EmptyState
                    title="No payments recorded yet"
                    hint="Manual and card payments both land here."
                    icon={<CreditCard className="size-8" aria-hidden="true" />}
                  />
                }
                renderCard={(p) => (
                  <Card padding="tight">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium" style={{ color: "var(--tx-1)" }}>{p.description ?? "Payment"}</p>
                        <p className="mt-0.5 text-xs" style={{ color: "var(--tx-3)" }}>{p.paidAt ? fmtDate(p.paidAt) : "—"}</p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <p className="text-sm font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>
                          {p.currency === "GBP" ? "£" : p.currency}{(p.amountPence / 100).toFixed(2)}
                        </p>
                        <PaymentStatusBadge status={p.status} />
                      </div>
                    </div>
                  </Card>
                )}
              />
              {payments.length > 0 && (
                <div className="flex items-center justify-between border-t px-3 py-2.5" style={{ background: "var(--sf-2)", borderColor: "var(--bd-default)" }}>
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
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ── Internal Notes ── */}
      {/* §4a.1: long-form text gets a `max-w-3xl` reading column nested INSIDE
          the layout container and left-aligned to the grid — never centred
          against it, and never its own `mx-auto` wrapper. */}
      {tab === "notes" && (
        <Card className="max-w-3xl space-y-4">
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
            rows={6}
            placeholder="Add internal notes about this member…"
            disabled={!canEdit}
            className="w-full resize-none rounded-[var(--r-md)] px-4 py-3 text-sm outline-none transition-all placeholder:text-[var(--tx-3)]"
            style={{
              background: "var(--sf-1)",
              border: "1px solid var(--bd-default)",
              color: "var(--tx-1)",
              lineHeight: 1.7,
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
          />
          {canEdit && (
            <Button
              onClick={saveNotes}
              loading={notesSaving}
              disabled={notesDraft === (member.notes ?? "")}
            >
              {!notesSaving && <Save className="size-4" />}
              {notesSaving ? "Saving…" : "Save notes"}
            </Button>
          )}
        </Card>
      )}

      {/* ── Photos ── */}
      {tab === "photos" && (<PhotosTabPanel memberId={member.id} />)}

      {/* ── Rank drawer (Sheet — multi-field form, §4a.3) ── */}
      {/* The hand-rolled overlay this replaces had no focus trap, no Escape,
          no scroll lock and a blurred scrim; the Sheet primitive brings all
          four. Behaviour and handlers are unchanged — this is a shell swap. */}
      <Sheet
        open={showRankDrawer}
        onClose={() => setShowRankDrawer(false)}
        title="Assign / Promote Rank"
        description={member.name}
        footer={
          <Button onClick={assignRank} loading={promotingSaving} disabled={!rankForm.rankSystemId}>
            {promotingSaving ? "Saving…" : "Confirm promotion"}
          </Button>
        }
      >
        <div className="space-y-4">
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
                {/* Two columns from `sm:` — the Sheet is 480px wide, so a
                    single column wasted half of it and pushed the confirm
                    action off-screen on long belt systems. */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {disciplineRanks.map((r) => (
                    <button key={r.id} onClick={() => setRankForm((f) => ({ ...f, rankSystemId: r.id }))} className={`flex items-center gap-3 rounded-[var(--r-md)] border p-3 text-left transition-colors ${rankForm.rankSystemId === r.id ? "border-bd-active bg-sf-2" : "border-bd-default hover:border-bd-hover"}`}>
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
                    <button key={n} onClick={() => setRankForm((f) => ({ ...f, stripes: n }))} className={`size-9 rounded-[var(--r-sm)] border text-sm font-medium transition-colors ${rankForm.stripes === n ? "border-bd-active bg-sf-2" : "border-bd-default hover:border-bd-hover"}`} style={{ color: rankForm.stripes === n ? "var(--tx-1)" : "var(--tx-3)" }}>{n}</button>
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
                <img src={toBlobProxyUrl(rankForm.photoUrl) ?? rankForm.photoUrl} alt="Preview" className="mt-2 w-20 h-20 rounded-lg object-cover" />
              )}
            </div>

            <div>
              <label className="text-xs mb-1.5 block" style={{ color: "var(--tx-3)" }}>Notes (optional)</label>
              <textarea
                value={rankForm.notes}
                onChange={(e) => setRankForm((f) => ({ ...f, notes: e.target.value }))}
                rows={2}
                placeholder="e.g. Competition win, grading night…"
                className="w-full rounded-[var(--r-md)] px-3 py-2 text-sm focus:outline-none resize-none"
                style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)", color: "var(--tx-1)" }}
                onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
              />
            </div>
        </div>
      </Sheet>

      {/* ── Add payment drawer (Sheet — §4a.3) ── */}
      <Sheet
        open={paymentDrawer}
        onClose={() => setPaymentDrawer(false)}
        title="Record payment"
        description={member.name}
        footer={
          <Button
            onClick={addPayment}
            disabled={!payForm.description.trim() || !payForm.amount}
          >
            Record payment
          </Button>
        }
      >
        <div className="space-y-4">
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
        </div>
      </Sheet>

      {/* F5 — three-strategy deletion gateway modal */}
      <RemoveMemberModal
        memberId={member.id}
        memberName={member.name}
        open={showRemoveModal}
        onClose={() => setShowRemoveModal(false)}
        primaryColor={primaryColor}
      />

      {/* Ad-hoc charge drawer — owner only */}
      <AdhocChargeDrawer
        memberId={member.id}
        memberName={member.name}
        open={showChargeDrawer}
        onClose={() => setShowChargeDrawer(false)}
        primaryColor={primaryColor}
      />

      {/* Waiver share modal (Dialog — short, non-scrolling content, §4a.3) */}
      <Dialog
        open={waiverShare !== null}
        onClose={() => setWaiverShare(null)}
        title="Share waiver link"
        description={`No login needed — ${member.name} opens this and signs. Link expires in 24 hours.`}
        footer={
          waiverShare && (
            <>
              <a
                href={waiverShare.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-[var(--r-md)] border border-bd-default bg-sf-2 px-4 text-sm font-medium text-tx-1 transition-colors hover:border-bd-hover"
              >
                <FileCheck2 className="size-4" /> Open
              </a>
              <Button
                onClick={async () => {
                  try { await navigator.clipboard.writeText(waiverShare.url); toast("Link copied", "success"); }
                  catch { toast("Could not copy", "error"); }
                }}
              >
                <Link2 className="size-4" /> Copy link
              </Button>
            </>
          )
        }
      >
        {waiverShare && (
          <div className="space-y-4">
            {waiverShare.qr && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={waiverShare.qr} alt="Waiver link QR code" width={200} height={200} className="rounded-[var(--r-md)] border" style={{ borderColor: "var(--bd-default)" }} />
              </div>
            )}
            <code
              className="block break-all rounded-[var(--r-sm)] px-2 py-2 font-mono text-[11px]"
              style={{ background: "var(--sf-2)", color: "var(--tx-2)" }}
            >
              {waiverShare.url}
            </code>
          </div>
        )}
      </Dialog>
    </>
  );
}

// ─── Photos tab (US-5 staff-side viewer) ─────────────────────────────────────

type MemberPhotoRow = { id: string; url: string; caption: string | null; kind: string; uploadedAt: string };

function PhotosTabPanel({ memberId }: { memberId: string }) {
  const { toast } = useToast();
  const [photos, setPhotos] = useState<MemberPhotoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch(`/api/members/${memberId}/photos`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => { if (Array.isArray(data)) setPhotos(data); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [memberId]);

  async function handleUpload(file: File) {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("targetMemberId", memberId);
      const up = await fetch("/api/upload?purpose=member-photo", { method: "POST", body: fd });
      if (!up.ok) {
        const j = (await up.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Upload failed");
      }
      const { url } = (await up.json()) as { url: string };
      const res = await fetch(`/api/members/${memberId}/photos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Could not save photo");
      }
      const created = (await res.json()) as MemberPhotoRow;
      setPhotos((prev) => [created, ...prev]);
      toast("Photo added", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Upload failed", "error");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(id: string) {
    setDeleting(id);
    try {
      const res = await fetch(`/api/members/${memberId}/photos?photoId=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error || "Could not remove photo");
      }
      setPhotos((prev) => prev.filter((p) => p.id !== id));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not remove photo", "error");
    } finally {
      setDeleting(null);
    }
  }

  return (
    <div className="p-2 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs" style={{ color: "var(--tx-3)" }}>
          Images stored on this member&apos;s account.
        </p>
        <Button size="compact" onClick={() => inputRef.current?.click()} loading={uploading}>
          {!uploading && <Camera className="size-3.5" />}
          {uploading ? "Uploading…" : "Add photo"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void handleUpload(file);
          }}
        />
      </div>

      {loading ? (
        <p className="text-sm py-8 text-center" style={{ color: "var(--tx-3)" }}>Loading photos…</p>
      ) : photos.length === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: "var(--tx-3)" }}>
          No photos yet — use &ldquo;Add photo&rdquo; to store an image on this account.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {photos.map((p) => (
            <div key={p.id} className="relative group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={toBlobProxyUrl(p.url) ?? p.url} alt={p.caption ?? "Photo"} className="aspect-square object-cover rounded-md w-full" />
              {p.kind !== "profile" && (
                <button
                  type="button"
                  onClick={() => handleDelete(p.id)}
                  disabled={deleting === p.id}
                  aria-label="Remove photo"
                  className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity disabled:opacity-50"
                  style={{ background: "rgba(15,16,20,0.78)" }}
                >
                  {deleting === p.id ? <Loader2 className="w-3 h-3 animate-spin text-white" /> : <Trash2 className="w-3 h-3 text-white" />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
