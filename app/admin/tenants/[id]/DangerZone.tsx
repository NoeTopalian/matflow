"use client";

// Danger Zone — destructive operator actions on a single tenant.
// Three v1 actions: force password reset, suspend / re-enable, soft-delete.
// Each gates with a typed reason; soft-delete also requires typing the gym
// name + a 7-second cooldown on the confirm button.

import { useEffect, useState } from "react";
import { adminButtonSecondary, adminCard, adminPalette } from "../../admin-theme";

type Props = {
  tenantId: string;
  tenantName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerTotpEnabled?: boolean;
  isSuspended: boolean;
  isDeleted: boolean;
};

export default function DangerZone(props: Props) {
  const { tenantId, tenantName, ownerName, ownerEmail, ownerTotpEnabled, isSuspended, isDeleted } = props;
  const [open, setOpen] = useState<null | "reset" | "suspend" | "delete" | "totp" | "transfer">(null);

  return (
    <div style={{ ...card, borderColor: "#fecaca", background: "#fff7f7" }}>
      <h2 style={{ ...cardTitle, color: adminPalette.red }}>Danger Zone</h2>
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
          title="Reset owner 2FA"
          subtitle={
            ownerName
              ? `Disable TOTP on ${ownerName}'s account. They will be forced to re-enrol on next login. Use only when the owner has lost their authenticator.`
              : "No owner on this tenant."
          }
          buttonLabel={ownerTotpEnabled ? "Disable 2FA" : "Clear 2FA state"}
          onClick={() => setOpen("totp")}
          disabled={!ownerName || isDeleted}
          variant="warning"
        />
        <Row
          title="Transfer ownership"
          subtitle="Promote an existing manager / coach / admin to owner. The current owner is demoted to manager. Both users are signed out."
          buttonLabel="Transfer"
          onClick={() => setOpen("transfer")}
          disabled={!ownerName || isDeleted}
          variant="warning"
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
      {open === "totp" && <TotpResetModal tenantId={tenantId} tenantName={tenantName} ownerName={ownerName} ownerTotpEnabled={ownerTotpEnabled} onClose={() => setOpen(null)} />}
      {open === "transfer" && <TransferOwnershipModal tenantId={tenantId} tenantName={tenantName} ownerName={ownerName} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Row({ title, subtitle, buttonLabel, onClick, disabled, variant = "danger" }: { title: string; subtitle: string; buttonLabel: string; onClick: () => void; disabled?: boolean; variant?: "danger" | "warning" | "neutral" }) {
  const palette = {
    danger:  { border: "#fecaca", bg: "#fef2f2", color: adminPalette.red },
    warning: { border: "#fde68a", bg: "#fffbeb", color: adminPalette.amber },
    neutral: { border: adminPalette.border, bg: "#ffffff", color: adminPalette.text },
  }[variant];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, padding: 12, background: "#ffffff", border: `1px solid ${adminPalette.borderSoft}`, borderRadius: 8 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: 12, color: adminPalette.muted, marginTop: 2 }}>{subtitle}</div>
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
          <div style={{ background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}`, borderRadius: 8, padding: 16, marginBottom: 12, fontFamily: "monospace", fontSize: 16, fontWeight: 700, textAlign: "center" }}>{result.tempPassword}</div>
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

function TotpResetModal({ tenantId, tenantName, ownerName, ownerTotpEnabled, onClose }: { tenantId: string; tenantName: string; ownerName: string | null; ownerTotpEnabled?: boolean; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${tenantId}/totp-reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason, confirmName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? "Could not reset 2FA");
      else setDone(true);
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  const canSubmit = !submitting && reason.trim().length >= 5 && confirmName.trim() === tenantName;

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>Reset 2FA for {ownerName}</h3>
      {done ? (
        <>
          <p style={modalDesc}>Done. The owner&apos;s TOTP is cleared and all sessions are kicked. They&apos;ll be prompted to re-enrol on their next login.</p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button onClick={onClose} style={btnPrimary}>Close</button>
          </div>
        </>
      ) : (
        <>
          <p style={modalDesc}>
            {ownerTotpEnabled
              ? "Disables TOTP and clears recovery codes. Owner will be prompted to re-enrol on next login."
              : "Owner doesn't currently have TOTP enrolled, but this clears any partial state. Safe to use."}
          </p>
          <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Reason (audit-logged)</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. owner lost phone, support ticket #123" rows={3} autoFocus style={textarea} />
          <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Type the gym name to confirm: <code>{tenantName}</code></label>
          <input type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={tenantName} style={{ ...textarea, height: "auto", fontFamily: "monospace" }} />
          {error && <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
            <button onClick={submit} disabled={!canSubmit} style={btnDanger}>{submitting ? "Resetting…" : "Reset 2FA"}</button>
          </div>
        </>
      )}
    </Modal>
  );
}

type Candidate = { id: string; email: string; name: string; role: string; totpEnabled: boolean };

function TransferOwnershipModal({ tenantId, tenantName, ownerName, onClose }: { tenantId: string; tenantName: string; ownerName: string | null; onClose: () => void }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [targetId, setTargetId] = useState("");
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ newOwnerEmail: string; newOwnerName: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/customers/${tenantId}/transfer-ownership`);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setError(data?.error ?? "Could not load candidates");
        else setCandidates(data.candidates ?? []);
      } catch {
        if (!cancelled) setError("Network error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tenantId]);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${tenantId}/transfer-ownership`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: targetId, reason, confirmName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? "Could not transfer ownership");
      else setDone({ newOwnerEmail: data.newOwner.email, newOwnerName: data.newOwner.name });
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  if (done) {
    return (
      <Modal onClose={onClose} disableClose={false}>
        <h3 style={modalTitle}>Ownership transferred</h3>
        <p style={modalDesc}>
          <strong>{done.newOwnerName}</strong> ({done.newOwnerEmail}) is now the owner of {tenantName}. {ownerName} has been demoted to manager. Both users have been signed out.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={() => window.location.reload()} style={btnPrimary}>Refresh page</button>
        </div>
      </Modal>
    );
  }

  const canSubmit = !submitting && targetId !== "" && reason.trim().length >= 5 && confirmName.trim() === tenantName;

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>Transfer ownership of {tenantName}</h3>
      <p style={modalDesc}>
        Promote a staff user to owner. {ownerName ? <><strong>{ownerName}</strong> will be demoted to manager.</> : null} Both users are signed out and must log in again.
      </p>
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>New owner</label>
      {loading ? (
        <div style={{ ...textarea, height: "auto" }}>Loading candidates…</div>
      ) : candidates && candidates.length > 0 ? (
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ ...textarea, height: "auto", fontFamily: "inherit" }}>
          <option value="">— pick a user —</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.email} ({c.role}){c.totpEnabled ? " · 2FA ✓" : ""}
            </option>
          ))}
        </select>
      ) : (
        <div style={{ ...textarea, height: "auto", opacity: 0.7 }}>
          No eligible staff users on this tenant. Add one via the dashboard first, then come back.
        </div>
      )}
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Reason (audit-logged)</label>
      <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. ownership change requested by gym, support ticket #123" rows={3} style={textarea} />
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Type the gym name to confirm: <code>{tenantName}</code></label>
      <input type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={tenantName} style={{ ...textarea, height: "auto", fontFamily: "monospace" }} />
      {error && <p style={{ color: "#ef4444", fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit} style={btnDanger}>{submitting ? "Transferring…" : "Transfer ownership"}</button>
      </div>
    </Modal>
  );
}

