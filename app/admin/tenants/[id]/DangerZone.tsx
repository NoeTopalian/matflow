"use client";

// Danger Zone — destructive operator actions on a single tenant.
// Three v1 actions: force password reset, suspend / re-enable, soft-delete.
// Each gates with a typed reason; soft-delete also requires typing the gym
// name + a 7-second cooldown on the confirm button.

import { useEffect, useState } from "react";
import { adminButtonSecondary, adminCard, adminPalette } from "../../admin-theme";
import { Button } from "@/components/ui/button";

// ── Step-up (6 Oct 2026) ─────────────────────────────────────────────────────
// Password, 2FA and ownership changes and deletion need a fresh authenticator
// code. The code buys a 5-minute, single-use grant for THIS action on THIS
// target (lib/operator-step-up.ts); the grant rides in a header.
const STEP_UP_HEADER = "x-matflow-step-up";
const isCode = (s: string) => /^\d{6}$/.test(s.trim());

type StepUpResult = { ok: boolean; status: number; data: Record<string, unknown> & { error?: string } };

async function stepUpFetch(args: {
  stepUpAction: "owner.force_password_reset" | "owner.totp_reset" | "tenant.transfer_ownership" | "tenant.soft_delete" | "tenant.suspend";
  targetId: string;
  code: string;
  url: string;
  init: RequestInit;
  // The canonical intended change the grant is bound to (lib/operator-step-up.ts
  // canonicalStepUpChange). Every Danger Zone action changes only the subject's
  // state, so it is {}; the server binds the grant to that state's version.
  change?: Record<string, string>;
}): Promise<StepUpResult> {
  const su = await fetch("/api/admin/auth/step-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: args.stepUpAction, targetId: args.targetId, change: args.change ?? {}, code: args.code.trim() }),
  });
  const suData = await su.json().catch(() => ({}));
  if (!su.ok || typeof suData?.grant !== "string") {
    return { ok: false, status: su.status, data: { error: suData?.error ?? "Your authenticator code was not accepted." } };
  }
  const headers = new Headers(args.init.headers);
  headers.set(STEP_UP_HEADER, suData.grant);
  const res = await fetch(args.url, { ...args.init, headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }} htmlFor="step-up-code">
        Your authenticator code (confirms it is you)
      </label>
      <input
        id="step-up-code"
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        autoComplete="one-time-code"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
        style={{ ...textarea, height: "auto", fontFamily: "monospace", letterSpacing: 4, textAlign: "center" }}
      />
    </>
  );
}

/**
 * Where a soft-deleted club stands (lib/tenant-lifecycle.ts). Restore is
 * possible only while "recoverable": past the 30-day window, or once the
 * purge has claimed the club, the server refuses it, so no button is offered
 * (review of lane C, D5).
 */
export type DeletionState = "live" | "recoverable" | "window-expired" | "in-progress";

type Props = {
  tenantId: string;
  tenantName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerTotpEnabled?: boolean;
  isSuspended: boolean;
  isDeleted: boolean;
  reviewLockedAt?: string | null;
  deletionState?: DeletionState;
};

