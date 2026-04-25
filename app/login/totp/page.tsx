"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { Loader2, ShieldCheck } from "lucide-react";

export default function TotpPage() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleVerify() {
    if (code.length !== 6) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/totp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (res.ok) {
        router.push("/dashboard");
      } else {
        const data = await res.json() as { error?: string };
        setError(data.error ?? "Invalid code. Try again.");
        setCode("");
        inputRef.current?.focus();
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4" style={{ background: "#0a0a0f" }}>
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "rgba(99,102,241,0.12)", border: "1px solid rgba(99,102,241,0.25)" }}
          >
            <ShieldCheck className="w-7 h-7 text-indigo-400" />
          </div>
          <h1 className="text-white text-xl font-bold tracking-tight">Two-factor authentication</h1>
          <p className="text-gray-500 text-sm mt-1.5">
            Open your authenticator app and enter the 6-digit code.
          </p>
        </div>

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
              if (v.length === 6) {
                setCode(v);
              }
            }}
            onKeyDown={(e) => { if (e.key === "Enter") handleVerify(); }}
            placeholder="000000"
            className="w-full text-center text-2xl font-mono tracking-[0.4em] py-4 rounded-2xl outline-none transition-all border"
            style={{
              background: "rgba(255,255,255,0.04)",
              borderColor: error ? "#ef4444" : "rgba(255,255,255,0.1)",
              color: "white",
            }}
            autoFocus
          />

          {error && (
            <p className="text-red-400 text-sm text-center">{error}</p>
          )}

          <button
            onClick={handleVerify}
            disabled={code.length !== 6 || loading}
            className="w-full py-3.5 rounded-2xl text-white font-bold text-sm disabled:opacity-30 flex items-center justify-center gap-2 transition-all"
            style={{ background: "#6366f1", boxShadow: "0 6px 20px rgba(99,102,241,0.3)" }}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Verify →"}
          </button>

          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="w-full py-3 text-sm text-center transition-colors"
            style={{ color: "rgba(255,255,255,0.3)" }}
          >
            Sign out and use a different account
          </button>
        </div>
      </div>
    </div>
  );
}
