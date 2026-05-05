"use client";

// Client-side filter/sort/search over a server-rendered tenant list.
// CSV export downloads whatever rows are currently visible (after filters).

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { TenantRow } from "./page";

type StatusFilter = "all" | "active" | "trial" | "suspended" | "cancelled";
type StripeFilter = "all" | "connected" | "broken" | "not_connected";
type SortKey = "recent" | "members_desc" | "name_asc" | "status";

export default function TenantsList({ tenants }: { tenants: TenantRow[] }) {
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [stripeFilter, setStripeFilter] = useState<StripeFilter>("all");
  const [sort, setSort] = useState<SortKey>("recent");

  // Sync ?q=... with URL on debounce (so refresh / share keeps state)
  useEffect(() => {
    const url = new URL(window.location.href);
    if (query) url.searchParams.set("q", query); else url.searchParams.delete("q");
    if (statusFilter !== "all") url.searchParams.set("status", statusFilter); else url.searchParams.delete("status");
    window.history.replaceState({}, "", url.toString());
  }, [query, statusFilter]);

  // Hydrate from URL on mount
  useEffect(() => {
    const url = new URL(window.location.href);
    const q = url.searchParams.get("q");
    const s = url.searchParams.get("status");
    if (q) setQuery(q);
    if (s && ["active", "trial", "suspended", "cancelled"].includes(s)) {
      setStatusFilter(s as StatusFilter);
    }
  }, []);

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

    if (statusFilter !== "all") {
      list = list.filter((t) => t.status === statusFilter);
    }

    if (stripeFilter === "connected") {
      list = list.filter((t) => t.stripeConnected && t.stripeChargesEnabled !== false);
    } else if (stripeFilter === "broken") {
      list = list.filter((t) => t.stripeConnected && t.stripeChargesEnabled === false);
    } else if (stripeFilter === "not_connected") {
      list = list.filter((t) => !t.stripeConnected);
    }

    const sorted = [...list];
    if (sort === "recent") {
      sorted.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
    } else if (sort === "members_desc") {
      sorted.sort((a, b) => b.memberCount - a.memberCount);
    } else if (sort === "name_asc") {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === "status") {
      sorted.sort((a, b) => a.status.localeCompare(b.status));
    }
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

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0e", color: "white", padding: "32px 24px" }}>
      <div style={{ maxWidth: 1200, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Tenants</h1>
            <p style={{ opacity: 0.6, margin: "4px 0 0", fontSize: 14 }}>
              Showing {filtered.length} of {tenants.length} gym{tenants.length === 1 ? "" : "s"}
            </p>
          </div>
          <nav style={{ display: "flex", gap: 16, fontSize: 13, alignItems: "center" }}>
            <Link href="/admin/applications" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>Applications →</Link>
            <Link href="/admin/login" style={{ color: "rgba(255,255,255,0.4)", textDecoration: "none" }}>Sign out</Link>
          </nav>
        </header>

        {/* Controls bar */}
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12, alignItems: "center" }}>
          <input
            type="search"
            placeholder="Search name, slug, owner email…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              flex: "1 1 240px",
              minWidth: 220,
              padding: "8px 12px",
              background: "#16181d",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              color: "white",
              fontSize: 13,
              outline: "none",
            }}
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

          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            style={{
              padding: "8px 12px",
              background: "#16181d",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              color: "white",
              fontSize: 13,
            }}
          >
            <option value="recent">Sort: Most recent</option>
            <option value="members_desc">Sort: Members (high → low)</option>
            <option value="name_asc">Sort: Name A → Z</option>
            <option value="status">Sort: Status</option>
          </select>

          <button
            onClick={exportCsv}
            style={{
              padding: "8px 14px",
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 8,
              color: "white",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Export CSV ({filtered.length})
          </button>
        </div>

        {filtered.length === 0 ? (
          <div style={{ background: "#16181d", borderRadius: 12, padding: "48px 24px", textAlign: "center", border: "1px solid rgba(255,255,255,0.07)" }}>
            <p style={{ opacity: 0.5, margin: 0 }}>No tenants match your filters.</p>
          </div>
        ) : (
          <div style={{ background: "#16181d", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead style={{ background: "rgba(255,255,255,0.03)" }}>
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
                  <tr key={t.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{t.name}</div>
                      <div style={{ fontSize: 12, opacity: 0.5 }}>{t.slug}</div>
                    </td>
                    <td style={td}>
                      {t.ownerName ? (
                        <>
                          <div>{t.ownerName}</div>
                          <div style={{ fontSize: 12, opacity: 0.5 }}>{t.ownerEmail}</div>
                        </>
                      ) : (
                        <span style={{ opacity: 0.4 }}>(no owner)</span>
                      )}
                    </td>
                    <td style={td}>{t.memberCount}</td>
                    <td style={td}>{statusBadge(t.status)}</td>
                    <td style={td}>{stripeBadge(t)}</td>
                    <td style={td}>{new Date(t.createdAt).toLocaleDateString()}</td>
                    <td style={td}>
                      <Link
                        href={`/admin/tenants/${t.id}`}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 6,
                          background: "rgba(255,255,255,0.06)",
                          color: "white",
                          textDecoration: "none",
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        View →
                      </Link>
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
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px", background: "#16181d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}>
      <span style={{ fontSize: 11, opacity: 0.5, padding: "0 6px" }}>{label}</span>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "none",
            background: current === o.value ? "rgba(255,255,255,0.12)" : "transparent",
            color: current === o.value ? "white" : "rgba(255,255,255,0.55)",
            fontSize: 12,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function statusBadge(status: string) {
  const palette: Record<string, { bg: string; fg: string }> = {
    active:    { bg: "rgba(16,185,129,0.12)", fg: "#10b981" },
    trial:     { bg: "rgba(245,158,11,0.12)", fg: "#f59e0b" },
    suspended: { bg: "rgba(239,68,68,0.12)",  fg: "#ef4444" },
    cancelled: { bg: "rgba(255,255,255,0.06)", fg: "rgba(255,255,255,0.5)" },
  };
  const p = palette[status] ?? palette.cancelled;
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, background: p.bg, color: p.fg, fontSize: 11, fontWeight: 600 }}>
      {status}
    </span>
  );
}

function stripeBadge(t: TenantRow) {
  if (!t.stripeConnected) {
    return <span style={{ fontSize: 12, opacity: 0.5 }}>—</span>;
  }
  if (t.stripeChargesEnabled === false) {
    return (
      <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(239,68,68,0.12)", color: "#ef4444", fontSize: 11, fontWeight: 600 }}>
        Broken
      </span>
    );
  }
  return (
    <span style={{ padding: "2px 8px", borderRadius: 999, background: "rgba(16,185,129,0.10)", color: "#10b981", fontSize: 11, fontWeight: 600 }}>
      Connected
    </span>
  );
}

const th: React.CSSProperties = { textAlign: "left", padding: "12px 16px", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", opacity: 0.5, fontWeight: 600 };
const td: React.CSSProperties = { padding: "14px 16px", verticalAlign: "top" };
