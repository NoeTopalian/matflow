"use client";

import { ShieldCheck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { adminButtonSecondary, adminCard, adminContainer, adminNavLink, adminPage, adminPalette } from "../admin-theme";

type SetupState =
  | { loading: true }
  | { loading: false; alreadyEnabled: true }
  | { loading: false; alreadyEnabled: false; secret: string; qrDataUrl: string };

export default function SecurityClient() {
  const [state, setState] = useState<SetupState>({ loading: true });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setError(null);
    const res = await fetch("/api/admin/auth/operator-totp/setup", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(data?.error ?? `Could not load security settings (${res.status})`);
      setState({ loading: false, alreadyEnabled: true });
      return;
    }
    setState({ loading: false, ...data });
  }

  useEffect(() => { void load(); }, []);

  async function verify() {
    if (!/^\d{6}$/.test(code) || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/operator-totp/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not enable 2FA");
        return;
      }
      setSuccess(true);
      setState({ loading: false, alreadyEnabled: true });
      setCode("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={adminPage}>
      <div style={{ ...adminContainer, maxWidth: 760 }}>
        <header style={header}>
          <div>
            <h1 style={title}>Security</h1>
            <p style={subtitle}>Operator account protection</p>
          </div>
          <nav style={nav}>
            <Link href="/admin" style={adminNavLink}>Dashboard</Link>
            <Link href="/admin/tenants" style={adminNavLink}>Tenants</Link>
          </nav>
        </header>

        <section style={{ ...adminCard, padding: 24 }}>
          <div style={sectionHeader}>
            <div style={iconBox}><ShieldCheck size={20} aria-hidden /></div>
            <div>
              <h2 style={sectionTitle}>Two-factor authentication</h2>
              <p style={sectionCopy}>Require an authenticator code after password sign-in.</p>
            </div>
          </div>

          {state.loading ? (
            <div style={mutedPanel}>Loading...</div>
          ) : state.alreadyEnabled ? (
            <div style={successPanel}>
              {success ? "2FA is now enabled for your operator account." : "2FA is enabled for your operator account."}
            </div>
          ) : (
            <div style={setupGrid}>
              <div>
                <Image src={state.qrDataUrl} alt="Operator 2FA QR code" width={220} height={220} style={qr} unoptimized />
              </div>
              <div>
                <label style={label}>Secret</label>
                <code style={secretBox}>{state.secret}</code>
                <label style={{ ...label, marginTop: 14 }}>Authenticator code</label>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  style={input}
                />
                {error && <p style={errorText}>{error}</p>}
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button onClick={verify} disabled={!/^\d{6}$/.test(code) || submitting} style={primaryButton(!/^\d{6}$/.test(code) || submitting)}>
                    {submitting ? "Enabling" : "Enable 2FA"}
                  </button>
                  <button onClick={() => void load()} style={adminButtonSecondary}>Refresh</button>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

const header: React.CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, marginBottom: 24, flexWrap: "wrap" };
const title: React.CSSProperties = { fontSize: 28, fontWeight: 750, margin: 0 };
const subtitle: React.CSSProperties = { color: adminPalette.muted, margin: "4px 0 0", fontSize: 14 };
const nav: React.CSSProperties = { display: "flex", gap: 16, fontSize: 13, alignItems: "center" };
const sectionHeader: React.CSSProperties = { display: "flex", gap: 12, alignItems: "center", marginBottom: 18 };
const iconBox: React.CSSProperties = { width: 42, height: 42, borderRadius: 8, background: adminPalette.brand, color: "#ffffff", display: "grid", placeItems: "center" };
const sectionTitle: React.CSSProperties = { fontSize: 18, fontWeight: 750, margin: 0 };
const sectionCopy: React.CSSProperties = { color: adminPalette.muted, margin: "3px 0 0", fontSize: 13 };
const mutedPanel: React.CSSProperties = { padding: 16, background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}`, borderRadius: 8, color: adminPalette.muted };
const successPanel: React.CSSProperties = { padding: 16, background: "#ecfdf5", border: "1px solid #bbf7d0", borderRadius: 8, color: adminPalette.green, fontWeight: 700 };
const setupGrid: React.CSSProperties = { display: "grid", gridTemplateColumns: "minmax(180px, 220px) 1fr", gap: 18, alignItems: "start" };
const qr: React.CSSProperties = { width: "100%", maxWidth: 220, border: `1px solid ${adminPalette.border}`, borderRadius: 8 };
const label: React.CSSProperties = { display: "block", fontSize: 12, color: adminPalette.muted, fontWeight: 750, marginBottom: 6 };
const secretBox: React.CSSProperties = { display: "block", padding: 10, background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}`, borderRadius: 8, color: adminPalette.text, fontSize: 12, wordBreak: "break-all" };
const input: React.CSSProperties = { width: "100%", padding: "10px 12px", borderRadius: 8, border: `1px solid ${adminPalette.border}`, color: adminPalette.text, fontSize: 18, letterSpacing: 6, textAlign: "center", boxSizing: "border-box" };
const errorText: React.CSSProperties = { color: adminPalette.red, fontSize: 12, margin: "8px 0 0" };
function primaryButton(disabled: boolean): React.CSSProperties {
  return { padding: "8px 14px", borderRadius: 8, background: disabled ? "#94a3b8" : adminPalette.brand, color: "#ffffff", border: 0, fontSize: 13, fontWeight: 750, cursor: disabled ? "not-allowed" : "pointer" };
}
