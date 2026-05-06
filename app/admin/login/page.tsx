"use client";

import { ArrowLeft, BadgeCheck, KeyRound, LockKeyhole, LogIn, Mail, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useRouter } from "next/navigation";

type Mode = "account" | "secret";

export default function AdminLoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("account");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [secret, setSecret] = useState("");
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const totpStep = mode === "account" && totpRequired;
  const canSubmit = totpStep
    ? /^\d{6}$/.test(totpCode.trim())
    : mode === "account"
      ? email.trim().length > 0 && password.length > 0
      : secret.trim().length > 0;

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setTotpRequired(false);
    setTotpCode("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || submitting) return;
    setError(null);
    setSubmitting(true);

    const url = totpStep
      ? "/api/admin/auth/operator-totp"
      : mode === "account"
        ? "/api/admin/auth/operator-login"
        : "/api/admin/auth/login";

    const payload = totpStep
      ? { code: totpCode.trim() }
      : mode === "account"
        ? { email: email.trim().toLowerCase(), password }
        : { secret: secret.trim() };

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

      if (mode === "account" && data?.totpRequired === true) {
        setTotpRequired(true);
        setTotpCode("");
        setPassword("");
        setSubmitting(false);
        return;
      }

      router.push("/admin/applications");
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <main style={page}>
      <form onSubmit={submit} style={panel}>
        <div style={brandRow}>
          <div style={brandMark}>
            <ShieldCheck size={20} aria-hidden />
          </div>
          <div>
            <p style={eyebrow}>MatFlow operations</p>
            <h1 style={title}>Admin sign in</h1>
          </div>
        </div>

        {!totpStep && (
          <div style={tabs} role="tablist" aria-label="Admin sign-in method">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "account"}
              onClick={() => switchMode("account")}
              style={tab(mode === "account")}
            >
              <BadgeCheck size={15} aria-hidden />
              Account
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "secret"}
              onClick={() => switchMode("secret")}
              style={tab(mode === "secret")}
            >
              <KeyRound size={15} aria-hidden />
              Bootstrap
            </button>
          </div>
        )}

        {totpStep ? (
          <section>
            <button
              type="button"
              onClick={() => {
                setTotpRequired(false);
                setTotpCode("");
                setError(null);
              }}
              style={backButton}
            >
              <ArrowLeft size={15} aria-hidden />
              Password
            </button>
            <div style={totpHeader}>
              <LockKeyhole size={18} aria-hidden />
              <div>
                <h2 style={sectionTitle}>Two-factor check</h2>
                <p style={sectionCopy}>{email.trim().toLowerCase()}</p>
              </div>
            </div>
            <label style={fieldLabel} htmlFor="totpCode">Authenticator code</label>
            <input
              id="totpCode"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              autoComplete="one-time-code"
              autoFocus
              style={{ ...input, letterSpacing: 6, textAlign: "center", fontVariantNumeric: "tabular-nums" }}
            />
          </section>
        ) : mode === "account" ? (
          <section>
            <label style={fieldLabel} htmlFor="email">Email</label>
            <div style={inputWrap}>
              <Mail size={16} aria-hidden style={inputIcon} />
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@matflow.studio"
                autoComplete="email"
                required
                style={inputWithIcon}
              />
            </div>
            <label style={{ ...fieldLabel, marginTop: 12 }} htmlFor="password">Password</label>
            <div style={inputWrap}>
              <LockKeyhole size={16} aria-hidden style={inputIcon} />
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                required
                style={inputWithIcon}
              />
            </div>
          </section>
        ) : (
          <section>
            <label style={fieldLabel} htmlFor="secret">Bootstrap secret</label>
            <div style={inputWrap}>
              <KeyRound size={16} aria-hidden style={inputIcon} />
              <input
                id="secret"
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="MATFLOW_ADMIN_SECRET"
                autoComplete="current-password"
                autoFocus
                required
                style={inputWithIcon}
              />
            </div>
          </section>
        )}

        {error && <p role="alert" style={errorBox}>{error}</p>}

        <button type="submit" disabled={!canSubmit || submitting} style={submitButton(!canSubmit || submitting)}>
          <LogIn size={16} aria-hidden />
          {submitting ? "Verifying" : totpStep ? "Verify code" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

const page: React.CSSProperties = {
  minHeight: "100vh",
  background: "#f6f8fb",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  color: "#0f172a",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
};

const panel: React.CSSProperties = {
  width: "100%",
  maxWidth: 420,
  background: "#ffffff",
  border: "1px solid #dfe6ef",
  borderRadius: 8,
  padding: 28,
  boxShadow: "0 18px 50px rgba(15, 23, 42, 0.08)",
};

const brandRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  marginBottom: 22,
};

const brandMark: React.CSSProperties = {
  width: 42,
  height: 42,
  borderRadius: 8,
  display: "grid",
  placeItems: "center",
  background: "#0f172a",
  color: "#ffffff",
};

const eyebrow: React.CSSProperties = {
  margin: 0,
  color: "#64748b",
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
};

const title: React.CSSProperties = {
  margin: "2px 0 0",
  color: "#0f172a",
  fontSize: 22,
  lineHeight: 1.15,
  fontWeight: 750,
};

const tabs: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 4,
  padding: 4,
  background: "#eef2f7",
  borderRadius: 8,
  marginBottom: 18,
};

function tab(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    padding: "8px 10px",
    borderRadius: 6,
    border: "none",
    background: active ? "#ffffff" : "transparent",
    color: active ? "#0f172a" : "#64748b",
    fontSize: 13,
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: active ? "0 1px 3px rgba(15, 23, 42, 0.08)" : undefined,
  };
}

const fieldLabel: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  fontWeight: 700,
  color: "#334155",
  marginBottom: 6,
};

const inputWrap: React.CSSProperties = {
  position: "relative",
};

const inputIcon: React.CSSProperties = {
  position: "absolute",
  left: 12,
  top: "50%",
  transform: "translateY(-50%)",
  color: "#64748b",
  pointerEvents: "none",
};

const input: React.CSSProperties = {
  width: "100%",
  minHeight: 44,
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #cbd5e1",
  background: "#ffffff",
  color: "#0f172a",
  fontSize: 14,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
};

const inputWithIcon: React.CSSProperties = {
  ...input,
  paddingLeft: 38,
};

const errorBox: React.CSSProperties = {
  margin: "14px 0 0",
  padding: "10px 12px",
  borderRadius: 8,
  border: "1px solid #fecaca",
  background: "#fff1f2",
  color: "#be123c",
  fontSize: 13,
};

function submitButton(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 44,
    marginTop: 16,
    padding: "10px 14px",
    borderRadius: 8,
    background: disabled ? "#94a3b8" : "#0f172a",
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 750,
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  };
}

const backButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "none",
  background: "transparent",
  color: "#475569",
  fontSize: 13,
  fontWeight: 700,
  padding: 0,
  marginBottom: 16,
  cursor: "pointer",
};

const totpHeader: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: 12,
  border: "1px solid #dfe6ef",
  borderRadius: 8,
  background: "#f8fafc",
  marginBottom: 14,
};

const sectionTitle: React.CSSProperties = {
  margin: 0,
  color: "#0f172a",
  fontSize: 14,
  fontWeight: 750,
};

const sectionCopy: React.CSSProperties = {
  margin: "2px 0 0",
  color: "#64748b",
  fontSize: 12,
};
