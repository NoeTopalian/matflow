"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";

/**
 * 2FA-optional spec (2026-05-07): client-side recommendation banner for the
 * member surface. Mounted in app/member/layout.tsx (which is itself a client
 * component). Fetches /api/member/me?fields=security to learn whether the
 * current member has a password (enrolment is gated to password-bearing
 * members) and whether TOTP is already enabled. The `fields=security` variant
 * answers both in one query — the full payload is a ~15-round-trip attendance
 * and rank aggregate, and because this banner sits in the layout it would
 * otherwise run concurrently with each page's own copy on every navigation.
 * Banner renders only when:
 *
 *   hasPassword === true AND totpEnabled === false
 *
 * Magic-link-only members (no password) and kid members never see this.
 */
export default function Recommend2FABannerMember() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/member/me?fields=security")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.hasPassword === true && data.totpEnabled === false) {
          setShow(true);
        }
      })
      .catch(() => { /* offline / demo — banner stays hidden */ });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!show) return null;

  return (
    <div
      className="w-full flex items-center gap-3 px-4 py-2.5 text-xs"
      style={{
        background: "rgba(245, 158, 11, 0.10)",
        borderBottom: "1px solid rgba(245, 158, 11, 0.25)",
        // The warning ink comes from the member layout's own token, which the
        // shell publishes per theme: amber-400 was a dark-shell ink, and on the
        // LIGHT member shell it composited to 1.32:1 (round 3, lane L-F). The
        // token resolves to #9a6700 on light — 4.50:1 on amber/10 per
        // globals.css — and the dark shell keeps its amber unchanged.
        color: "var(--member-warning)",
      }}
      role="status"
    >
      <ShieldCheck className="w-4 h-4 shrink-0" style={{ color: "var(--member-warning)" }} aria-hidden />
      {/* Copy may wrap to a second line — never truncated mid-word. The
          button keeps its own column (shrink-0) so it stays fully visible
          and never overlaps the text. */}
      <p className="flex-1 min-w-0 leading-snug">
        Add two-factor authentication to protect your account.
      </p>
      <Link
        href="/login/totp/setup"
        className="shrink-0 px-2.5 py-1 rounded-md font-semibold whitespace-nowrap"
        style={{
          background: "rgba(245, 158, 11, 0.18)",
          color: "var(--member-warning)",
          border: "1px solid rgba(245, 158, 11, 0.35)",
        }}
      >
        Set up
      </Link>
    </div>
  );
}
