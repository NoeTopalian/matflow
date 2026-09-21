"use client";

// Owner-only panel for managing the per-tenant public leaderboard URL. Mirrors
// components/dashboard/KioskPanel.tsx, but drives /api/settings/display and the
// DISPLAY token (never the kiosk token) — a photographed TV must not carry a
// check-in credential.
//
// Constraint, as with the kiosk: the raw token is only ever returnable in the
// same response that mints it (the server stores an HMAC hash only). So
// Open / Copy / QR are available during the session in which the token was just
// generated or regenerated; after that only Regenerate / Disable remain.
//
// Non-owner roles see a read-only pill. Uses the Button primitive and tokens
// throughout (docs/UI-RULES.md §5) so it renders correctly on the light staff
// shell.

import { useEffect, useState } from "react";
import { Trophy, Loader2, RefreshCw, Copy, Check, AlertCircle, ExternalLink } from "lucide-react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";

type DisplayStatus = { enabled: boolean; issuedAt: string | null };
type DisplayRevealed = { rawToken: string; url: string; issuedAt: string } | null;

export default function DisplayTokenPanel({
  primaryColor,
  role,
  variant = "card",
}: {
  primaryColor: string;
  role: string;
  variant?: "card" | "compact";
}) {
  const isOwner = role === "owner";

  const [status, setStatus] = useState<DisplayStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<DisplayRevealed>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/settings/display");
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
      const res = await fetch("/api/settings/display", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: act }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not update the leaderboard");
        return;
      }
      if (act === "disable") {
        setStatus({ enabled: false, issuedAt: null });
        setRevealed(null);
        setQrDataUrl(null);
      } else if (data.rawToken) {
        const url = `${window.location.origin}/leaderboard/${data.rawToken}`;
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
        className="flex items-center gap-2 rounded-xl border px-3 py-2 text-xs"
        style={{ borderColor: "var(--bd-default)", background: "var(--sf-1)", color: "var(--tx-3)" }}
      >
        <Trophy className="h-3.5 w-3.5" style={{ color: status.enabled ? "var(--hue-success-ink)" : "var(--tx-4)" }} />
        <span style={{ color: "var(--tx-2)" }}>Leaderboard {status.enabled ? "active" : "disabled"}</span>
        <span style={{ color: "var(--tx-4)" }}>· ask the owner to manage</span>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{ background: `${primaryColor}1f` }}
          >
            <Trophy className="h-5 w-5" style={{ color: primaryColor }} />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
              Attendance Leaderboard
            </h2>
            <p className="mt-0.5 text-xs" style={{ color: "var(--tx-3)" }}>
              {variant === "compact"
                ? "Public TV board of this month's most-active members. Safe to photograph — no personal details."
                : "Mount this URL on a TV in the gym to show this month's most-active members. First name and last initial only — safe to photograph, and it cannot be used to check anyone in."}
            </p>
          </div>
        </div>
        {status?.enabled && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-[10px] font-semibold"
            style={{ background: "var(--sf-2)", color: "var(--hue-success-ink)" }}
          >
            <Check className="h-2.5 w-2.5" /> Active
          </span>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-xs"
          style={{ background: "var(--sf-2)", color: "var(--hue-danger-ink)" }}
        >
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      {status === null ? (
        <div className="flex items-center gap-2 text-xs" style={{ color: "var(--tx-3)" }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      ) : !status.enabled ? (
        <Button onClick={() => action("enable")} loading={busy}>
          Generate leaderboard URL
        </Button>
      ) : (
        <div className="space-y-3">
          {status.issuedAt && (
            <p className="text-xs" style={{ color: "var(--tx-3)" }}>
              Active since {new Date(status.issuedAt).toLocaleDateString("en-GB")}.
              {!revealed && " The URL was shown once when you generated it; if you've lost it, regenerate to mint a new one."}
            </p>
          )}
          {revealed && (
            <div className="space-y-3 rounded-xl border p-3" style={{ borderColor: "var(--bd-default)", background: "var(--sf-2)" }}>
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 break-all rounded-md px-2 py-1.5 font-mono text-xs"
                  style={{ background: "var(--sf-0)", color: "var(--tx-1)" }}
                >
                  {revealed.url}
                </code>
                <Button
                  variant="secondary"
                  size="compact"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(revealed.url);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    } catch {
                      /* clipboard denied */
                    }
                  }}
                >
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <a
                  href={revealed.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-semibold"
                  style={{ borderColor: "var(--bd-default)", color: "var(--tx-2)" }}
                >
                  <ExternalLink className="h-3 w-3" />
                  Open
                </a>
              </div>
              {qrDataUrl && (
                <div className="flex justify-center pt-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrDataUrl} alt="Leaderboard URL QR code" width={192} height={192} className="rounded-lg" />
                </div>
              )}
              <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>
                This URL is shown once. Print it, copy it, or scan the QR with the TV now — you won&apos;t see it again. Lose it? Click Regenerate.
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="compact" onClick={() => action("regenerate")} loading={busy}>
              <RefreshCw className="h-3 w-3" />
              Regenerate URL
            </Button>
            <Button variant="destructive" size="compact" onClick={() => action("disable")} disabled={busy}>
              Disable leaderboard
            </Button>
          </div>
          <p className="text-[11px]" style={{ color: "var(--tx-4)" }}>
            Regenerate immediately invalidates the previous URL — re-pair the TV after.
          </p>
        </div>
      )}
    </div>
  );
}
