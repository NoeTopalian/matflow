"use client";

// Client-side filter/sort/search over a server-rendered tenant list.
// The server picks the view (open clubs, or "Closed clubs" = soft-deleted);
// search, filters, counts and the CSV all work within the rows of that view.

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { TenantRow, TenantView } from "./page";
import AdminTopNav from "../AdminTopNav";
import { adminButtonSecondary, adminCard, adminContainer, adminPage, adminPalette } from "../admin-theme";
import { csvRow } from "@/lib/csv";
import { formatDate } from "@/lib/date";

type StatusFilter = "all" | "active" | "trial" | "suspended" | "cancelled";
type StripeFilter = "all" | "connected" | "broken" | "not_connected";
type SortKey = "recent" | "members_desc" | "name_asc" | "status";

// Filters live in the URL (q, status, stripe), read with useSearchParams.
function toStatus(status: string | undefined): StatusFilter {
  return status && ["active", "trial", "suspended", "cancelled"].includes(status)
    ? status as StatusFilter
    : "all";
}

function toStripe(stripe: string | undefined): StripeFilter {
  return stripe && ["connected", "broken", "not_connected"].includes(stripe)
    ? stripe as StripeFilter
    : "all";
}

export default function TenantsList({
  tenants,
  view = "open",
  openCount = view === "open" ? tenants.length : 0,
  closedCount = view === "closed" ? tenants.length : 0,
}: {
  tenants: TenantRow[];
  view?: TenantView;
  openCount?: number;
  closedCount?: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const closedView = view === "closed";
  // Start from the browser's URL: after Back from a club page this is the URL
  // the list last wrote, so a typed search survives.
  const [query, setQuery] = useState(() => searchParams.get("q") ?? "");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => toStatus(searchParams.get("status") ?? undefined));
  const [stripeFilter, setStripeFilter] = useState<StripeFilter>(() => toStripe(searchParams.get("stripe") ?? undefined));
  const [sort, setSort] = useState<SortKey>("recent");

  // Keep the URL equal to the visible filters, also after a navigation that
  // changed the URL without remounting the list (e.g. the top-nav Tenants link).
  const urlKey = searchParams.toString();
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
    if (statusFilter !== "all") url.searchParams.set("status", statusFilter); else url.searchParams.delete("status");
    if (stripeFilter !== "all") url.searchParams.set("stripe", stripeFilter); else url.searchParams.delete("stripe");
    // A plain state object lets Next sync useSearchParams with the new URL.
    if (url.toString() !== window.location.href) window.history.replaceState({}, "", url.toString());
  }, [query, statusFilter, stripeFilter, urlKey]);

  const filtered = useMemo(() => {
    let list = tenants;

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.slug.toLowerCase().includes(q) ||
          (t.ownerEmail?.toLowerCase().includes(q) ?? false) ||
          (t.ownerName?.toLowerCase().includes(q) ?? false),
      );
    }

    if (statusFilter !== "all") list = list.filter((t) => t.status === statusFilter);

    if (stripeFilter === "connected") {
      list = list.filter((t) => t.stripeConnected && t.stripeChargesEnabled !== false);
    } else if (stripeFilter === "broken") {
      list = list.filter((t) => t.stripeConnected && t.stripeChargesEnabled === false);
    } else if (stripeFilter === "not_connected") {
      list = list.filter((t) => !t.stripeConnected);
    }

    const sorted = [...list];
    // "Most recent" means most recently closed in the closed view.
    if (sort === "recent" && closedView) sorted.sort((a, b) => +new Date(b.deletedAt ?? 0) - +new Date(a.deletedAt ?? 0));
    else if (sort === "recent") sorted.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    else if (sort === "members_desc") sorted.sort((a, b) => b.memberCount - a.memberCount);
    else if (sort === "name_asc") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "status") sorted.sort((a, b) => a.status.localeCompare(b.status));
    return sorted;
  }, [tenants, query, statusFilter, stripeFilter, sort, closedView]);

  /** The other view, keeping the current search and filters. */
  function viewHref(target: TenantView) {
    const params = new URLSearchParams();
    if (target === "closed") params.set("view", "closed");
    if (query) params.set("q", query);
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (stripeFilter !== "all") params.set("stripe", stripeFilter);
    const s = params.toString();
    return s ? `/admin/tenants?${s}` : "/admin/tenants";
  }

  function exportCsv() {
    const rows = [
      // Headers unchanged for the open view (no documented consumer; compatibility
      // unknown), so "Status" here is the subscription status; the closed view
      // only appends a Closed column.
      ["Gym", "Slug", "Owner Name", "Owner Email", "Members", "Status", "Stripe Connected", "Stripe Charges Enabled", "Onboarding Completed", "Created", ...(closedView ? ["Closed"] : [])],
      ...filtered.map((t) => [
        t.name,
        t.slug,
        t.ownerName ?? "",
        t.ownerEmail ?? "",
        String(t.memberCount),
        t.status,
        String(t.stripeConnected),
        t.stripeChargesEnabled === null ? "" : String(t.stripeChargesEnabled),
        String(t.onboardingCompleted),
        t.createdAt,
        ...(closedView ? [t.deletedAt ?? ""] : []),
      ]),
    ];
    // Route every cell through lib/csv.csvRow — RFC-4180 quoting AND the
    // formula-injection guard. A gym owner controls ownerName/ownerEmail, so a
    // hand-rolled quote-only escape let a "=cmd()" name execute in the operator's
    // exported sheet (the same bug fixed in the payments export). Single-writer:
    // CSV escaping lives only in lib/csv.ts.
    const csv = rows.map((r) => csvRow(r)).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `matflow-tenants-${closedView ? "closed-" : ""}${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={adminPage}>
      {/* Canonical console nav (audit A2): the inline per-page nav made
          Billing/Activity unreachable and duplicated Sign out logic. */}
      <AdminTopNav />
      <div style={adminContainer}>
        <header style={header}>
          <div>
            <h1 style={title}>Tenants</h1>
            <p style={subtitle}>
              Showing {filtered.length} of {tenants.length} {closedView ? "closed" : "open"} club{tenants.length === 1 ? "" : "s"}
            </p>
          </div>
        </header>

        <nav aria-label="Club view" style={viewNav}>
          <Link href={viewHref("open")} aria-current={closedView ? undefined : "page"} style={viewTab(!closedView)}>
            Open clubs ({openCount})
          </Link>
          <Link href={viewHref("closed")} aria-current={closedView ? "page" : undefined} style={viewTab(closedView)}>
            Closed clubs ({closedCount})
          </Link>
        </nav>

        {closedView && (
          <p style={closedNote}>
            Closed clubs were soft-deleted from their club page&apos;s Danger zone. Their owners, staff and members cannot
            sign in. Opening a club only shows its details. Restoring, where the club page still offers it, is a separate action there.
          </p>
        )}

        <div style={controls}>
          <input aria-label="Search name, slug, owner email"
            type="search"
            placeholder="Search name, slug, owner email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={searchInput}
          />

          <FilterChips
            label="Subscription"
            current={statusFilter}
            options={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "trial", label: "Trial" },
              { value: "suspended", label: "Suspended" },
              { value: "cancelled", label: "Cancelled" },
            ]}
            onChange={(v) => setStatusFilter(v as StatusFilter)}
          />

          <FilterChips
            label="Stripe"
            current={stripeFilter}
            options={[
              { value: "all", label: "All" },
              { value: "connected", label: "Connected" },
              { value: "broken", label: "Broken" },
              { value: "not_connected", label: "Not connected" },
            ]}
            onChange={(v) => setStripeFilter(v as StripeFilter)}
          />

          <select aria-label="Sort tenants" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={select}>
            <option value="recent">{closedView ? "Sort: Recently closed" : "Sort: Most recent"}</option>
            <option value="members_desc">Sort: Active members high to low</option>
            <option value="name_asc">Sort: Name A to Z</option>
            <option value="status">Sort: Subscription</option>
          </select>

          <button onClick={exportCsv} style={adminButtonSecondary}>Export CSV ({filtered.length})</button>
        </div>

        {filtered.length === 0 ? (
          <div style={{ ...adminCard, padding: "48px 24px", textAlign: "center", color: adminPalette.muted }}>
            {tenants.length === 0 ? (closedView ? "No closed clubs." : "No open clubs.") : "No clubs match your filters."}
          </div>
        ) : (
          <div style={{ ...adminCard, overflowX: "auto" }}>
            <table style={table}>
              <thead style={{ background: adminPalette.cardSoft }}>
                <tr>
                  <th style={th}>Gym</th>
                  <th style={th}>Owner</th>
                  <th style={th}>Active members</th>
                  <th style={th}>Subscription</th>
                  <th style={th}>Stripe</th>
                  <th style={th}>Created</th>
                  {closedView && <th style={th}>Closed</th>}
                  <th style={th}><span style={srOnly}>Details</span></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} style={{ borderTop: `1px solid ${adminPalette.borderSoft}` }}>
                    <td style={td}>
                      <div style={{ fontWeight: 750 }}>{t.name}</div>
                      <div style={mutedSmall}>{t.slug}</div>
                    </td>
                    <td style={td}>
                      {t.ownerName ? (
                        <>
                          <div>{t.ownerName}</div>
                          <div style={mutedSmall}>{t.ownerEmail}</div>
                        </>
                      ) : (
                        <span style={{ color: adminPalette.faint }}>(no owner)</span>
                      )}
                    </td>
                    <td style={td}>{t.memberCount}</td>
                    <td style={td}>{statusBadge(t.status)}</td>
                    <td style={td}>{stripeBadge(t)}</td>
                    <td style={td}>{formatDate(t.createdAt)}</td>
                    {closedView && <td style={td}>{t.deletedAt ? formatDate(t.deletedAt) : "-"}</td>}
                    <td style={td}>
                      <Link href={`/admin/tenants/${t.id}`} style={rowAction} aria-label={`View ${t.name}`}>View</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function FilterChips({
  label,
  current,
  options,
  onChange,
}: {
  label: string;
  current: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div style={chipGroup}>
      <span style={{ fontSize: 11, color: adminPalette.muted, padding: "0 6px", fontWeight: 750 }}>{label}</span>
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} style={chip(current === o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function statusBadge(status: string) {
  const palette: Record<string, { bg: string; fg: string }> = {
    active: { bg: "#ecfdf5", fg: adminPalette.green },
    trial: { bg: "#fffbeb", fg: adminPalette.amber },
    suspended: { bg: "#fef2f2", fg: adminPalette.red },
    cancelled: { bg: adminPalette.cardSoft, fg: adminPalette.muted },
  };
  const p = palette[status] ?? palette.cancelled;
  return <span style={badge(p.bg, p.fg)}>{status}</span>;
}

function stripeBadge(t: TenantRow) {
  if (!t.stripeConnected) return <span style={{ fontSize: 12, color: adminPalette.faint }}>-</span>;
  if (t.stripeChargesEnabled === false) return <span style={badge("#fef2f2", adminPalette.red)}>Broken</span>;
  return <span style={badge("#ecfdf5", adminPalette.green)}>Connected</span>;
}

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 18,
  marginBottom: 24,
  flexWrap: "wrap",
};
const title: React.CSSProperties = { fontSize: 28, fontWeight: 750, margin: 0 };
const subtitle: React.CSSProperties = { color: adminPalette.muted, margin: "4px 0 0", fontSize: 14 };
const nav: React.CSSProperties = { display: "flex", gap: 16, fontSize: 13, alignItems: "center", flexWrap: "wrap" };
const controls: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" };
const viewNav: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 };
function viewTab(active: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    minHeight: 44,
    boxSizing: "border-box",
    display: "inline-flex",
    alignItems: "center",
    borderRadius: 8,
    border: `1px solid ${active ? adminPalette.brand : adminPalette.border}`,
    background: active ? adminPalette.brand : adminPalette.card,
    color: active ? adminPalette.card : adminPalette.text,
    fontSize: 13,
    fontWeight: 750,
    textDecoration: "none",
  };
}
const closedNote: React.CSSProperties = { color: adminPalette.muted, fontSize: 13, margin: "0 0 12px", maxWidth: 760 };
const srOnly: React.CSSProperties = { position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" };
const searchInput: React.CSSProperties = {
  flex: "1 1 240px",
  minWidth: 220,
  padding: "8px 12px",
  background: "#ffffff",
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  color: adminPalette.text,
  fontSize: 13,
  outline: "none",
};
const chipGroup: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: 4,
  background: "#ffffff",
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
};
function chip(active: boolean): React.CSSProperties {
  return {
    padding: "4px 9px",
    borderRadius: 6,
    border: "none",
    background: active ? adminPalette.brand : "transparent",
    color: active ? "#ffffff" : adminPalette.muted,
    fontSize: 12,
    fontWeight: 750,
    cursor: "pointer",
  };
}
const select: React.CSSProperties = {
  padding: "8px 12px",
  background: "#ffffff",
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  color: adminPalette.text,
  fontSize: 13,
};
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 14, minWidth: 840 };
const th: React.CSSProperties = { textAlign: "left", padding: "12px 16px", fontSize: 11, textTransform: "uppercase", color: adminPalette.muted, fontWeight: 800 };
const td: React.CSSProperties = { padding: "14px 16px", verticalAlign: "top" };
const mutedSmall: React.CSSProperties = { fontSize: 12, color: adminPalette.muted, marginTop: 2 };
const rowAction: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  minHeight: 44,
  boxSizing: "border-box",
  padding: "6px 14px",
  borderRadius: 8,
  background: adminPalette.cardSoft,
  border: `1px solid ${adminPalette.borderSoft}`,
  color: adminPalette.text,
  textDecoration: "none",
  fontSize: 12,
  fontWeight: 750,
};
function badge(bg: string, fg: string): React.CSSProperties {
  return { padding: "2px 8px", borderRadius: 999, background: bg, color: fg, fontSize: 11, fontWeight: 750 };
}
