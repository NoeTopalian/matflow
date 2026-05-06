"use client";

/**
 * /admin/login — super-admin sign-in.
 *
 * Two auth modes:
 *  - "account" (default, preferred): email + password against the Operator
 *    table. POST /api/admin/auth/operator-login. v1.5 of admin auth.
 *  - "secret" (fallback): paste MATFLOW_ADMIN_SECRET. POST /api/admin/auth/login.
 *    Kept as a bootstrap / recovery path. v1 of admin auth.
 *
 * On success either mode redirects to /admin/applications.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "account" | "secret";

export default function AdminLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("account");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const url = mode === "account" ? "/api/admin/auth/operator-login" : "/api/admin/auth/login";
    const payload =
      mode === "account"
        ? { email: email.trim().toLowerCase(), password }
        : { secret: secret.trim() };

    const valid =
      mode === "account"
        ? !!email.trim() && !!password
        : !!secret.trim();
    if (!valid) return;

    setSubmitting(true);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
    <div style={{ minHeight: "100vh", background: "#fafafa", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, color: "#0f172a", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <form onSubmit={submit} style={{ width: "100%", maxWidth: 400, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 16, padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 4px", color: "#0f172a" }}>MatFlow super-admin</h1>
        <p style={{ fontSize: 13, color: "#64748b", margin: "0 0 20px" }}>
          Sign in to manage clients, owners, and platform-level operations.
        </p>

        {/* Mode tabs */}
        <div style={{ display: "flex", gap: 4, padding: 4, background: "#f1f5f9", borderRadius: 10, marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => { setMode("account"); setError(null); }}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: "none", background: mode === "account" ? "#fff" : "transparent", color: mode === "account" ? "#0f172a" : "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: mode === "account" ? "0 1px 2px rgba(0,0,0,0.04)" : undefined }}
          >
            My account
          </button>
          <button
            type="button"
            onClick={() => { setMode("secret"); setError(null); }}
            style={{ flex: 1, padding: "8px 12px", borderRadius: 6, border: "none", background: mode === "secret" ? "#fff" : "transparent", color: mode === "secret" ? "#0f172a" : "#64748b", fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: mode === "secret" ? "0 1px 2px rgba(0,0,0,0.04)" : undefined }}
          >
            Bootstrap secret
          </button>
        </div>

        {mode === "account" ? (
          <>
            <label style={fieldLabel}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@matflow.studio"
              autoComplete="email"
              required
              style={input}
            />
            <label style={{ ...fieldLabel, marginTop: 12 }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              required
              style={input}
            />
          </>
        ) : (
          <>
            <label style={fieldLabel}>
              <code style={{ background: "#f1f5f9", padding: "1px 6px", borderRadius: 4, fontSize: 12 }}>MATFLOW_ADMIN_SECRET</code>
            </label>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="Bootstrap secret"
              autoFocus
              required
              style={input}
            />
            <p style={{ fontSize: 11, color: "#94a3b8", margin: "8px 0 0" }}>
              Use this only when an operator account is unavailable.
            </p>
          </>
        )}

        {error && (
          <p style={{ marginTop: 12, fontSize: 13, color: "#dc2626" }}>{error}</p>
        )}

        <button
          type="submit"
          disabled={submitting || (mode === "account" ? (!email.trim() || !password) : !secret.trim())}
          style={{ width: "100%", marginTop: 16, padding: "10px 14px", borderRadius: 8, background: submitting ? "#94a3b8" : "#0f172a", color: "#fff", fontSize: 14, fontWeight: 600, border: "none", cursor: submitting ? "default" : "pointer", opacity: (mode === "account" ? (!email.trim() || !password) : !secret.trim()) ? 0.5 : 1 }}
        >
          {submitting ? "Verifying…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 600,
  color: "#475569",
  marginBottom: 6,
};

const input: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#fff",
  color: "#0f172a",
  fontSize: 14,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};
