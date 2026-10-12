"use client";

// Settings → Account → Login email (7 Oct 2026, US-002).
//
// Shows the address the signed-in staff user types to sign in, with a
// "Provisional — unverified" badge when it is an identifier MatFlow has not
// verified as their mailbox, and a change form that needs the current password
// AND a fresh authenticator code. A successful change signs this device out
// too (every session is revoked server-side): the person signs in again with
// the new address, their password and their authenticator.
//
// There is no verify-by-link flow yet, so a new address is saved as
// provisional whatever the mail switch says. The copy names the switch's real
// state (GET returns emailDelivery from lib/email-delivery.ts) instead of
// assuming email is off (review defect 3, 7 Oct 2026).

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/ErrorState";
import { Skeleton } from "@/components/ui/Skeleton";

type State = {
  email: string;
  provisional: boolean;
  provisionalSince: string | null;
  totpEnabled: boolean;
  emailDelivery: "on" | "off";
};

export default function LoginEmailCard() {
  const [state, setState] = useState<State | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const res = await fetch("/api/account/login-email", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      setState((await res.json()) as State);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const canSubmit = !submitting && /\S+@\S+\.\S+/.test(newEmail.trim()) && password.length > 0 && /^\d{6}$/.test(code);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/account/login-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newEmail: newEmail.trim(), currentPassword: password, totpCode: code }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Your login email could not be changed.");
        return;
      }
      setChanged(true);
    } catch {
      setError("Couldn't reach the server. Nothing was changed — try again.");
    } finally {
      setPassword("");
      setCode("");
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <h2 className="font-semibold text-sm mb-1" style={{ color: "var(--tx-1)" }}>Login email</h2>
      <p className="text-xs mb-4" style={{ color: "var(--tx-3)" }}>
        The address you sign in with. It is not your club&apos;s public contact address.
      </p>

      {loadError ? (
        <ErrorState message="Couldn't load your login email." onRetry={() => void load()} />
      ) : !state ? (
        <Skeleton className="h-6 w-64" />
      ) : changed ? (
        <div role="status" className="space-y-3">
          <p className="text-sm" style={{ color: "var(--tx-2)" }}>
            Your login email has been changed. You have been signed out on every device, including this one. Sign in again with the new
            address, your password and your authenticator code.
          </p>
          <p className="text-sm" style={{ color: "var(--tx-2)" }}>
            The code you just entered has been used and will not work again. Wait for your authenticator app to show a new code
            before you sign in.
          </p>
          <Button onClick={() => window.location.assign("/login")}>Go to sign in</Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium break-all" style={{ color: "var(--tx-1)" }}>{state.email}</span>
            {state.provisional ? (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: "var(--sf-1)", border: "1px solid var(--hue-warning)", color: "var(--hue-warning-ink)" }}>
                Provisional — unverified
              </span>
            ) : (
              // Not "Verified": MatFlow has no mailbox-verification flow yet, so an
              // unmarked address is unproven too (review of lanes P + M, 7 Oct 2026).
              <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold" style={{ background: "var(--sf-1)", border: "1px solid var(--bd-default)", color: "var(--tx-3)" }}>
                Not marked provisional
              </span>
            )}
          </div>
          {state.provisional && (
            <p className="text-xs mt-2" style={{ color: "var(--tx-3)" }}>
              MatFlow has not verified that you read this mailbox, so password-reset codes and sign-in links are never sent to it. You sign in
              with your password and authenticator. If you lose either, MatFlow support recovers your account after checking it is you.
            </p>
          )}

          {!state.totpEnabled ? (
            <p className="text-xs mt-3" style={{ color: "var(--tx-3)" }}>Set up two-factor authentication (below) before changing your login email.</p>
          ) : !open ? (
            <div className="mt-4">
              <Button variant="secondary" size="compact" onClick={() => setOpen(true)}>Change login email</Button>
            </div>
          ) : (
            <form onSubmit={submit} className="mt-4 space-y-3" noValidate>
              <div>
                <label htmlFor="login-email-new" className="block text-xs font-medium mb-1" style={{ color: "var(--tx-2)" }}>New login email</label>
                <input
                  id="login-email-new"
                  type="email"
                  autoComplete="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                />
              </div>
              <div>
                <label htmlFor="login-email-password" className="block text-xs font-medium mb-1" style={{ color: "var(--tx-2)" }}>Current password</label>
                <input
                  id="login-email-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                />
              </div>
              <div>
                <label htmlFor="login-email-code" className="block text-xs font-medium mb-1" style={{ color: "var(--tx-2)" }}>Authenticator code</label>
                <input
                  id="login-email-code"
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={6}
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  className="w-full rounded-lg border px-3 py-2 text-sm font-mono tracking-widest"
                  style={{ background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
                />
              </div>
              <p className="text-xs" style={{ color: "var(--tx-3)" }}>
                {state.emailDelivery === "off"
                  ? "Email is turned off, so the new address cannot be verified by link: it is saved as provisional (unverified)."
                  : "MatFlow cannot verify the new address by link yet, so it is saved as provisional (unverified) and no reset codes or sign-in links are sent to it."}{" "}
                Your account, role, password and authenticator stay the same. Every device is signed out.
              </p>
              {error && <p role="alert" className="text-xs" style={{ color: "var(--hue-danger-ink)" }}>{error}</p>}
              <div className="flex gap-2 justify-end">
                <Button type="button" variant="secondary" onClick={() => { setOpen(false); setError(null); }} disabled={submitting}>Cancel</Button>
                <Button type="submit" disabled={!canSubmit} loading={submitting}>Change login email</Button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}
