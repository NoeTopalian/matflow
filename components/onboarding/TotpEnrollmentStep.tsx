"use client";

/**
 * Two-factor (TOTP) enrolment UI — single source of truth for the flow.
 *
 * Renders the same 3-phase enrol → verify → recovery-codes flow used by
 * both the standalone /login/totp/setup page (recovery surface for owners
 * who bypassed the wizard) and the new wizard step inside
 * OwnerOnboardingWizard.
 *
 * Drives the API at /api/auth/totp/setup (GET = generate QR, POST =
 * verify the typed code + enable TOTP + re-encode JWT) and
 * /api/auth/totp/recovery-codes (POST = generate 8 codes, shown ONCE).
 *
 * Caller passes onComplete (where to go once recovery codes are
 * acknowledged) and primaryColor (used for the action buttons so the
 * wizard maintains tenant-brand consistency; the standalone page passes
 * the gym's primaryColor too).
 */
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Loader2, ShieldCheck, Copy, Check, KeyRound, Download } from "lucide-react";

type Phase = "enrol" | "recovery";

export default function TotpEnrollmentStep({
  onComplete,
  primaryColor,
  onAlreadyEnabled,
}: {
  onComplete: () => void;
  primaryColor: string;
  /** Optional callback if /api/auth/totp/setup GET reports the user already
   *  enrolled — wizard can advance immediately, standalone page can redirect. */
  onAlreadyEnabled?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("enrol");

  // Phase 1 — enrolment
  const [secret, setSecret] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [loadingQr, setLoadingQr] = useState(true);
  const [error, setError] = useState("");
  const [secretCopied, setSecretCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Phase 2 — recovery codes
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryLoading, setRecoveryLoading] = useState(false);
  const [savedAck, setSavedAck] = useState(false);
  const [allCopied, setAllCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/totp/setup", { method: "GET" });
        if (!res.ok) {
          setError("Could not initialise two-factor setup. Please refresh.");
          return;
        }
        const data = (await res.json()) as { secret: string; qrDataUrl: string; alreadyEnabled?: boolean };
        if (cancelled) return;
        if (data.alreadyEnabled) {
          if (onAlreadyEnabled) onAlreadyEnabled();
          else onComplete();
          return;
        }
        setSecret(data.secret);
        setQrDataUrl(data.qrDataUrl);
      } catch {
        if (!cancelled) setError("Network error loading setup. Please refresh.");
      } finally {
        if (!cancelled) setLoadingQr(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleVerify() {
    if (code.length !== 6) return;
    setVerifying(true);
    setError("");
    try {
      const res = await fetch("/api/auth/totp/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        await loadRecoveryCodes();
        setPhase("recovery");
      } else {
        const data = (await res.json()) as { error?: string };
        setError(data.error ?? "Invalid code. Try again.");
        setCode("");
        inputRef.current?.focus();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setVerifying(false);
    }
  }

  async function loadRecoveryCodes() {
    setRecoveryLoading(true);
    try {
      const res = await fetch("/api/auth/totp/recovery-codes", { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { codes: string[] };
        setRecoveryCodes(data.codes ?? []);
      } else {
        setError("Could not generate recovery codes. You can regenerate them later from Settings → Account.");
      }
    } catch {
      setError("Network error generating recovery codes.");
    } finally {
      setRecoveryLoading(false);
    }
  }

  function copySecret() {
    if (!secret) return;
    void navigator.clipboard.writeText(secret).then(() => {
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    });
  }

  function copyAllRecoveryCodes() {
    if (recoveryCodes.length === 0) return;
    const text = recoveryCodes.join("\n");
    void navigator.clipboard.writeText(text).then(() => {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 2000);
    });
  }

  function downloadRecoveryCodes() {
    const text =
      "MatFlow — Two-Factor Recovery Codes\n" +
      "Generated: " + new Date().toLocaleString() + "\n" +
      "\n" +
      "Each code can be used ONCE to recover access if you lose your\n" +
      "authenticator device. Store somewhere safe (1Password, password\n" +
      "manager, printed in a safe). DO NOT email or screenshot these.\n" +
      "\n" +
      recoveryCodes.map((c, i) => `${i + 1}. ${c}`).join("\n") + "\n";
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "matflow-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="w-full max-w-md mx-auto">
      {/* ── Phase 1: TOTP enrolment ── */}
      {phase === "enrol" && (
        <>
          <div className="text-center mb-8">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)" }}
            >
              <ShieldCheck className="w-7 h-7 text-amber-400" />
            </div>
            <h1 className="text-white text-xl font-bold tracking-tight">
              Set up two-factor authentication
            </h1>
            <p className="text-gray-500 text-sm mt-1.5 leading-relaxed">
              Scan the QR code with Google Authenticator, 1Password, or any TOTP app, then enter the 6-digit code.
            </p>
          </div>

          {loadingQr ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
            </div>
          ) : (
            <>
              {qrDataUrl && (
                <div className="mb-4 flex justify-center">
                  <div className="rounded-2xl bg-white p-4">
                    <Image src={qrDataUrl} alt="TOTP QR code" width={200} height={200} unoptimized />
                  </div>
                </div>
              )}

              {secret && (
                <button
                  onClick={copySecret}
                  className="w-full mb-6 flex items-center justify-between gap-2 px-4 py-3 rounded-xl text-xs font-mono transition-colors"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    color: "rgba(255,255,255,0.6)",
                  }}
                  aria-label="Copy secret to clipboard"
                >
                  <span className="truncate">{secret}</span>
                  {secretCopied ? (
                    <Check className="w-4 h-4 text-emerald-400 shrink-0" />
                  ) : (
                    <Copy className="w-4 h-4 shrink-0" />
                  )}
                </button>
              )}

              <div className="space-y-4">
                <input
                  ref={inputRef}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, "");
                    setCode(v);
                    setError("");
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleVerify(); }}
                  placeholder="000000"
                  className="w-full text-center text-2xl font-mono tracking-[0.4em] py-4 rounded-2xl outline-none transition-all border"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    borderColor: error ? "#ef4444" : "rgba(255,255,255,0.1)",
                    color: "white",
                  }}
                  autoFocus
                />

                {error && <p className="text-red-400 text-sm text-center">{error}</p>}

                <button
                  onClick={handleVerify}
                  disabled={code.length !== 6 || verifying}
                  className="w-full py-3.5 rounded-2xl text-white font-bold text-sm disabled:opacity-30 flex items-center justify-center gap-2 transition-all"
                  style={{ background: primaryColor, boxShadow: `0 6px 20px ${primaryColor}55` }}
                >
                  {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : "Enable two-factor →"}
                </button>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Phase 2: Recovery codes (one-time display) ── */}
      {phase === "recovery" && (
        <>
          <div className="text-center mb-6">
            <div
              className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
              style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)" }}
            >
              <KeyRound className="w-7 h-7 text-indigo-400" />
            </div>
            <h1 className="text-white text-xl font-bold tracking-tight">
              Save your recovery codes
            </h1>
            <p className="text-gray-500 text-sm mt-1.5 leading-relaxed">
              If you lose your phone, each of these codes can be used <strong>once</strong> to recover access. Store them somewhere safe — a password manager works well.
            </p>
          </div>

          {recoveryLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-gray-500" />
            </div>
          ) : recoveryCodes.length === 0 ? (
            <div className="rounded-2xl border p-4 mb-4 text-center" style={{ background: "rgba(239,68,68,0.06)", borderColor: "rgba(239,68,68,0.24)" }}>
              <p className="text-sm text-red-400 mb-3">{error || "No recovery codes generated."}</p>
              <button
                onClick={loadRecoveryCodes}
                className="px-4 py-2 rounded-xl text-xs font-bold text-white"
                style={{ background: "#ef4444" }}
              >
                Retry
              </button>
            </div>
          ) : (
            <>
              <div
                className="grid grid-cols-2 gap-2 p-4 rounded-2xl border mb-4"
                style={{ background: "rgba(99,102,241,0.04)", borderColor: "rgba(99,102,241,0.15)" }}
              >
                {recoveryCodes.map((codeStr, i) => (
                  <div
                    key={codeStr}
                    className="font-mono text-xs px-2 py-2 rounded-lg text-center"
                    style={{ background: "rgba(255,255,255,0.04)", color: "rgba(255,255,255,0.85)" }}
                  >
                    <span className="opacity-50 mr-1">{i + 1}.</span>
                    {codeStr}
                  </div>
                ))}
              </div>

              <div className="flex gap-2 mb-4">
                <button
                  onClick={copyAllRecoveryCodes}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold border transition-colors"
                  style={{ background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.85)" }}
                >
                  {allCopied ? (
                    <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copied</>
                  ) : (
                    <><Copy className="w-3.5 h-3.5" /> Copy all</>
                  )}
                </button>
                <button
                  onClick={downloadRecoveryCodes}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold border transition-colors"
                  style={{ background: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.85)" }}
                >
                  <Download className="w-3.5 h-3.5" /> Download .txt
                </button>
              </div>

              <label className="flex items-start gap-3 p-4 rounded-2xl border cursor-pointer transition-colors mb-4"
                style={{
                  background: savedAck ? "rgba(34,197,94,0.06)" : "rgba(255,255,255,0.03)",
                  borderColor: savedAck ? "rgba(34,197,94,0.3)" : "rgba(255,255,255,0.08)",
                }}
              >
                <input
                  type="checkbox"
                  checked={savedAck}
                  onChange={(e) => setSavedAck(e.target.checked)}
                  className="mt-0.5 w-4 h-4 shrink-0 cursor-pointer"
                />
                <span className="text-xs leading-relaxed" style={{ color: "rgba(255,255,255,0.75)" }}>
                  I&apos;ve saved my recovery codes somewhere safe. I understand they will not be shown again, and I can regenerate a new set anytime from <strong>Settings → Account</strong>.
                </span>
              </label>

              <button
                onClick={() => savedAck && onComplete()}
                disabled={!savedAck}
                className="w-full py-3.5 rounded-2xl text-white font-bold text-sm disabled:opacity-30 flex items-center justify-center gap-2 transition-all"
                style={{ background: primaryColor, boxShadow: `0 6px 20px ${primaryColor}55` }}
              >
                Continue →
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
