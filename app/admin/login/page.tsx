"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AdminLoginPage() {
  const router = useRouter();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!secret.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: secret.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? `Login failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      router.push("/admin/applications");
    } catch {
      setError("Network error — try again");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a0b0e", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#f5f6f8", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 380, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 28 }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: "0 0 4px" }}>MatFlow super-admin</h1>
        <p style={{ fontSize: 13, color: "rgba(255,255,255,0.55)", margin: "0 0 20px" }}>
          Paste <code style={{ background: "rgba(255,255,255,0.06)", padding: "1px 6px", borderRadius: 4 }}>MATFLOW_ADMIN_SECRET</code> to manage gym applications.
        </p>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="Admin secret"
          autoFocus
          required
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.03)", color: "#fff", fontSize: 14, fontFamily: "inherit", outline: "none" }}
        />
        {error && (
          <p style={{ marginTop: 12, fontSize: 12, color: "#ef4444" }}>{error}</p>
        )}
        <button
          type="submit"
          disabled={submitting || !secret.trim()}
          style={{ width: "100%", marginTop: 16, padding: "10px 14px", borderRadius: 8, background: submitting ? "rgba(255,255,255,0.1)" : "#3b82f6", color: "#fff", fontSize: 14, fontWeight: 600, border: "none", cursor: submitting ? "default" : "pointer", opacity: !secret.trim() ? 0.5 : 1 }}
        >
          {submitting ? "Verifying…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
