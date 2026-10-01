"use client";

/**
 * Settings → Staff: "Reset authenticator" for one manager/admin/coach
 * (1 Oct 2026). With TOTP mandatory for managers and admins, a lost phone
 * would lock them out; the owner clears it here (POST /api/staff/[id]/totp-reset,
 * owner only — this page is owner only) and they enrol a new one at their
 * next sign-in. A reason is required and audited. Renders nothing for someone
 * who has not enrolled, and never for the owner (operator-only reset).
 */
import { useState } from "react";
import { ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function StaffTotpResetControl({
  staffId,
  name,
  role,
  totpEnabled,
  onReset,
}: {
  staffId: string;
  name: string;
  role: string;
  totpEnabled: boolean | null | undefined;
  onReset: (message: string) => void | Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (role === "owner" || totpEnabled !== true) return null;

  async function reset() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/staff/${encodeURIComponent(staffId)}/totp-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "Couldn't reset their authenticator — nothing has changed.");
        return;
      }
      setConfirming(false);
      setReason("");
      await onReset(data.message ?? "Authenticator reset.");
    } catch {
      setError("Couldn't reach MatFlow — nothing has changed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="compact"
        onClick={() => { setError(null); setConfirming(true); }}
        aria-label={`Reset ${name}'s authenticator`}
        title="Reset authenticator"
      >
        <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      <ConfirmDialog
        open={confirming}
        onClose={() => { if (!busy) setConfirming(false); }}
        title={`Reset ${name}'s authenticator?`}
        description="Their current authenticator stops working and every signed-in device is signed out. They set up a new one at their next sign-in. This is recorded with your reason."
        confirmLabel="Reset authenticator"
        destructive
        loading={busy}
        onConfirm={reset}
      >
        <label className="mt-3 block text-xs font-medium" style={{ color: "var(--tx-2)" }}>
          Reason (kept in the activity log)
          <input
            aria-label="Reason for the reset"
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. lost phone, confirmed in person"
            minLength={5}
            maxLength={500}
            className="mt-1 w-full rounded-[var(--r-md)] border bg-transparent px-3 py-2 text-sm placeholder:text-[var(--tx-4)]"
            style={{ borderColor: "var(--bd-default)", color: "var(--tx-1)" }}
          />
        </label>
        {reason.trim().length > 0 && reason.trim().length < 5 && (
          <p className="mt-1 text-xs" style={{ color: "var(--tx-3)" }}>A few more words, so the log makes sense later.</p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs" style={{ color: "var(--hue-danger-ink)" }}>{error}</p>
        )}
      </ConfirmDialog>
    </>
  );
}
