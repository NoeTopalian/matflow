"use client";

/**
 * Shown above an archived member's profile (PR 3, 6 Nov 2026). "Remove
 * member" archives: the member is out of every list, count and door, and
 * every record stays. Restore (owner and manager, audited server-side) puts
 * them back exactly as they were. A coach sees the notice without the button.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/lib/date";

export default function ArchivedMemberBanner({
  memberId,
  name,
  archivedAt,
  archivedByName,
  canRestore,
}: {
  memberId: string;
  name: string;
  archivedAt: string;
  archivedByName: string | null;
  canRestore: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/members/${encodeURIComponent(memberId)}/restore`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; restoredKids?: number; subscriptionEnding?: boolean; note?: string };
      if (!res.ok) {
        setError(data.error ?? "Couldn't restore this member. Try again.");
        return;
      }
      const kids = data.restoredKids ?? 0;
      const who = kids > 0 ? `${name} and ${kids} ${kids === 1 ? "child" : "children"} restored` : `${name} restored`;
      // Remove set their card subscription to end; Restore does not restart billing.
      const billing = data.subscriptionEnding ? " Their card subscription is still set to end, so set billing up again." : "";
      toast(`${who}.${billing}${data.note ? ` ${data.note}` : ""}`, "success");
      router.refresh();
    } catch {
      setError("Couldn't reach MatFlow. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Archived member"
      data-testid="archived-member-banner"
      className="mb-4 flex flex-col gap-3 rounded-[var(--r-md)] border border-bd-default bg-sf-1 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <Archive className="mt-0.5 h-4 w-4 shrink-0 text-tx-3" aria-hidden />
        <div>
          <p className="text-sm font-semibold text-tx-1">This member is archived</p>
          <p className="mt-0.5 text-[13px] text-tx-3">
            Removed on {formatDate(archivedAt)}
            {archivedByName ? ` by ${archivedByName}` : ""}. They are hidden from lists and counts and can&rsquo;t check in or sign in.
            Their attendance, payments and history are kept.
          </p>
          {error && (
            <p role="alert" className="mt-1 text-[13px] text-[var(--hue-danger-ink)]">
              {error}
            </p>
          )}
        </div>
      </div>
      {canRestore && (
        <Button variant="secondary" loading={busy} onClick={restore} className="self-start sm:self-auto">
          Restore member
        </Button>
      )}
    </section>
  );
}
