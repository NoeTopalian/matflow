"use client";

import { LogIn } from "lucide-react";
import { useState } from "react";
import { adminButtonSecondary, adminPalette } from "../../admin-theme";

export default function LoginAsOwnerButton({
  ownerUserId,
  ownerName,
}: {
  ownerUserId: string;
  ownerName: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: ownerUserId, reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not start impersonation");
        setSubmitting(false);
        return;
      }
      window.location.href = data?.redirectTo ?? "/dashboard";
    } catch {
      setError("Network error");
      setSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setReason(""); setError(null); setOpen(true); }}
        style={dangerButton}
      >
        <LogIn size={16} aria-hidden />
        Login as {ownerName}
      </button>

      {open && (
        <>
          <div onClick={() => !submitting && setOpen(false)} style={backdrop} />
          <div style={modal}>
            <h2 style={modalTitle}>Confirm impersonation of {ownerName}</h2>
            <p style={modalDesc}>
              Type a brief reason. It is recorded in the audit log alongside every action during this session.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. customer reported a booking issue"
              minLength={5}
              maxLength={500}
              rows={3}
              autoFocus
              style={textarea}
            />
            {error && <p style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setOpen(false)} disabled={submitting} style={adminButtonSecondary}>Cancel</button>
              <button onClick={start} disabled={submitting || reason.trim().length < 5} style={confirmButton(reason.trim().length >= 5 && !submitting)}>
                {submitting ? "Starting" : "Start impersonation"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

const dangerButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 16px",
  background: adminPalette.red,
  color: "#ffffff",
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 750,
  cursor: "pointer",
};
const backdrop: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 50 };
const modal: React.CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: "90%",
  maxWidth: 500,
  background: "#ffffff",
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  padding: 24,
  zIndex: 51,
  color: adminPalette.text,
  boxShadow: "0 24px 60px rgba(15, 23, 42, 0.18)",
};
const modalTitle: React.CSSProperties = { fontSize: 18, fontWeight: 750, margin: "0 0 8px" };
const modalDesc: React.CSSProperties = { fontSize: 13, color: adminPalette.muted, margin: "0 0 16px", lineHeight: 1.5 };
const textarea: React.CSSProperties = {
  width: "100%",
  background: "#ffffff",
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  padding: 10,
  color: adminPalette.text,
  fontSize: 13,
  fontFamily: "inherit",
  resize: "vertical",
  boxSizing: "border-box",
};
function confirmButton(enabled: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    background: enabled ? adminPalette.red : "#fecaca",
    color: enabled ? "#ffffff" : "#991b1b",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 750,
    cursor: enabled ? "pointer" : "not-allowed",
  };
}
