"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, Plus, Users, ChevronRight, X, Loader2, SlidersHorizontal } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemberRow {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  membershipType?: string | null;
  status: string;
  joinedAt: string; // ISO string
  rank?: {
    name: string;
    color?: string | null;
    discipline: string;
    stripes?: number;
  } | null;
}

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
  if (!color) return { bg: "rgba(255,255,255,0.07)", text: "rgba(255,255,255,0.45)" };
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

// ─── Main component ───────────────────────────────────────────────────────────

type SortOption = "name-asc" | "name-desc" | "joined-newest" | "joined-oldest";
type StatusFilter = "all" | "active" | "inactive" | "cancelled" | "taster";

export default function MembersList({ members: initial, primaryColor, role }: Props) {
  const [members, setMembers] = useState<MemberRow[]>(initial);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [membershipFilter, setMembershipFilter] = useState<string>("all");
  const [sortBy, setSortBy] = useState<SortOption>("name-asc");
  const [showFilters, setShowFilters] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const autoRef = useRef<HTMLElement>(null);
  const router = useRouter();

  const canAdd = ["owner", "manager", "admin"].includes(role);

  // Unique membership types from the list
  const membershipTypes = useMemo(() => {
    const types = Array.from(new Set(members.map((m) => m.membershipType).filter(Boolean))) as string[];
    return types.sort();
  }, [members]);

  const filtered = useMemo(() => {
    let list = members;
    if (statusFilter !== "all") list = list.filter((m) => m.status === statusFilter);
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

  const counts: Record<string, number> = {
    all:       members.length,
    active:    members.filter((m) => m.status === "active").length,
    inactive:  members.filter((m) => m.status === "inactive").length,
    cancelled: members.filter((m) => m.status === "cancelled").length,
    taster:    members.filter((m) => m.status === "taster").length,
  };

  const activeFilterCount = (statusFilter !== "all" ? 1 : 0) + (membershipFilter !== "all" ? 1 : 0) + (sortBy !== "name-asc" ? 1 : 0);

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-white text-xl font-bold tracking-tight">Members</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {members.length} {members.length === 1 ? "member" : "members"}
          </p>
        </div>
        {canAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white transition-all hover:opacity-90"
            style={{ background: primaryColor }}
            aria-label="Add member"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Member
          </button>
        )}
      </div>

      {/* ── Search + filter button ── */}
      <div className="flex gap-2 mb-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
          <input
            type="search"
            placeholder="Search name, email, phone…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 rounded-xl text-white text-sm placeholder-gray-600 outline-none transition-colors"
            style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)" }}
            onFocus={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.2)")}
            onBlur={(e) => (e.currentTarget.style.borderColor = "rgba(255,255,255,0.08)")}
            aria-label="Search members"
          />
          {filtered.length === 1 && query.trim() && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold px-1.5 py-0.5 rounded-full pointer-events-none" style={{ background: hex(primaryColor, 0.2), color: primaryColor }}>
              1 match
            </span>
          )}
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="relative px-3 py-2.5 rounded-xl border text-sm font-medium transition-all flex items-center gap-1.5"
          style={{
            background: showFilters || activeFilterCount > 0 ? hex(primaryColor, 0.1) : "rgba(255,255,255,0.04)",
            borderColor: showFilters || activeFilterCount > 0 ? hex(primaryColor, 0.3) : "rgba(255,255,255,0.08)",
            color: showFilters || activeFilterCount > 0 ? primaryColor : "rgba(255,255,255,0.5)",
          }}
          aria-label="Filters"
        >
          <SlidersHorizontal className="w-4 h-4" />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center text-white" style={{ background: primaryColor }}>
              {activeFilterCount}
            </span>
          )}
        </button>
      </div>

      {/* ── Filter panel ── */}
      {showFilters && (
        <div className="mb-4 p-4 rounded-2xl border space-y-4" style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.07)" }}>
          {/* Sort */}
          <div>
            <p className="text-gray-500 text-xs font-medium mb-2">Sort by</p>
            <div className="flex flex-wrap gap-1.5">
              {([
                { val: "name-asc",      label: "Name A–Z" },
                { val: "name-desc",     label: "Name Z–A" },
                { val: "joined-newest", label: "Newest first" },
                { val: "joined-oldest", label: "Oldest first" },
              ] as { val: SortOption; label: string }[]).map(({ val, label }) => (
                <button key={val} onClick={() => setSortBy(val)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{ background: sortBy === val ? hex(primaryColor, 0.15) : "rgba(255,255,255,0.04)", color: sortBy === val ? primaryColor : "rgba(255,255,255,0.45)", border: `1px solid ${sortBy === val ? hex(primaryColor, 0.3) : "transparent"}` }}>
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
                  style={{ background: membershipFilter === "all" ? hex(primaryColor, 0.15) : "rgba(255,255,255,0.04)", color: membershipFilter === "all" ? primaryColor : "rgba(255,255,255,0.45)", border: `1px solid ${membershipFilter === "all" ? hex(primaryColor, 0.3) : "transparent"}` }}>
                  All
                </button>
                {membershipTypes.map((t) => (
                  <button key={t} onClick={() => setMembershipFilter(t)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{ background: membershipFilter === t ? hex(primaryColor, 0.15) : "rgba(255,255,255,0.04)", color: membershipFilter === t ? primaryColor : "rgba(255,255,255,0.45)", border: `1px solid ${membershipFilter === t ? hex(primaryColor, 0.3) : "transparent"}` }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Reset */}
          {activeFilterCount > 0 && (
            <button onClick={() => { setStatusFilter("all"); setMembershipFilter("all"); setSortBy("name-asc"); }} className="text-xs text-red-400 hover:text-red-300 transition-colors">
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* ── Status tabs ── */}
      <div className="flex gap-1.5 mb-5 overflow-x-auto scrollbar-hide pb-1">
        {(["all", "active", "inactive", "taster", "cancelled"] as const).filter((s) => s === "all" || counts[s] > 0).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all capitalize whitespace-nowrap shrink-0"
            style={{
              background: statusFilter === s ? hex(primaryColor, 0.15) : "rgba(255,255,255,0.04)",
              color: statusFilter === s ? primaryColor : "rgba(255,255,255,0.4)",
              border: `1px solid ${statusFilter === s ? hex(primaryColor, 0.3) : "transparent"}`,
            }}
          >
            {s === "all" ? `All · ${counts.all}` : `${s.charAt(0).toUpperCase() + s.slice(1)} · ${counts[s]}`}
          </button>
        ))}
      </div>

      {/* ── Empty state ── */}
      {filtered.length === 0 && (
        <div
          className="rounded-2xl border py-16 text-center"
          style={{ borderColor: "rgba(255,255,255,0.05)", background: "rgba(255,255,255,0.015)" }}
        >
          {members.length === 0 ? (
            <>
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
                style={{ background: "rgba(255,255,255,0.05)" }}
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
            return (
              <article
                key={m.id}
                ref={isAuto && idx === 0 ? (autoRef as React.RefObject<HTMLElement>) : undefined}
                className="rounded-2xl border p-4 flex items-center gap-3 transition-all active:scale-[0.99] cursor-pointer"
                style={{
                  background: isAuto ? hex(primaryColor, 0.06) : "rgba(255,255,255,0.02)",
                  borderColor: isAuto ? hex(primaryColor, 0.4) : "rgba(255,255,255,0.06)",
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
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-white font-semibold text-sm">{m.name}</span>
                    {m.rank && (
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: belt.bg, color: belt.text }}
                      >
                        {m.rank.name}
                        {!!m.rank.stripes && Array.from({ length: m.rank.stripes }).map((_, i) => (
                          <span key={i} className="w-1 h-1 rounded-full bg-current opacity-70" />
                        ))}
                      </span>
                    )}
                    <span
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                        m.status === "active"
                          ? "bg-emerald-500/15 text-emerald-400"
                          : "bg-white/5 text-gray-500"
                      }`}
                    >
                      {m.status}
                    </span>
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5 truncate">{m.email}</p>
                  {m.membershipType && (
                    <p className="text-gray-600 text-xs">{m.membershipType}</p>
                  )}
                </div>

                <ChevronRight className="w-4 h-4 text-gray-700 shrink-0" />
              </article>
            );
          })}
        </div>
      )}

      {/* ── Desktop: table ── */}
      {filtered.length > 0 && (
        <div
          className="hidden md:block rounded-2xl border overflow-hidden"
          style={{ borderColor: "rgba(255,255,255,0.06)" }}
        >
          <table className="w-full">
            <thead>
              <tr
                className="border-b"
                style={{ background: "rgba(255,255,255,0.02)", borderColor: "rgba(255,255,255,0.05)" }}
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
                    className="border-b hover:bg-white/2 transition-colors cursor-pointer"
                    style={{
                      borderColor: "rgba(255,255,255,0.04)",
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
                          <p className="text-white text-sm font-medium">{m.name}</p>
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
                      <span className="text-gray-400 text-sm">{m.membershipType ?? "—"}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-[11px] font-semibold px-2 py-1 rounded-full ${
                          m.status === "active"
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-white/5 text-gray-500"
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
    background: "rgba(255,255,255,0.06)",
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
          background: "#0e1013",
          borderTop: "1px solid rgba(255,255,255,0.08)",
          borderRadius: "20px 20px 0 0",
        }}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 md:hidden">
          <div className="w-10 h-1 rounded-full bg-white/15" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <h2 className="text-white font-semibold text-base">Add Member</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white transition-colors"
            style={{ background: "rgba(255,255,255,0.07)" }}
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
