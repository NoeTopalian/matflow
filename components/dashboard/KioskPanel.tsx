"use client";

// Owner-only panel for managing the per-tenant kiosk URL. Rendered in
// Settings → Integrations and at the top of Mark Attendance so the owner
// has fast access without navigating between pages.
//
// Constraint: the raw token is only ever returnable in the same response
// that mints it (server stores HMAC hash only). So Open / Copy / QR are
// available *during the session in which the token was just generated or
// regenerated*. After that, only Regenerate / Disable remain.
//
// Non-owner roles (manager, coach, admin) see a read-only pill that
// indicates whether the kiosk is active and points them to the owner.

import { useEffect, useState } from "react";
import { QrCode, Loader2, RefreshCw, Copy, Check, AlertCircle, ExternalLink } from "lucide-react";
import QRCode from "qrcode";

type KioskStatus = { enabled: boolean; issuedAt: string | null };
type KioskRevealed = { rawToken: string; url: string; issuedAt: string } | null;

export default function KioskPanel({
  primaryColor,
  role,
  variant = "card",
}: {
  primaryColor: string;
  role: string;
  variant?: "card" | "compact";
}) {
  const isOwner = role === "owner";

  const [status, setStatus] = useState<KioskStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<KioskRevealed>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/settings/kiosk");
      const data = await res.json();
      if (res.ok) setStatus({ enabled: !!data.enabled, issuedAt: data.issuedAt ?? null });
      else setStatus({ enabled: false, issuedAt: null });
    } catch {
      setStatus({ enabled: false, issuedAt: null });
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function action(act: "enable" | "regenerate" | "disable") {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/settings/kiosk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not update kiosk");
        return;
      }
      if (act === "disable") {
        setStatus({ enabled: false, issuedAt: null });
        setRevealed(null);
        setQrDataUrl(null);
      } else if (data.rawToken) {
        const url = `${window.location.origin}/kiosk/${data.rawToken}`;
        setRevealed({ rawToken: data.rawToken, url, issuedAt: data.issuedAt });
        setStatus({ enabled: true, issuedAt: data.issuedAt });
        try {
          const png = await QRCode.toDataURL(url, { width: 256, margin: 1 });
          setQrDataUrl(png);
        } catch {
          setQrDataUrl(null);
        }
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  // Non-owner: read-only pill, regardless of variant.
  if (!isOwner) {
    if (status === null) return null;
    return (
      <div
        className="rounded-xl border px-3 py-2 flex items-center gap-2 text-xs"
        style={{ borderColor: "var(--bd-default)", background: "rgba(255,255,255,0.02)", color: "var(--tx-3)" }}
      >
        <QrCode className="w-3.5 h-3.5" style={{ color: status.enabled ? "#10b981" : "var(--tx-4)" }} />
        <span style={{ color: "var(--tx-2)" }}>
          Kiosk {status.enabled ? "active" : "disabled"}
        </span>
        <span style={{ color: "var(--tx-4)" }}>· ask the owner to manage</span>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border p-5"
      style={{ background: "rgba(255,255,255,0.025)", borderColor: "var(--bd-default)" }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: `${primaryColor}1f` }}
          >
            <QrCode className="w-5 h-5" style={{ color: primaryColor }} />
          </div>
          <div className="min-w-0">
            <h2 className="font-semibold text-sm" style={{ color: "var(--tx-1)" }}>
              Kiosk Check-In
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--tx-3)" }}>
              {variant === "compact"
                ? "iPad URL for self check-in. Disconnected from your admin login."
                : "Mount this URL on an iPad at the front desk so members can check in without staff. Disconnected from your admin login — a stolen iPad cannot reach your dashboard."}
            </p>
          </div>
        </div>
        {status?.enabled && (
          <span
            className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-semibold shrink-0"
            style={{ background: "rgba(16,185,129,0.12)", color: "#10b981" }}
          >
            <Check className="w-2.5 h-2.5" /> Active
          </span>
        )}
      </div>

      {error && (
        <div
          className="mb-3 px-3 py-2 rounded-lg text-xs flex items-center gap-2"
          style={{ background: "rgba(239,68,68,0.08)", color: "#ef4444" }}
        >
          <AlertCircle className="w-3.5 h-3.5" /> {error}
        </div>
      )}

      {status === null ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--tx-3)" }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
        </div>
      ) : !status.enabled ? (
        <button
          onClick={() => action("enable")}
          disabled={busy}
          className="px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-50 inline-flex items-center gap-2"
          style={{ background: primaryColor }}
        >
          {busy && <Loader2 className="w-3 h-3 animate-spin" />}
          Generate kiosk URL
        </button>
      ) : (
        <div className="space-y-3">
          {status.issuedAt && (
            <p className="text-xs" style={{ color: "var(--tx-3)" }}>
              Active since {new Date(status.issuedAt).toLocaleDateString()}.
              {!revealed && " The URL was shown once when you generated it; if you've lost it, regenerate to mint a new one."}
            </p>
          )}
          {revealed && (
            <div
              className="rounded-xl border p-3 space-y-3"
              style={{ borderColor: "var(--bd-default)", background: "rgba(0,0,0,0.04)" }}
            >
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 text-xs font-mono break-all px-2 py-1.5 rounded-md"
                  style={{ background: "rgba(0,0,0,0.06)", color: "var(--tx-1)" }}
                >
                  {revealed.url}
                </code>
                <button
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(revealed.url);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      /* clipboard denied */
                    }
                  }}
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                >
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <a
                  href={revealed.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold border"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                >
                  <ExternalLink className="w-3 h-3" />
                  Open
                </a>
              </div>
              {qrDataUrl && (
                <div className="flex justify-center pt-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="Kiosk URL QR code" width={192} height={192} className="rounded-lg" />
                </div>
              )}
              <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>
                This URL is shown once. Print it, copy it, or scan the QR with the iPad now — you won&apos;t see it again. Lose it? Click Regenerate.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => action("regenerate")}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-50 inline-flex items-center gap-1.5"
              style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Regenerate URL
            </button>
            <button
              onClick={() => action("disable")}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-50"
              style={{ borderColor: "rgba(239,68,68,0.25)", color: "#ef4444", background: "rgba(239,68,68,0.06)" }}
            >
              Disable kiosk
            </button>
          </div>
          <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>
            Regenerate immediately invalidates the previous URL — print new posters / re-pair the iPad after.
          </p>
        </div>
      )}
    </div>
  );
}