export default function DangerZone(props: Props) {
  const { tenantId, tenantName, ownerName, ownerEmail, ownerTotpEnabled, isSuspended, isDeleted, reviewLockedAt } = props;
  const deletionState: DeletionState = props.deletionState ?? (isDeleted ? "recoverable" : "live");
  const inReview = !!reviewLockedAt;
  const [open, setOpen] = useState<null | "reset" | "suspend" | "delete" | "totp" | "transfer" | "review">(null);

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
          title={inReview ? "End review mode" : "Review mode"}
          subtitle={inReview
            ? `In review since ${new Date(reviewLockedAt!).toLocaleString("en-GB")}. Card sign-ups, membership migration, bulk invitations, erasure and deletion are refused until you end it.`
            : "Let the owner inspect imported data while their old platform still takes payments. Refuses card sign-ups, membership migration, bulk invitations, erasure and deletion. Changes nothing else."}
          buttonLabel={inReview ? "End review" : "Start review"}
          onClick={() => setOpen("review")}
          disabled={isDeleted}
          variant={inReview ? "neutral" : "warning"}
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
        {deletionState === "in-progress" ? (
          <Row
            title="Deletion in progress"
            subtitle="Permanent deletion of this gym has started and cannot be undone. Some of its data may already be gone. It cannot be restored."
            buttonLabel={null}
            onClick={() => {}}
            variant="danger"
          />
        ) : deletionState === "window-expired" ? (
          <Row
            title="Recovery window passed"
            subtitle="This gym was deleted more than 30 days ago. It is due for permanent deletion and can no longer be restored."
            buttonLabel={null}
            onClick={() => {}}
            variant="danger"
          />
        ) : (
          <Row
            title={isDeleted ? "Restore gym" : "Soft-delete gym"}
            subtitle={isDeleted ? "Restore this tenant. Members regain access; its data was kept while it was deleted." : "Mark this gym deleted. Disappears from active lists. Reversible for 30 days, then a cron hard-deletes."}
            buttonLabel={isDeleted ? "Restore" : "Soft-delete"}
            onClick={() => setOpen("delete")}
            variant={isDeleted ? "neutral" : "danger"}
          />
        )}
      </div>

      {open === "reset" && <ForceResetModal tenantId={tenantId} ownerEmail={ownerEmail} ownerName={ownerName} onClose={() => setOpen(null)} />}
      {open === "suspend" && <SuspendModal tenantId={tenantId} tenantName={tenantName} isSuspended={isSuspended} onClose={() => setOpen(null)} />}
      {open === "delete" && <DeleteModal tenantId={tenantId} tenantName={tenantName} isDeleted={isDeleted} onClose={() => setOpen(null)} />}
      {open === "review" && <ReviewModal tenantId={tenantId} tenantName={tenantName} inReview={inReview} onClose={() => setOpen(null)} />}
      {open === "totp" && <TotpResetModal tenantId={tenantId} tenantName={tenantName} ownerName={ownerName} ownerTotpEnabled={ownerTotpEnabled} onClose={() => setOpen(null)} />}
      {open === "transfer" && <TransferOwnershipModal tenantId={tenantId} tenantName={tenantName} ownerName={ownerName} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Row({ title, subtitle, buttonLabel, onClick, disabled, variant = "danger" }: { title: string; subtitle: string; buttonLabel: string | null; onClick: () => void; disabled?: boolean; variant?: "danger" | "warning" | "neutral" }) {
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
      {buttonLabel !== null && (
        <button onClick={onClick} disabled={disabled} style={{ padding: "8px 14px", borderRadius: 6, border: `1px solid ${palette.border}`, background: palette.bg, color: palette.color, fontSize: 12, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1, whiteSpace: "nowrap" }}>{buttonLabel}</button>
      )}
    </div>
  );
}

function ForceResetModal({ tenantId, ownerEmail, ownerName, onClose }: { tenantId: string; ownerEmail: string | null; ownerName: string | null; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tempPassword: string; ownerEmail: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const { ok, data } = await stepUpFetch({
        stepUpAction: "owner.force_password_reset",
        targetId: tenantId,
        code,
        url: `/api/admin/customers/${tenantId}/force-password-reset`,
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) },
      });
      setCode("");
      if (!ok) setError(data?.error ?? "Could not reset password");
      else setResult({ tempPassword: String(data.tempPassword), ownerEmail: String(data.ownerEmail) });
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>Force password reset for {ownerName}</h3>
      {result ? (
        <>
          <p style={modalDesc}>Done. Give the temporary password to <code>{result.ownerEmail}</code> through the channel you verified them on. <strong>This is the only time it&apos;s shown, and it stops working after 72 hours.</strong></p>
          <div style={{ background: adminPalette.cardSoft, border: `1px solid ${adminPalette.borderSoft}`, borderRadius: 8, padding: 16, marginBottom: 12, fontFamily: "monospace", fontSize: 16, fontWeight: 700, textAlign: "center" }}>{result.tempPassword}</div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={async () => { try { await navigator.clipboard.writeText(result.tempPassword); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* */ } }} style={btnNeutral}>{copied ? "Copied" : "Copy password"}</button>
            <button onClick={onClose} style={btnPrimary}>Done</button>
          </div>
        </>
      ) : (
        <>
          <p style={modalDesc}>Resets <strong>{ownerEmail ?? ownerName}</strong>&apos;s password and kicks all their sessions. Verify the owner first (call back on the number on file, or email the address on file — never act on an inbound request alone) and record how in the reason.</p>
          <textarea aria-label="Reason for resetting this owner's password" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. owner verified by call-back to number on file, ticket #123" minLength={5} rows={3} autoFocus style={textarea} />
          <CodeField value={code} onChange={setCode} />
          {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
            <button onClick={submit} disabled={submitting || reason.trim().length < 5 || !isCode(code)} style={btnDanger}>{submitting ? "Resetting…" : "Reset password"}</button>
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
  const [code, setCode] = useState("");

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      // Suspending asks for an authenticator code (it signs the whole club
      // out); re-enabling is the recovery direction and does not.
      const { ok, data } = isSuspended
        ? await (async () => {
            const res = await fetch(`/api/admin/customers/${tenantId}/suspend`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
            return { ok: res.ok, data: (await res.json().catch(() => ({}))) as { error?: string } };
          })()
        : await stepUpFetch({
            stepUpAction: "tenant.suspend",
            targetId: tenantId,
            code,
            url: `/api/admin/customers/${tenantId}/suspend`,
            init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) },
          });
      setCode("");
      if (!ok) setError(data?.error ?? "Could not update suspension");
      else window.location.reload();
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>{isSuspended ? `Re-enable ${tenantName}` : `Suspend ${tenantName}`}</h3>
      <p style={modalDesc}>{isSuspended ? "Members will be able to log in again." : "All logins will be rejected until you re-enable. Type a reason."}</p>
      {!isSuspended && (<textarea aria-label="Reason for suspending this tenant" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. unpaid invoice, awaiting compliance review" rows={3} autoFocus style={textarea} />)}
      {!isSuspended && <CodeField value={code} onChange={setCode} />}
      {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
        <button onClick={submit} disabled={submitting || (!isSuspended && (reason.trim().length < 5 || !isCode(code)))} style={isSuspended ? btnPrimary : btnDanger}>{submitting ? "Working…" : isSuspended ? "Re-enable" : "Suspend gym"}</button>
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
  const [code, setCode] = useState("");
  const [billingReview, setBillingReview] = useState<string | null>(null);

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
      // Restore needs no step-up (see the soft-delete route); deletion does.
      const { ok, data } = isDeleted
        ? await (async () => {
            const res = await fetch(`/api/admin/customers/${tenantId}/soft-delete`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
            return { ok: res.ok, data: (await res.json().catch(() => ({}))) as { error?: string; billingReview?: { required?: boolean; reason?: string } } };
          })()
        : await stepUpFetch({
            stepUpAction: "tenant.soft_delete",
            targetId: tenantId,
            code,
            url: `/api/admin/customers/${tenantId}/soft-delete`,
            init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, confirmName }) },
          });
      setCode("");
      const review = (data as { billingReview?: { required?: boolean; reason?: string } })?.billingReview;
      if (!ok) setError(data?.error ?? "Could not update");
      // A restore does not resume member billing: show what to review first.
      else if (isDeleted && review?.required) setBillingReview(review.reason ?? "Review member billing with the club.");
      else window.location.href = "/admin/tenants";
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  if (isDeleted) {
    return (
      <Modal onClose={onClose} disableClose={submitting}>
        <h3 style={modalTitle}>Restore {tenantName}</h3>
        {billingReview ? (
          <>
            <p style={modalDesc}>Restored. Members and staff can sign in again.</p>
            <p role="status" style={{ ...modalDesc, marginTop: 8 }}><strong>Billing to review:</strong> {billingReview}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button onClick={() => { window.location.href = "/admin/tenants"; }} style={btnPrimary}>Done</button>
            </div>
          </>
        ) : (
          <>
            <p style={modalDesc}>This brings the gym back. All members regain access. Its data was kept while it was deleted; member subscriptions that deletion set to stop renewing stay that way until reviewed.</p>
            {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
              <button onClick={submit} disabled={submitting} style={btnPrimary}>{submitting ? "Restoring…" : "Restore"}</button>
            </div>
          </>
        )}
      </Modal>
    );
  }

  const canSubmit = !submitting && cooldownLeft === 0 && reason.trim().length >= 5 && confirmName.trim() === tenantName && understood && isCode(code);

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>Soft-delete {tenantName}</h3>
      <p style={modalDesc}>Marks the gym deleted. Disappears from active lists. Reversible for 30 days; cron hard-deletes after that.</p>
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Reason (audit-logged)</label>
      <textarea aria-label="Reason (audit-logged)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. test gym cleanup, customer requested deletion" rows={3} autoFocus style={textarea} />
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Type the gym name to confirm: <code>{tenantName}</code></label>
      <input aria-label="Type the gym name to confirm:" type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={tenantName} style={{ ...textarea, height: "auto", fontFamily: "monospace" }} />
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, marginTop: 12, cursor: "pointer" }}>
        <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I understand all members will lose access immediately and the gym disappears from active lists.</span>
      </label>
      <CodeField value={code} onChange={setCode} />
      {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
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
  const [code, setCode] = useState("");

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const { ok, data } = await stepUpFetch({
        stepUpAction: "owner.totp_reset",
        targetId: tenantId,
        code,
        url: `/api/admin/customers/${tenantId}/totp-reset`,
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason, confirmName }) },
      });
      setCode("");
      if (!ok) setError(data?.error ?? "Could not reset 2FA");
      else setDone(true);
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  const canSubmit = !submitting && reason.trim().length >= 5 && confirmName.trim() === tenantName && isCode(code);

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
          <textarea aria-label="Reason (audit-logged)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. owner lost phone, verified by call-back to number on file, ticket #123" rows={3} autoFocus style={textarea} />
          <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Type the gym name to confirm: <code>{tenantName}</code></label>
          <input aria-label="Type the gym name to confirm:" type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={tenantName} style={{ ...textarea, height: "auto", fontFamily: "monospace" }} />
          <CodeField value={code} onChange={setCode} />
          {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
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
  const [code, setCode] = useState("");

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
      const { ok, data } = await stepUpFetch({
        stepUpAction: "tenant.transfer_ownership",
        // Bound to the club AND the chosen new owner (lib/operator-step-up.ts stepUpTarget).
        targetId: `${tenantId}/${targetId}`,
        code,
        url: `/api/admin/customers/${tenantId}/transfer-ownership`,
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetUserId: targetId, reason, confirmName }) },
      });
      setCode("");
      const newOwner = data?.newOwner as { email?: string; name?: string } | undefined;
      if (!ok || !newOwner) setError(data?.error ?? "Could not transfer ownership");
      else setDone({ newOwnerEmail: String(newOwner.email ?? ""), newOwnerName: String(newOwner.name ?? "") });
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

  const canSubmit = !submitting && targetId !== "" && reason.trim().length >= 5 && confirmName.trim() === tenantName && isCode(code);

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
        <select aria-label="New owner" value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ ...textarea, height: "auto", fontFamily: "inherit" }}>
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
      <textarea aria-label="Reason (audit-logged)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. ownership change requested by gym, support ticket #123" rows={3} style={textarea} />
      <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Type the gym name to confirm: <code>{tenantName}</code></label>
      <input aria-label="Type the gym name to confirm:" type="text" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={tenantName} style={{ ...textarea, height: "auto", fontFamily: "monospace" }} />
      <CodeField value={code} onChange={setCode} />
      {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <button onClick={onClose} disabled={submitting} style={btnNeutral}>Cancel</button>
        <button onClick={submit} disabled={!canSubmit} style={btnDanger}>{submitting ? "Transferring…" : "Transfer ownership"}</button>
      </div>
    </Modal>
  );
}

