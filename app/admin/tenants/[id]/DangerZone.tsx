"use client";

// Danger Zone — destructive operator actions on a single tenant.
// Three v1 actions: force password reset, suspend / re-enable, soft-delete.
// Each gates with a typed reason; soft-delete also requires typing the gym
// name + a 7-second cooldown on the confirm button.

import { useEffect, useState } from "react";

type Props = {
  tenantId: string;
  tenantName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  isSuspended: boolean;
  isDeleted: boolean;
};

export default function DangerZone(props: Props) {
  const { tenantId, tenantName, ownerName, ownerEmail, isSuspended, isDeleted } = props;
  const [open, setOpen] = useState<null | "reset" | "suspend" | "delete">(null);

  return (
    <div style={{ ...card, borderColor: "rgba(239,68,68,0.2)", background: "rgba(239,68,68,0.03)" }}>
      <h2 style={{ ...cardTitle, color: "#ef4444" }}>Danger Zone</h2>
      <p style={cardDesc}>
        Destructive operations on <strong>{tenantName}</strong>. Each is audit-logged with both your admin context and a required reason.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Row
          title="Force password reset"
          subtitle={ownerName ? `Resets ${ownerName}'s password to a fresh temp value. Kicks all their sessions. You'll get the new password once — share it via your support channel.` : "No owner on this tenant."}
          buttonLabel="Reset password"
          onClick={() => setOpen("reset")}
          disabled={!ownerName || isDeleted}
        />
        <Row
          title={isSuspended ? "Re-enable gym" : "Suspend gym"}
          subtitle={isSuspended ? "Restore login access for all members and staff." : "Reject all logins until re-enabled. No data is deleted. Reversible."}
          buttonLabel={isSuspended ? "Re-enable" : "Suspend"}
          onClick={() => setOpen("suspend")}
          disabled={isDeleted}
          variant={isSuspended ? "neutral" : "warning"}
        />
        <Row
          title={isDeleted ? "Restore gym" : "Soft-delete gym"}
          subtitle={isDeleted ? "Restore this tenant. Members regain access; data is unchanged." : "Mark this gym deleted. Disappears from active lists. Reversible for 30 days, then a cron hard-deletes."}
          buttonLabel={isDeleted ? "Restore" : "Soft-delete"}
          onClick={() => setOpen("delete")}
          variant={isDeleted ? "neutral" : "danger"}
        />
      </div>

      {open === "reset" && <ForceResetModal tenantId={tenantId} ownerEmail={ownerEmail} ownerName={ownerName} onClose={() => setOpen(null)} />}
      {open === "suspend" && <SuspendModal tenantId={tenantId} tenantName={tenantName} isSuspended={isSuspended} onClose={() => setOpen(null)} />}
      {open === "delete" && <DeleteModal tenantId={tenantId} tenantName={tenantName} isDeleted={isDeleted} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Row({ title, subtitle, buttonLabel, onClick, disabled, variant = "danger" }: { title: string; subtitle: string; buttonLabel: string; onClick: () => void; disabled?: boolean; variant?: "danger" | "warning" | "neutral" }) {
  const palette = {
    danger:  { border: "rgba(239,68,68,0.3)", bg: "rgba(239,68,68,0.1)", color: "#ef4444" },
    warning: { border: "rgba(245,158,11,0.3)", bg: "rgba(245,158,11,0.1)", color: "#f59e0b" },
    neutral: { border: "rgba(255,255,255,0.15)", bg: "rgba(255,255,255,0.04)", color: "white" },
  }[variant];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: 12, background: "rgba(0,0,0,0.2)", borderRadius: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, opacity: 0.7, marginTop: 2 }}>{subtitle}</div>
      </div>
      <button onClick={onClick} disabled={disabled} style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${palette.border}`, background: palette.bg, color: palette.color, fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, whiteSpace: "nowrap" }}>{buttonLabel}</button>
    </div>
  );
}

function ForceResetModal({ tenantId, ownerEmail, ownerName, onClose }: { tenantId: string; ownerEmail: string | null; ownerName: string | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tempPassword: string; ownerEmail: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${tenantId}/force-password-reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? "Could not reset password");
      else setResult({ tempPassword: data.tempPassword, ownerEmail: data.ownerEmail });
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>Force password reset for {ownerName}</h3>
      {result ? (
        <>
          <p style={modalDesc}>Done. Send the temp password to <code>{result.ownerEmail}</code> via your support channel. <strong>This is the only time it&apos;s shown.</strong></p>
          <div style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: 16, marginBottom: 12, fontFamily: "monospace", fontSize: 16, fontWeight: 600, textAlign: "center", letterSpacing: "0.1em" }}>{result.tempPassword}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={async () => { try { await navigator.clipboard.writeText(result.tempPassword); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } }} style={btnNeutral}>{copied ? "Copied" : "Copy password"}</button>
            <button onClick={onClose} style={btnPrimary}>Done</button>
          </div>
        </>
      ) : (
        <>
          <p style={modalDesc}>Resets <strong>{ownerEmail ?? ownerName}</strong>&apos;s password and kicks all their sessions. Type a reason for the audit log.</p>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. customer reported can&apos;t log in" minLength={5} rows={3} autoFocus style={textarea} />
          {error && <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
            <button onClick={submit} disabled={submitting || reason.trim().length < 5} style={btnDanger}>{submitting ? "Resetting…" : "Reset password"}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

function SuspendModal({ tenantId, tenantName, isSuspended, onClose }: { tenantId: string; tenantName: string; isSuspended: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${tenantId}/suspend`, { method: isSuspended ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: isSuspended ? undefined : JSON.stringify({ reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? "Could not update suspension");
      else window.location.reload();
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>{isSuspended ? `Re-enable ${tenantName}` : `Suspend ${tenantName}`}</h3>
      <p style={modalDesc}>{isSuspended ? "Members will be able to log in again." : "All logins will be rejected until you re-enable. Type a reason."}</p>
      {!isSuspended && (<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. unpaid invoice, awaiting compliance review" rows={3} autoFocus style={textarea} />)}
      {error && <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
        <button onClick={submit} disabled={submitting || (!isSuspended && reason.trim().length < 5)} style={isSuspended ? btnPrimary : btnDanger}>{submitting ? "Working…" : isSuspended ? "Re-enable" : "Suspend gym"}</button>
      </div>
    </Modal>
  );
}

function DeleteModal({ tenantId, tenantName, isDeleted, onClose }: { tenantId: string; tenantName: string; isDeleted: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [understood, setUnderstood] = useState(false);
  const [cooldownLeft, setCooldownLeft] = useState(7);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isDeleted) { setCooldownLeft(0); return; }
    setCooldownLeft(7);
    const t = setInterval(() => setCooldownLeft((n) => (n <= 0 ? 0 : n - 1)), 1000);
    return () => clearInterval(t);
  }, [isDeleted]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${tenantId}/soft-delete`, { method: isDeleted ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body: isDeleted ? undefined : JSON.stringify({ reason, confirmName }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? "Could not update");
      else window.location.href = "/admin/tenants";
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  if (isDeleted) {
    return (
      <Modal onClose={onClose} disableClose={submitting}>
        <h3 style={modalTitle}>Restore {tenantName}</h3>
        <p style={modalDesc}>This brings the gym back. All members regain access. No data was lost.</p>
        {error && <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
          <button onClick={submit} disabled={submitting} style={btnPrimary}>{submitting ? "Restoring…" : "Restore"}</button>
        </div>
      </Modal>
    );
  }

  const canSubmit = !submitting && cooldownLeft === 0 && reason.trim().length >= 5 && confirmName.trim() === tenantName && understood;

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>Soft-delete {tenantName}</h3>
      <p style={modalDesc}>Marks the gym deleted. Disappears from active lists. Reversible for 30 days; cron hard-deletes after that.</p>
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Reason (audit-logged)</label>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. test gym cleanup, customer requested deletion" rows={3} autoFocus style={textarea} />
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Type the gym name to confirm: <code>{tenantName}</code></label>
      <input type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={tenantName} style={{ ...textarea, height: "auto", fontFamily: "monospace" }} />
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, marginTop: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I understand all members will lose access immediately and the gym disappears from active lists.</span>
      </label>
      {error && <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit} style={btnDanger}>{submitting ? "Deleting…" : cooldownLeft > 0 ? `Wait ${cooldownLeft}s…` : "Soft-delete gym"}</button>
      </div>
    </Modal>
  );
}

function Modal({ children, onClose, disableClose }: { children: React.ReactNode; onClose: () => void; disableClose?: boolean }) {
  return (
    <>
      <div onClick={() => !disableClose && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 50 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "90%", maxWidth: 520, background: "#16181d", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 12, padding: 24, zIndex: 51, color: "white" }}>{children}</div>
    </>
  );
}

const card: React.CSSProperties = { background: "#16181d", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 24 };
const cardTitle: React.CSSProperties = { fontSize: 16, fontWeight: 600, margin: "0 0 8px" };
const cardDesc: React.CSSProperties = { fontSize: 13, opacity: 0.65, margin: "0 0 16px", lineHeight: 1.5 };
const modalTitle: React.CSSProperties = { fontSize: 18, fontWeight: 600, margin: "0 0 8px" };
const modalDesc: React.CSSProperties = { fontSize: 13, opacity: 0.7, margin: "0 0 16px", lineHeight: 1.5 };
const textarea: React.CSSProperties = { width: "100%", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: 10, color: "white", fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" };
const btnNeutral: React.CSSProperties = { padding: "8px 14px", background: "transparent", color: "rgba(255,255,255,0.6)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 13, cursor: "pointer" };
const btnPrimary: React.CSSProperties = { padding: "8px 14px", background: "#3b82f6", color: "white", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" };
const btnDanger: React.CSSProperties = { padding: "8px 14px", background: "#dc2626", color: "white", border: "none", borderRadius: 6, fontSize: 13, fontWeight: 600, cursor: "pointer" };
