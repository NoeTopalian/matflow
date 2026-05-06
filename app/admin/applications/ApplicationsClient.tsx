"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { adminButtonSecondary, adminCard, adminContainer, adminNavLink, adminPage, adminPalette } from "../admin-theme";

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

export default function ApplicationsClient() {
  const router = useRouter();
  const [apps, setApps] = useState<Application[] | null>(null);
  const [filter, setFilter] = useState<"pending" | "all">("pending");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showRejectFor, setShowRejectFor] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/applications?status=${filter}`, { cache: "no-store" });
      if (res.status === 401 || res.status === 403) { router.push("/admin/login"); return; }
      if (!res.ok) { setError(`Load failed (${res.status})`); return; }
      setApps(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    }
  }, [filter, router]);

  useEffect(() => { void load(); }, [load]);

  async function approve(id: string) {
    if (!confirm("Approve this application? Tenant and owner will be created.")) return;
    setBusyId(id);
    try {
      const res = await fetch(`/api/admin/applications/${id}/approve`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setToast({ kind: "err", text: data?.error ?? `Approve failed (${res.status})` }); return; }
      setToast({ kind: "ok", text: `Approved: slug ${data.slug}, owner ${data.ownerEmail}` });
      void load();
    } finally {
      setBusyId(null);
    }
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
    } finally {
      setBusyId(null);
    }
  }

  async function logout() {
    await fetch("/api/admin/auth/logout", { method: "POST" });
    router.push("/admin/login");
  }

  return (
    <div style={adminPage}>
      <div style={{ ...adminContainer, maxWidth: 1100 }}>
        <header style={header}>
          <div>
            <p style={eyebrow}>Super-admin</p>
            <h1 style={title}>Gym Applications</h1>
          </div>
          <nav style={nav}>
            <Link href="/admin" style={adminNavLink}>Dashboard</Link>
            <Link href="/admin/tenants" style={adminNavLink}>Customers</Link>
            <Link href="/admin/security" style={adminNavLink}>Security</Link>
            <select value={filter} onChange={(e) => setFilter(e.target.value as "pending" | "all")} style={select}>
              <option value="pending">Pending</option>
              <option value="all">All</option>
            </select>
            <button onClick={() => void load()} style={adminButtonSecondary}>Reload</button>
            <button onClick={logout} style={adminButtonSecondary}>Sign out</button>
          </nav>
        </header>

        {toast && (
          <div role="status" style={toastBox(toast.kind)}>
            {toast.text}
            <button onClick={() => setToast(null)} style={toastDismiss}>Dismiss</button>
          </div>
        )}

        {error && <p style={errorBox}>{error}</p>}

        {apps === null && !error ? (
          <div style={empty}>Loading...</div>
        ) : apps && apps.length === 0 ? (
          <div style={empty}>No {filter === "pending" ? "pending" : ""} applications.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {apps?.map((a) => (
              <article key={a.id} style={{ ...adminCard, padding: 16 }}>
                <div style={applicationHeader}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <h2 style={cardTitle}>{a.gymName}</h2>
                      <span style={pill(a.status)}>{a.status}</span>
                    </div>
                    <p style={metaLine}>
                      {a.contactName} - <a href={`mailto:${a.email}`} style={link}>{a.email}</a>{a.phone ? ` - ${a.phone}` : ""}
                    </p>
                    <p style={mutedLine}>
                      {a.discipline} - ~{a.memberCount} members - received {new Date(a.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                    </p>
                    {a.notes && <p style={notes}>{a.notes}</p>}
                  </div>
                  {a.status !== "approved" && a.status !== "rejected" && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button disabled={busyId === a.id} onClick={() => approve(a.id)} style={primaryButton(busyId === a.id)}>
                        {busyId === a.id ? "..." : "Approve"}
                      </button>
                      <button disabled={busyId === a.id} onClick={() => { setShowRejectFor(a.id); setRejectReason(""); }} style={adminButtonSecondary}>
                        Reject
                      </button>
                    </div>
                  )}
                </div>

                {showRejectFor === a.id && (
                  <div style={rejectBox}>
                    <p style={mutedLine}>Optional reason, kept in the audit trail:</p>
                    <input
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="e.g. not a fit for the current rollout"
                      style={input}
                    />
                    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                      <button onClick={() => reject(a.id)} disabled={busyId === a.id} style={dangerButton}>
                        Confirm reject
                      </button>
                      <button onClick={() => { setShowRejectFor(null); setRejectReason(""); }} style={adminButtonSecondary}>Cancel</button>
                    </div>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 20,
  flexWrap: "wrap",
};
const eyebrow: React.CSSProperties = { fontSize: 11, fontWeight: 800, textTransform: "uppercase", color: adminPalette.muted, margin: "0 0 4px" };
const title: React.CSSProperties = { fontSize: 24, fontWeight: 750, margin: 0 };
const nav: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const select: React.CSSProperties = { padding: "8px 10px", borderRadius: 8, background: "#ffffff", border: `1px solid ${adminPalette.border}`, color: adminPalette.text, fontSize: 13 };
const errorBox: React.CSSProperties = { padding: "12px 14px", borderRadius: 8, background: "#fff1f2", color: "#be123c", border: "1px solid #fecaca" };
const empty: React.CSSProperties = { ...adminCard, padding: "32px 16px", textAlign: "center", color: adminPalette.muted };
const applicationHeader: React.CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start", justifyContent: "space-between" };
const cardTitle: React.CSSProperties = { fontSize: 15, fontWeight: 750, margin: 0 };
const metaLine: React.CSSProperties = { fontSize: 12, color: adminPalette.muted, margin: "6px 0 4px" };
const mutedLine: React.CSSProperties = { fontSize: 12, color: adminPalette.muted, margin: 0 };
const link: React.CSSProperties = { color: adminPalette.blue, textDecoration: "none", fontWeight: 700 };
const notes: React.CSSProperties = { fontSize: 12, color: adminPalette.muted, margin: "8px 0 0", padding: "8px 10px", background: adminPalette.cardSoft, borderRadius: 8, whiteSpace: "pre-wrap" };
const rejectBox: React.CSSProperties = { marginTop: 12, padding: 12, borderRadius: 8, background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}` };
const input: React.CSSProperties = { width: "100%", padding: "8px 10px", borderRadius: 8, background: "#ffffff", border: `1px solid ${adminPalette.border}`, color: adminPalette.text, fontSize: 13 };
const dangerButton: React.CSSProperties = { padding: "8px 14px", borderRadius: 8, background: adminPalette.red, color: "#ffffff", border: 0, fontSize: 13, fontWeight: 750, cursor: "pointer" };
function primaryButton(disabled: boolean): React.CSSProperties {
  return { padding: "8px 14px", borderRadius: 8, background: adminPalette.blue, color: "#ffffff", border: 0, fontSize: 13, fontWeight: 750, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 };
}
function toastBox(kind: "ok" | "err"): React.CSSProperties {
  return {
    marginBottom: 16,
    padding: "10px 14px",
    borderRadius: 8,
    fontSize: 13,
    background: kind === "ok" ? "#ecfdf5" : "#fff1f2",
    color: kind === "ok" ? adminPalette.green : "#be123c",
    border: `1px solid ${kind === "ok" ? "#bbf7d0" : "#fecaca"}`,
  };
}
const toastDismiss: React.CSSProperties = { marginLeft: 12, background: "none", color: "inherit", border: 0, cursor: "pointer", fontSize: 12, fontWeight: 700 };
function pill(status: string): React.CSSProperties {
  const map: Record<string, { bg: string; fg: string }> = {
    new: { bg: "#eff6ff", fg: adminPalette.blue },
    pending: { bg: "#fffbeb", fg: adminPalette.amber },
    contacted: { bg: "#f5f3ff", fg: "#7c3aed" },
    approved: { bg: "#ecfdf5", fg: adminPalette.green },
    rejected: { bg: "#fef2f2", fg: adminPalette.red },
  };
  const c = map[status] ?? { bg: adminPalette.cardSoft, fg: adminPalette.muted };
  return { fontSize: 10, fontWeight: 800, textTransform: "uppercase", padding: "2px 8px", borderRadius: 999, background: c.bg, color: c.fg };
}
