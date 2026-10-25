"use client";

/**
 * D2 (booking preservation, approved 21 Oct 2026): what the owner reads
 * BEFORE saving a class whose squad list, rank gate or membership list would
 * turn people away. Booked members are listed with the door's reason —
 * their bookings are kept, never deleted — and so are members who are not
 * booked but would be refused, grouped by reason. Rendered inside the
 * confirmation dialog (components/ui/confirm-dialog.tsx).
 */
import {
  ACCESS_REFUSAL_LABEL,
  RECENT_DAYS,
  type AccessRefusal,
  type RestrictionPreview,
} from "@/lib/booking-eligibility";

const NAMES_SHOWN = 8;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** True when the preview has anyone to tell the owner about. */
export function previewHasRefusals(p: RestrictionPreview | null | undefined): p is RestrictionPreview {
  return !!p && (p.booked.length > 0 || p.notBookedTotal > 0);
}

function reasonsText(reasons: readonly AccessRefusal[]): string {
  return reasons.map((r) => ACCESS_REFUSAL_LABEL[r]).join("; ");
}

export function RestrictionPreviewBody({ preview, editing }: { preview: RestrictionPreview; editing: boolean }) {
  const weeks = Math.round(RECENT_DAYS / 7);
  const newly = preview.booked.filter((b) => b.newlyRefused).length;
  return (
    <div className="space-y-4 text-sm text-tx-2" data-testid="restriction-preview">
      {editing && preview.booked.length > 0 && (
        <p>
          <strong className="text-tx-1">Bookings are kept.</strong> These members stay booked; the doors turn them away when they
          try to check in, and they see the class marked &ldquo;Not eligible&rdquo; with the reason. Their bookings still count
          towards the class&rsquo;s capacity, so a full class stays full for new bookings.
        </p>
      )}

      {preview.booked.length > 0 && (
        <section aria-labelledby="restriction-booked">
          <h3 id="restriction-booked" className="text-[13px] font-semibold text-tx-1">
            Booked and would not be admitted ({preview.booked.length}{newly !== preview.booked.length ? `, ${newly} because of this change` : ""})
          </h3>
          <ul className="mt-1 space-y-1">
            {preview.booked.slice(0, NAMES_SHOWN * 2).map((b) => (
              <li key={b.memberId} data-testid="restriction-booked-row">
                <span className="font-medium text-tx-1">{b.name || "A member"}</span>
                {" — "}
                {reasonsText(b.reasons)}
                {b.staffDoorsAdmit ? " (refused at the member app and kiosk; staff can still mark them in)" : ""}
                {!b.newlyRefused ? " (already refused under the current rules)" : ""}
              </li>
            ))}
          </ul>
          {preview.booked.length > NAMES_SHOWN * 2 && (
            <p className="mt-1 text-tx-3">and {preview.booked.length - NAMES_SHOWN * 2} more booked members.</p>
          )}
        </section>
      )}

      {preview.notBookedTotal > 0 && (
        <section aria-labelledby="restriction-not-booked">
          <h3 id="restriction-not-booked" className="text-[13px] font-semibold text-tx-1">
            Not booked but would be refused ({preview.notBookedTotal})
          </h3>
          <p className="text-tx-3">Members this change would turn away at the door. Guardian and payer accounts are not counted.</p>
          <ul className="mt-1 space-y-2">
            {preview.notBooked.map((g) => {
              const shown = g.members.slice(0, NAMES_SHOWN);
              const more = g.count - shown.length;
              return (
                <li key={g.key} data-testid={`restriction-group-${g.key}`}>
                  <span className="font-medium text-tx-1">{g.label}</span>
                  {` — ${plural(g.count, "member", "members")}`}
                  {editing && g.attendedThisClassCount > 0
                    ? `, ${g.attendedThisClassCount} of them attended this class in the last ${weeks} weeks`
                    : g.recentlyActiveCount > 0
                      ? `, ${g.recentlyActiveCount} of them trained in the last ${weeks} weeks`
                      : ""}
                  <span className="block text-tx-3">
                    {shown.map((m) => m.name || "A member").join(", ")}
                    {more > 0 ? ` and ${more} more` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
