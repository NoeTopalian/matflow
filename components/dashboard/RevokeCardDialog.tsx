"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/components/ui/Toast";

/**
 * Cancels every printed ID card a member holds.
 *
 * The reason is required rather than optional because the endpoint requires it,
 * and the endpoint requires it because a card being cancelled is a real-world
 * event — lost at training, left the club, reprinted after a promotion — and an
 * audit row that cannot say which is worth much less when someone asks months
 * later why a card stopped working.
 *
 * The failure branch matters more than the success one here: telling a coach a
 * lost card is dead when the request failed is precisely the
 * reports-success-on-failure defect this codebase has been repeatedly bitten
 * by, and this particular lie would leave a working credential in a stranger's
 * pocket.
 */
export function RevokeCardDialog({
  memberId,
  memberName,
  open,
  onClose,
  onRevoked,
}: {
  memberId: string;
  memberName: string;
  open: boolean;
  onClose: () => void;
  onRevoked?: (cardVersion: number) => void;
}) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const close = () => {
    setReason("");
    onClose();
  };

  async function submit() {
    if (reason.trim().length < 5) {
      toast("Give a short reason (at least 5 characters)", "error");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/members/${memberId}/card/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast(data.error ?? "Couldn't cancel the card — nothing has changed", "error");
        return;
      }
      onRevoked?.(data.cardVersion);
      toast("Card cancelled. Print a replacement when you're ready.", "success");
      close();
    } catch {
      toast("Couldn't reach MatFlow — the card has NOT been cancelled", "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onClose={close}
      onConfirm={submit}
      title="Cancel this member's ID card"
      description={`Any card ${memberName} is carrying will stop scanning immediately. Print a replacement afterwards.`}
      confirmLabel="Cancel card"
      cancelLabel="Keep it"
      destructive
      loading={saving}
    >
      <label className="block text-sm font-medium text-tx-2" htmlFor="revoke-card-reason">
        Why?
      </label>
      <input
        id="revoke-card-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Lost at training"
        maxLength={500}
        className="mt-1 w-full rounded-lg border border-bd-default bg-sf-1 px-3 py-2 text-sm text-tx-1"
      />
    </ConfirmDialog>
  );
}

export default RevokeCardDialog;
