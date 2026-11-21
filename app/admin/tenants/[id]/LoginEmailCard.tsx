"use client";

// Login email — operator card (7 Oct 2026, US-001/US-002).
// Shows the owner's current login email and whether it is a provisional
// identifier (unverified) or simply not marked (MatFlow has never verified
// any mailbox — review defect 2), with three audited actions: mark
// provisional, confirm (clear the mark — operator attestation only) and
// change. Each needs a reason and a fresh authenticator code; the code buys a
// single-use grant for "owner.login_email" on THIS club's THIS owner for THIS
// sub-action (lib/operator-step-up.ts stepUpTarget(tenant, owner, action) —
// review defect 7), sent in the x-matflow-step-up header. Copy that mentions
// email follows the real mail switch (emailDelivery prop — review defect 3).

//
// Conflict resolution (admin hub lane F, 9 Oct 2026): "Check address" asks
// the operator-only check route who holds an address in this club; when a
// member holds it, the guided ConflictPanel moves that member's contact
// address and then changes the owner's login address (two step-ups). A
// half-finished resolution is resumed from the URL after a reload. Since
// 12 Oct 2026 a staff account or every holder of a duplicate can be moved
// too (resume carries &staff=<id>), and the heading says plainly that this is
// the owner's back-office sign-in, not a member record.

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import ConflictPanel, { checkLoginAddress, loadResume, type CheckResult, type ResumeState } from "@/components/admin/ConflictPanel";
import { adminCard, adminPalette, adminPill } from "../../admin-theme";

const STEP_UP_HEADER = "x-matflow-step-up";
const REASON_MIN = 10;

type Mode = "mark_provisional" | "clear_provisional" | "change";

type Props = {
  tenantId: string;
  ownerUserId: string;
  ownerName: string;
  ownerEmail: string;
  provisionalSince: string | null;
  /** lib/email-delivery.ts emailDeliveryMode(), read on the server. */
  emailDelivery: "on" | "off";
  disabled?: boolean;
};

