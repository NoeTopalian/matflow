"use client";

// Client-side filter/sort/search over a server-rendered tenant list.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { TenantRow } from "./page";
import { adminButtonSecondary, adminCard, adminContainer, adminNavLink, adminPage, adminPalette } from "../admin-theme";

type StatusFilter = "all" | "active" | "trial" | "suspended" | "cancelled";
type StripeFilter = "all" | "connected" | "broken" | "not_connected";
type SortKey = "recent" | "members_desc" | "name_asc" | "status";

function initialQuery() {
  if (typeof window === "undefined") return "";
  return new URL(window.location.href).searchParams.get("q") ?? "";
}

function initialStatus(): StatusFilter {
  if (typeof window === "undefined") return "all";
  const status = new URL(window.location.href).searchParams.get("status");
  return status && ["active", "trial", "suspended", "cancelled"].includes(status)
    ? status as StatusFilter
    : "all";
}

function initialStripe(): StripeFilter {
  if (typeof window === "undefined") return "all";
  const stripe = new URL(window.location.href).searchParams.get("stripe");
  return stripe && ["connected", "broken", "not_connected"].includes(stripe)
    ? stripe as StripeFilter
    : "all";
}

export default function TenantsList({ tenants }: { tenants: TenantRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState(initialQuery);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [stripeFilter, setStripeFilter] = useState<StripeFilter>(initialStripe);
  const [sort, setSort] = useState<SortKey>("recent");

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
    if (statusFilter !== "all") url.searchParams.set("status", statusFilter); else url.searchParams.delete("status");
    if (stripeFilter !== "all") url.searchParams.set("stripe", stripeFilter); else url.searchParams.delete("stripe");
    window.history.replaceState({}, "", url.toString());
  }, [query, statusFilter, stripeFilter]);

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
    if (sort === "recent") sorted.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    else if (sort === "members_desc") sorted.sort((a, b) => b.memberCount - a.memberCount);
    else if (sort === "name_asc") sorted.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === "status") sorted.sort((a, b) => a.status.localeCompare(b.status));
    return sorted;
  }, [tenants, query, statusFilter, stripeFilter, sort]);

  function exportCsv() {
    const rows = [
      ["Gym", "Slug", "Owner Name", "Owner Email", "Members", "Status", "Stripe Connected", "Stripe Charges Enabled", "Onboarding Completed", "Created"],
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
      ]),
    ];
    const csv = rows.map((r) => r.map((cell) => /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `matflow-tenants-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function logout() {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    router.push("/admin/login");
  }

  return (
    <div style={adminPage}>
      <div style={adminContainer}>
        <header style={header}>
          <div>
            <h1 style={title}>Tenants</h1>
            <p style={subtitle}>Showing {filtered.length} of {tenants.length} gym{tenants.length === 1 ? "" : "s"}</p>
          </div>
          <nav style={nav}>
            <Link href="/admin" style={adminNavLink}>Dashboard</Link>
            <Link href="/admin/applications" style={adminNavLink}>Applications</Link>
            <Link href="/admin/security" style={adminNavLink}>Security</Link>
            <button type="button" onClick={logout} style={linkButton}>Sign out</button>
          </nav>
        </header>

        <div style={controls}>
          <input
            type="search"
            placeholder="Search name, slug, owner email"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={searchInput}
          />

          <FilterChips
            label="Status"
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

          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} style={select}>
            <option value="recent">Sort: Most recent</option>
            <option value="members_desc">Sort: Members high to low</option>
            <option value="name_asc">Sort: Name A to Z</option>
            <option value="status">Sort: Status</option>
          </select>

          <button onClick={exportCsv} style={adminButtonSecondary}>Export CSV ({filtered.length})</button>
        </div>

        {filtered.length === 0 ? (
          <div style={{ ...adminCard, padding: "48px 24px", textAlign: "center", color: adminPalette.muted }}>
            No tenants match your filters.
          </div>
        ) : (
          <div style={{ ...adminCard, overflowX: "auto" }}>
            <table style={table}>
              <thead style={{ background: adminPalette.cardSoft }}>
                <tr>
                  <th style={th}>Gym</th>
                  <th style={th}>Owner</th>
                  <th style={th}>Members</th>
                  <th style={th}>Status</th>
                  <th style={th}>Stripe</th>
                  <th style={th}>Created</th>
                  <th style={th}></th>
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
                    <td style={td}>{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td style={td}>
                      <Link href={`/admin/tenants/${t.id}`} style={rowAction}>View</Link>
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
const linkButton: React.CSSProperties = { ...adminNavLink, border: 0, background: "transparent", padding: 0, cursor: "pointer", fontSize: 13 };
const controls: React.CSSProperties = { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12, alignItems: "center" };
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
  padding: "6px 12px",
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
