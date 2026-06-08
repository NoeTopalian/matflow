/**
 * /member/actions — the member's full action list.
 *
 * Shows the same data MemberActionsPanel renders in compact mode on
 * /member/home, just without the "See all" link and without truncation.
 *
 * Stays inside the member layout (tab bar visible), so a member who taps
 * the home panel's "See all" lands here without losing navigation context.
 */
import MemberActionsPanel from "@/components/member/MemberActionsPanel";

export const dynamic = "force-dynamic";

export default function MemberActionsPage() {
  return (
    <div className="max-w-xl mx-auto px-4 pt-6 pb-12 space-y-4">
      <header>
        <h1 className="text-xl font-bold" style={{ color: "var(--member-text)" }}>
          Your action list
        </h1>
        <p className="text-xs mt-1" style={{ color: "var(--member-text-muted)" }}>
          Things your gym sent you, plus quick fixes the app spotted.
        </p>
      </header>

      <MemberActionsPanel mode="full" />
    </div>
  );
}
