"use client";

import { Suspense, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { Loader2, CheckCircle2, ArrowLeft } from "lucide-react";

// useSearchParams() forces this page to opt out of prerender — wrap in
// Suspense so Next 16 can serve the shell while the token is read on the
// client. Without this, `npm run build` fails with a prerender error.
export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<div className="min-h-screen" style={{ background: "#111111" }} />}>
      <AcceptInviteForm />
    </Suspense>
  );
}

function AcceptInviteForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // Surface a missing-token error from the initial state — avoids the
  // cascading-render warning of a setState() inside useEffect on mount.
  const [error, setError] = useState<string | null>(
    token ? null : "Missing invite token. Check the link in your email.",
  );
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < 10) { setError("Password must be at least 10 characters."); return; }
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      setError("Password must include upper, lower, and a number.");
      return;
    }
    if (password !== confirm) { setError("Passwords don't match."); return; }

    setSubmitting(true);
    try {
      const res = await fetch("/api/members/accept-invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not set your password. Try again.");
        setSubmitting(false);
        return;
      }
      setDone(true);
      // Sign the member in straight away with the new password — they
      // shouldn't have to retype it on the login screen.
      const signinRes = await signIn("credentials", {
        email: data.email,
        password,
        tenantSlug: data.tenantSlug,
        redirect: false,
      });
      if (signinRes?.error) {
        // Edge case — password set but credentials sign-in failed. Fall back
        // to the login page with the email pre-filled.
        router.push(`/login?email=${encodeURIComponent(data.email)}`);
        return;
      }
      router.push("/member/home");
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: "#111111" }}>
      <div className="w-full max-w-[360px]">
        {done ? (
          <div className="text-center">
            <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6" style={{ background: "rgba(59,130,246,0.16)" }}>
              <CheckCircle2 className="w-8 h-8" style={{ color: "#3b82f6" }} />
            </div>
            <h1 className="text-xl font-bold text-white mb-2">Signing you in…</h1>
            <p className="text-sm" style={{ color: "rgba(255,255,255,0.45)" }}>One moment.</p>
          </div>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-white text-center mb-2">Set up your account</h1>
            <p className="text-sm text-center mb-8 leading-relaxed" style={{ color: "rgba(255,255,255,0.45)" }}>
              Choose a password — at least 10 characters with one upper, one lower, and one number.
            </p>

            <form onSubmit={onSubmit} className="space-y-3">
              <input
                type="password"
                placeholder="New password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting || !token}
                className="w-full rounded-xl px-4 py-4 text-white text-sm outline-none"
                style={{ background: "#1c1c1c", border: "1px solid rgba(255,255,255,0.1)" }}
              />
              <input
                type="password"
                placeholder="Confirm password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={submitting || !token}
                className="w-full rounded-xl px-4 py-4 text-white text-sm outline-none"
                style={{ background: "#1c1c1c", border: "1px solid rgba(255,255,255,0.1)" }}
              />

              {error && (
                <div
                  className="rounded-xl px-4 py-3 text-xs border"
                  style={{ color: "#f87171", background: "rgba(239,68,68,0.08)", borderColor: "rgba(239,68,68,0.2)" }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !token}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 hover:opacity-90 active:scale-[0.99]"
                style={{ background: "#3b82f6" }}
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Set password and sign in"}
              </button>
            </form>

            {!token && (
              <div className="mt-8 text-center space-y-3">
                <Link
                  href="/login"
                  className="inline-flex items-center gap-1.5 text-sm text-white/60 hover:text-white transition-colors"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Back to sign in
                </Link>
                <p className="text-xs" style={{ color: "rgba(255,255,255,0.35)" }}>
                  Need a new invite link? Ask your gym to resend it.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
