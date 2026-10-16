/**
 * SetupBanner — owner-facing nudge to finish onboarding items they skipped.
 *
 * Shown on the dashboard when an owner completed the wizard but left
 * meaningful gaps. The gaps and their links come from getSetupGaps
 * (lib/setup-gaps.ts); each link opens the page that does the job, never the
 * wizard (onboarding batch 1, 16 Oct 2026).
 *
 * Non-dismissible by design — these are real gaps, not nags.
 */
import Link from "next/link";
import { ArrowRight } from "lucide-react";

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
      className="rounded-2xl border px-4 py-3 flex items-center gap-3 flex-wrap"
      style={{ background: "var(--sf-1)", borderColor: "var(--bd-default)" }}
      role="complementary"
      aria-label="Setup progress"
    >
      <span
        className="w-2 h-2 rounded-full shrink-0"
        style={{ background: "var(--hue-warning)" }}
        aria-hidden
      />
      <p className="text-sm font-semibold" style={{ color: "var(--tx-1)" }}>
        Finish setting up your gym
        <span className="font-normal" style={{ color: "var(--tx-2)" }}>
          {" "}— {items.length} {items.length === 1 ? "item" : "items"} remaining
        </span>
      </p>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 sm:ml-auto">
        {items.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="inline-flex items-center gap-1 text-xs font-semibold transition-colors hover:underline"
              style={{ color: primaryColor }}
            >
              {item.label}
              <ArrowRight className="w-3 h-3" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
