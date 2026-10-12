"use client";

// Starts a READ-ONLY support session as the club owner (6 Oct 2026).
// The server needs a reason of at least 10 characters and a fresh
// authenticator code: the code buys a single-use step-up grant for
// "support.impersonate" bound to this club and this person
// (lib/operator-step-up.ts), sent in the x-matflow-step-up header.

import { LogIn } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { adminButtonSecondary, adminPalette } from "../../admin-theme";

const STEP_UP_HEADER = "x-matflow-step-up";
const REASON_MIN = 10;
const isCode = (s: string) => /^\d{6}$/.test(s.trim());

export default function LoginAsOwnerButton({
  ownerUserId,
  ownerName,
}: {
  ownerUserId: string;
  ownerName: string;
}) {
  // The page is /admin/tenants/[id]: the club the grant is bound to.
  const params = useParams<{ id: string }>();
  const tenantId = typeof params?.id === "string" ? params.id : "";
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = reason.trim().length >= REASON_MIN && isCode(code) && !!tenantId && !submitting;

  async function start() {
    setSubmitting(true);
    setError(null);
    try {
      const su = await fetch("/api/admin/auth/step-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "support.impersonate",
          targetId: `${tenantId}/${ownerUserId}`,
          // A support session changes nothing on the person: the grant is
          // bound to their state as it stands (lib/operator-step-up.ts).
          change: {},
          code: code.trim(),
        }),
      });
      const suData = await su.json().catch(() => ({}));
      if (!su.ok || typeof suData?.grant !== "string") {
        setError(suData?.error ?? "Your authenticator code was not accepted.");
        setCode("");
        setSubmitting(false);
        return;
      }
      const res = await fetch("/api/admin/impersonate", {
        method: "POST",
        headers: { "Content-Type": "application/json", [STEP_UP_HEADER]: suData.grant },
        body: JSON.stringify({ targetUserId: ownerUserId, reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "Could not start the support session");
        setCode("");
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
        onClick={() => { setReason(""); setCode(""); setError(null); setOpen(true); }}
        style={dangerButton}
      >
        <LogIn size={16} aria-hidden />
        View as {ownerName} (read-only)
      </button>

      {open && (
        <>
          <div onClick={() => !submitting && setOpen(false)} style={backdrop} />
          <div style={modal} role="dialog" aria-modal="true" aria-labelledby="support-title">
            <h2 id="support-title" style={modalTitle}>Start a read-only support session as {ownerName}</h2>
            <p style={modalDesc}>
              You will see the club as the owner does for 30 minutes. You cannot change anything, export
              personal data or use the operator console until you end it. The reason is recorded in the
              audit log.
            </p>
            <textarea aria-label="Reason for the support session"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. owner reported the timetable shows the wrong coach"
              minLength={REASON_MIN}
              maxLength={500}
              rows={3}
              autoFocus
              style={textarea}
            />
            <label style={{ fontSize: 12, color: adminPalette.muted, display: "block", marginTop: 12 }} htmlFor="support-step-up-code">
              Your authenticator code (confirms it is you)
            </label>
            <input
              id="support-step-up-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              style={{ ...textarea, fontFamily: "monospace", letterSpacing: 4, textAlign: "center" }}
            />
            {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button onClick={() => setOpen(false)} disabled={submitting} style={adminButtonSecondary}>Cancel</button>
              <button onClick={start} disabled={!ready} style={confirmButton(ready)}>
                {submitting ? "Starting" : "Start support session"}
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
