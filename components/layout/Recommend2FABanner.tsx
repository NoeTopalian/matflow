import Link from "next/link";
import { ShieldCheck } from "lucide-react";

/**
 * 2FA-optional spec (2026-05-07): persistent recommendation banner shown to
 * any logged-in user (User or Member) where `totpEnabled === false`. Banner is
 * non-dismissible — disappears only when the user actually enrols.
 *
 * Server component, no interactivity. Mounted in:
 *   - app/dashboard/layout.tsx (staff: owner/manager/coach/admin)
 *   - app/member/home + /member/* layouts (password-bearing members)
 *
 * Caller is responsible for the visibility check; this component renders
 * unconditionally so it can be wrapped in `{!totpEnabled && <Recommend2FABanner />}`
 * by the parent layout.
 */
export default function Recommend2FABanner({
  setupHref = "/login/totp/setup",
  scope = "your account",
}: {
  setupHref?: string;
  /** Brief noun for the banner copy. "your account" by default; "your gym" for owners. */
  scope?: string;
}) {
  return (
    <div
      className="w-full flex items-center justify-between gap-4 px-4 py-2.5 text-sm border-b"
      style={{
        background: "rgba(245, 158, 11, 0.08)",
        borderBottomColor: "rgba(245, 158, 11, 0.25)",
        color: "var(--tx-1, #fbbf24)",
      }}
      role="status"
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: "#f59e0b" }} aria-hidden />
        <span className="truncate">
          <strong className="font-semibold">Two-factor authentication is recommended.</strong>
          {" "}Set up now to protect {scope}.
        </span>
      </div>
      <Link
        href={setupHref}
        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
        style={{
          background: "rgba(245, 158, 11, 0.15)",
          color: "#fbbf24",
          border: "1px solid rgba(245, 158, 11, 0.35)",
        }}
      >
        Set up now →
      </Link>
    </div>
  );
}
