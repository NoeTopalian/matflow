"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  FileCheck2,
  Loader2,
  Plus,
  Search,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  membershipType?: string | null;
  status: string;
  paymentStatus?: string | null;
  waiverAccepted?: boolean;
  accountType?: string | null;
  dateOfBirth?: string | null;
  parentMemberId?: string | null;
  hasKidsHint?: boolean;
  joinedAt: string; // ISO string
  lastVisitAt?: string | null;
  rank?: {
    name: string;
    color?: string | null;
    discipline: string;
    stripes?: number;
  } | null;
}

function isBirthdayToday(dob?: string | null): boolean {
  if (!dob) return false;
  const d = new Date(dob);
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function calcAge(dob?: string | null): number | null {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age;
}

const ACCOUNT_BADGE: Record<string, { bg: string; color: string }> = {
  adult:  { bg: "rgba(255,255,255,0.07)", color: "rgba(255,255,255,0.4)" },
  junior: { bg: "rgba(59,130,246,0.15)",  color: "#3b82f6" },
  kids:   { bg: "rgba(245,158,11,0.15)",  color: "#f59e0b" },
};

interface Props {
  members: MemberRow[];
  primaryColor: string;
  role: string;
}

// ─── Belt colour map ──────────────────────────────────────────────────────────

const BELT: Record<string, { bg: string; text: string }> = {
  white:  { bg: "#ffffff", text: "#111111" },
  blue:   { bg: "#3b82f6", text: "#ffffff" },
  purple: { bg: "#8b5cf6", text: "#ffffff" },
  brown:  { bg: "#92400e", text: "#ffffff" },
  black:  { bg: "#111111", text: "#ffffff" },
  red:    { bg: "#ef4444", text: "#ffffff" },
  coral:  { bg: "#fb923c", text: "#ffffff" },
};

function beltStyle(color?: string | null) {
  if (!color) return { bg: "rgba(0,0,0,0.08)", text: "rgba(0,0,0,0.50)" };
  const k = color.toLowerCase();
  return BELT[k] ?? { bg: color, text: "#ffffff" };
}

function initials(name: string) {
  return name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase();
}

function hex(hex: string, alpha: number) {
  if (!hex.startsWith("#")) return `rgba(0,0,0,${alpha})`;
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

function formatShortDate(iso?: string | null) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function daysSince(iso?: string | null) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function paymentMeta(status?: string | null) {
  const s = (status ?? "paid").toLowerCase();
  if (s === "paid") return { label: "Paid", color: "#22c55e", bg: "rgba(34,197,94,0.12)", Icon: CheckCircle2 };
  if (s === "overdue") return { label: "Overdue", color: "#f97316", bg: "rgba(249,115,22,0.14)", Icon: AlertTriangle };
  if (s === "pending") return { label: "Pending", color: "#38bdf8", bg: "rgba(56,189,248,0.13)", Icon: CreditCard };
  if (s === "paused") return { label: "Paused", color: "#a78bfa", bg: "rgba(167,139,250,0.13)", Icon: CreditCard };
  if (s === "free") return { label: "Free", color: "#94a3b8", bg: "rgba(148,163,184,0.12)", Icon: CreditCard };
  if (s === "cancelled") return { label: "Cancelled", color: "#ef4444", bg: "rgba(239,68,68,0.13)", Icon: AlertTriangle };
  return { label: s.charAt(0).toUpperCase() + s.slice(1), color: "#94a3b8", bg: "rgba(148,163,184,0.12)", Icon: CreditCard };
}

// ─── Main component ───────────────────────────────────────────────────────────

type SortOption = "name-asc" | "name-desc" | "joined-newest" | "joined-oldest" | "last-visit";
type StatusFilter = "all" | "attention" | "overdue" | "waiver-missing" | "missing-phone" | "quiet" | "active" | "inactive" | "cancelled" | "taster" | "kids";

const QUIET_THRESHOLD_DAYS = 14;
const FILTERS: StatusFilter[] = ["all", "attention", "overdue", "waiver-missing", "missing-phone", "quiet", "active", "inactive", "cancelled", "taster", "kids"];

function isQuiet(m: { paymentStatus?: string | null; status: string; lastVisitAt?: string | null }) {
  // "Quiet" = paying active member who hasn't checked in for {QUIET_THRESHOLD_DAYS} days.
  // Tasters and unpaid members are excluded — they belong in the Attention/Overdue bucket.
  if (m.status !== "active") return false;
  if ((m.paymentStatus ?? "paid") !== "paid") return false;
  const days = daysSince(m.lastVisitAt);
  return days === null || days >= QUIET_THRESHOLD_DAYS;
}

export default function MembersList({ members: initial, primaryColor, role }: Props) {
  const searchParams = useSearchParams();
  const requestedFilter = searchParams.get("filter");
  const urlFilter = FILTERS.includes(requestedFilter as StatusFilter) ? requestedFilter as StatusFilter : "all";
  const [members, setMembers] = useState<MemberRow[]>(initial);
  const [query, setQuery] = useState("");
  const [localStatusFilter, setLocalStatusFilter] = useState<StatusFilter | null>(null);
  const [membershipFilter, setMembershipFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortOption>("name-asc");
  const [showFilters, setShowFilters] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const autoRef = useRef<HTMLElement>(null);
  const router = useRouter();

  const canAdd = ["owner", "manager", "admin"].includes(role);
  const statusFilter = localStatusFilter ?? urlFilter;

  // Unique membership types from the list
  const membershipTypes = useMemo(() => {
    const types = Array.from(new Set(members.map((m) => m.membershipType).filter(Boolean))) as string[];
    return types.sort();
  }, [members]);

  const filtered = useMemo(() => {
    let list = members;
    if (statusFilter === "attention") {
      list = list.filter((m) => m.paymentStatus === "overdue" || m.waiverAccepted === false || m.status === "taster" || isQuiet(m));
    } else if (statusFilter === "overdue") {
      list = list.filter((m) => m.paymentStatus === "overdue");
    } else if (statusFilter === "waiver-missing") {
      list = list.filter((m) => m.waiverAccepted === false);
    } else if (statusFilter === "missing-phone") {
      list = list.filter((m) => !m.phone?.trim());
    } else if (statusFilter === "quiet") {
      list = list.filter((m) => isQuiet(m));
    } else if (statusFilter === "kids") {
      // Source of truth: parentMemberId IS NOT NULL (the link, not accountType,
      // since accountType could be junior/kids and not always reflect linkage).
      list = list.filter((m) => !!m.parentMemberId);
    } else if (statusFilter !== "all") {
      list = list.filter((m) => m.status === statusFilter);
    }
    if (membershipFilter !== "all") list = list.filter((m) => m.membershipType === membershipFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q) ||
          m.phone?.includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      switch (sortBy) {
        case "name-asc":      return a.name.localeCompare(b.name);
        case "name-desc":     return b.name.localeCompare(a.name);
        case "joined-newest": return new Date(b.joinedAt).getTime() - new Date(a.joinedAt).getTime();
        case "joined-oldest": return new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime();
        case "last-visit":    return new Date(b.lastVisitAt ?? 0).getTime() - new Date(a.lastVisitAt ?? 0).getTime();
        default:              return 0;
      }
    });
    return list;
  }, [members, query, statusFilter, membershipFilter, sortBy]);

  // Auto-select: scroll single match into view
  useEffect(() => {
    if (filtered.length === 1 && query.trim()) {
      autoRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [filtered.length, query]);

  function handleAdded(member: MemberRow) {
    setMembers((prev) => [...prev, member].sort((a, b) => a.name.localeCompare(b.name)));
    setShowAdd(false);
  }

  const quietMembers = members.filter(isQuiet);
  const counts: Record<string, number> = {
    all:       members.length,
    attention: members.filter((m) => m.paymentStatus === "overdue" || m.waiverAccepted === false || m.status === "taster" || isQuiet(m)).length,
    overdue: members.filter((m) => m.paymentStatus === "overdue").length,
    waiverMissing: members.filter((m) => m.waiverAccepted === false).length,
    missingPhone: members.filter((m) => !m.phone?.trim()).length,
    quiet: quietMembers.length,
    paid: members.filter((m) => (m.paymentStatus ?? "paid") === "paid").length,
    active:    members.filter((m) => m.status === "active").length,
    inactive:  members.filter((m) => m.status === "inactive").length,
    cancelled: members.filter((m) => m.status === "cancelled").length,
    taster:    members.filter((m) => m.status === "taster").length,
    kids:      members.filter((m) => !!m.parentMemberId).length,
  };

  const activeFilterCount = (statusFilter !== "all" ? 1 : 0) + (membershipFilter !== "all" ? 1 : 0) + (sortBy !== "name-asc" ? 1 : 0);

  return (
    <div className="w-full max-w-7xl mx-auto">
      <div className="flex flex-col gap-4 mb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] mb-1" style={{ color: "var(--tx-4)" }}>
            Member Management
          </p>
          <h1 className="text-white text-2xl font-bold tracking-tight">Member Operations</h1>
          <p className="text-sm mt-1" style={{ color: "var(--tx-3)" }}>
            {members.length} members · {counts.attention} need attention
          </p>
        </div>
        {canAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:opacity-90 shrink-0"
            style={{ background: primaryColor, boxShadow: `0 14px 30px ${hex(primaryColor, 0.22)}` }}
            aria-label="Add member"
          >
            <Plus className="w-4 h-4" />
            Add Member
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-5">
        {[
          { label: "Total Members", value: counts.all, sub: "In this club", color: primaryColor, Icon: Users },
          { label: "Paid", value: counts.paid, sub: "Membership current", color: "#22c55e", Icon: CheckCircle2 },
          { label: "Overdue", value: counts.overdue, sub: "Needs chasing", color: "#f97316", Icon: AlertTriangle },
          { label: "Waivers Missing", value: counts.waiverMissing, sub: "Paperwork risk", color: "#f59e0b", Icon: FileCheck2 },
          { label: "Tasters", value: counts.taster, sub: "Convert soon", color: "#38bdf8", Icon: CalendarCheck },
        ].map(({ label, value, sub, color, Icon }) => (
          <div
            key={label}
            className="rounded-2xl border p-4"
            style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}
          >
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

      <div
        className="rounded-2xl border p-3 mb-4"
        style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
            <input
              type="search"
              placeholder="Search name, email, or phone"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 rounded-xl text-white text-sm placeholder-gray-600 outline-none transition-colors"
              style={{ background: "rgba(0,0,0,0.20)", border: "1px solid var(--bd-default)" }}
              aria-label="Search members"
            />
            {filtered.length === 1 && query.trim() && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold px-2 py-1 rounded-full pointer-events-none" style={{ background: hex(primaryColor, 0.18), color: primaryColor }}>
                1 match
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1 xl:pb-0">
            {([
              { key: "all", label: "All", count: counts.all },
              { key: "attention", label: "Needs Attention", count: counts.attention },
              { key: "overdue", label: "Overdue", count: counts.overdue },
              { key: "waiver-missing", label: "Waiver Missing", count: counts.waiverMissing },
              { key: "missing-phone", label: "Missing Phone", count: counts.missingPhone },
              { key: "quiet", label: `Quiet (${QUIET_THRESHOLD_DAYS}d+)`, count: counts.quiet },
              { key: "taster", label: "Tasters", count: counts.taster },
              { key: "kids", label: "Kids", count: counts.kids },
            ] as { key: StatusFilter; label: string; count: number }[])
              .filter((item) => item.key === "all" || item.count > 0)
              .map((item) => (
                <button
                  key={item.key}
                  onClick={() => setLocalStatusFilter(item.key)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold transition-all whitespace-nowrap shrink-0 border"
                  style={{
                    background: statusFilter === item.key ? hex(primaryColor, 0.16) : "rgba(255,255,255,0.03)",
                    color: statusFilter === item.key ? primaryColor : "var(--tx-3)",
                    borderColor: statusFilter === item.key ? hex(primaryColor, 0.36) : "var(--bd-default)",
                  }}
                >
                  {item.label} · {item.count}
                </button>
              ))}
          </div>

          <button
            onClick={() => setShowFilters((v) => !v)}
            className="relative px-3 py-2.5 rounded-xl border text-xs font-semibold transition-all flex items-center justify-center gap-2 shrink-0"
            style={{
              background: showFilters || activeFilterCount > 0 ? hex(primaryColor, 0.1) : "rgba(255,255,255,0.03)",
              borderColor: showFilters || activeFilterCount > 0 ? hex(primaryColor, 0.3) : "var(--bd-default)",
              color: showFilters || activeFilterCount > 0 ? primaryColor : "var(--tx-3)",
            }}
            aria-label="Filters"
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center text-white" style={{ background: primaryColor }}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Filter panel ── */}
      {showFilters && (
        <div className="mb-4 p-4 rounded-2xl border space-y-4" style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.08)" }}>
          {/* Sort */}
          <div>
            <p className="text-gray-500 text-xs font-medium mb-2">Sort by</p>
            <div className="flex flex-wrap gap-1.5">
              {([
                { val: "name-asc",      label: "Name A–Z" },
                { val: "name-desc",     label: "Name Z–A" },
                { val: "joined-newest", label: "Newest first" },
                { val: "joined-oldest", label: "Oldest first" },
                { val: "last-visit", label: "Last visit" },
              ] as { val: SortOption; label: string }[]).map(({ val, label }) => (
                <button key={val} onClick={() => setSortBy(val)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{ background: sortBy === val ? hex(primaryColor, 0.15) : "rgba(0,0,0,0.03)", color: sortBy === val ? primaryColor : "rgba(0,0,0,0.50)", border: `1px solid ${sortBy === val ? hex(primaryColor, 0.3) : "transparent"}` }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Membership type */}
          {membershipTypes.length > 0 && (
            <div>
              <p className="text-gray-500 text-xs font-medium mb-2">Membership</p>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setMembershipFilter("all")}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{ background: membershipFilter === "all" ? hex(primaryColor, 0.15) : "rgba(0,0,0,0.03)", color: membershipFilter === "all" ? primaryColor : "rgba(0,0,0,0.50)", border: `1px solid ${membershipFilter === "all" ? hex(primaryColor, 0.3) : "transparent"}` }}>
                  All
                </button>
                {membershipTypes.map((t) => (
                  <button key={t} onClick={() => setMembershipFilter(t)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{ background: membershipFilter === t ? hex(primaryColor, 0.15) : "rgba(0,0,0,0.03)", color: membershipFilter === t ? primaryColor : "rgba(0,0,0,0.50)", border: `1px solid ${membershipFilter === t ? hex(primaryColor, 0.3) : "transparent"}` }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Reset */}
          {activeFilterCount > 0 && (
            <button onClick={() => { setLocalStatusFilter("all"); setMembershipFilter("all"); setSortBy("name-asc"); }} className="text-xs text-red-400 hover:text-red-300 transition-colors">
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {filtered.length === 0 && (
        <div
          className="rounded-2xl border py-16 text-center"
          style={{ borderColor: "rgba(0,0,0,0.04)", background: "rgba(255,255,255,0.015)" }}
        >
          {members.length === 0 ? (
            <>
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
                style={{ background: "rgba(0,0,0,0.04)" }}
              >
                <Users className="w-6 h-6 text-gray-600" />
              </div>
              <p className="text-white font-medium text-sm mb-1">No members yet</p>
              <p className="text-gray-600 text-xs mb-4">Add your first member to get started</p>
              {canAdd && (
                <button
                  onClick={() => setShowAdd(true)}
                  className="text-xs font-semibold px-4 py-2 rounded-lg text-white"
                  style={{ background: primaryColor }}
                >
                  + Add Member
                </button>
              )}
            </>
          ) : (
            <p className="text-gray-600 text-sm">No members match &ldquo;{query}&rdquo;</p>
          )}
        </div>
      )}

      {/* ── Mobile: cards ── */}
      {filtered.length > 0 && (
        <div className="md:hidden space-y-2">
          {filtered.map((m, idx) => {
            const isAuto = filtered.length === 1 && query.trim();
            const belt = beltStyle(m.rank?.color);
            const pay = paymentMeta(m.paymentStatus);
            const PayIcon = pay.Icon;
            return (
              <article
                key={m.id}
                ref={isAuto && idx === 0 ? (autoRef as React.RefObject<HTMLElement>) : undefined}
                className="rounded-2xl border p-4 flex items-center gap-3 transition-all active:scale-[0.99] cursor-pointer"
                style={{
                  background: isAuto ? hex(primaryColor, 0.06) : "rgba(0,0,0,0.02)",
                  borderColor: isAuto ? hex(primaryColor, 0.4) : "rgba(0,0,0,0.08)",
                }}
                onClick={() => router.push(`/dashboard/members/${m.id}`)}
                aria-label={`View ${m.name}`}
              >
                {/* Avatar */}
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                  style={{ background: hex(primaryColor, 0.18), color: primaryColor }}
                >
                  {initials(m.name)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-white font-semibold text-sm">
                      {m.name}
                      {isBirthdayToday(m.dateOfBirth) && <span className="ml-1" title="Birthday today!">🎂</span>}
                    </span>
                    {m.rank && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border"
                        style={{ background: belt.bg, color: belt.text, borderColor: m.rank.color?.toLowerCase() === "white" ? "rgba(0,0,0,0.16)" : "transparent" }}
                      >
                        {m.rank.name}
                        {!!m.rank.stripes && Array.from({ length: m.rank.stripes }).map((_, i) => (
                          <span key={i} className="w-1 h-1 rounded-full bg-current opacity-70" />
                        ))}
                      </span>
                    )}
                    <span
                      className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                      style={{ background: pay.bg, color: pay.color }}
                    >
                      <PayIcon className="w-3 h-3" />
                      {pay.label}
                    </span>
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        m.waiverAccepted
                          ? "bg-emerald-500/10 text-emerald-400"
                          : "bg-amber-500/15 text-amber-300"
                      }`}
                    >
                      {m.waiverAccepted ? "Waiver signed" : "Waiver missing"}
                    </span>
                    {m.accountType && m.accountType !== "adult" && (() => {
                      const ab = ACCOUNT_BADGE[m.accountType!] ?? ACCOUNT_BADGE.adult;
                      return (
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize" style={{ background: ab.bg, color: ab.color }}>
                          {m.accountType}
                        </span>
                      );
                    })()}
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5 truncate">{m.email}</p>
                  {m.membershipType && (
                    <p className="text-gray-600 text-xs">{m.membershipType} · Last visit {formatShortDate(m.lastVisitAt)}</p>
                  )}
                </div>

                <ChevronRight className="w-4 h-4 text-gray-700 shrink-0" />
              </article>
            );
          })}
        </div>
      )}

      {/* Redesigned desktop table */}
      {filtered.length > 0 && (
        <div
          className="hidden md:block rounded-2xl border overflow-hidden"
          style={{ background: "rgba(255,255,255,0.018)", borderColor: "var(--bd-default)" }}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b" style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}>
                {["Member", "Membership", "Payment", "Waiver", "Rank", "Last Visit", "Joined", ""].map((h) => (
                  <th key={h} className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--tx-4)" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((m, idx) => {
                const isAuto = filtered.length === 1 && query.trim();
                const belt = beltStyle(m.rank?.color);
                const pay = paymentMeta(m.paymentStatus);
                const PayIcon = pay.Icon;
                const inactiveDays = daysSince(m.lastVisitAt);
                return (
                  <tr
                    key={m.id}
                    ref={isAuto && idx === 0 ? (autoRef as React.RefObject<HTMLTableRowElement>) : undefined}
                    className="border-b transition-colors cursor-pointer"
                    style={{ borderColor: "var(--bd-default)", background: isAuto ? hex(primaryColor, 0.05) : undefined }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = isAuto ? hex(primaryColor, 0.08) : "rgba(255,255,255,0.025)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = isAuto ? hex(primaryColor, 0.05) : "transparent")}
                    onClick={() => router.push(`/dashboard/members/${m.id}`)}
                  >
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-9 h-9 rounded-xl flex items-center justify-center text-xs font-bold shrink-0"
                          style={{ background: hex(primaryColor, 0.18), color: primaryColor }}
                        >
                          {initials(m.name)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate" style={{ color: "var(--tx-1)" }}>
                            {m.name}
                            {isBirthdayToday(m.dateOfBirth) && <span className="ml-1" title="Birthday today!">🎂</span>}
                          </p>
                          <p className="text-xs truncate" style={{ color: "var(--tx-4)" }}>{m.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm" style={{ color: "var(--tx-2)" }}>{m.membershipType ?? "No membership"}</span>
                        <div className="flex items-center gap-1.5">
                          {m.accountType && m.accountType !== "adult" && (() => {
                            const ab = ACCOUNT_BADGE[m.accountType!] ?? ACCOUNT_BADGE.adult;
                            return (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize" style={{ background: ab.bg, color: ab.color }}>
                                {m.accountType}
                              </span>
                            );
                          })()}
                          {m.dateOfBirth && (
                            <span className="text-[11px]" style={{ color: "var(--tx-4)" }}>{calcAge(m.dateOfBirth)} yrs</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full" style={{ background: pay.bg, color: pay.color }}>
                        <PayIcon className="w-3 h-3" />
                        {pay.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full ${
                          m.waiverAccepted ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/15 text-amber-300"
                        }`}
                      >
                        <FileCheck2 className="w-3 h-3" />
                        {m.waiverAccepted ? "Signed" : "Missing"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {m.rank ? (
                        <span
                          className="inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full border"
                          style={{
                            background: belt.bg,
                            color: belt.text,
                            borderColor: m.rank.color?.toLowerCase() === "white" ? "rgba(0,0,0,0.18)" : "transparent",
                            boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.20)",
                          }}
                        >
                          {m.rank.name}
                          {!!m.rank.stripes && Array.from({ length: m.rank.stripes }).map((_, i) => (
                            <span key={i} className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
                          ))}
                        </span>
                      ) : (
                        <span className="text-xs" style={{ color: "var(--tx-4)" }}>No rank</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-xs" style={{ color: m.lastVisitAt ? "var(--tx-2)" : "var(--tx-4)" }}>
                          {formatShortDate(m.lastVisitAt)}
                        </span>
                        {inactiveDays !== null && inactiveDays >= 14 && (
                          <span className="text-[10px] text-amber-300">{inactiveDays}d ago</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs" style={{ color: "var(--tx-4)" }}>{formatShortDate(m.joinedAt)}</span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronRight className="w-4 h-4 inline" style={{ color: "var(--tx-4)" }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Desktop: table ── */}
      {filtered.length > 0 && (
        <div
          className="hidden"
          style={{ borderColor: "rgba(0,0,0,0.08)" }}
        >
          <table className="w-full">
            <thead>
              <tr
                className="border-b"
                style={{ background: "rgba(0,0,0,0.02)", borderColor: "rgba(0,0,0,0.04)" }}
              >
                {["Member", "Rank", "Membership", "Status", "Joined", ""].map((h) => (
                  <th
                    key={h}
                    className="text-left px-4 py-3 text-gray-500 text-xs font-semibold uppercase tracking-wider"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((m, idx) => {
                const isAuto = filtered.length === 1 && query.trim();
                const belt = beltStyle(m.rank?.color);
                return (
                  <tr
                    key={m.id}
                    ref={isAuto && idx === 0 ? (autoRef as React.RefObject<HTMLTableRowElement>) : undefined}
                    className="border-b hover:bg-black/2 transition-colors cursor-pointer"
                    style={{
                      borderColor: "rgba(0,0,0,0.03)",
                      background: isAuto ? hex(primaryColor, 0.05) : undefined,
                    }}
                    onClick={() => router.push(`/dashboard/members/${m.id}`)}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                          style={{ background: hex(primaryColor, 0.18), color: primaryColor }}
                        >
                          {initials(m.name)}
                        </div>
                        <div>
                          <p className="text-white text-sm font-medium">
                            {m.name}
                            {isBirthdayToday(m.dateOfBirth) && <span className="ml-1" title="Birthday today!">🎂</span>}
                          </p>
                          <p className="text-gray-500 text-xs">{m.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {m.rank ? (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded-full"
                          style={{ background: belt.bg, color: belt.text }}
                        >
                          {m.rank.name}
                          {!!m.rank.stripes && Array.from({ length: m.rank.stripes }).map((_, i) => (
                            <span key={i} className="w-1 h-1 rounded-full bg-current opacity-70" />
                          ))}
                        </span>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-gray-400 text-sm">{m.membershipType ?? "—"}</span>
                        <div className="flex items-center gap-1.5">
                          {m.accountType && m.accountType !== "adult" && (() => {
                            const ab = ACCOUNT_BADGE[m.accountType!] ?? ACCOUNT_BADGE.adult;
                            return (
                              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full capitalize" style={{ background: ab.bg, color: ab.color }}>
                                {m.accountType}
                              </span>
                            );
                          })()}
                          {m.dateOfBirth && (
                            <span className="text-gray-600 text-[11px]">{calcAge(m.dateOfBirth)} yrs</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-[11px] font-semibold px-2 py-1 rounded-full ${
                          m.status === "active"
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-black/4 text-gray-500"
                        }`}
                      >
                        {m.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-gray-500 text-xs">
                        {new Date(m.joinedAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        })}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <ChevronRight className="w-4 h-4 text-gray-700 inline" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Add Member modal ── */}
      {showAdd && (
        <AddMemberModal
          primaryColor={primaryColor}
          onClose={() => setShowAdd(false)}
          onAdded={handleAdded}
        />
      )}
    </div>
  );
}

// ─── Add Member Modal ─────────────────────────────────────────────────────────

const MEMBERSHIP_TYPES = [
  "Monthly Unlimited",
  "Monthly 2x/week",
  "Monthly 3x/week",
  "Drop-in",
  "Annual",
  "Student",
  "Family",
];

function AddMemberModal({
  primaryColor,
  onClose,
  onAdded,
}: {
  primaryColor: string;
  onClose: () => void;
  onAdded: (member: MemberRow) => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    membershipType: "",
    dateOfBirth: "",
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim()) return;
    setLoading(true);
    try {
      const res = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim().toLowerCase(),
          phone: form.phone.trim() || undefined,
          membershipType: form.membershipType || undefined,
          ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data.error ?? "Failed to add member", "error");
      } else {
        toast(`${form.name} added`, "success");
        onAdded({
          ...data,
          joinedAt: data.joinedAt ?? new Date().toISOString(),
          paymentStatus: data.paymentStatus ?? "paid",
          waiverAccepted: data.waiverAccepted ?? false,
          lastVisitAt: null,
          rank: null,
        });
      }
    } catch {
      toast("Network error", "error");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full px-3 py-2.5 rounded-xl text-white text-sm placeholder-gray-600 outline-none transition-colors";
  const inputStyle = {
    background: "rgba(0,0,0,0.08)",
    border: "1px solid rgba(255,255,255,0.1)",
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 z-40 md:flex md:items-center md:justify-center"
        onClick={onClose}
      />

      {/* Sheet — slides up on mobile, centered card on desktop */}
      <div
        className="fixed bottom-0 left-0 right-0 z-50 md:bottom-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 md:w-full md:max-w-md"
        style={{
          background: "var(--sf-0)",
          borderTop: "1px solid rgba(0,0,0,0.10)",
          borderRadius: "20px 20px 0 0",
        }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 md:hidden">
          <div className="w-10 h-1 rounded-full bg-black/10" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-black/8">
          <h2 className="text-white font-semibold text-base">Add Member</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white transition-colors"
            style={{ background: "rgba(0,0,0,0.08)" }}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={submit} className="px-5 py-5 space-y-3">
          {/* Name */}
          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">
              Full Name <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              placeholder="e.g. John Smith"
              value={form.name}
              onChange={set("name")}
              required
              className={inputCls}
              style={inputStyle}
              autoFocus
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-gray-400 text-xs font-medium mb-1.5">
              Email <span className="text-red-400">*</span>
            </label>
            <input
              type="email"
              placeholder="john@example.com"
              value={form.email}
              onChange={set("email")}
              required
              className={inputCls}
              style={inputStyle}
            />
          </div>

          {/* Phone + Membership (side by side on wider screens) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-gray-400 text-xs font-medium mb-1.5">Phone</label>
              <input
                type="tel"
                placeholder="+44 7700 000000"
                value={form.phone}
                onChange={set("phone")}
                className={inputCls}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="block text-gray-400 text-xs font-medium mb-1.5">Membership</label>
              <select
                value={form.membershipType}
                onChange={set("membershipType")}
                className={inputCls}
                style={{ ...inputStyle, appearance: "none" }}
              >
                <option value="">Select…</option>
                {MEMBERSHIP_TYPES.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-gray-400 text-xs font-medium mb-1.5">Date of Birth</label>
              <input
                type="date"
                value={form.dateOfBirth}
                onChange={set("dateOfBirth")}
                className={inputCls}
                style={inputStyle}
              />
            </div>
          </div>

          {/* Submit */}
          <button
            type="submit"
            disabled={loading || !form.name.trim() || !form.email.trim()}
            className="w-full py-3 rounded-xl text-white font-semibold text-sm transition-all hover:opacity-90 disabled:opacity-40 flex items-center justify-center gap-2 mt-1"
            style={{ background: primaryColor }}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Adding…
              </>
            ) : (
              "Add Member"
            )}
          </button>
        </form>

        {/* Safe area bottom */}
        <div className="pb-safe" />
      </div>
    </>
  );
}
