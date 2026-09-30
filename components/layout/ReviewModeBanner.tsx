import { Eye } from "lucide-react";
import { formatDate } from "@/lib/date";

/**
 * Review mode (lib/review-lock.ts): shown on every dashboard page while the
 * operator has the club in review. It states what the data is and who is
 * still collecting the money, so an owner inspecting an imported copy never
 * mistakes it for the live system of record. Not dismissible — it goes when
 * review mode ends.
 */
export default function ReviewModeBanner({
  snapshotAt,
  note,
  sourcePlatform,
}: {
  snapshotAt: Date | null;
  note: string | null;
  /** e.g. "TeamUp", from the club's last import; null → "Your current platform". */
  sourcePlatform: string | null;
}) {
  return (
    <div
      className="w-full px-4 py-2.5 text-sm border-b"
      style={{
        background: "rgba(245, 158, 11, 0.08)",
        borderBottomColor: "rgba(245, 158, 11, 0.25)",
        color: "var(--tx-1)",
      }}
      role="status"
      data-testid="review-mode-banner"
    >
      <div className="flex items-start gap-2.5">
        <Eye className="w-4 h-4 shrink-0 mt-0.5" style={{ color: "var(--hue-warning-ink)" }} aria-hidden />
        <p className="min-w-0">
          <strong className="font-semibold">Review copy.</strong>{" "}
          {snapshotAt ? <>This is your data as exported on {formatDate(snapshotAt)}. </> : <>This is an imported copy of your data. </>}
          {sourcePlatform ?? "Your current platform"} remains responsible for existing billing — card sign-ups, invitations to all members and deletions are paused until the review ends.
          {note ? <> {note}</> : null}
        </p>
      </div>
    </div>
  );
}
