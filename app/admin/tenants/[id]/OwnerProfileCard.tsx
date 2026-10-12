"use client";

// Owner profile — operator card (8 Oct 2026, account-editing lane R, C4).
// Corrects the club owner's DISPLAY NAME only. The operator never chooses the
// owner's password (Danger Zone → Reset password issues a temporary one), never
// enrols or reads their authenticator (Reset 2FA only clears it), never changes
// their role or club; the login email has its own card. Needs a reason (≥10
// characters) and a fresh operator authenticator code, which buys a single-use
// grant for "owner.profile" on THIS club's THIS owner for the "name"
// sub-action (stepUpTarget(tenant, owner, "name")), sent in x-matflow-step-up.

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { adminCard, adminPalette } from "../../admin-theme";

const STEP_UP_HEADER = "x-matflow-step-up";
const REASON_MIN = 10;

type Props = {
  tenantId: string;
  ownerUserId: string;
  ownerName: string;
  disabled?: boolean;
};

export default function OwnerProfileCard({ tenantId, ownerUserId, ownerName: initialName, disabled }: Props) {
  const [ownerName, setOwnerName] = useState(initialName);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initialName);
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSubmit =
    !submitting &&
    trimmed.length > 0 &&
    trimmed.length <= 100 &&
    trimmed !== ownerName &&
    reason.trim().length >= REASON_MIN &&
    /^\d{6}$/.test(code);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const su = await fetch("/api/admin/auth/step-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same shape as stepUpTarget(tenantId, ownerUserId, "name") on the server,
        // bound to THIS name (the change the route re-derives from the body below).
        body: JSON.stringify({ action: "owner.profile", targetId: `${tenantId}/${ownerUserId}/name`, change: { name: trimmed }, code }),
      });
      const suData = await su.json().catch(() => ({}));
      if (!su.ok || typeof suData?.grant !== "string") {
        setError(suData?.error ?? "Your authenticator code was not accepted.");
        return;
      }
      const res = await fetch(`/api/admin/customers/${tenantId}/owner-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [STEP_UP_HEADER]: suData.grant },
        body: JSON.stringify({ name: trimmed, reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "The change was not made.");
        return;
      }
      setOwnerName(String(data.name));
      setName(String(data.name));
      setDone("Name corrected and audit-logged. The owner sees it after their next sign-in; they are not signed out.");
      setOpen(false);
      setReason("");
    } catch {
      setError("Network error. Nothing was confirmed; try again with a new code.");
    } finally {
      setCode("");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ ...adminCard, padding: 24 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 8px" }}>Owner profile</h2>
      <p style={{ fontSize: 13, color: adminPalette.muted, margin: "0 0 12px", lineHeight: 1.5 }}>
        Correct the owner&apos;s display name. You cannot set their password (only reset it to a temporary one), enrol or read their
        authenticator (only reset it), or change their role or club. The owner can change their own name in Settings → Account.
      </p>
      <div style={{ fontSize: 14, marginBottom: 12 }}><strong>{ownerName}</strong></div>

      {!open ? (
        <Button variant="secondary" size="compact" disabled={disabled} onClick={() => { setOpen(true); setDone(null); setError(null); setName(ownerName); }}>
          Correct name
        </Button>
      ) : (
        <div style={{ paddingTop: 12, borderTop: `1px solid ${adminPalette.borderSoft}` }}>
          <label htmlFor="owner-profile-name" style={label}>Owner name</label>
          <input id="owner-profile-name" type="text" autoComplete="off" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} style={field} />
          <label htmlFor="owner-profile-reason" style={label}>Reason (audit-logged, at least {REASON_MIN} characters)</label>
          <textarea
            id="owner-profile-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. club created with a placeholder name; owner confirmed spelling on call; ticket #123"
            style={{ ...field, resize: "vertical" }}
          />
          <label htmlFor="owner-profile-code" style={label}>Your authenticator code (confirms it is you)</label>
          <input
            id="owner-profile-code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            style={{ ...field, fontFamily: "monospace", letterSpacing: 4, textAlign: "center" }}
          />
          {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <Button variant="secondary" onClick={() => { setOpen(false); setError(null); }} disabled={submitting}>Cancel</Button>
            <Button onClick={submit} disabled={!canSubmit} loading={submitting}>Save name</Button>
          </div>
        </div>
      )}

      {done && <p role="status" style={{ fontSize: 13, color: adminPalette.green, margin: "12px 0 0" }}>{done}</p>}
    </div>
  );
}

const label: React.CSSProperties = { fontSize: 12, opacity: 0.7, display: "block", marginTop: 12, marginBottom: 4 };
const field: React.CSSProperties = {
  width: "100%",
  background: adminPalette.card,
  border: `1px solid ${adminPalette.border}`,
  borderRadius: 8,
  padding: 10,
  color: adminPalette.text,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};