function Modal({ children, onClose, disableClose }: { children: React.ReactNode; onClose: () => void; disableClose?: boolean }) {
  return (
    <>
      <div onClick={() => !disableClose && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 50 }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: "90%", maxWidth: 520, background: "#ffffff", border: `1px solid ${adminPalette.border}`, borderRadius: 8, padding: 24, zIndex: 51, color: adminPalette.text, boxShadow: "0 24px 60px rgba(15, 23, 42, 0.18)" }}>{children}</div>
    </>
  );
}

const card: React.CSSProperties = { ...adminCard, padding: 24 };
const cardTitle: React.CSSProperties = { fontSize: 16, fontWeight: 600, margin: "0 0 8px" };
const cardDesc: React.CSSProperties = { fontSize: 13, color: adminPalette.muted, margin: "0 0 16px", lineHeight: 1.5 };
const modalTitle: React.CSSProperties = { fontSize: 18, fontWeight: 600, margin: "0 0 8px" };
const modalDesc: React.CSSProperties = { fontSize: 13, color: adminPalette.muted, margin: "0 0 16px", lineHeight: 1.5 };
const textarea: React.CSSProperties = { width: "100%", background: "#ffffff", border: `1px solid ${adminPalette.border}`, borderRadius: 8, padding: 10, color: adminPalette.text, fontSize: 13, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box" };
const btnNeutral: React.CSSProperties = adminButtonSecondary;
const btnPrimary: React.CSSProperties = { padding: "8px 14px", background: adminPalette.blue, color: "white", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" };
const btnDanger: React.CSSProperties = { padding: "8px 14px", background: adminPalette.red, color: "white", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer" };
