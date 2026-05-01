/**
 * SetupBanner — owner-facing nudge to finish onboarding items they skipped.
 *
 * Shown on the dashboard when an owner completed the wizard but left
 * meaningful gaps. Detects:
 *   - Stripe not connected (most common skip — owner can re-launch from
 *     Settings or via the resume route)
 *   - No membership tiers created
 *   - No classes scheduled
 *
 * Resume route: /onboarding?resume=1 — bypasses the onboardingCompleted
 * check on the page so owners can re-run the wizard from the start.
 *
 * Non-dismissible by design — these are real gaps, not nags.
 */
import Link from "next/link";
import { ArrowRight, AlertCircle } from "lucide-react";

interface SetupItem {
  label: string;
  href: string;
}

export interface SetupBannerProps {
  items: SetupItem[];
  primaryColor: string;
}

export default function SetupBanner({ items, primaryColor }: SetupBannerProps) {
  if (items.length === 0) return null;

  return (
    <div
      className="rounded-2xl border p-4 flex items-start gap-3"
      style={{
        background: "rgba(245,158,11,0.06)",
        borderColor: "rgba(245,158,11,0.24)",
      }}
      role="complementary"
      aria-label="Setup progress"
    >
      <div
        className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
        style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
      >
        <AlertCircle className="w-5 h-5" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-amber-400">
          Finish setting up your gym ({items.length} {items.length === 1 ? "item" : "items"} remaining)
        </p>
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
          {items.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="inline-flex items-center gap-1 text-xs font-semibold transition-colors hover:text-white"
                style={{ color: primaryColor }}
              >
                {item.label}
                <ArrowRight className="w-3 h-3" />
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