function ReviewModal({ tenantId, tenantName, inReview, onClose }: { tenantId: string; tenantName: string; inReview: boolean; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const body = inReview ? undefined : JSON.stringify({ ...(snapshot ? { snapshotAt: new Date(snapshot).toISOString() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      const res = await fetch(`/api/admin/customers/${tenantId}/review-lock`, { method: inReview ? "DELETE" : "POST", headers: { "Content-Type": "application/json" }, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(data?.error ?? "Could not update review mode");
      else window.location.reload();
    } catch { setError("Network error"); }
    finally { setSubmitting(false); }
  }

  return (
    <Modal onClose={onClose} disableClose={submitting}>
      <h3 style={modalTitle}>{inReview ? `End review for ${tenantName}` : `Put ${tenantName} in review`}</h3>
      <p style={modalDesc}>{inReview ? "Card sign-ups, migration, bulk invitations, erasure and deletion become available again." : "The owner sees a banner saying the data is a review copy and that their current platform is still responsible for billing."}</p>
      {!inReview && (
        <>
          <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>When was the source data exported? (shown on the banner)</label>
          <input aria-label="When was the source data exported?" type="datetime-local" value={snapshot} onChange={(e) => setSnapshot(e.target.value)} style={{ ...textarea, height: "auto" }} />
          <label style={{ fontSize: 12, opacity: 0.7, display: "block", marginTop: 12 }}>Note for the owner (optional, e.g. what is still missing)</label>
          <textarea aria-label="Note for the owner" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} rows={2} style={textarea} />
        </>
      )}
      {error && <p role="alert" style={{ color: adminPalette.red, fontSize: 12, margin: "8px 0 0" }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button variant={inReview ? "secondary" : "destructive"} onClick={submit} disabled={submitting}>{submitting ? "Working…" : inReview ? "End review" : "Start review"}</Button>
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
