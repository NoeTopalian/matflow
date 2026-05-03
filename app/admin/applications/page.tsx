"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Application = {
  id: string;
  gymName: string;
  contactName: string;
  email: string;
  phone: string | null;
  discipline: string;
  memberCount: string;
  notes: string | null;
  status: string;
  createdAt: string;
};

export default function AdminApplicationsPage() {
  const router = useRouter();
  const [apps, setApps] = useState<Application[] | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRejectFor, setShowRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch(`/api/admin/applications?status=${filter}`, { cache: "no-store" });
      if (res.status === 401) { router.push("/admin/login"); return; }
      if (!res.ok) { setError(`Load failed (${res.status})`); return; }
      setApps(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  }

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filter]);

  async function approve(id: string) {
    if (!confirm("Approve this application? Tenant + owner will be created and an activation email sent.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/applications/${id}/approve`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setToast({ kind: "err", text: data?.error ?? `Approve failed (${res.status})` }); return; }
      setToast({ kind: "ok", text: `Approved — slug ${data.slug}, owner ${data.ownerEmail}` });
      void load();
    } finally { setBusyId(null); }
  }

  async function reject(id: string) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/applications/${id}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: rejectReason.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setToast({ kind: "err", text: data?.error ?? `Reject failed (${res.status})` }); return; }
      setToast({ kind: "ok", text: "Rejected" });
      setShowRejectFor(null);
      setRejectReason("");
      void load();
    } finally { setBusyId(null); }
  }

  async function logout() {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    router.push("/admin/login");
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0e", color: "#f5f6f8", fontFamily: "system-ui, -apple-system, sans-serif", padding: "24px 16px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(255,255,255,0.4)", margin: "0 0 4px" }}>Super-admin</p>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Gym Applications</h1>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as "pending" | "all")}
              style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", fontSize: 13 }}
            >
              <option value="pending">Pending</option>
              <option value="all">All</option>
            </select>
            <button onClick={() => void load()} style={btnSecondary}>Reload</button>
            <button onClick={logout} style={{ ...btnSecondary, color: "rgba(255,255,255,0.5)" }}>Sign out</button>
          </div>
        </header>

        {toast && (
          <div role="status" style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 10, fontSize: 13, background: toast.kind === "ok" ? "rgba(16,185,129,0.12)" : "rgba(239,68,68,0.12)", color: toast.kind === "ok" ? "#34d399" : "#f87171", border: `1px solid ${toast.kind === "ok" ? "rgba(16,185,129,0.25)" : "rgba(239,68,68,0.25)"}` }}>
            {toast.text}
            <button onClick={() => setToast(null)} style={{ marginLeft: 12, background: "none", color: "inherit", border: 0, cursor: "pointer", fontSize: 12 }}>dismiss</button>
          </div>
        )}

        {error && (
          <p style={{ padding: "12px 14px", borderRadius: 10, background: "rgba(239,68,68,0.1)", color: "#f87171", border: "1px solid rgba(239,68,68,0.2)" }}>{error}</p>
        )}

        {apps === null && !error ? (
          <p style={{ color: "rgba(255,255,255,0.4)" }}>Loading…</p>
        ) : apps && apps.length === 0 ? (
          <p style={{ padding: "32px 16px", textAlign: "center", color: "rgba(255,255,255,0.4)", borderRadius: 12, border: "1px dashed rgba(255,255,255,0.1)" }}>
            No {filter === "pending" ? "pending" : ""} applications.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {apps?.map((a) => (
              <div key={a.id} style={{ padding: 16, borderRadius: 12, background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start", justifyContent: "space-between" }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <h2 style={{ fontSize: 15, fontWeight: 700, margin: 0 }}>{a.gymName}</h2>
                      <span style={pill(a.status)}>{a.status}</span>
                    </div>
                    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", margin: "6px 0 4px" }}>
                      {a.contactName} · <a href={`mailto:${a.email}`} style={{ color: "#60a5fa" }}>{a.email}</a>{a.phone ? ` · ${a.phone}` : ""}
                    </p>
                    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", margin: 0 }}>
                      {a.discipline} · ~{a.memberCount} members · received {new Date(a.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                    {a.notes && (
                      <p style={{ fontSize: 12, color: "rgba(255,255,255,0.55)", margin: "8px 0 0", padding: "8px 10px", background: "rgba(0,0,0,0.25)", borderRadius: 6, whiteSpace: "pre-wrap" }}>{a.notes}</p>
                    )}
                  </div>
                  {a.status !== "approved" && a.status !== "rejected" && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <button
                        disabled={busyId === a.id}
                        onClick={() => approve(a.id)}
                        style={{ ...btnPrimary, opacity: busyId === a.id ? 0.5 : 1 }}
                      >
                        {busyId === a.id ? "…" : "Approve"}
                      </button>
                      <button
                        disabled={busyId === a.id}
                        onClick={() => { setShowRejectFor(a.id); setRejectReason(""); }}
                        style={{ ...btnSecondary, opacity: busyId === a.id ? 0.5 : 1 }}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>

                {showRejectFor === a.id && (
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 8, background: "rgba(0,0,0,0.25)" }}>
                    <p style={{ fontSize: 12, color: "rgba(255,255,255,0.6)", margin: "0 0 6px" }}>Optional reason (kept in audit log only):</p>
                    <input
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="e.g. Not in target market"
                      style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)", color: "#fff", fontSize: 13 }}
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button onClick={() => reject(a.id)} disabled={busyId === a.id} style={{ ...btnPrimary, background: "#ef4444" }}>
                        Confirm reject
                      </button>
                      <button onClick={() => { setShowRejectFor(null); setRejectReason(""); }} style={btnSecondary}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: "8px 14px", borderRadius: 8, background: "#3b82f6", color: "#fff",
  border: 0, fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,0.05)",
  color: "#fff", border: "1px solid rgba(255,255,255,0.1)", fontSize: 13, cursor: "pointer",
};
function pill(status: string): React.CSSProperties {
  const map: Record<string, { bg: string; fg: string }> = {
    new:       { bg: "rgba(96,165,250,0.15)", fg: "#60a5fa" },
    pending:   { bg: "rgba(245,158,11,0.15)", fg: "#f59e0b" },
    contacted: { bg: "rgba(167,139,250,0.15)", fg: "#a78bfa" },
    approved:  { bg: "rgba(16,185,129,0.15)", fg: "#10b981" },
    rejected:  { bg: "rgba(239,68,68,0.15)",  fg: "#f87171" },
  };
  const c = map[status] ?? { bg: "rgba(255,255,255,0.1)", fg: "rgba(255,255,255,0.6)" };
  return {
    fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em",
    padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg,
  };
}
