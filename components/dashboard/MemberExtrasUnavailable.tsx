import { Card } from "@/components/ui/card";

/**
 * Said on the staff member profile when its optional extras (2FA status, comp
 * class roster) could not be read. A failed read is not "none": this replaces
 * the silence that used to look like "no 2FA, no comp classes". The 2FA part
 * is only mentioned to the roles that would see the Reset 2FA card.
 */
export function MemberExtrasUnavailable({ memberId, mentionTwoFactor }: { memberId: string; mentionTwoFactor: boolean }) {
  return (
    <Card padding="tight" className="mt-4">
      <div role="alert" className="flex items-center justify-between gap-3" data-testid="member-extras-unavailable">
        <p className="text-xs" style={{ color: "var(--tx-2)" }}>
          {mentionTwoFactor
            ? "Two-factor and comp class details couldn't be loaded, so they aren't shown. Nothing about them has changed."
            : "Comp class details couldn't be loaded, so they aren't shown. Nothing about them has changed."}
        </p>
        <a href={`/dashboard/members/${memberId}`} className="shrink-0 text-xs font-semibold underline" style={{ color: "var(--tx-1)" }}>
          Reload
        </a>
      </div>
    </Card>
  );
}
