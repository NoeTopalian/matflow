"use client";

import { useState, useMemo, useRef, useEffect, useId, useCallback } from "react";
import { describeSaveFailure } from "@/lib/save-failure";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  FileCheck2,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { ErrorState } from "@/components/ui/ErrorState";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatTierPrice } from "@/lib/membership-tier-format";
import GuardianReviewQueue from "@/components/dashboard/GuardianReviewQueue";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";
import AttributionFields, { emptyAttribution, type AttributionValue } from "@/components/dashboard/AttributionFields";
import { resolveSignupCredit } from "@/lib/signup-credit";
import { BilledByTeamUpPill } from "@/components/dashboard/BilledByTeamUpPill";
import { paymentStatusLabel } from "@/lib/payment-status";

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
  // Only set when status === "cancelled" (Member.cancelledAt). Drives the
  // "churned-this-month" drill-through filter below.
  cancelledAt?: string | null;
  /** "teamup" while TeamUp collects this member's money (readiness spec v3 §7). */
  billedBy?: string | null;
  billingStatusAsOf?: string | null;
  lastVisitAt?: string | null;
  // feat/member-profile-pictures Track A: Avatar renders this when set,
  // falls back to deterministic initials when null. Flattened from
  // MemberPhoto kind='profile' by GET /api/members (see route flatten step).
  profilePictureUrl?: string | null;
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

// §4a.5: the adult fallback was white-alpha on white — an invisible chip.
// Tokens instead, so it reads on the light staff shell.
const ACCOUNT_BADGE: Record<string, { bg: string; color: string }> = {
  adult:  { bg: "var(--sf-2)",            color: "var(--tx-3)" },
  junior: { bg: "rgba(37,99,235,0.12)",   color: "#2563eb" },
  kids:   { bg: "rgba(180,83,9,0.12)",    color: "#b45309" },
};

/** Waiver chip colours — readable on the light shell, unlike emerald-400/amber-300. */
const WAIVER_CHIP = {
  signed:  { bg: "rgba(21,128,61,0.10)", color: "#15803d" },
  missing: { bg: "rgba(180,83,9,0.12)",  color: "#b45309" },
};

interface Props {
  members: MemberRow[];
  primaryColor: string;
  role: string;
  /**
   * Guardian links an import suggested and nobody has confirmed, counted on
   * the server across the whole club. Owner/manager only (null for other
   * roles): they are the roles that may confirm.
   */
  guardianReviewCount?: number | null;
  /** Set when the page loaded only the first N members (SSR cap). */
  truncatedAt?: number | null;
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

// feat/member-profile-pictures Track A Phase A1: canonical helper lives in
// lib/initials.ts. The Avatar component handles initials + picture rendering.

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
  if (s === "pending") return { label: paymentStatusLabel(s), color: "#38bdf8", bg: "rgba(56,189,248,0.13)", Icon: CreditCard };
  if (s === "paused") return { label: "Paused", color: "#a78bfa", bg: "rgba(167,139,250,0.13)", Icon: CreditCard };
  if (s === "free") return { label: "Free", color: "#94a3b8", bg: "rgba(148,163,184,0.12)", Icon: CreditCard };
  if (s === "cancelled") return { label: "Cancelled", color: "#ef4444", bg: "rgba(239,68,68,0.13)", Icon: AlertTriangle };
  return { label: s.charAt(0).toUpperCase() + s.slice(1), color: "#94a3b8", bg: "rgba(148,163,184,0.12)", Icon: CreditCard };
}

// ─── Table columns ────────────────────────────────────────────────────────────

/**
 * The eight Members columns, rendered through the DataTable primitive at the
 * §1.5.4 dense spec (36px rows, py-2, 13px, sticky thead). Module scope keeps
 * the array identity stable so the table's sort memo survives re-renders.
 *
 * Member, Last Visit and Joined carry `sortValue`, so the header click-sorts
 * client-side — the three orderings people actually ask for. The Filters
 * panel's sort control still drives the underlying list order.
 */
