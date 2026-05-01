"use client";

/**
 * /login/totp/setup — forced TOTP enrolment for owner accounts (Fix 4).
 *
 * The proxy pins owners with `requireTotpSetup: true` to this page until
 * they enrol. Two-step UI:
 *   1. Show QR code + secret (member scans into Google Authenticator / 1Password)
 *   2. Member enters first 6-digit code → server enables TOTP + clears
 *      requireTotpSetup in the JWT → redirect to /dashboard.
 *
 * No "Skip" button — this is the gate, not the offer.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import Image from "next/image";
import { Loader2, ShieldCheck, Copy, Check } from "lucide-react";

export default function ForcedTotpSetupPage() {
  const router = useRouter();
  const [secret, setSecret] = useState<string>("");
  const [qrDataUrl, setQrDataUrl] = useState<string>("");
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [loadingQr, setLoadingQr] = useState(true);
  const [error, setError] = useState("");
  const [secretCopied, setSecretCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
          // Edge case: enrolment somehow completed elsewhere. Bounce to dashboard.
          router.push("/dashboard");
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
    return () => {
      cancelled = true;
    };
  }, [router]);

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
        // JWT was re-encoded server-side — refresh the session and route to dashboard.
        router.push("/dashboard");
        router.refresh();
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

  function copySecret() {
    if (!secret) return;
    void navigator.clipboard.writeText(secret).then(() => {
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    });
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8" style={{ background: "#0a0a0f" }}>
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.25)" }}
          >
            <ShieldCheck className="w-7 h-7 text-amber-400" />
          </div>
          <h1 className="text-white text-xl font-bold tracking-tight">
            Two-factor authentication required
          </h1>
          <p className="text-gray-500 text-sm mt-1.5 leading-relaxed">
            Owner accounts must enable an authenticator app before continuing.
            Scan the QR code with Google Authenticator, 1Password, or any TOTP app.
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
                style={{ background: "#f59e0b", boxShadow: "0 6px 20px rgba(245,158,11,0.3)" }}
              >
                {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : "Enable two-factor →"}
              </button>

              <button
                onClick={() => signOut({ callbackUrl: "/login" })}
                className="w-full py-3 text-sm text-center transition-colors"
                style={{ color: "rgba(255,255,255,0.3)" }}
              >
                Sign out
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
