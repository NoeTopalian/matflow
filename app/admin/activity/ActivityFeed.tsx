"use client";

// Cross-tenant audit-log viewer with filter chips and cursor pagination.

import Link from "next/link";
import { useEffect, useState } from "react";
import { adminButtonSecondary, adminCard, adminNavLink, adminPalette } from "../admin-theme";

type Row = {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  actorEmail: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown> | null;
  ipApprox: string | null;
  createdAt: string;
};

const ACTION_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "admin.", label: "Admin" },
  { value: "auth.", label: "Auth" },
  { value: "member.", label: "Member" },
  { value: "attendance.", label: "Attendance" },
  { value: "payment.", label: "Payment" },
  { value: "tenant.", label: "Tenant" },
];

export default function ActivityFeed() {
  const [items, setItems] = useState<Row[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [actionFilter, setActionFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function fetchPage(reset = true, cursor: string | null = null) {
    setLoading(true);
    setError(null);
    try {
      const url = new URL("/api/admin/activity", window.location.origin);
      if (actionFilter) url.searchParams.set("action", actionFilter);
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString());
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Failed to load");
        return;
      }
      setItems((prev) => (reset ? data.items : [...prev, ...data.items]));
      setNextCursor(data.nextCursor);
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchPage(true, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFilter]);

  return (
    <>
      <header style={header}>
        <div>
          <h1 style={title}>Activity</h1>
          <p style={subtitle}>Cross-tenant audit log - {items.length} loaded</p>
        </div>
        <nav style={nav}>
          <Link href="/admin" style={adminNavLink}>Dashboard</Link>
          <Link href="/admin/tenants" style={adminNavLink}>Tenants</Link>
          <Link href="/admin/applications" style={adminNavLink}>Applications</Link>
          <Link href="/admin/security" style={adminNavLink}>Security</Link>
        </nav>
      </header>

      <div style={filters}>
        <span style={{ fontSize: 11, color: adminPalette.muted, padding: "0 6px", fontWeight: 750 }}>Action</span>
        {ACTION_FILTERS.map((f) => (
          <button key={f.value} onClick={() => setActionFilter(f.value)} style={filterButton(actionFilter === f.value)}>
            {f.label}
          </button>
        ))}
      </div>

      {error && <div style={errorBox}>{error}</div>}

      <div style={{ ...adminCard, overflow: "hidden" }}>
        {items.length === 0 && !loading ? (
          <div style={empty}>No activity yet.</div>
        ) : (
          <div>
            {items.map((r) => (
              <div key={r.id} style={row}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                      <code style={actionBadge(r.action)}>{r.action}</code>
                      <span style={{ fontSize: 13 }}>
                        on <strong>{r.entityType}</strong>{" "}
                        {r.tenantSlug && (
                          <Link href={`/admin/tenants/${r.tenantId}`} style={tenantLink}>
                            @{r.tenantSlug}
                          </Link>
                        )}
                      </span>
                      <span style={mutedSmall}>{new Date(r.createdAt).toLocaleString()}</span>
                    </div>
                    <div style={{ fontSize: 12, color: adminPalette.muted, marginTop: 4 }}>
                      {r.actorEmail ? <>by {r.actorName ?? r.actorEmail}</> : <span>system</span>}
                      {r.metadata && typeof r.metadata === "object" && "actingAs" in r.metadata && (
                        <span style={{ marginLeft: 8, color: adminPalette.amber }}>(impersonated)</span>
                      )}
                      {r.ipApprox && <span style={{ marginLeft: 8 }}>- {r.ipApprox}</span>}
                    </div>
                  </div>
                  <button onClick={() => setExpanded(expanded === r.id ? null : r.id)} style={detailsButton}>
                    {expanded === r.id ? "Hide" : "Details"}
                  </button>
                </div>
                {expanded === r.id && (
                  <pre style={pre}>
                    {JSON.stringify({ entityId: r.entityId, metadata: r.metadata }, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ marginTop: 16, textAlign: "center" }}>
        {nextCursor && (
          <button onClick={() => fetchPage(false, nextCursor)} disabled={loading} style={adminButtonSecondary}>
            {loading ? "Loading..." : "Load more"}
          </button>
        )}
      </div>
    </>
  );
}

function actionBadge(action: string): React.CSSProperties {
  const { bg, fg } = actionColors(action);
  return { background: bg, padding: "2px 8px", borderRadius: 6, fontSize: 12, color: fg, fontWeight: 750 };
}

function actionColors(action: string): { bg: string; fg: string } {
  if (action.startsWith("admin.impersonate")) return { bg: "#fffbeb", fg: adminPalette.amber };
  if (action.startsWith("admin.")) return { bg: "#fef2f2", fg: adminPalette.red };
  if (action.startsWith("auth.")) return { bg: "#eef2ff", fg: "#4f46e5" };
  if (action.startsWith("payment.") || action.startsWith("invoice.")) return { bg: "#ecfdf5", fg: adminPalette.green };
  if (action.startsWith("attendance.")) return { bg: "#eff6ff", fg: adminPalette.blue };
  return { bg: adminPalette.cardSoft, fg: adminPalette.text };
}

const header: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 18, marginBottom: 24, flexWrap: "wrap" };
const title: React.CSSProperties = { fontSize: 28, fontWeight: 750, margin: 0 };
const subtitle: React.CSSProperties = { color: adminPalette.muted, margin: "4px 0 0", fontSize: 14 };
const nav: React.CSSProperties = { display: "flex", gap: 16, fontSize: 13, alignItems: "center", flexWrap: "wrap" };
const filters: React.CSSProperties = { display: "flex", gap: 4, marginBottom: 16, flexWrap: "wrap", alignItems: "center", padding: 4, background: "#ffffff", border: `1px solid ${adminPalette.border}`, borderRadius: 8 };
function filterButton(active: boolean): React.CSSProperties {
  return {
    padding: "4px 10px",
    borderRadius: 6,
    border: "none",
    background: active ? adminPalette.brand : "transparent",
    color: active ? "#ffffff" : adminPalette.muted,
    fontSize: 12,
    fontWeight: 750,
    cursor: "pointer",
  };
}
const errorBox: React.CSSProperties = { padding: 16, background: "#fff1f2", border: "1px solid #fecaca", borderRadius: 8, color: "#be123c", marginBottom: 16, fontSize: 13 };
const row: React.CSSProperties = { borderTop: `1px solid ${adminPalette.borderSoft}`, padding: "12px 16px" };
const empty: React.CSSProperties = { padding: "48px 24px", textAlign: "center", color: adminPalette.muted };
const tenantLink: React.CSSProperties = { color: adminPalette.blue, textDecoration: "none", fontWeight: 700 };
const mutedSmall: React.CSSProperties = { fontSize: 11, color: adminPalette.muted };
const detailsButton: React.CSSProperties = { background: "transparent", border: "none", color: adminPalette.blue, cursor: "pointer", fontSize: 12, fontWeight: 700 };
const pre: React.CSSProperties = { marginTop: 8, padding: 12, background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}`, borderRadius: 8, fontSize: 11, overflowX: "auto", color: adminPalette.text };