const MEMBER_COLUMNS: DataTableColumn<MemberRow>[] = [
  {
    key: "member",
    header: "Member",
    sortValue: (m) => m.name,
    // ONE line (§4a.4): name over email was a stacked cell, and a stacked cell
    // defeats --row-h-dense outright — it is why this table measured 57px
    // against a 36px spec. The email now trails the name inline and the whole
    // cell carries it as a title, so nothing is lost.
    cell: (m) => (
      // A synthesised placeholder is not an address — showing it would be
      // fabricated data (UI-RULES §7) and a member of staff would try to mail it.
      <div className="flex min-w-0 items-center gap-3" title={isSynthesisedEmail(m.email) ? "No email address" : m.email}>
        {/* feat/member-profile-pictures Track A Phase A5: avatar slot. `sm`
            (28px) is the largest avatar a 36px row can hold with 4px cell
            padding; `md` (40px) forced the row to 48px on its own. */}
        <Avatar pictureUrl={m.profilePictureUrl ?? null} name={m.name} colorSeed={m.id} size="sm" />
        <p className="min-w-0 truncate">
          <span className="font-semibold" style={{ color: "var(--tx-1)" }}>
            {m.name}
          </span>
          {isBirthdayToday(m.dateOfBirth) && <span className="ml-1" title="Birthday today!">🎂</span>}
          <span className="ml-1.5 text-[11px]" style={{ color: "var(--tx-3)" }}>
            · {isSynthesisedEmail(m.email) ? "No email" : m.email}
          </span>
        </p>
        {/* D4: the member's standing when not plain active. */}
        <StatusTag m={m} />
      </div>
    ),
  },
  {
    key: "membership",
    header: "Membership",
    // One line: tier, then the junior/kids chip and the age inline.
    cell: (m) => (
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate" style={{ color: "var(--tx-2)" }}>{m.membershipType ?? "No membership"}</span>
        {m.accountType && m.accountType !== "adult" && (() => {
          const ab = ACCOUNT_BADGE[m.accountType!] ?? ACCOUNT_BADGE.adult;
          return (
            <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize" style={{ background: ab.bg, color: ab.color }}>
              {m.accountType}
            </span>
          );
        })()}
        {m.dateOfBirth && (
          <span className="shrink-0 text-[11px]" style={{ color: "var(--tx-3)" }}>· {calcAge(m.dateOfBirth)} yrs</span>
        )}
      </div>
    ),
  },
  {
    key: "payment",
    header: "Payment",
    width: "8rem",
    cell: (m) => {
      // Suppressed for no-membership rows (e.g. a parent tied to a kid who
      // holds the membership) — the default "paid" would mislead the owner.
      if (!m.membershipType) return <span className="text-[11px]" style={{ color: "var(--tx-3)" }}>—</span>;
      const pay = paymentMeta(m.paymentStatus);
      const PayIcon = pay.Icon;
      return (
        <span className="inline-flex flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: pay.bg, color: pay.color }}>
            <PayIcon className="size-3" />
            {pay.label}
          </span>
          <BilledByTeamUpPill member={m} />
        </span>
      );
    },
  },
  {
    key: "waiver",
    header: "Waiver",
    width: "7rem",
    cell: (m) => {
      const chip = m.waiverAccepted ? WAIVER_CHIP.signed : WAIVER_CHIP.missing;
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: chip.bg, color: chip.color }}>
          <FileCheck2 className="size-3" />
          {m.waiverAccepted ? "Signed" : "Missing"}
        </span>
      );
    },
  },
  {
    key: "rank",
    header: "Rank",
    // §5a: a fixed-geometry badge must never be resized by its text. 8rem left
    // "Blue Belt" + 3 stripe dots one or two pixels short, so the pill wrapped
    // to two lines and deepened the whole row. 9.5rem fits the longest belt
    // name plus four stripes at 11px bold with the cell's own px-3 removed.
    width: "9.5rem",
    cell: (m) => {
      if (!m.rank) return <span className="text-xs" style={{ color: "var(--tx-3)" }}>No rank</span>;
      const belt = beltStyle(m.rank.color);
      return (
        <span
          className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold"
          style={{
            background: belt.bg,
            color: belt.text,
            borderColor: m.rank.color?.toLowerCase() === "white" ? "rgba(0,0,0,0.18)" : "transparent",
          }}
        >
          {m.rank.name}
          {!!m.rank.stripes && Array.from({ length: m.rank.stripes }).map((_, i) => (
            <span key={i} className="size-1.5 shrink-0 rounded-full bg-current opacity-70" />
          ))}
        </span>
      );
    },
  },
  {
    key: "lastVisit",
    header: "Last Visit",
    width: "8rem",
    sortValue: (m) => (m.lastVisitAt ? new Date(m.lastVisitAt) : null),
    cell: (m) => {
      const inactiveDays = daysSince(m.lastVisitAt);
      return (
        // One line: date, then the inactivity hint inline behind a separator.
        <span className="whitespace-nowrap" style={{ color: m.lastVisitAt ? "var(--tx-2)" : "var(--tx-3)" }}>
          {formatShortDate(m.lastVisitAt)}
          {inactiveDays !== null && inactiveDays >= 14 && (
            // suppressHydrationWarning: daysSince() calls Date.now(), so SSR
            // and CSR can disagree by a day across a midnight boundary. The
            // drift is cosmetic (an inactivity hint, not an actionable value).
            <span suppressHydrationWarning className="ml-1 text-[11px]" style={{ color: "#b45309" }}>
              · {inactiveDays}d
            </span>
          )}
        </span>
      );
    },
  },
  {
    key: "joined",
    header: "Joined",
    width: "8rem",
    sortValue: (m) => new Date(m.joinedAt),
    cell: (m) => (
      <span className="whitespace-nowrap" style={{ color: "var(--tx-3)" }}>{formatShortDate(m.joinedAt)}</span>
    ),
  },
  {
    key: "go",
    header: "",
    headerLabel: "",
    align: "right",
    width: "3rem",
    cell: () => <ChevronRight className="inline size-4" style={{ color: "var(--tx-4)" }} aria-hidden="true" />,
  },
];

// ─── Main component ───────────────────────────────────────────────────────────

type SortOption = "name-asc" | "name-desc" | "joined-newest" | "joined-oldest" | "last-visit";
type StatusFilter = "all" | "attention" | "overdue" | "waiver-missing" | "missing-phone" | "quiet" | "active" | "inactive" | "cancelled" | "on-hold" | "taster" | "kids" | "new-this-month" | "churned-this-month" | "guardians" | "guardian-review";

const QUIET_THRESHOLD_DAYS = 14;
// "new-this-month" / "churned-this-month": deep-link-only filters (no visible
// chip, same pattern as "active"/"inactive"/"cancelled" below) — the Reports
// page's "New this month" / "Churn rate this month" tiles link here so the
// owner can see the actual members behind those two numbers (Track A drill-
// through). Month boundary is the browser's local calendar month, same
// server-local convention lib/reports.ts uses for its own month buckets.
const FILTERS: StatusFilter[] = ["all", "attention", "overdue", "waiver-missing", "missing-phone", "quiet", "active", "inactive", "cancelled", "on-hold", "taster", "kids", "new-this-month", "churned-this-month", "guardians", "guardian-review"];

function isThisCalendarMonth(iso?: string | null) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

