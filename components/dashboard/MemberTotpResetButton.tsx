"use client";

/**
 * Staff-facing "Reset 2FA" button for a member.
 * 2FA-optional spec (2026-05-07): one of the two unlock paths for an
 * enrolled member's TOTP. The other is the operator route at
 * /api/admin/customers/[id]/member-totp-reset.
 *
 * Only renders when the member has TOTP enabled. Confirms with a prompt
 * before POSTing to /api/members/[id]/totp-reset.
 */
import { useState } from "react";
import { Shield } from "lucide-react";

export default function MemberTotpResetButton({
  memberId,
  memberName,
  totpEnabled,
}: {
  memberId: string;
  memberName: string;
  totpEnabled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!totpEnabled) return null;
  if (done) {
    return (
      <p className="text-xs" style={{ color: "var(--tx-3, #94a3b8)" }}>
        2FA reset for {memberName}. They&apos;ll be prompted to re-enrol on next sign-in.
      </p>
    );
  }

  async function handleReset() {
    const reason = window.prompt(
      `Reset 2FA for ${memberName}? They will need to re-enrol from their settings page.\n\nEnter a reason (min 5 chars):`,
    );
    if (!reason || reason.trim().length < 5) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/members/${memberId}/totp-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to reset 2FA");
        return;
      }
      setDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={handleReset}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50"
        style={{
          borderColor: "rgba(239,68,68,0.25)",
          color: "#ef4444",
          background: "rgba(239,68,68,0.06)",
        }}
      >
        <Shield className="w-3.5 h-3.5" />
        {busy ? "Resetting…" : "Reset 2FA"}
      </button>
      {error && <span className="text-xs" style={{ color: "#f87171" }}>{error}</span>}
    </div>
  );
}
