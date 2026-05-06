"use client";

// Cross-tenant audit-log viewer with filter chips + cursor pagination.

import Link from "next/link";
import { useEffect, useState } from "react";

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
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Activity</h1>
          <p style={{ opacity: 0.6, margin: "4px 0 0", fontSize: 14 }}>Cross-tenant audit log · {items.length} loaded</p>
        </div>
        <nav style={{ display: "flex", gap: 16, fontSize: 13, alignItems: "center" }}>
          <Link href="/admin/tenants" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>← Tenants</Link>
          <Link href="/admin/applications" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>Applications</Link>
        </nav>
      </header>

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap", alignItems: "center", padding: "4px 6px", background: "#16181d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}>
        <span style={{ fontSize: 11, opacity: 0.5, padding: "0 6px" }}>Action</span>
        {ACTION_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setActionFilter(f.value)}
            style={{
              padding: "4px 10px",
              borderRadius: 6,
              border: "none",
              background: actionFilter === f.value ? "rgba(255,255,255,0.12)" : "transparent",
              color: actionFilter === f.value ? "white" : "rgba(255,255,255,0.55)",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <div style={{ padding: 16, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, color: "#ef4444", marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      <div style={{ background: "#16181d", borderRadius: 12, overflow: "hidden", border: "1px solid rgba(255,255,255,0.07)" }}>
        {items.length === 0 && !loading ? (
          <div style={{ padding: "48px 24px", textAlign: "center", opacity: 0.5 }}>No activity yet.</div>
        ) : (
          <div>
            {items.map((r) => (
              <div key={r.id} style={{ borderTop: "1px solid rgba(255,255,255,0.05)", padding: "12px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                      <code style={{ background: actionPalette(r.action), padding: "2px 8px", borderRadius: 4, fontSize: 12, color: actionFg(r.action), fontWeight: 600 }}>
                        {r.action}
                      </code>
                      <span style={{ fontSize: 13 }}>
                        on{" "}
                        <strong>{r.entityType}</strong>{" "}
                        {r.tenantSlug && (
                          <Link href={`/admin/tenants/${r.tenantId}`} style={{ color: "rgba(255,255,255,0.7)", textDecoration: "none" }}>
                            @ {r.tenantSlug}
                          </Link>
                        )}
                      </span>
                      <span style={{ fontSize: 11, opacity: 0.5 }}>
                        {new Date(r.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                      {r.actorEmail ? <>by {r.actorName ?? r.actorEmail}</> : <span style={{ opacity: 0.5 }}>system</span>}
                      {r.metadata && typeof r.metadata === "object" && "actingAs" in r.metadata && (
                        <span style={{ marginLeft: 8, color: "#f59e0b" }}>(impersonated)</span>
                      )}
                      {r.ipApprox && <span style={{ marginLeft: 8, opacity: 0.5 }}>· {r.ipApprox}</span>}
                    </div>
                  </div>
                  <button
                    onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                    style={{ background: "transparent", border: "none", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 11 }}
                  >
                    {expanded === r.id ? "Hide" : "Details"}
                  </button>
                </div>
                {expanded === r.id && (
                  <pre style={{ marginTop: 8, padding: 12, background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6, fontSize: 11, overflowX: "auto", color: "rgba(255,255,255,0.7)" }}>
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
          <button
            onClick={() => fetchPage(false, nextCursor)}
            disabled={loading}
            style={{ padding: "8px 18px", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, color: "white", fontSize: 13, fontWeight: 600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.6 : 1 }}
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </>
  );
}

function actionPalette(action: string): string {
  if (action.startsWith("admin.impersonate")) return "rgba(245,158,11,0.15)";
  if (action.startsWith("admin.")) return "rgba(239,68,68,0.12)";
  if (action.startsWith("auth.")) return "rgba(99,102,241,0.12)";
  if (action.startsWith("payment.") || action.startsWith("invoice.")) return "rgba(16,185,129,0.12)";
  if (action.startsWith("attendance.")) return "rgba(56,189,248,0.12)";
  return "rgba(255,255,255,0.08)";
}

function actionFg(action: string): string {
  if (action.startsWith("admin.impersonate")) return "#f59e0b";
  if (action.startsWith("admin.")) return "#ef4444";
  if (action.startsWith("auth.")) return "#818cf8";
  if (action.startsWith("payment.") || action.startsWith("invoice.")) return "#10b981";
  if (action.startsWith("attendance.")) return "#38bdf8";
  return "rgba(255,255,255,0.7)";
}