/**
 * A parent/guardian account — including the no-login guardian records an
 * import makes from emergency contacts — holds an account for a child; it is
 * not a training member (3 Oct 2026). Same rule as TRAINING_MEMBER in
 * lib/member-population.ts, which Reports and the dashboard's waiver count
 * already use, so the Members page cannot disagree with them. Without it a
 * TeamUp import's ~219 guardian records (status "active", payment "paid", no
 * plan) inflated Current Members, Paid, Waivers Missing, Missing Phone and —
 * a fortnight later — Quiet. They stay findable: the "Parents & guardians"
 * chip lists them, and a search on All looks at everyone.
 */
export function isAccountHolderOnly(m: { accountType?: string | null }) {
  return m.accountType === "parent";
}

/**
 * "Waiver missing" = someone who can train (active or taster) with no signed
 * waiver. The dashboard's "Missing waivers" count links to this filter and
 * uses the same definition (app/dashboard/page.tsx); they used to disagree
 * (4 vs 5) because this side also counted inactive members.
 */
export function isWaiverMissing(m: { status: string; waiverAccepted?: boolean | null }) {
  return (m.status === "active" || m.status === "taster") && m.waiverAccepted === false;
}

export function isQuiet(m: { paymentStatus?: string | null; status: string; lastVisitAt?: string | null; joinedAt?: string | null }) {
  // "Quiet" = paying active member who hasn't checked in for {QUIET_THRESHOLD_DAYS} days.
  // Tasters and unpaid members are excluded — they belong in the Attention/Overdue bucket.
  if (m.status !== "active") return false;
  if ((m.paymentStatus ?? "paid") !== "paid") return false;
  const days = daysSince(m.lastVisitAt);
  if (days !== null) return days >= QUIET_THRESHOLD_DAYS;
  // Never visited. Verifier lane 3 D4: this used to be quiet regardless of
  // joining date, so a member who joined this morning was flagged as lapsed.
  // Someone who has not had 14 days to visit yet is new, not quiet.
  const sinceJoined = daysSince(m.joinedAt);
  return sinceJoined === null || sinceJoined >= QUIET_THRESHOLD_DAYS;
}

/**
 * The member's standing, when it is not plain active (D4) — the list used to
 * show a cancelled or on-hold member exactly like a current one. "On hold" is
 * a membership hold: paymentStatus "paused" on an otherwise active member.
 */
export function memberStatusLabel(m: { status: string; paymentStatus?: string | null }): string | null {
  if (m.status === "cancelled") return "Cancelled";
  if (m.status === "inactive") return "Inactive";
  if (m.status === "taster") return "Taster";
  if (m.paymentStatus === "paused") return "On hold";
  return null;
}

function StatusTag({ m }: { m: { status: string; paymentStatus?: string | null } }) {
  const label = memberStatusLabel(m);
  if (!label) return null;
  return (
    <span className="shrink-0 rounded-full border border-bd-default bg-sf-2 px-1.5 py-0.5 text-[10px] font-semibold text-tx-2">
      {label}
    </span>
  );
}

/**
 * Filters whose rows include cancelled members. Every other filter — and the
 * counts beside them — works on CURRENT members only (see `current` in the
 * component), so a cancelled member no longer inflates "All", "Total members",
 * "Waivers missing" or "Needs attention".
 */
const INCLUDES_CANCELLED: StatusFilter[] = ["cancelled", "churned-this-month", "new-this-month"];