export default function LoginEmailCard(props: Props) {
  const { tenantId, ownerUserId, ownerName, emailDelivery, disabled } = props;
  const [email, setEmail] = useState(props.ownerEmail);
  const [provisionalSince, setProvisionalSince] = useState<string | null>(props.provisionalSince);
  const provisional = provisionalSince !== null;
  const [mode, setMode] = useState<Mode | null>(null);
  const [newEmail, setNewEmail] = useState("");
  const [reason, setReason] = useState("");
  const [attest, setAttest] = useState(false);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<{ address: string; result: CheckResult } | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<{ address: string; check: CheckResult; resume: ResumeState | null } | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);

  // A resolution interrupted after step 1 (reload, closed tab): resume at the
  // owner step with a FRESH check. Reads only; never repeats a change.
  useEffect(() => {
    const { urlMemberId, urlStaffId, state } = loadResume(tenantId);
    if (!urlMemberId && !urlStaffId) return;
    if (!state) {
      setResumeNotice(
        urlMemberId && !urlStaffId
          ? `A conflict resolution was interrupted after step 1 (member ${urlMemberId}): that member's contact address was changed, the owner's login address was not. Check the owner's new address again to finish.`
          : `A conflict resolution was interrupted after step 1 (${[urlMemberId && `member ${urlMemberId}`, urlStaffId && `staff account ${urlStaffId}`].filter(Boolean).join(", ")}): the conflicting address was moved, the owner's login address was not. Check the owner's new address again to finish.`,
      );
      return;
    }
    let cancelled = false;
    void checkLoginAddress(tenantId, state.address).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setResumeNotice(`Step 1 is done but the address could not be checked again: ${r.error}`);
        return;
      }
      setResolving({ address: state.address, check: r.data, resume: state });
    });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  async function checkAddress() {
    const address = newEmail.trim();
    if (!address || checking) return;
    setChecking(true);
    setCheckError(null);
    setChecked(null);
    const r = await checkLoginAddress(tenantId, address);
    setChecking(false);
    if (!r.ok) {
      setCheckError(r.error);
      return;
    }
    setChecked({ address, result: r.data });
    if (!r.data.free) setResolving({ address, check: r.data, resume: null });
  }

  function choose(next: Mode) {
    setMode(next);
    setError(null);
    setDone(null);
    setReason("");
    setNewEmail("");
    setAttest(false);
    setCode("");
  }

  const canSubmit =
    !!mode &&
    !submitting &&
    reason.trim().length >= REASON_MIN &&
    /^\d{6}$/.test(code) &&
    (mode !== "change" || /\S+@\S+\.\S+/.test(newEmail.trim())) &&
    (mode !== "clear_provisional" || attest);

  async function submit() {
    if (!mode) return;
    setSubmitting(true);
    setError(null);
    try {
      const su = await fetch("/api/admin/auth/step-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same shape as stepUpTarget(tenantId, ownerUserId, mode) on the server,
        // and the same change the route re-derives from the body below: the
        // grant is bound to THIS new address (lib/operator-step-up.ts).
        body: JSON.stringify({
          action: "owner.login_email",
          targetId: `${tenantId}/${ownerUserId}/${mode}`,
          change: mode === "change" ? { newEmail: newEmail.trim() } : {},
          code,
        }),
      });
      const suData = await su.json().catch(() => ({}));
      if (!su.ok || typeof suData?.grant !== "string") {
        setError(suData?.error ?? "Your authenticator code was not accepted.");
        return;
      }
      const body =
        mode === "change"
          ? { action: mode, reason: reason.trim(), newEmail: newEmail.trim() }
          : mode === "clear_provisional"
            ? { action: mode, reason: reason.trim(), attestMailboxVerified: true }
            : { action: mode, reason: reason.trim() };
      const res = await fetch(`/api/admin/customers/${tenantId}/login-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [STEP_UP_HEADER]: suData.grant },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = data?.error ?? "The change was not made.";
        setError(res.status === 409 && mode === "change" ? `${msg} Use "Check address" to see who holds it.` : msg);
        return;
      }
      setEmail(String(data.email));
      setProvisionalSince(
        !data.provisional ? null : mode === "change" ? new Date().toISOString() : provisionalSince ?? new Date().toISOString(),
      );
      setDone(
        mode === "change"
          ? `Login email changed. It is provisional (unverified). ${ownerName} has been signed out everywhere and signs in with the new address, their password and their authenticator.`
          : mode === "mark_provisional"
            ? "Marked provisional. No reset code, sign-in link or Google sign-in will reach this address."
            : emailDelivery === "off"
              ? "Confirmed on your own verification. Reset codes and sign-in links can reach this address once email is turned on."
              : "Confirmed on your own verification. Reset codes and sign-in links can reach this address again.",
      );
      setMode(null);
    } catch {
      setError("Network error. Nothing was confirmed; try again with a new code.");
    } finally {
      setCode("");
      setSubmitting(false);
    }
  }

  return (
    <div style={{ ...adminCard, padding: 24, borderColor: adminPalette.amberSoft }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: "0 0 8px" }}>Owner&apos;s sign-in email (back office)</h2>
      <p style={{ fontSize: 13, color: adminPalette.muted, margin: "0 0 6px", lineHeight: 1.5 }}>
        The address {ownerName} uses to sign in to the club&apos;s dashboard. Not a member record.
      </p>
      <p style={{ fontSize: 13, color: adminPalette.muted, margin: "0 0 12px", lineHeight: 1.5 }}>
        A <strong>provisional</strong> address is an identifier only: nobody has shown that {ownerName} reads it,
        so no reset code, sign-in link or Google sign-in reaches it. Password and authenticator sign-in work either way.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        <code style={{ fontSize: 13 }}>{email}</code>
        <span style={adminPill(provisional ? "amber" : "neutral")}>
          {provisional ? "Provisional — unverified" : "Not marked provisional — mailbox not verified by MatFlow"}
        </span>
        {provisional && provisionalSince && (
          <span style={{ fontSize: 12, color: adminPalette.muted }}>
            since {new Date(provisionalSince).toLocaleString("en-GB")}
          </span>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {!provisional && (
          <Button variant="secondary" size="compact" disabled={disabled} onClick={() => choose("mark_provisional")}>Mark provisional</Button>
        )}
        {provisional && (
          <Button variant="secondary" size="compact" disabled={disabled} onClick={() => choose("clear_provisional")}>Confirm mailbox</Button>
        )}
        <Button variant="secondary" size="compact" disabled={disabled} onClick={() => choose("change")}>Change login email</Button>
      </div>

      {done && <p role="status" style={{ fontSize: 13, color: adminPalette.green, margin: "12px 0 0" }}>{done}</p>}

      {resumeNotice && !resolving && (
        <p role="status" style={{ fontSize: 13, color: adminPalette.amber, margin: "12px 0 0", lineHeight: 1.5 }}>{resumeNotice}</p>
      )}

      {resolving && (
        <ConflictPanel
          tenantId={tenantId}
          ownerUserId={ownerUserId}
          address={resolving.address}
          check={resolving.check}
          resume={resolving.resume}
          onOwnerChanged={(address) => {
            setEmail(address);
            setProvisionalSince(new Date().toISOString());
            setResumeNotice(null);
            setMode(null);
            setDone(`Login email changed to the resolved address. It is provisional (unverified). ${ownerName} has been signed out everywhere.`);
          }}
          onClose={() => {
            setResolving(null);
            setChecked(null);
          }}
        />
      )}

      {mode && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${adminPalette.borderSoft}` }}>
          {mode === "change" && (
            <>
              <label htmlFor="login-email-new" style={label}>New login email</label>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  id="login-email-new"
                  type="email"
                  autoComplete="off"
                  value={newEmail}
                  onChange={(e) => { setNewEmail(e.target.value); setChecked(null); setCheckError(null); }}
                  style={field}
                />
                <Button variant="secondary" size="compact" onClick={checkAddress} loading={checking} disabled={checking || !/\S+@\S+\.\S+/.test(newEmail.trim())}>
                  Check address
                </Button>
              </div>
              {checked && checked.address === newEmail.trim() && checked.result.free && (
                <p role="status" style={{ ...hint, color: adminPalette.green }}>
                  {checked.result.sameAsOwner ? "That is already the owner's login email." : "Free in this club."}
                </p>
              )}
              {checkError && <p role="alert" style={{ ...hint, color: adminPalette.red }}>{checkError}</p>}
              <p style={hint}>Typing an address proves nothing about who reads it, so it is saved as provisional. Same account, role, password and authenticator.</p>
            </>
          )}
          {mode === "clear_provisional" && (
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, marginTop: 4 }}>
              <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} style={{ marginTop: 2 }} />
              <span>
                You are confirming you verified this mailbox yourself. MatFlow has no verify-by-email step
                {emailDelivery === "off" ? " (and email is turned off)" : ""}, so this rests on your verification alone (see
                docs/runbooks/SUPPORT-IDENTITY-VERIFICATION.md). Say how in the reason.
              </span>
            </label>
          )}
          <label htmlFor="login-email-reason" style={label}>Reason (audit-logged, at least {REASON_MIN} characters)</label>
          <textarea
            id="login-email-reason"
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={mode === "clear_provisional" ? "e.g. video call with the owner, who read back a code I sent from my own mail client; ticket #123" : "e.g. owner verified by call-back to the number on file; ticket #123"}
            style={{ ...field, resize: "vertical" }}
          />
          <label htmlFor="login-email-code" style={label}>Your authenticator code (confirms it is you)</label>
          <input
            id="login-email-code"
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
            <Button variant="secondary" onClick={() => setMode(null)} disabled={submitting}>Cancel</Button>
            <Button variant="destructive" onClick={submit} disabled={!canSubmit} loading={submitting}>
              {mode === "change" ? "Change login email" : mode === "mark_provisional" ? "Mark provisional" : "Confirm mailbox"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const label: React.CSSProperties = { fontSize: 12, opacity: 0.7, display: "block", marginTop: 12, marginBottom: 4 };
const hint: React.CSSProperties = { fontSize: 12, color: adminPalette.muted, margin: "6px 0 0" };
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
