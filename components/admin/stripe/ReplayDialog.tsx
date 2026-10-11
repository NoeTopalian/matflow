"use client";

// Replay one Stripe event (payments lane PD, 11 Oct 2026). The operator gives a
// reason and a fresh authenticator code; the code buys a 5-minute, single-use
// grant bound to THIS event in its current state ("stripe.event_replay",
// lib/operator-step-up.ts), which rides in the x-matflow-step-up header. The
// server fetches the event fresh from Stripe and runs it through the webhook's
// own processing path. Nothing here edits a member or a payment.

import { useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const STEP_UP_HEADER = "x-matflow-step-up";
const REASON_MIN = 5;
const REASON_MAX = 500;

export type ReplayTarget = { tenantId: string; eventId: string; type: string; clubName: string };

type Props = {
  target: ReplayTarget | null;
  onClose: () => void;
  /** Called with a short outcome line after the server answered. */
  onDone: (message: string, ok: boolean) => void;
};

const fieldClass =
  "w-full rounded-[var(--r-md)] border border-bd-default bg-sf-1 px-3 py-2 text-[13px] text-tx-1 placeholder:text-tx-4 focus-visible:border-bd-hover";

export default function ReplayDialog({ target, onClose, onDone }: Props) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasonOk = reason.trim().length >= REASON_MIN && reason.trim().length <= REASON_MAX;
  const codeOk = /^\d{6}$/.test(code.trim());

  function close() {
    if (busy) return;
    setReason("");
    setCode("");
    setError(null);
    onClose();
  }

  async function submit() {
    if (!target || !reasonOk || !codeOk) return;
    setBusy(true);
    setError(null);
    try {
      const su = await fetch("/api/admin/auth/step-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "stripe.event_replay",
          targetId: `${target.tenantId}/${target.eventId}`,
          change: { force: false },
          code: code.trim(),
        }),
      });
      const suBody = (await su.json().catch(() => ({}))) as { grant?: string; error?: string };
      if (!su.ok || typeof suBody.grant !== "string") {
        setError(suBody.error ?? "Your authenticator code was not accepted.");
        return;
      }
      const res = await fetch(`/api/admin/stripe/events/${encodeURIComponent(target.eventId)}/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json", [STEP_UP_HEADER]: suBody.grant },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: string; error?: string; alreadyApplied?: boolean };
      if (!res.ok) {
        setError(body.error ?? "The replay did not go through. Nothing was changed.");
        return;
      }
      const message = body.alreadyApplied
        ? "This replay had already been applied."
        : body.result === "processed"
          ? "Event replayed and processed."
          : body.result === "ignored_foreign" || body.result === "ignored_stale"
            ? "Event replayed; the handler recorded it as not applicable."
            : "Event replayed.";
      setReason("");
      setCode("");
      onDone(message, true);
    } catch {
      setError("Couldn't reach the server. Nothing was changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onClose={close}
      title="Replay Stripe event"
      description={target ? `${target.type} · ${target.clubName}` : undefined}
      footer={
        <div className="flex justify-end gap-2 p-4">
          <Button type="button" variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="primary" onClick={submit} loading={busy} disabled={!reasonOk || !codeOk}>
            Replay event
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-4 text-[13px] text-tx-2">
        <p>
          The event is fetched again from Stripe as this club&rsquo;s account and processed once. If it has already been
          processed, nothing happens. The replay is recorded in the audit log with your reason.
        </p>
        <p className="font-mono text-[12px] text-tx-3 break-all">{target?.eventId}</p>
        <div className="flex flex-col gap-1">
          <label htmlFor="replay-reason" className="text-[12px] font-medium text-tx-2">
            Reason
          </label>
          <textarea
            id="replay-reason"
            className={fieldClass}
            rows={3}
            maxLength={REASON_MAX}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-describedby="replay-reason-hint"
          />
          <span id="replay-reason-hint" className="text-[12px] text-tx-3">
            At least {REASON_MIN} characters. Say what was fixed.
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="replay-code" className="text-[12px] font-medium text-tx-2">
            Your authenticator code (confirms it is you)
          </label>
          <input
            id="replay-code"
            className={fieldClass}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        {error ? (
          <p role="alert" className="text-[13px] text-[var(--hue-danger-ink)]">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