export default function MembersList({ members: initial, primaryColor, role, guardianReviewCount = null, truncatedAt = null }: Props) {
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
  // Scroll target for the single-match case. It used to sit on the matched
  // ROW; with the DataTable owning row rendering it sits on the table wrapper
  // — equivalent, because the branch only fires when exactly one row is left.
  const autoRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const canAdd = ["owner", "manager", "admin"].includes(role);
  const canReviewGuardians = role === "owner" || role === "manager";
  const [reviewCount, setReviewCount] = useState<number | null>(canReviewGuardians ? guardianReviewCount : null);
  const statusFilter = localStatusFilter ?? urlFilter;

  // Unique membership types from the list
  const membershipTypes = useMemo(() => {
    const types = Array.from(new Set(members.map((m) => m.membershipType).filter(Boolean))) as string[];
    return types.sort();
  }, [members]);

  const filtered = useMemo(() => {
    // D4: cancelled members are not current. They appear under the Cancelled
    // (and the two Reports drill-through) filters, and under "All" only when
    // the desk is searching — a returning member is still findable by name,
    // with the Cancelled tag on the row.
    const searchingAll = statusFilter === "all" && query.trim() !== "";
    const includeCancelled = INCLUDES_CANCELLED.includes(statusFilter) || searchingAll;
    let list = includeCancelled ? members : members.filter((m) => m.status !== "cancelled");
    // Parent/guardian accounts are listed under their own chip and found by a
    // search on All; every other view is training members, matching its count.
    if (statusFilter === "guardians") list = list.filter(isAccountHolderOnly);
    else if (!searchingAll) list = list.filter((m) => !isAccountHolderOnly(m));
    if (statusFilter === "guardians" || statusFilter === "guardian-review") {
      // guardians: already narrowed above. guardian-review renders the queue
      // (GuardianReviewQueue), which loads its own rows from the server.
    } else if (statusFilter === "attention") {
      list = list.filter((m) => m.paymentStatus === "overdue" || isWaiverMissing(m) || m.status === "taster" || isQuiet(m));
    } else if (statusFilter === "overdue") {
      list = list.filter((m) => m.paymentStatus === "overdue");
    } else if (statusFilter === "waiver-missing") {
      list = list.filter(isWaiverMissing);
    } else if (statusFilter === "missing-phone") {
      list = list.filter((m) => !m.phone?.trim());
    } else if (statusFilter === "quiet") {
      list = list.filter((m) => isQuiet(m));
    } else if (statusFilter === "kids") {
      // Source of truth: parentMemberId IS NOT NULL (the link, not accountType,
      // since accountType could be junior/kids and not always reflect linkage).
      list = list.filter((m) => !!m.parentMemberId);
    } else if (statusFilter === "new-this-month") {
      list = list.filter((m) => isThisCalendarMonth(m.joinedAt));
    } else if (statusFilter === "churned-this-month") {
      list = list.filter((m) => m.status === "cancelled" && isThisCalendarMonth(m.cancelledAt));
    } else if (statusFilter === "on-hold") {
      list = list.filter((m) => m.paymentStatus === "paused");
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

  // F-5: the create route already returns a one-time invite link as the
  // fallback for when email does not deliver; until now it was never shown.
  const [inviteShare, setInviteShare] = useState<{ name: string; url: string } | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);
  function handleAdded(member: MemberRow, inviteUrl?: string | null) {
    setMembers((prev) => [...prev, member].sort((a, b) => a.name.localeCompare(b.name)));
    setShowAdd(false);
    if (inviteUrl) setInviteShare({ name: member.name, url: inviteUrl });
  }

  // D4 (verifier lane 3): every count below except `cancelled` is computed
  // over CURRENT members — `members` minus status "cancelled". They used to be
  // computed over every row, so "Total members" and "All" counted people who
  // had left the club as current, and a cancelled member's missing waiver
  // still asked for attention. The rows under each chip match its count.
  // Parent/guardian accounts are not training members either (see
  // isAccountHolderOnly) — counted only under their own chip.
  const current = members.filter((m) => m.status !== "cancelled" && !isAccountHolderOnly(m));
  const accountHolders = members.filter((m) => m.status !== "cancelled" && isAccountHolderOnly(m));
  const showGuardianQueue = statusFilter === "guardian-review" && canReviewGuardians;
  const quietMembers = current.filter(isQuiet);
  const counts: Record<string, number> = {
    all:       current.length,
    attention: current.filter((m) => m.paymentStatus === "overdue" || isWaiverMissing(m) || m.status === "taster" || isQuiet(m)).length,
    overdue: current.filter((m) => m.paymentStatus === "overdue").length,
    waiverMissing: current.filter(isWaiverMissing).length,
    missingPhone: current.filter((m) => !m.phone?.trim()).length,
    quiet: quietMembers.length,
    paid: current.filter((m) => (m.paymentStatus ?? "paid") === "paid").length,
    active:    current.filter((m) => m.status === "active").length,
    inactive:  current.filter((m) => m.status === "inactive").length,
    onHold:    current.filter((m) => m.paymentStatus === "paused").length,
    cancelled: members.filter((m) => m.status === "cancelled" && !isAccountHolderOnly(m)).length,
    guardians: accountHolders.length,
    guardianReview: reviewCount ?? 0,
    taster:    current.filter((m) => m.status === "taster").length,
    kids:      current.filter((m) => !!m.parentMemberId).length,
  };

  const activeFilterCount = (statusFilter !== "all" ? 1 : 0) + (membershipFilter !== "all" ? 1 : 0) + (sortBy !== "name-asc" ? 1 : 0);

  return (
    <div className="w-full">
      {/* §4: one PageHeader treatment, no per-page heading inventions. The
          eyebrow ("MEMBER MANAGEMENT") and the drop-shadow glow on the primary
          action are both gone — §1.5.3 allows no glow or gradients. */}
      <PageHeader
        title="Members"
        description={`${counts.all} current members · ${counts.attention} need attention`}
        action={
          canAdd || (reviewCount ?? 0) > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* Guardian links an import suggested: the count is the whole
                  club's (server-side), not the rows loaded on this page. */}
              {(reviewCount ?? 0) > 0 && (
                <Button
                  variant="secondary"
                  onClick={() => setLocalStatusFilter("guardian-review")}
                  aria-label={`${reviewCount} guardian suggestions to review`}
                >
                  <ShieldCheck className="size-4" />
                  {reviewCount} to review
                </Button>
              )}
              {canAdd && (
                <Button onClick={() => setShowAdd(true)}>
                  <Plus className="size-4" />
                  Add member
                </Button>
              )}
            </div>
          ) : undefined
        }
      />

      {truncatedAt !== null && (
        <p role="status" className="mb-4 rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-[13px] text-tx-2">
          This club has more than {truncatedAt.toLocaleString("en-GB")} members. This page shows the first{" "}
          {truncatedAt.toLocaleString("en-GB")} by name, so the counts and search below cover only those.
        </p>
      )}

      {/* 5 stat tiles. md:grid-cols-5 left the icons clipped on the right at
          770-1023px because each card was ~135px wide and the text column had
          no min-w-0 — long labels like "Membership current" pushed the
          right-anchored icon past the card border. Stepping to lg:grid-cols-5
          (5 wide only at 1024px+) and constraining the text column with
          min-w-0 + truncate fixes it across mobile, tablet, and desktop. */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-5">
        {[
          { label: "Current Members", value: counts.all, sub: "Excludes cancelled & guardians", color: primaryColor, Icon: Users },
          { label: "Paid", value: counts.paid, sub: "Membership current", color: "#22c55e", Icon: CheckCircle2 },
          { label: "Overdue", value: counts.overdue, sub: "Needs chasing", color: "#f97316", Icon: AlertTriangle },
          { label: "Waivers Missing", value: counts.waiverMissing, sub: "Active & tasters", color: "#f59e0b", Icon: FileCheck2 },
          { label: "Tasters", value: counts.taster, sub: "Convert soon", color: "#38bdf8", Icon: CalendarCheck },
        ].map(({ label, value, sub, color, Icon }) => (
          <Card key={label} padding="tight">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xl font-semibold tabular-nums" style={{ color: "var(--tx-1)" }}>{value}</p>
                <p className="mt-1 truncate text-[13px] font-medium" style={{ color: "var(--tx-2)" }}>{label}</p>
                <p className="mt-0.5 truncate text-[11px]" style={{ color: "var(--tx-3)" }}>{sub}</p>
              </div>
              <Icon className="size-4 shrink-0" style={{ color: hex(color, 0.75) }} />
            </div>
          </Card>
        ))}
      </div>

      <div
        className="rounded-2xl border p-3 mb-4"
        style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
      >
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 pointer-events-none" style={{ color: "var(--tx-3)" }} />
            <input
              type="search"
              placeholder="Search name, email, or phone"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-3 rounded-xl text-sm outline-none transition-colors placeholder:text-[var(--tx-3)]"
              style={{
                background: "var(--sf-2)",
                border: "1px solid var(--bd-default)",
                color: "var(--tx-1)",
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "var(--bd-active)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-default)"; }}
              aria-label="Search members"
            />
            {filtered.length === 1 && query.trim() && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold px-2 py-1 rounded-full pointer-events-none" style={{ background: hex(primaryColor, 0.18), color: primaryColor }}>
                1 match
              </span>
            )}
          </div>

          {/* Pills scroll horizontally on phones but WRAP from `lg:` — a
              hidden-scrollbar strip at desktop widths buries filters the user
              cannot see (§4a.7). */}
          <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide pb-1 lg:flex-wrap lg:overflow-x-visible lg:pb-0">
            {([
              { key: "all", label: "All", count: counts.all },
              { key: "attention", label: "Needs Attention", count: counts.attention },
              { key: "overdue", label: "Overdue", count: counts.overdue },
              { key: "waiver-missing", label: "Waiver Missing", count: counts.waiverMissing },
              { key: "missing-phone", label: "Missing Phone", count: counts.missingPhone },
              { key: "quiet", label: `Quiet (${QUIET_THRESHOLD_DAYS}d+)`, count: counts.quiet },
              { key: "taster", label: "Tasters", count: counts.taster },
              { key: "kids", label: "Kids", count: counts.kids },
              { key: "on-hold", label: "On hold", count: counts.onHold },
              { key: "inactive", label: "Inactive", count: counts.inactive },
              { key: "cancelled", label: "Cancelled", count: counts.cancelled },
              { key: "guardians", label: "Parents & guardians", count: counts.guardians },
              ...(canReviewGuardians ? [{ key: "guardian-review" as const, label: "Guardian suggestions to review", count: counts.guardianReview }] : []),
            ] as { key: StatusFilter; label: string; count: number }[])
              .filter((item) => item.key === "all" || item.key === statusFilter || item.count > 0)
              .map((item) => (
                <button
                  key={item.key}
                  onClick={() => setLocalStatusFilter(item.key)}
                  className="px-3 py-2 rounded-xl text-xs font-semibold transition-all whitespace-nowrap shrink-0 border"
                  style={{
                    background: statusFilter === item.key ? hex(primaryColor, 0.16) : "var(--sf-1)",
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
              background: showFilters || activeFilterCount > 0 ? hex(primaryColor, 0.1) : "var(--sf-1)",
              borderColor: showFilters || activeFilterCount > 0 ? hex(primaryColor, 0.3) : "var(--bd-default)",
              color: showFilters || activeFilterCount > 0 ? primaryColor : "var(--tx-3)",
            }}
            aria-label="Filters"
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters
            {activeFilterCount > 0 && (
              <span className="w-4 h-4 rounded-full text-[9px] font-bold flex items-center justify-center text-[var(--tx-on-accent)]" style={{ background: primaryColor }}>
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* ── Filter panel ── */}
      {showFilters && (
        <div className="mb-4 p-4 rounded-2xl border space-y-4" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
          {/* Sort */}
          <div>
            <p className="text-xs font-medium mb-2" style={{ color: "var(--tx-3)" }}>Sort by</p>
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
                  style={{
                    background: sortBy === val ? hex(primaryColor, 0.15) : "var(--sf-1)",
                    color: sortBy === val ? primaryColor : "var(--tx-3)",
                    border: `1px solid ${sortBy === val ? hex(primaryColor, 0.3) : "transparent"}`,
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Membership type */}
          {membershipTypes.length > 0 && (
            <div>
              <p className="text-xs font-medium mb-2" style={{ color: "var(--tx-3)" }}>Membership</p>
              <div className="flex flex-wrap gap-1.5">
                <button onClick={() => setMembershipFilter("all")}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{
                    background: membershipFilter === "all" ? hex(primaryColor, 0.15) : "var(--sf-1)",
                    color: membershipFilter === "all" ? primaryColor : "var(--tx-3)",
                    border: `1px solid ${membershipFilter === "all" ? hex(primaryColor, 0.3) : "transparent"}`,
                  }}>
                  All
                </button>
                {membershipTypes.map((t) => (
                  <button key={t} onClick={() => setMembershipFilter(t)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                    style={{
                      background: membershipFilter === t ? hex(primaryColor, 0.15) : "var(--sf-1)",
                      color: membershipFilter === t ? primaryColor : "var(--tx-3)",
                      border: `1px solid ${membershipFilter === t ? hex(primaryColor, 0.3) : "transparent"}`,
                    }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Reset */}
          {activeFilterCount > 0 && (
            <button onClick={() => { setLocalStatusFilter("all"); setMembershipFilter("all"); setSortBy("name-asc"); }} className="text-xs text-[var(--hue-danger-ink)] hover:underline">
              Clear all filters
            </button>
          )}
        </div>
      )}

      {/* ── Empty state ── */}
      {showGuardianQueue && (
        <div className="mb-4">
          <GuardianReviewQueue onTotalChange={setReviewCount} />
        </div>
      )}

      {!showGuardianQueue && filtered.length === 0 && (
        <div
          className="rounded-2xl border py-16 text-center"
          style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)" }}
        >
          {members.length === 0 ? (
            <>
              <div
                className="w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3"
                style={{ background: "var(--sf-2)" }}
              >
                <Users className="w-6 h-6" style={{ color: "var(--tx-3)" }} />
              </div>
              <p className="font-medium text-sm mb-1" style={{ color: "var(--tx-1)" }}>No members yet</p>
              <p className="text-xs mb-4" style={{ color: "var(--tx-3)" }}>Add your first member to get started</p>
              {canAdd && (
                <Button size="compact" onClick={() => setShowAdd(true)}>
                  <Plus className="size-3.5" />
                  Add member
                </Button>
              )}
            </>
          ) : (
            <p className="text-sm" style={{ color: "var(--tx-3)" }}>
              {query.trim()
                ? <>No members match &ldquo;{query}&rdquo;</>
                : "No members in this view."}
            </p>
          )}
        </div>
      )}

      {/* ── Members (DataTable — §1.5.4 dense spec; card-collapse below sm:) ── */}
      {/*
        Replaces the two hand-maintained lists (a `md:hidden` card stack and a
        `hidden md:block` <table>) with one DataTable. The card chrome is
        applied from `sm:` only, because below that the primitive renders its
        own per-row Cards and an outer card would nest white on white.
        The imperative onMouseEnter/onMouseLeave row hover — which wrote
        inline background styles on every pointer move — is gone; the
        primitive's `hover:bg-sf-2` / `hover:bg-sf-0` zebra-aware hover
        replaces it.
      */}
      {!showGuardianQueue && filtered.length > 0 && (
        <div
          ref={autoRef}
          // No `overflow-hidden` — see the DataTable header comment: it would
          // become the table's nearest scroll container and make the sticky
          // <thead> inert. The primitive rounds its own corner cells.
          className="sm:rounded-[var(--r-md)] sm:border sm:border-bd-default sm:bg-sf-1"
        >
          <DataTable
            label="Members"
            rows={filtered}
            rowKey={(m) => m.id}
            columns={MEMBER_COLUMNS}
            onRowClick={(m) => router.push(`/dashboard/members/${m.id}`)}
            renderCard={(m) => {
              const belt = beltStyle(m.rank?.color);
              const pay = paymentMeta(m.paymentStatus);
              const PayIcon = pay.Icon;
              const waiver = m.waiverAccepted ? WAIVER_CHIP.signed : WAIVER_CHIP.missing;
              return (
                <Card padding="tight" className="flex items-center gap-3">
                  {/* feat/member-profile-pictures Track A Phase A5: avatar slot. */}
                  <Avatar
                    pictureUrl={m.profilePictureUrl ?? null}
                    name={m.name}
                    colorSeed={m.id}
                    size="md"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
                        {m.name}
                        {isBirthdayToday(m.dateOfBirth) && <span className="ml-1" title="Birthday today!">🎂</span>}
                      </span>
                      <StatusTag m={m} />
                      {m.rank && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold"
                          style={{ background: belt.bg, color: belt.text, borderColor: m.rank.color?.toLowerCase() === "white" ? "rgba(0,0,0,0.16)" : "transparent" }}
                        >
                          {m.rank.name}
                          {!!m.rank.stripes && Array.from({ length: m.rank.stripes }).map((_, i) => (
                            <span key={i} className="size-1 rounded-full bg-current opacity-70" />
                          ))}
                        </span>
                      )}
                      {/* Payment chip suppressed for no-membership rows (e.g. a parent
                          Member tied to a kid who has the membership). The default
                          paymentStatus="paid" would otherwise show "Paid" against an
                          unbilled parent and mislead the owner. */}
                      {m.membershipType && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                          style={{ background: pay.bg, color: pay.color }}
                        >
                          <PayIcon className="size-3" />
                          {pay.label}
                        </span>
                      )}
                      <BilledByTeamUpPill member={m} />
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        // `WAIVER_CHIP` entries are `{ bg, color }`, not CSS —
                        // passing one straight to `style` made React drop `bg`
                        // and render the chip as bare coloured text. The
                        // desktop column at :225 already did this correctly.
                        style={{ background: waiver.bg, color: waiver.color }}
                      >
                        {m.waiverAccepted ? "Waiver signed" : "Waiver missing"}
                      </span>
                      {m.accountType && m.accountType !== "adult" && (() => {
                        const ab = ACCOUNT_BADGE[m.accountType!] ?? ACCOUNT_BADGE.adult;
                        return (
                          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize" style={{ background: ab.bg, color: ab.color }}>
                            {m.accountType}
                          </span>
                        );
                      })()}
                    </div>
                    <p className="mt-0.5 truncate text-xs" style={{ color: "var(--tx-3)" }}>
                      {isSynthesisedEmail(m.email) ? "No email" : m.email}
                    </p>
                    {m.membershipType && (
                      <p className="text-xs" style={{ color: "var(--tx-3)" }}>{m.membershipType} · Last visit {formatShortDate(m.lastVisitAt)}</p>
                    )}
                  </div>

                  <ChevronRight className="size-4 shrink-0" style={{ color: "var(--tx-4)" }} />
                </Card>
              );
            }}
          />
        </div>
      )}

      {/* ── Add Member modal ── */}
      {showAdd && (
        <AddMemberModal
          onClose={() => setShowAdd(false)}
          onAdded={handleAdded}
        />
      )}

      <Dialog
        open={inviteShare !== null}
        onClose={() => { setInviteShare(null); setInviteCopied(false); }}
        title="Invite link"
        description={inviteShare ? `${inviteShare.name} was added and an invite email was queued. If email does not reach them, hand them this link instead — it sets up their login, works once and expires in 7 days.` : ""}
        footer={
          inviteShare && (
            <Button
              onClick={async () => {
                try { await navigator.clipboard.writeText(inviteShare.url); setInviteCopied(true); }
                catch { setInviteCopied(false); }
              }}
            >
              {inviteCopied ? "Copied" : "Copy link"}
            </Button>
          )
        }
      >
        {inviteShare && (
          <code className="block break-all rounded-[var(--r-sm)] px-2 py-2 font-mono text-[11px]" style={{ background: "var(--sf-2)", color: "var(--tx-2)" }}>
            {inviteShare.url}
          </code>
        )}
      </Dialog>
    </div>
  );
}

// ─── Add Member Modal ─────────────────────────────────────────────────────────

// C1: this used to be seven invented tier names ("Monthly Unlimited",
// "Drop-in", "Student"…) that no gym had ever agreed to. Whatever the desk
// picked was written to the member as free text and matched nothing on the
// gym's own price list. The dropdown now reads the tenant's real
// MembershipTier rows from GET /api/memberships.
type TierOption = {
  id: string;
  name: string;
  pricePence: number;
  currency: string;
  billingCycle: string;
};

function AddMemberModal({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (member: MemberRow, inviteUrl?: string | null) => void;
}) {
  const { toast } = useToast();
  const formId = useId();
  const [loading, setLoading] = useState(false);
  // Said inside the dialog, with the input kept (F-10, F-17).
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    membershipTierId: "",
    dateOfBirth: "",
    // Attribution (M1): adults may be created straight into "taster" — the
    // funnel's start event — rather than the server's default "active".
    status: "active",
  });
  // Attribution (M1): who ran the trial + who gets the sign-up credit. Held
  // separately from `form` because the resolver collapses it to the XOR body.
  const [attribution, setAttribution] = useState<AttributionValue>(emptyAttribution);

  // Three states, never two (UI-RULES §7). "This gym has not created any
  // tiers yet" and "we could not find out what its tiers are" look identical
  // if you collapse a failed fetch into an empty array — and the desk would
  // then be told to go and build a price list the gym already has.
  const [tiers, setTiers] = useState<TierOption[] | null>(null);
  const [tiersError, setTiersError] = useState(false);
  // Four states, in fact. `admin` may add members but GET /api/memberships is
  // owner/manager only, so for them the 403 is permanent — offering "couldn't
  // load, tap to retry" would be a retry loop dressed as an error.
  const [tiersForbidden, setTiersForbidden] = useState(false);
  const [tiersLoading, setTiersLoading] = useState(true);

  const loadTiers = useCallback(() => {
    setTiersLoading(true);
    setTiersError(false);
    setTiersForbidden(false);
    fetch("/api/memberships")
      .then((r) => {
        if (r.status === 401 || r.status === 403) {
          setTiersForbidden(true);
          return null;
        }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((rows: TierOption[] | null) => {
        if (rows === null) return;
        setTiers(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {
        setTiers(null);
        setTiersError(true);
      })
      .finally(() => setTiersLoading(false));
  }, []);

  useEffect(() => { loadTiers(); }, [loadTiers]);

  const attemptRef = useRef<{ key: string; sig: string } | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((p) => ({ ...p, [k]: e.target.value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) return;
    setLoading(true);
    setFormError(null);
    // One request id per distinct Add member: a retry of the same form (after
    // a lost response) reuses it and the server returns the member it already
    // created; any edit to the form starts a new one (verifier lane 7).
    const sig = JSON.stringify([form, attribution]);
    const held = attemptRef.current;
    const requestId = held && held.sig === sig ? held.key : crypto.randomUUID();
    attemptRef.current = { key: requestId, sig };
    try {
      // Attribution (M1): collapse the credit control to the XOR the API + DB
      // enforce — at most one of userId / memberId / label is non-null.
      const credit = resolveSignupCredit(attribution);
      const res = await fetch("/api/members", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          // Omitted, never sent empty: the create schema validates `email` as
          // an address when the key is present, so "" is a 400. Absent means
          // "this member has none" and the server synthesises a placeholder.
          ...(form.email.trim() ? { email: form.email.trim().toLowerCase() } : {}),
          phone: form.phone.trim() || undefined,
          // The tier id is what the server acts on: it resolves it inside the
          // tenant and derives the legacy `membershipType` label from the tier
          // row, so both columns are written and cannot drift apart.
          membershipTierId: form.membershipTierId || undefined,
          ...(form.dateOfBirth ? { dateOfBirth: form.dateOfBirth } : {}),
          // Attribution (M1): a taster with a trialRunById coach is the
          // funnel's entry. Only send the fields that were actually set.
          status: form.status,
          ...(attribution.trialRunById ? { trialRunById: attribution.trialRunById } : {}),
          ...(credit.creditedToUserId ? { creditedToUserId: credit.creditedToUserId } : {}),
          ...(credit.creditedToMemberId ? { creditedToMemberId: credit.creditedToMemberId } : {}),
          ...(credit.creditedToLabel ? { creditedToLabel: credit.creditedToLabel } : {}),
          requestId,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const failure = describeSaveFailure(res.status, data, "Add Member", { idempotent: true });
        setFormError(failure.message);
        toast(failure.kind === "invalid" ? failure.message : "Member not added", "error");
      } else {
        toast(`${form.name} added`, "success");
        onAdded({
          ...data,
          joinedAt: data.joinedAt ?? new Date().toISOString(),
          // A desk-created member starts with "No payment yet" (lib/payment-status.ts).
          paymentStatus: data.paymentStatus ?? "pending",
          waiverAccepted: data.waiverAccepted ?? false,
          lastVisitAt: null,
          rank: null,
        }, typeof data.inviteUrl === "string" ? data.inviteUrl : null);
      }
    } catch {
      setFormError(describeSaveFailure(0, null, "Add Member", { idempotent: true }).message);
      toast("Member not added", "error");
    } finally {
      setLoading(false);
    }
  }

  const inputCls =
    "w-full px-3 py-2.5 rounded-xl text-sm outline-none transition-colors placeholder:text-[var(--tx-3)]";
  const inputStyle = {
    background: "var(--sf-2)",
    border: "1px solid var(--bd-default)",
    color: "var(--tx-1)",
  };
  const focusHandlers = {
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-active)";
    },
    onBlur: (e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) => {
      e.currentTarget.style.borderColor = "var(--bd-default)";
    },
  };

  return (
    // Dialog (§4a.3): a short create form — centred, capped at max-w-lg, a
    // bottom sheet below `sm:`. The primitive supplies role="dialog",
    // aria-modal, Escape, the focus trap and scroll lock, none of which the
    // hand-rolled backdrop + fixed panel had. The form element stays in the
    // body so `submit` keeps its FormEvent and Enter still submits; the footer
    // button reaches it by `form={formId}`.
    <Dialog
      open
      onClose={onClose}
      title="Add Member"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            loading={loading}
            disabled={!form.name.trim()}
          >
            {loading ? "Adding…" : "Add Member"}
          </Button>
        </>
      }
    >
        {/* Form */}
        <form id={formId} onSubmit={submit} className="space-y-3">
          {formError && (
            <p role="alert" className="rounded-[var(--r-md)] px-3 py-2 text-sm" style={{ background: "var(--hue-danger-soft, rgba(239,68,68,0.10))", color: "var(--hue-danger-ink)" }}>
              {formError}
            </p>
          )}
          {/* Name */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-3)" }}>
              Full Name <span className="text-[var(--hue-danger-ink)]">*</span>
            </label>
            <input aria-label="Full Name"
              type="text"
              placeholder="e.g. John Smith"
              value={form.name}
              onChange={set("name")}
              required
              className={inputCls}
              style={inputStyle}
              {...focusHandlers}
              autoFocus
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-3)" }}>
              Email
            </label>
            <input aria-label="Email"
              type="email"
              placeholder="john@example.com"
              value={form.email}
              onChange={set("email")}
              className={inputCls}
              style={inputStyle}
              {...focusHandlers}
            />
            {/*
              Optional since 19 Sep 2026. A club has walk-ins, older members and
              families sharing one inbox; refusing them a row sent them to paper
              and took the attendance, the payments and the waiver with them.
              The consequence is stated here, at the moment of the decision,
              rather than discovered later when an invite silently never arrives.
            */}
            {!form.email.trim() && (
              <p className="mt-1.5 text-xs" style={{ color: "var(--tx-3)" }}>
                Optional. Without an email this member can&rsquo;t be sent a login invite,
                a waiver link or a payment reminder — you can add one later.
              </p>
            )}
          </div>

          {/* Phone + Membership (side by side on wider screens) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-3)" }}>Phone</label>
              <input aria-label="Phone"
                type="tel"
                placeholder="+44 7700 000000"
                value={form.phone}
                onChange={set("phone")}
                className={inputCls}
                style={inputStyle}
                {...focusHandlers}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-3)" }}>Membership</label>
              {tiersError ? (
                // A failed lookup is not "this gym has no tiers" (UI-RULES §7).
                <ErrorState
                  message="Couldn't load your membership tiers"
                  onRetry={loadTiers}
                />
              ) : tiersForbidden ? (
                <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                  Only owners and managers can see the price list. Add the member now — an owner can
                  set their membership afterwards.
                </p>
              ) : tiersLoading ? (
                <Skeleton className="h-[42px] w-full" />
              ) : tiers && tiers.length === 0 ? (
                <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                  No membership tiers yet. Create your price list in{" "}
                  <Link href="/dashboard/memberships" className="underline" style={{ color: "var(--tx-1)" }}>
                    Memberships
                  </Link>
                  , then you can put members on it. You can still add this member now.
                </p>
              ) : (
                <select aria-label="Membership"
                  value={form.membershipTierId}
                  onChange={set("membershipTierId")}
                  className={inputCls}
                  style={{ ...inputStyle, appearance: "none" }}
                  {...focusHandlers}
                >
                  <option value="">Select…</option>
                  {(tiers ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} — {formatTierPrice(t)}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-3)" }}>Date of Birth</label>
              <input aria-label="Date of Birth"
                type="date"
                value={form.dateOfBirth}
                onChange={set("dateOfBirth")}
                className={inputCls}
                style={inputStyle}
                {...focusHandlers}
              />
            </div>
            <div>
              {/* Attribution (M1): a member can be added straight into the
                  funnel as a taster, so a trial coach's conversion can be
                  tracked from the first touch. */}
              <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--tx-3)" }}>Status</label>
              <select aria-label="Status"
                value={form.status}
                onChange={set("status")}
                className={inputCls}
                style={{ ...inputStyle, appearance: "none" }}
                {...focusHandlers}
              >
                <option value="active">Active</option>
                <option value="taster">Taster (trial)</option>
              </select>
            </div>
          </div>

          {/* Attribution (M1): who ran the trial and who gets sign-up credit. */}
          <div className="pt-1">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--tx-4)" }}>
              Attribution
            </p>
            <AttributionFields
              value={attribution}
              onChange={setAttribution}
              inputClassName={inputCls}
              inputStyle={inputStyle}
              focusHandlers={focusHandlers}
            />
          </div>
        </form>
    </Dialog>
  );
}
