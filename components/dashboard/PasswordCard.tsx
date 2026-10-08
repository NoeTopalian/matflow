"use client";

// Settings → Account → Password (8 Oct 2026, account-editing lane R, C2).
//
// Self-service password change after activation: current password, new
// password (twice) and — when the account has an authenticator — a fresh
// 6-digit code, which is spent and will not work again. On success EVERY
// device is signed out, this one included (same decision as the login-email
// change), and the person signs in with the new password and their
// authenticator. A temporary password is replaced at /set-password, not here.
//
// Forgotten password: "Forgot password" on the sign-in page sends a reset code
// only to a login email that is not provisional, and only while email delivery
// is on; otherwise MatFlow support resets it after checking identity. The card
// says that rather than promising an email.

import { useState } from "react";
import { Button } from "@/components/ui/button";

type Props = {
  /** Whether this account has an authenticator (then a code is required). */
  totpEnabled: boolean;
};

const RULES = "At least 10 characters, with an upper-case letter, a lower-case letter and a number. Not one you have used recently.";

export default function PasswordCard({ totpEnabled }: Props) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit =
    !submitting &&
    current.length > 0 &&
    next.length >= 10 &&
    next === confirm &&
    (!totpEnabled || /^\d{6}$/.test(code));

  function reset() {
    setCurrent("");
    setNext("");
    setConfirm("");
    setCode("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          totpEnabled
            ? { currentPassword: current, newPassword: next, totpCode: code }
            : { currentPassword: current, newPassword: next },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data?.error === "string" ? data.error : "Your password could not be changed.");
        return;
      }
      setChanged(true);
    } catch {
      setError("Couldn't reach the server. Nothing was changed — try again.");
    } finally {
      reset();
      setSubmitting(false);
    }
  }

  const field = "w-full rounded-lg border px-3 py-2 text-sm";
  const fieldStyle = { background: "var(--sf-0)", borderColor: "var(--bd-default)", color: "var(--tx-1)" } as const;
  const labelCls = "block text-xs font-medium mb-1";

  return (
    <div className="rounded-2xl border p-5" style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}>
      <h2 className="font-semibold text-sm mb-1" style={{ color: "var(--tx-1)" }}>Password</h2>
      <p className="text-xs mb-4" style={{ color: "var(--tx-3)" }}>
        Change the password you sign in with. {totpEnabled ? "You confirm with your current password and a code from your authenticator." : "You confirm with your current password."}
      </p>

      {changed ? (
        <div role="status" className="space-y-3">
          <p className="text-sm" style={{ color: "var(--tx-2)" }}>
            Your password has been changed. You have been signed out on every device, including this one. Sign in again with your new
            password{totpEnabled ? " and your authenticator code" : ""}.
          </p>
          {totpEnabled && (
            <p className="text-sm" style={{ color: "var(--tx-2)" }}>
              The code you just entered has been used and will not work again. Wait for your authenticator app to show a new code before you
              sign in.
            </p>
          )}
          <Button onClick={() => window.location.assign("/login")}>Go to sign in</Button>
        </div>
      ) : !open ? (
        <Button variant="secondary" size="compact" onClick={() => setOpen(true)}>Change password</Button>
      ) : (
        <form onSubmit={submit} className="space-y-3" noValidate>
          <div>
            <label htmlFor="pw-current" className={labelCls} style={{ color: "var(--tx-2)" }}>Current password</label>
            <input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} className={field} style={fieldStyle} />
          </div>
          <div>
            <label htmlFor="pw-new" className={labelCls} style={{ color: "var(--tx-2)" }}>New password</label>
            <input id="pw-new" type="password" autoComplete="new-password" aria-describedby="pw-rules" value={next} onChange={(e) => setNext(e.target.value)} className={field} style={fieldStyle} />
            <p id="pw-rules" className="text-[11px] mt-1" style={{ color: "var(--tx-3)" }}>{RULES}</p>
          </div>
          <div>
            <label htmlFor="pw-confirm" className={labelCls} style={{ color: "var(--tx-2)" }}>Confirm new password</label>
            <input id="pw-confirm" type="password" autoComplete="new-password" aria-invalid={mismatch} value={confirm} onChange={(e) => setConfirm(e.target.value)} className={field} style={fieldStyle} />
            {mismatch && <p className="text-[11px] mt-1" style={{ color: "var(--hue-danger-ink)" }}>The two new passwords do not match.</p>}
          </div>
          {totpEnabled && (
            <div>
              <label htmlFor="pw-code" className={labelCls} style={{ color: "var(--tx-2)" }}>Authenticator code</label>
              <input
                id="pw-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                className={`${field} font-mono tracking-widest`}
                style={fieldStyle}
              />
            </div>
          )}
          <p className="text-xs" style={{ color: "var(--tx-3)" }}>
            Every device is signed out, this one included. Your login email, role and authenticator stay the same.
          </p>
          {error && <p role="alert" className="text-xs" style={{ color: "var(--hue-danger-ink)" }}>{error}</p>}
          <div className="flex gap-2 justify-end">
            <Button type="button" variant="secondary" onClick={() => { setOpen(false); setError(null); reset(); }} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={!canSubmit} loading={submitting}>Change password</Button>
          </div>
        </form>
      )}

      {!changed && (
        <p className="mt-3 text-[11px]" style={{ color: "var(--tx-4)" }}>
          Forgotten it? Sign out and use &ldquo;Forgot password&rdquo; on the sign-in page. A reset code is only sent when email is turned on and your
          login email is not provisional; otherwise MatFlow support resets it after checking it is you.
        </p>
      )}
    </div>
  );
}
