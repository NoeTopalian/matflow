"use client";

// Client button — opens a modal asking for a typed reason, then POSTs to
// /api/admin/impersonate. On success, navigates the browser to /dashboard
// where the ImpersonationBanner takes over.

import { useState } from "react";

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
        style={{
          padding: "10px 16px",
          background: "#dc2626",
          color: "white",
          border: "none",
          borderRadius: 8,
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        🛠 Login as {ownerName}
      </button>

      {open && (
        <>
          <div
            onClick={() => !submitting && setOpen(false)}
            style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50 }}
          />
          <div
            style={{
              position: "fixed",
              top: "50%",
              left: "50%",
              transform: "translate(-50%, -50%)",
              width: "90%",
              maxWidth: 500,
              background: "#16181d",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: 12,
              padding: 24,
              zIndex: 51,
              color: "white",
            }}
          >
            <h2 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 8px" }}>
              Confirm impersonation of {ownerName}
            </h2>
            <p style={{ fontSize: 13, opacity: 0.65, margin: "0 0 16px", lineHeight: 1.5 }}>
              Type a brief reason — it&apos;s recorded in the audit log alongside every action you take during this session.
            </p>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. customer reported can&apos;t book class — investigating"
              minLength={5}
              maxLength={500}
              rows={3}
              autoFocus
              style={{
                width: "100%",
                background: "rgba(0,0,0,0.3)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 8,
                padding: 10,
                color: "white",
                fontSize: 13,
                fontFamily: "inherit",
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />
            {error && <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button
                onClick={() => setOpen(false)}
                disabled={submitting}
                style={{
                  padding: "8px 14px",
                  background: "transparent",
                  color: "rgba(255,255,255,0.6)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={start}
                disabled={submitting || reason.trim().length < 5}
                style={{
                  padding: "8px 14px",
                  background: reason.trim().length >= 5 ? "#dc2626" : "rgba(220,38,38,0.4)",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: submitting || reason.trim().length < 5 ? "not-allowed" : "pointer",
                }}
              >
                {submitting ? "Starting…" : "Start impersonation"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
